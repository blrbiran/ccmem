# ccmem for Codex CLI and oh-my-pi — design

- Date: 2026-10-17
- Author: Orca session `d0843ec0` (Claude Opus 5.5), brainstormed with the human in Chinese
- Base: ccmem `main` at `68e5357` (version 0.14.0)
- Status: draft, awaiting the human's approval. Nothing is built before that.

## 1. Intent

The human works in three coding agents: Claude Code, Codex CLI and oh-my-pi (OMP).
In Claude Code, ccmem injects the rules the human has accumulated (language
conventions, working habits such as "agree on a plan first", "ask before every paid
call", "list targets before destructive actions"). In Codex and OMP none of that
exists, so the human corrects the same things again in every session, and those
agents "feel worse than Claude".

The goal: **in Codex and OMP the human no longer has to repeat a correction ccmem
already knows**, and a correction made in Codex or OMP is learned into the same
memory, so every agent benefits from it.

Success, as the human would see it: a working session in Codex or OMP in which the
human does not re-state an old rule.

## 2. Goals

G1. **One shared memory, read and write, from all three agents.** Same data root,
same database, same scope rules (global rules visible everywhere; project rules only
in that project, keyed by the existing project-key logic — independent of which agent
is used). No agent is primary.

G2. **Injection into Codex and OMP**, using the same file-based mechanism ccmem
uses for Claude today (see §5.2).

G3. **Learning from Codex and OMP sessions**: at the end of a turn/session, their
transcripts are queued and summarized into memories exactly like Claude transcripts.

G4. **Each memory records which agent it was learned from** (for diagnosis).

G5. **The daemon's LLM work can run on Claude, Codex or OMP.**
- Manual: a config setting, plus a CLI command to show and change it.
- Automatic: when the active agent reports its quota is exhausted, ccmem proposes the
  next available agent in a configurable order (default Claude → Codex → OMP) and
  switches **after the human approves** (§5.5), without losing queued work; it
  returns to the preferred agent once its reported reset time has passed.
- Every switch is logged (from, to, reason) and visible in the existing status output.
- If every agent is exhausted, tasks stay queued; no busy retry loop.

G6. **Install commands**: `ccmem install codex` and `ccmem install omp` (exact CLI
shape is the builder's call) write the integration into the human's agent config,
back up first, show what changed, and can be undone (`ccmem uninstall codex|omp` or
equivalent).

## 3. Non-goals

- Other agents (Gemini, opencode, Cursor…).
- Rewriting the Claude Code integration for its own sake. The human explicitly
  allows changing Claude's behavior where this design needs it (§5.2 session-start
  injection, §4 truncation, agent-neutral prompts).
- Moving the data root. It stays `CCMEM_DATA_ROOT ?? ~/.claude/ccmem` (moving it
  would break existing installs and Orca). *Agent's call.*
- Changing the `ccmem export` contract Orca depends on (§6).
- Fixing unrelated open items in the handoff (embedding credits, UserPromptSubmit 5 s
  timeouts, plist drift).

## 4. Anti-goals (fail even if everything technically runs)

A1. **Summarization quality drops** when the work runs on Codex or OMP.

A2. **Summarized output is truncated.** Input selection may be a trade-off; the
*result* written into memory must not be silently cut. On the summarize path
(`summarize-pending.mjs:270` calls `parseLlmJson(..., { skipTruncate: true })`):
- `scripts/lib/llm-parse.mjs:43-46` cut `investigated / learned / completed /
  next_steps` to 200 chars each — a silent cut, to remove;
- over-long content goes to `refineContentToLimit` (`scripts/lib/content-refiner.mjs`),
  an LLM rewrite down to 500 chars. **The human ruled this rewrite is necessary and
  is not truncation** — it stays (and runs on whichever backend is active);
- if the rewrite fails, is disabled, or is still too long, `truncateAtWordBoundary`
  slices silently — a silent cut, to replace (re-ask, split, or keep the item
  queued/flagged with a logged reason).
The `maxContentChars` slice at `llm-parse.mjs:51` is off on this path; any other
caller that still slices is covered by the same rule. The invariant is "no silent
cut"; the mechanism is the builder's call. The test must target the path summaries
actually use.

A3. **Injection breaks the model's prompt cache.** Per-turn content must not change
anything already sent in the conversation (§5.2).

A4. **Injection is truncated or silently dropped.** This already happens in Claude
Code today (§5.2): session start emits every active memory of the scope, and Claude
Code keeps only a ~2 KB preview. Codex spills hook context above
`additionalContextLimit` (~2,500 tokens by default) to a file; OMP `sendMessage`
would put the whole text into the conversation. After this work, what goes into the
conversation at session start is small and bounded in all three agents, and any
overflow is reported, not hidden.

A5. **Memories are malformed.** A real example exists today: a memory whose content
is a raw JSON string `{"content":"Only clean up destructive targets …"}` was injected
into this session's stable context. New writes must not produce that shape (whether
to repair existing rows is out of scope; note it as a finding).

