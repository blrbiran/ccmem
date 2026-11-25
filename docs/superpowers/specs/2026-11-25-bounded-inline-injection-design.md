# Bounded inline injection: the stable section and the retrieved rows ride in `additionalContext` (#453) — design

Status: **implemented behind `injection.inline_bounded`, default `false`** (today's behaviour unchanged). Author: Orca
session `5d3d0c09` (Claude Opus 5.5), 2026-11-25, on ccmem main `fe447dbf` + the #475/#464/#452 fixes of the same
branch. Human (tester ledger #453): 「如果你觉得合适，那我同意」 — design plus a default-off switch; the paid A/B that would
change the default is **not** run here.

## 1. Problem

File-based injection (`injection.file_based: true`, the default) gives the conversation only a read instruction
(`buildReadInstruction`, `scripts/handlers/session-start.mjs`) and writes the memories to `.ccmem/context-<hash>.md`.
The model then spends a tool round trip `cat`-ing that file every session. Tester numbers (ledger #453, 2026-11-24,
codex-cli 0.170.0 through the magpie gateway, one irrelevant prompt, 3 reps per side, bypass path):

| | off | on (file-based) |
|---|---|---|
| codex `tokens used` (3 runs) | 417 / 420 / 430 (sum 1267) | 2490 / 2494 / 2531 (sum 7515) — **5.93×** |
| prompt tokens, first request | 13671 | 13788 (`ccmemTokens` 107: the read instruction) |
| prompt tokens after the `cat` | — | 15146 (`parts.results` 1510 = the 5594 B file) |
| cache hit | 0.9737 | 0.922 / 0.879 |

The file was 5594 B; about 4 KB of it is the stable section, bounded by `STABLE_SECTION_MAX_BYTES = 4096`
(`scripts/lib/context-file.mjs`). The rest was 6 retrieved rows with fused scores ≤ 0.188 — since then gated by the
relevance floor (`min_cosine_by_signature`, bge-m3 0.60; `retrieveMemories(..., { relevanceFloor: true })`).

So the round trip costs a tool call, its PreToolUse/PostToolUse hooks and the whole file as a tool result, to deliver
≤ 4 KB of stable rules plus a handful of gated rows.

## 2. Why injection went file-based, and what must stay impossible

`docs/superpowers/specs/2026-10-17-codex-omp-adaptation-design.md` §5.2: session start used to emit the scope's whole
rendered `injection_cache` — **unbounded** (global 1,384,831 chars measured; Claude Code reported a 1.9 MB SessionStart
output and kept a 2 KB preview). The legacy inline path (`file_based: false`) still does exactly that:
`injection_cache.rendered_text` is unbounded today (1.5 MB measured by the tester).

Invariant of this design: **nothing unbounded is ever inlined.** The switch never touches `rendered_text`; it inlines
only text that the file-based path already builds under a byte cap.

## 3. Design

New config key `injection.inline_bounded` (boolean, default `false`). It has effect only while `file_based` is on.

| Hook | `inline_bounded: false` (today) | `inline_bounded: true` |
|---|---|---|
| SessionStart `additionalContext` | read instruction (+ backend-switch notice) | `## ccmem context` + the bounded stable section (+ notice) |
| UserPromptSubmit `additionalContext` | `''` | the floor-gated retrieved rows, rendered as in the file, under the file's retrieved cap; `''` when none |
| `.ccmem/context-<hash>.md` | written | **still written**, same content |

- The inlined text is the very text `writeContextFile` put in the file (same selection, same caps, same truncation),
  returned to the hook instead of being re-rendered. One code path decides what is injected.
- The stable section is inlined once, at session start; it is not repeated per turn (that would add ~4 KB per turn).
- What stays file-based: the file itself (written as today, so telemetry — `context_write_log`, `recent_injections`,
  `admin diagnose` cache stats — is unchanged and a session can switch back mid-way), and the legacy `file_based: false`
  path, which this switch does not change.

### Byte bounds

| Output | Bound | From |
|---|---|---|
| SessionStart | header (17 B) + stable section ≤ 4096 B + notice (one generated line) | `STABLE_SECTION_MAX_BYTES` |
| UserPromptSubmit | retrieved block ≤ 8192 − 32 B | `RETRIEVED_MAX_BYTES` − hash line, as `fitsCaps` |
| Either, hard guard | ≤ `MAX_CONTEXT_FILE_BYTES` (12288 B) | checked on the final string; over it the hook falls back to today's output and says so on stderr |

The guard cannot fire by construction; it exists so a future change to the section builders cannot silently re-open
the 1.9 MB failure.

## 4. Risks the A/B must look at

- **Compaction.** The read instruction told the model to re-read after compaction. Inline text from SessionStart is
  lost when the host compacts unless the host re-runs SessionStart (Claude Code does, with `source: compact`; Codex and
  OMP: unverified). The A/B's long session must include a compaction.
- **History growth.** Per-turn retrieved rows stay in the conversation history (file-based: each `cat` result stays
  too). With the floor most turns inject nothing; the long session measures it.
- **Cache prefix.** SessionStart's inline block is fixed for the session, so the prefix stays stable; per-turn rows sit
  in the user turn, after the cached prefix.

## 5. How the default gets decided (the paid A/B — not run by this work)

Run on the **approved** hook path (#464 fixed), not the bypass path, both arms on the same path:

1. Arms: `inline_bounded: false` vs `true` (everything else equal, floor on).
2. Prompts: the #453 irrelevant prompt (TTL), one prompt a stable rule should answer ("what language should you answer
   in"), 3 reps each; plus one long session ≥ 30 turns that crosses a compaction.
3. Measure: codex `tokens used`; magpie per-request prompt tokens, `cacheRead`, cache hit; count of tool calls that read
   `.ccmem/`; whether the relevant prompt's answer follows the rule.
4. Flip the default to `true` if, on both short and long sessions, inline's `tokens used` is ≤ file-based's (within
   +5 %), cache hit is not lower by more than 2 points, and the relevant-prompt answers follow the rule at least as
   often. Otherwise keep `false` and record why.

## 6. Criteria shipped with the switch

- `tests/integration/bounded-inline-injection.test.mjs`: with the switch on, SessionStart output contains the stable
  section and stays within the bound while `injection_cache.rendered_text` is 2 MB and memories are large; prompt-submit
  output carries only gated rows within the retrieved bound; with the switch off (absent and explicit `false`), both
  outputs equal today's bytes.