## 5. Design decided with the human

### 5.1 Integration points (from source reading; see §10 for evidence)

| ccmem today (Claude Code) | Codex CLI (installed 0.160.0) | OMP (installed 18.10.1) |
|---|---|---|
| SessionStart hook → `additionalContext` | `SessionStart` command hook, Claude-like stdin JSON (`session_id, cwd, transcript_path, source…`), `hookSpecificOutput.additionalContext` becomes a developer message | TypeScript extension: `session_start` event; inject once via `pi.sendMessage(..., {deliverAs:"nextTurn"})` or equivalent |
| UserPromptSubmit hook | `UserPromptSubmit` command hook (`prompt`, `turn_id`) | `before_agent_start` event (`prompt`) |
| Stop hook (`transcript_path`) | `Stop` hook (`transcript_path`, `last_assistant_message`) | `session_stop` event (`session_id, session_file, messages`), or `agent_end` when `!willContinue` |
| daemon `claude -p` | `codex exec -` (stdin), `--ephemeral`, `-s read-only`, `--output-schema`, `-o <file>` | `omp -p --no-session --no-tools --no-extensions --no-skills --no-rules`, stdin prompt, `--mode json` |

Codex: hooks only run once the user trusts them (`/hooks` in the TUI); any change to
the hook definition requires re-approval. **The installer must not write
`trusted_hash` itself** — it tells the human to approve in `/hooks`. *Agent's call:
bypassing Codex's trust gate is not ours to do.*

OMP: it does not execute Claude-style command hooks; ccmem ships a small OMP
extension that forwards each event to the existing handler logic (e.g. by spawning
`scripts/hook.mjs <mode>` with a Claude-shaped JSON payload, or calling it in-process
— builder's call). It must skip subagents (`ctx.agent.kind === "sub"`) and print
mode runs.

### 5.2 Injection is file-based in all three agents (protects the cache)

Per turn, ccmem already does the right thing: UserPromptSubmit writes only the
retrieved, relevance-ranked memories into `.ccmem/<session>.md` and returns empty
`additionalContext` (`scripts/handlers/prompt-submit.mjs:128`).

**Session start is broken today and is fixed in this work, Claude included** (the
human allowed changing Claude's behavior):
- `scripts/handlers/session-start.mjs:116-118` emits `stableContext` *followed by*
  the read instruction. `stableContext` is the rendered injection cache for the
  scope, with no size bound (`scripts/lib/render.mjs:17`). Measured 2026-10-17,
  read-only: `sqlite3 -readonly ~/.claude/ccmem/global.db "select scope,
  length(rendered_text) from injection_cache order by 2 desc limit 3"` →
  `global` 1,384,831 chars; `project:github.com/blrbiran/Orca` 638,495;
  `project:github.com/blrbiran/ccmem` 441,855; 4,251 non-quarantined global memories.
- In this very session Claude Code reported the SessionStart hook output as 1.9 MB,
  saved it to a file and kept a ~2 KB preview. The read instruction sits after the
  stable context, so it is very likely never seen; the model may never learn to read
  `.ccmem/<session>.md` at all.

New shape, same for all three agents:
- session start: the conversation gets only a short, fixed, agent-neutral read
  instruction (the builder adapts compaction wording per agent — Claude `/compact`,
  Codex PreCompact/PostCompact, OMP `compaction` entries). It is identical across
  turns of a session, so the cache prefix is stable.
- the session's stable rules move into the context file, **selected and bounded**
  (relevance/priority ranking with a size cap), not the whole scope. How to rank
  (pinned, rule type, trust score, project match, recency) and the cap are the
  builder's call; the invariant is "bounded and ranked, never the whole scope".
- per turn: rewrite the context file only; never inject into the conversation, never
  replace OMP's system prompt (`before_agent_start` can replace it — not used).
- The bloat itself (4,000+ active global memories) is noted as a finding; pruning
  or consolidating them is not required by this work.

The new risk is whether Codex/OMP models actually read the file. Acceptance (§7)
must show the read in their transcripts.

### 5.3 Learning from Codex/OMP transcripts

- One transcript parser per agent, producing the same internal entry shape the
  current parser (`scripts/lib/transcript.mjs`) yields:
  - Claude: unchanged.
  - Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, maybe
    `.jsonl.zst` after 7 days): `response_item` messages; must drop injected
    AGENTS.md / environment-context user-role items and ccmem's own injected text.
  - OMP session JSONL (`~/.omp/agent/sessions/<cwd>/<ts>_<uuid>.jsonl`): tree of
    entries with `parentId`; follow the active branch.
- The summarizer prompt becomes agent-neutral (today
  `scripts/daemon/tasks/summarize-pending.mjs:71` says "a FRESH Claude Code session").
- Input selection (today the last 4,000 chars, `summarize-pending.mjs:45-63`) is a
  trade-off the builder may keep or improve; it is not required to change.
- The Stop hook's feedback learning (`inferFromTranscript`, `inferL25FromTranscript`,
  `recordL25Probe` in `scripts/handlers/stop.mjs`, via `scripts/lib/feedback.mjs`)
  also works for Codex and OMP, through the same per-agent parsers. *Agent's call:
  the parsers emit one shape, so this is mostly free, and skipping it would leave the
  other agents half-learned.*

### 5.4 Which agent a memory came from

New nullable column (e.g. `origin_agent` ∈ `claude-code | codex | omp`) on
`memories`, set for new writes from hooks/summaries; old rows stay NULL. Shown in
`list`/`show`. **Not added to `ccmem export`** (Orca's row schema is `.strict()`,
`Orca/src/memory/ccmemExport.ts:13-31`; an extra field makes Orca reject the whole
export). Also record the agent on `session_context` so the summarizer knows which
parser to use. The migration follows ccmem Rule 13 (backup, dry run on a copy,
written rollback).

### 5.5 Summarizer agent selection and failover

- Today every daemon LLM task goes through `callClaudeP`
  (`scripts/daemon/claude-p.mjs`; callers: summarize-pending, weekly-synthesis,
  monthly-meta-synthesis, contradiction-audit, security-audit, resurrect,
  content-refiner). The selection applies to all of them through one seam.
- Each backend must provide: run a prompt (stdin), optional JSON schema, timeout,
  parse the result, report tool-given usage/cost (or "unknown" — never estimated),
  classify "quota exhausted" with the reset time when the tool gives one (Claude 429
  / retry-after; Codex "usage limit … try again at …"; OMP depends on its provider).
- Recursion guard per backend: the child must not trigger ccmem itself
  (`CCMEM_INTERNAL=1` is already checked by `hook.mjs:54`; plus Codex
  `-c features.hooks=false` and OMP `--no-extensions`), and must not write sessions
  (`--ephemeral` / `--no-session`). It also should not load the human's AGENTS.md /
  rules into a summarization call (run in a neutral cwd; OMP config overlay).
- Install-time checks (`daemon.mjs` resolves `claude` into the plist PATH and probes
  `--json-schema`) extend to the configured backends.
- Order, the manual setting and the persisted "exhausted until" state live in ccmem's
  config/DB (builder's call), visible in status.
- **Automatic failover asks first** (human's decision). When the active backend is
  exhausted, ccmem does not switch on its own: it records the exhaustion, keeps tasks
  queued, and asks the human to approve switching to the next backend (the daemon is
  headless, so the ask surfaces where the human will see it — e.g. the next session
  start's read instruction / status output plus a `ccmem` command to approve; the
  channel is the builder's call). Only after approval does it switch. Returning to the
  preferred backend after its reset time needs no approval. Reason: a fallback backend
  may bill per token (the human's OMP default goes through `local-litellm` at
  localhost:4000, billing unknown) and shares quota with the human's own
  interactive Codex/OMP work.
- Default models (agent's call, configurable): Claude unchanged (no `--model`, the
  human's default); Codex `gpt-6-luna`; OMP its default model role.

### 5.6 Install commands

- Codex: add the three hooks (SessionStart, UserPromptSubmit, Stop) to the user's
  Codex config (`~/.codex/config.toml` `[hooks]` or `~/.codex/hooks.json` — builder
  picks; must not clobber the existing `notify` entry or other settings).
- OMP: place the extension under `~/.omp/agent/extensions/` (or register it in
  `~/.omp/agent/config.yml`).
- Both: back up the touched file first (timestamped copy, mode 0600), print a diff,
  idempotent re-run, `uninstall` restores/removes exactly what install added.
  Paths relocatable by env (`CODEX_HOME`, `PI_CODING_AGENT_DIR`/OMP equivalent) so
  tests never touch the real files. These out-of-repo writes are registered in the
  spec/README (path, trigger, residue on failure).
- Never print or copy credentials (`~/.codex/auth.json`, OMP `models.yaml` keys).

## 6. Constraints

- ccmem `CLAUDE.md` Rule 13: back up before any write to `~/.claude/ccmem/**`; no
  development writes to the production DB; migrations need backup + dry run on a copy
  + rollback steps; restart the daemon after daemon-side changes, and verify by
  behavior, not by the restart.
- `~/.claude/plugins/ccmem` is a symlink to the main checkout: hook-path changes go
  live for every Claude session immediately. Build in a worktree.
- Orca depends on `ccmem export` (fields, enums, `version`, project-key rule).
  Unchanged by this work.
- Hook budgets: Codex SessionEnd is capped at 3 s; existing Claude timeouts 2/5/3 s.
  Heavy work stays in the daemon.
- Version skew: the source checkouts are newer than the installed binaries (Codex
  source ≈0.163-alpha vs 0.160.0; OMP 18.11.2 vs 18.10.1). Anything the build relies
  on must be confirmed against the installed binaries.
- Paid runs (real model calls) need the human's approval each time.
- Tests use `node:test` via `scripts/run-tests.sh` with an isolated data root.

## 7. Acceptance

Mechanical (free, isolated data root and agent homes):
- each install command: backup exists, diff matches, re-run is a no-op, uninstall
  restores the original bytes;
- fixture transcripts from each agent parse to the expected entries (including the
  filtering of injected context);
- the parser rejects/splits over-long results instead of slicing (a test that fails
  if a silent slice is reintroduced);
- failover: a fake backend reporting exhaustion switches to the next, logs it, keeps
  the task queued, and switches back after the reset time.

Paid (ask the human before each run):
- **Quality**: the same set of transcripts summarized by Claude, Codex and OMP,
  compared against the five criteria the human approved:
  1. actionable — tells you what to do next time, not a one-off log;
  2. self-contained — readable without the original conversation, carries why and
     when it applies;
  3. correct scope — global vs project;
  4. no duplicates or contradictions with existing memories;
  5. complete and well-formed — not truncated, no raw JSON in content.
  Judge: the human, from a side-by-side report. A backend the human rules below par
  is left out of the default failover order until its prompt is tuned; it does not
  block shipping the rest. *Agent's call.*
- **Session start is bounded**: in each agent the conversation-side session-start
  text is the short read instruction only, and the context file holds a bounded,
  ranked set (mechanical check on a fixture DB with thousands of memories).
- **Injection works**: a real Codex session and a real OMP session in which the
  transcript shows the model reading `.ccmem/<session>.md`.
- **Cache not damaged**: tool-reported cache numbers for the same short scripted
  session with and without ccmem; no drop attributable to ccmem.

## 8. Calls made by the agent (for the human to check)

- Data root stays `~/.claude/ccmem` (§3).
- `origin_agent` is stored but not exported, because Orca's export schema is strict (§5.4).
- The Codex installer does not bypass Codex's hook trust gate; the human approves in
  `/hooks` (§5.1).
- Default summarizer models (§5.5).
- Feedback learning extends to Codex/OMP (§5.3).
- The paid quality comparison is judged by the human; a failing backend leaves the
  default order rather than blocking the release (§7).

## 9. Left to the builder

CLI shape of install/uninstall and the agent-selection command; where the OMP
extension lives in the repo and how it calls the handlers; parser module layout;
the backend seam's API; storage for failover state; how per-agent instruction
wording differs; whether to improve input selection.

## 10. Evidence (source reading, 2026-10-17)

- Codex source `/Users/biran/code/skills/agent/codex` HEAD `4eb4a65407`
  (paths under `codex-rs/`): hook events `config/src/hook_config.rs:36-61`; trust
  gate `hooks/src/engine/discovery.rs:715-721, 796-813`; context as developer message
  `core/src/context/hook_additional_context.rs:22-24`; context limit
  `hook_config.rs:175-184`; rollout path `rollout/src/recorder.rs:1744-1760`;
  `codex exec` flags `exec/src/cli.rs:30-104`. Installed 0.160.0 `codex exec --help`
  lists `--ephemeral`, `--ignore-user-config`, `--output-schema`,
  `--dangerously-bypass-hook-trust`.
- OMP source `/Users/biran/code/skills/agent/oh-my-pi` 18.11.2 HEAD `714a63689b`:
  events `packages/coding-agent/src/extensibility/shared-events.ts` and
  `.../extensions/types.ts`; docs `docs/extensions.md`, `docs/session.md`,
  `docs/context-files.md`; no Claude command-hook execution found. Installed 18.10.1
  `omp --help` lists `--no-session`, `--no-tools`, `--no-extensions`, `--no-rules`.
- ccmem coupling map: `hooks/hooks.json`, `scripts/hook.mjs`,
  `scripts/handlers/*.mjs`, `scripts/lib/transcript.mjs`,
  `scripts/daemon/claude-p.mjs`, `scripts/lib/llm-parse.mjs`,
  `scripts/migrations/001_initial.sql:23-47` (no agent column).
