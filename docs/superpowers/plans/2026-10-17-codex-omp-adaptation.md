# ccmem for Codex CLI and oh-my-pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared ccmem memory that Claude Code, Codex CLI and oh-my-pi (OMP) all read (bounded, file-based injection) and write (per-agent transcript learning), with a selectable, approval-gated summarizer backend and reversible install commands.

**Architecture:** The existing hook handlers stay the single implementation; Codex calls them as command hooks and OMP through a small TypeScript extension, both passing `--agent <id>`. Transcripts are normalized per agent into the Claude entry shape the rest of ccmem already consumes. Every daemon LLM call keeps going through `callClaudeP`, which becomes a dispatcher over three backends with persisted exhaustion state.

**Tech Stack:** Node ≥ 24 (`/usr/local/bin/node`, `node:sqlite`, native TS type stripping for the OMP extension test), `node:test`, SQLite migrations in `scripts/migrations/`.

**Spec:** `docs/superpowers/specs/2026-10-17-codex-omp-adaptation-design.md` (commit `1f19daf`).

## Global Constraints

- Agent ids, verbatim everywhere (DB, argv, config): `claude-code`, `codex`, `omp`. Backend ids: `claude`, `codex`, `omp`.
- `ccmem export` output is byte-for-byte unchanged in shape: row keys exactly `id,scope,project_key,type,content,pinned,source,trust_score,tags,created_at,updated_at`; `source` enum unchanged (Orca `src/memory/ccmemExport.ts:13-31` is `.strict()`).
- Data root stays `CCMEM_DATA_ROOT ?? ~/.claude/ccmem`.
- No test touches real `~/.claude/ccmem`, `~/.codex`, `~/.omp`: tests set `CCMEM_DATA_ROOT`, `CODEX_HOME`, `CCMEM_OMP_AGENT_DIR` to temp dirs. Run tests only through `sh scripts/run-tests.sh <files>`.
- New files/dirs written outside the repo by install: dirs `0700`, files `0600`; existing files keep their mode.
- Backups use the existing naming `<file>.bak.<millisecond epoch>`.
- No silent truncation of summarized output (spec A2). The LLM refiner rewrite stays.
- Session-start text in the conversation is the short read instruction only (spec §5.2), ≤ 1024 bytes.
- Context file caps: stable section `STABLE_SECTION_MAX_BYTES = 4096`; whole file `MAX_CONTEXT_FILE_BYTES = 12288` (was 8192; retrieved rows keep 8192 of it).
- Default models: codex `gpt-6-luna`; omp none (its default role); claude none.
- Failover never switches backend without the human's approval; returning to the preferred backend after its reset time needs none.
- Paid real-model runs are not part of automated tasks; Task 12 lists them for the human.
- The production plugin symlink `~/.claude/plugins/ccmem` points at the main checkout: work only in this worktree; nothing goes live before the human merges.

## Review Focus

1. A user whose Codex config already has hooks (TOML `[hooks]` in `config.toml`, or a `hooks.json` with other entries) — install must merge or refuse, never clobber. → Task 6 tests `install refuses when config.toml has [hooks]` and `install keeps foreign hooks.json entries`.
2. A transcript whose last line is half-written (the agent is still flushing) or contains a non-JSON line — parsers must skip it, not throw (today `parseTranscript` throws). → Task 5 test `parsers skip malformed lines`.
3. The ccmem hook failing or hanging inside OMP — the OMP session must neither hang nor crash. → Task 7 test `extension swallows hook failure and timeout`.
4. A summarizer child (`codex exec` / `omp -p`) re-triggering ccmem's own hooks — recursion. → Task 8 test `codex and omp invocations carry recursion guards`.
5. A Codex session started outside any git repo (`cwd` with no `.git`) — project key falls back to the path key and the context file still lands in `<cwd>/.ccmem/`. → Task 4 test `codex session-start in a non-git dir`.

---

### Task 0: Repair stale repo paths in tests (baseline)

Baseline on `d9d1547` (`npm test`, Orca session `d0843ec0`): 760 tests, 695 pass, 65 fail. Every failure inspected traces to the hardcoded pre-move path `/Users/biran/code/skills/ccmem` (76 occurrences in 10 files under `tests/integration/`; e.g. `ENOENT … /Users/biran/code/skills/ccmem/config.default.json`, `spawnSync /usr/local/bin/node ENOENT` from a missing cwd).

**Files:** Modify the 10 files found by `grep -rln '/Users/biran/code/skills/ccmem' tests scripts`.

- [ ] **Step 1:** In each file derive `const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))` (strip trailing slash) and replace every literal occurrence with it (template strings / `path.join`). No other edits.
- [ ] **Step 2:** `grep -rn '/Users/biran/code/skills/ccmem' tests scripts` → no output.
- [ ] **Step 3:** `npm test` (output to a file, read back) → 760 tests, 0 fail. Any remaining failure is reported with its cause, not fixed beyond this task's scope.
- [ ] **Step 4:** Commit `test: derive the repo root instead of hardcoding the pre-move path`.

### Task 1: Bounded, file-based session start (all agents, Claude included)

**Files:**
- Modify: `scripts/lib/context-file.mjs` (add stable section; raise file cap)
- Modify: `scripts/handlers/session-start.mjs:107-118` (write file, emit instruction only)
- Modify: `scripts/handlers/prompt-submit.mjs:71-87` (keep stable section when rewriting)
- Test: `tests/integration/bounded-session-start.test.mjs` (new); update `tests/integration/save-list-session-start.test.mjs` and `tests/integration/v014-scope-isolation-injection.test.mjs` where they assert stable text inside `additionalContext` (approved criterion rewrite: assert it in the context file instead)

**Interfaces:**
- Produces: `selectStableRows(db, projectKey, { disableScopeIsolation }) -> Array<{id, scope, content, pinned}>` (ordered: the `member_ids` order of `injection_cache` rows `global` then `project:<key>`, i.e. already ranked by `rankRows`); `writeContextFile(cwd, rows, sessionId = null, db = null, { stableRows = null } = {})`; `STABLE_SECTION_MAX_BYTES`.
- Stable section renders with `renderStableContext(projectKey, rows)` truncated row-by-row (whole rows only) to `STABLE_SECTION_MAX_BYTES`; on overflow write stderr `ccmem: stable section trimmed to N of M mems` (the "reported, not hidden" rule).

- [ ] **Step 1: Write failing tests** in `bounded-session-start.test.mjs`:
  - `session start emits only the read instruction`: seed 3,000 active global memories (+1 pinned with marker text `PINNED-MARKER`), `rebuildInjectionCache`, call `handleSessionStart({cwd, session_id:'s1'})`; assert `Buffer.byteLength(additionalContext) <= 1024`, it includes `.ccmem/` and not `PINNED-MARKER`.
  - `context file holds a bounded ranked stable section`: after the same call, read `getContextFilePath(cwd,'s1')`; assert it contains `PINNED-MARKER`, file bytes ≤ 12288, stable section bytes ≤ 4096.
  - `prompt submit keeps the stable section`: call `handlePromptSubmit` for `s1`; file still contains `PINNED-MARKER` and the retrieved block header `=== ccmem: retrieved for current prompt ===` when rows match.
  - `instruction is identical across calls of one session` (cache-stable): two `handleSessionStart` calls → equal strings.
- [ ] **Step 2:** `sh scripts/run-tests.sh tests/integration/bounded-session-start.test.mjs` → FAIL (stable text in `additionalContext`).
- [ ] **Step 3:** Implement. Session start: `writeContextFile(cwd, [], sessionId, db, { stableRows })` when `useFileBased`; return `buildReadInstruction(sessionId)` only. With `file_based === false` keep today's behavior (legacy path, untouched). Prompt submit passes `stableRows` from `selectStableRows` so the rewrite keeps it; `clearContextFile` path also keeps it. The content hash covers both sections.
- [ ] **Step 4:** Update the two existing test files' assertions (stable text now in the file); run them plus the new file → PASS.
- [ ] **Step 5:** Commit `feat(inject): bound session-start injection and move stable rules into the context file`.

### Task 2: No silent output truncation; unwrap JSON-string content

**Files:**
- Modify: `scripts/lib/llm-parse.mjs:43-46` (drop the 200-char slices), add JSON-string unwrap
- Modify: `scripts/lib/content-refiner.mjs` (no `truncateAtWordBoundary` fallback on the refine path)
- Modify: `scripts/daemon/tasks/summarize-pending.mjs:275-290` (handle refine failure)
- Test: `tests/integration/no-silent-truncation.test.mjs` (new); update `tests/unit/*content-refiner*` / any test asserting the word-boundary fallback (approved rewrite)

**Interfaces:**
- Produces: `refineContentToLimit(content, opts) -> Promise<{ ok: true, content: string } | { ok: false, reason: 'refiner_disabled'|'refine_failed'|'still_too_long', content: string }>` (content is the full original when `ok:false`). `truncateAtWordBoundary` stays exported for non-summary callers but is no longer called here.
- `normalizeSynthesizedArray`: if `content` trimmed parses as a JSON object with a string `content` field, use that inner string (spec A5).

- [ ] **Step 1: Failing tests** (drive `runSummarizePending` with `payload.llm_output` mock, like `summarize-excerpt-window.test.mjs`):
  - `summary fields are not sliced`: `learned` of 450 chars → stored `summary_meta.learned` length 450.
  - `refine failure keeps the memory out and audits the full text`: content 900 chars, refiner mocked to return 700 chars twice → no memory row with a 500-char prefix of it; an audit row `summarize_refine_rejected` whose payload `content` length is 900 and `reason` `still_too_long`.
  - `refiner disabled stores nothing truncated`: `summarize.content_refiner.enabled=false`, 900 chars → audit `summarize_refine_rejected` reason `refiner_disabled`, no truncated row.
  - `json-string content is unwrapped`: content `{"content":"Only clean up X"}` → stored content `Only clean up X`.
  - Mutation note for the reviewer: re-adding `.slice(0, 200)` or the word-boundary fallback must turn the first/second test red.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Refiner: one retry with the instruction "must be ≤ 500 characters" when the first result is too long; then `ok:false`. Summarize: `ok:false` → `writeAudit(db,'summarize_refine_rejected',null,{session_id, reason, content})`, skip insert. Mock seam for the refiner: accept `opts.mockOutputs: string[]` consumed in order (tests only).
- [ ] **Step 4:** Run new + updated tests → PASS.
- [ ] **Step 5:** Commit `fix(summarize): never truncate summarized output silently`.

### Task 3: Migration 017 — origin agent, session agent, backend state

**Files:**
- Create: `scripts/migrations/017_v015_agents.sql` (shape of `016_v013.sql`)
- Modify: `scripts/lib/cmd/save.mjs:32-52` (`originAgent` param), `scripts/lib/cmd/list.mjs`, `scripts/lib/cmd/show.mjs` (display)
- Test: `tests/integration/migration-017.test.mjs`, `tests/integration/export-contract-unchanged.test.mjs`

**Interfaces:**
- SQL: `ALTER TABLE memories ADD COLUMN origin_agent TEXT CHECK (origin_agent IN ('claude-code','codex','omp'))`; `ALTER TABLE session_context ADD COLUMN agent TEXT`; `CREATE TABLE llm_backend_state (backend TEXT PRIMARY KEY, exhausted_until INTEGER, last_error TEXT, updated_at INTEGER NOT NULL)`; `CREATE TABLE llm_switch_proposals (id INTEGER PRIMARY KEY, from_backend TEXT NOT NULL, to_backend TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, approved_at INTEGER, superseded_at INTEGER)`; version 16 → 17.
- Produces: `insertMemory(db, { ..., originAgent = null })`.

- [ ] **Step 1: Failing tests:** migration applies on a fresh root and on a v16 DB copy (built via `openDb` before the file exists is not possible — instead assert `schema_meta.version === 17` and columns via `PRAGMA table_info`); CHECK rejects `origin_agent='gemini'`; `insertMemory({originAgent:'codex'})` persists; `ccmem export --json --scope global` rows have exactly the 11 keys (spawn `scripts/cli.mjs`); `ccmem show <id>` prints `origin_agent: codex`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; also run `tests/integration/migration-016.test.mjs` and `migration-v1-to-v2.test.mjs`.
- [ ] **Step 5:** Commit `feat(db): record the agent a memory and a session came from`.

### Task 4: Agent-aware hook entry

**Files:**
- Modify: `scripts/hook.mjs` (parse `--agent`), `scripts/handlers/session-start.mjs` (`upsertSessionContext` writes `agent`; `buildReadInstruction(sessionId, agent)`), `scripts/handlers/stop.mjs` (payload `agent`, `session_context.agent`), `scripts/handlers/prompt-submit.mjs` (pass agent through)
- Test: `tests/integration/hook-agent-arg.test.mjs`

**Interfaces:**
- argv: `hook.mjs <mode> [--agent claude-code|codex|omp]`, default `claude-code`; unknown value → treat as `claude-code` and stderr warning. Handlers receive `hookData.ccmem_agent`.
- `buildReadInstruction(sessionId, agent = 'claude-code') -> string`: compaction line per agent — claude-code `/compact`; codex `after context compaction`; omp `after compaction`. No "Claude" wording for codex/omp.
- Stop task payload: `{ session_id, transcript_path, last_message_seq, agent }`.
- Output JSON shape unchanged for all agents (Codex accepts the Claude shape).

- [ ] **Step 1: Failing tests** (spawn `hook.mjs` with stdin JSON, temp data root):
  - `codex session-start returns hookSpecificOutput with the codex instruction` (no `/compact`).
  - `stop with --agent omp enqueues agent omp` (read `tasks.payload`), and `session_context.agent='omp'`.
  - `codex session-start in a non-git dir` (Review Focus 5): cwd = fresh temp dir; exit 0; `.ccmem/` file exists; `session_context.project_key` starts with `path:`.
  - `no --agent keeps claude-code` (regression for the Claude path).
- [ ] **Step 2–4:** run FAIL → implement → PASS; also run `stop-hook-dispatch.test.mjs`, `stop-daemon-flow.test.mjs`.
- [ ] **Step 5:** Commit `feat(hooks): carry the calling agent through every hook`.

### Task 5: Per-agent transcript parsers

**Files:**
- Create: `scripts/lib/transcripts/codex.mjs`, `scripts/lib/transcripts/omp.mjs`
- Modify: `scripts/lib/transcript.mjs` (dispatch, tolerant lines), `scripts/lib/feedback.mjs` (thread `agent`), `scripts/handlers/stop.mjs`, `scripts/daemon/tasks/summarize-pending.mjs` (use `payload.agent ?? ctx.agent ?? 'claude-code'`)
- Create fixtures: `tests/fixtures/transcripts/codex-rollout.jsonl`, `tests/fixtures/transcripts/omp-session.jsonl` (synthetic, hand-written from the formats below; never copy real session content)
- Test: `tests/unit/transcript-parsers.test.mjs`

**Interfaces:**
- `parseTranscript(transcriptPath, agent = 'claude-code') -> Array<{ type: 'user'|'assistant'|'tool', message: { content: string } }>` for codex/omp; claude-code returns raw entries as today. All agents: a line that fails `JSON.parse` is skipped.
- Codex (`{timestamp,type,payload}` lines): `response_item` with `payload.type==='message'`: role `user` → user, `assistant` → assistant, `developer` → dropped; content = join of `input_text`/`output_text` texts. Drop user items whose text starts with `<environment_context>`, `<user_instructions>`, `# AGENTS.md instructions`, or contains `## ccmem context`. `function_call`/`custom_tool_call` → `{type:'tool'}`. Path ending `.zst` → `[]` plus stderr notice.
- OMP: skip `title`/`session` lines; build `id → entry`; walk from the last entry by `parentId` to the root, reverse; `type==='message'`: `message.role` `user`/`assistant` → same; `toolResult` → tool; content string or array of `{type:'text',text}`.
- `inferFromTranscript(db, sessionId, transcriptPath, agent = 'claude-code')`, same extra param for `inferL25FromTranscript`, `recordL25Probe(db, sessionId, transcriptPath, config, agent = 'claude-code')`, `computeSessionStats(path, agent)`, `countTranscriptLines(path, agent)`.

- [ ] **Step 1: Failing tests:** codex fixture → exact expected entries (AGENTS.md and environment items gone, developer gone, tool counted); omp fixture with an abandoned branch → only active-branch messages, in order; `parsers skip malformed lines` (Review Focus 2) for all three agents (half line at EOF); claude-code output unchanged on an existing fixture.
- [ ] **Step 2–4:** FAIL → implement → PASS; rerun `summarize-excerpt-window`, `tier15-feedback`, `v013-l25-probe` tests.
- [ ] **Step 5:** Before committing, sanity-check read-only against one real local file per agent (`ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -1`, newest `~/.omp/agent/sessions/*/*.jsonl`): run a throwaway script printing only entry counts by type to a scratch file. Record counts in the task report, not content.
- [ ] **Step 6:** Commit `feat(transcript): parse Codex rollouts and OMP sessions`.

### Task 6: `ccmem install|uninstall codex`

**Files:**
- Create: `scripts/lib/install/manifest.mjs`, `scripts/lib/install/codex.mjs`
- Modify: `scripts/cli.mjs` (verbs `install`, `uninstall`; help text)
- Test: `tests/integration/install-codex.test.mjs`

**Interfaces:**
- Target: `${CODEX_HOME ?? ~/.codex}/hooks.json` (Claude-format JSON). Never edits `config.toml`.
- Entries: `SessionStart`, `UserPromptSubmit`, `Stop`, each `{ hooks: [{ type: 'command', command: '<execPath> --no-warnings --experimental-sqlite <repo>/scripts/hook.mjs <mode> --agent codex', timeout: 5 }] }` with `<execPath>` = `process.execPath` at install time.
- Manifest: `<dataRoot>/installs/codex.json` `{ target, createdFile: boolean, backup: string|null, entries: [...] , installedAt }`.
- `installCodex({ codexHome, dataRoot, repoRoot, execPath }) -> { changed: boolean, diff: string, backup: string|null }`; `uninstallCodex({ codexHome, dataRoot }) -> { changed, restored: boolean }`.
- Prints after install: `Codex hooks run only after you trust them: open codex and run /hooks to approve the three ccmem hooks.` Never writes `trusted_hash`, never `--dangerously-bypass-hook-trust`.

- [ ] **Step 1: Failing tests** (temp `CODEX_HOME`):
  - fresh install creates `hooks.json` mode 0600 with three ccmem entries; second run `changed:false`.
  - `install keeps foreign hooks.json entries` (Review Focus 1): pre-existing file with a foreign `Stop` hook → both present; backup file exists with original bytes.
  - `install refuses when config.toml has [hooks]`: exit non-zero, no file written, message names the conflict.
  - uninstall after fresh install deletes the file; uninstall after merge restores original bytes exactly; uninstall without manifest → `changed:false`.
  - `config.toml` bytes unchanged throughout.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(install): install and uninstall the Codex hooks reversibly`.

### Task 7: OMP extension and `ccmem install|uninstall omp`

**Files:**
- Create: `integrations/omp/ccmem-extension.ts`, `scripts/lib/install/omp.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/unit/omp-extension.test.mjs` (imports the `.ts` under node 24), `tests/integration/install-omp.test.mjs`

**Interfaces:**
- `export function createCcmemExtension(opts: { node: string; hookScript: string; timeoutMs?: number; spawnImpl?: typeof spawn }): (pi: ExtensionAPI) => void`. Handlers:
  - `session_start` → run `session-start` with `{session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, transcript_path: ctx.sessionManager.getSessionFile()}`; if `additionalContext` non-empty, `pi.sendMessage({ customType: 'ccmem', content: additionalContext, display: false }, { deliverAs: 'nextTurn' })` once per session.
  - `before_agent_start` → run `prompt-submit` with `{..., prompt: event.prompt}`; return `undefined` (never touches `systemPrompt`).
  - `session_stop` → run `stop` with `transcript_path: event.session_file`, `session_id: event.session_id`; return `undefined`.
  - Skip all when `ctx.agent?.kind === 'sub'`, `ctx.mode === 'print'`, or `process.env.CCMEM_INTERNAL === '1'`.
  - Each run: spawn `node --no-warnings --experimental-sqlite hookScript <mode> --agent omp`, stdin JSON, kill after `timeoutMs` (default 5000); any error/timeout → resolve empty.
  - Confirm the exact `ExtensionAPI`, `sendMessage` payload fields and event names against the installed OMP 18.10.1 (`omp` package under the nvm/global install, read-only) before finalizing; the source checkout is 18.11.2.
- Loader written by install: `${CCMEM_OMP_AGENT_DIR ?? ~/.omp/agent}/extensions/ccmem.ts` containing `import { createCcmemExtension } from '<repo>/integrations/omp/ccmem-extension.ts'; export default createCcmemExtension({ node: '<execPath>', hookScript: '<repo>/scripts/hook.mjs' });`. Manifest `<dataRoot>/installs/omp.json`. Existing different `ccmem.ts` → back up, then replace. Uninstall removes or restores.

- [ ] **Step 1: Failing tests:** with a fake `pi` (records `on` handlers and `sendMessage` calls) and a fake `spawnImpl`: session_start sends one message with the instruction and only once; before_agent_start returns undefined and spawned `prompt-submit`; sub-agent ctx → no spawn; `extension swallows hook failure and timeout` (Review Focus 3): spawn emitting `error` and one that never exits → handler resolves within `timeoutMs + 200` ms, no throw. Install/uninstall tests mirror Task 6 (fresh, idempotent, backup+restore, modes).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(omp): add the OMP extension and its reversible installer`.

### Task 8: Backend seam behind `callClaudeP`

**Files:**
- Create: `scripts/daemon/backends/claude.mjs` (move the argv/usage logic out of `claude-p.mjs`), `scripts/daemon/backends/codex.mjs`, `scripts/daemon/backends/omp.mjs`
- Modify: `scripts/daemon/claude-p.mjs` (dispatch; keep spawn/timeout/telemetry/queue code shared), `scripts/lib/config.mjs` + `config.default.json` (`llm.backend`, `llm.backend_order`, `llm.models`, `llm.commands`), `scripts/daemon/tasks/summarize-pending.mjs:71` (agent-neutral wording), `scripts/lib/llm-parse.mjs` (unwrap stays generic)
- Test: `tests/integration/llm-backends.test.mjs` (fake binaries via `llm.commands`, like existing `CCMEM_CLAUDE_P_COMMAND` tests)

**Interfaces:**
- Backend module: `{ id, buildInvocation(prompt, { jsonSchema, taskType, model, command, workDir }) -> { command, args, env, stdin, outputFile? }, readResult({ stdout, outputFileText }) -> string, extractUsage({ stdout }) -> { input_tokens, output_tokens, total_cost_usd }, classifyExhaustion({ stderr, stdout, exitCode }) -> { exhausted: boolean, resetAt: number|null } }`.
- `claude`: existing argv exactly (env overrides `CCMEM_CLAUDE_P_COMMAND`/`CCMEM_CLAUDE_P_ARGS_JSON` still win); exhaustion = existing 429 regex.
- `codex`: `codex exec --ephemeral -s read-only --skip-git-repo-check -c features.hooks=false --json -o <workDir>/last.txt [-m <model>] [--output-schema <workDir>/schema.json] -`; result = `last.txt`; usage from the last JSONL event carrying `usage` (`input_tokens`/`output_tokens`, else null), cost null; exhaustion when text matches `/usage limit|try again at/i`, `resetAt` parsed from `try again at <date>` (null if unparseable).
- `omp`: `omp -p --no-session --no-tools --no-extensions --no-skills --no-rules --no-title --mode json [--model <model>]`, stdin prompt; schema goes into the prompt text ("Return JSON matching this schema: …"); result = last assistant text from the `message_end` event; usage from that event's `usage` if present else null; exhaustion `/429|rate limit|quota|insufficient/i`.
- Every child: env `CCMEM_INTERNAL=1` (plus existing blacklisted `CLAUDE_CODE_SESSION_ID` for claude); cwd = `workDir` = fresh `mkdtemp` under the data root's `tmp/`, removed after the call.
- `callClaudeP(prompt, opts)` signature unchanged; picks the backend via Task 9's `resolveActiveBackend(db, config)`; Task 8 alone reads `config.llm.backend ?? 'claude'`.
- Cost telemetry row gains `backend`.

- [ ] **Step 1: Failing tests:** `codex and omp invocations carry recursion guards` (Review Focus 4): argv contains `features.hooks=false` / `--no-extensions`, env `CCMEM_INTERNAL=1`, cwd not the repo; fake codex writing `last.txt` → `callClaudeP` returns its text; fake omp printing NDJSON → returns assistant text; usage null when absent (never estimated); claude path argv unchanged (existing `v015-*` tests still pass); summarize prompt contains no `Claude Code`.
- [ ] **Step 2–4:** FAIL → implement → PASS; run all `tests/integration/v01*.test.mjs` and `daemon-loop.test.mjs`.
- [ ] **Step 5:** Commit `feat(daemon): run LLM tasks on Claude, Codex or OMP`.

### Task 9: Exhaustion state and approval-gated failover

**Files:**
- Create: `scripts/daemon/backend-state.mjs`, `scripts/lib/admin/llm.mjs`
- Modify: `scripts/daemon/claude-p.mjs`, `scripts/cli.mjs` (`admin llm`), `scripts/handlers/session-start.mjs` (notice line in the context file), `scripts/lib/admin/daemon.mjs` status output
- Test: `tests/integration/llm-failover.test.mjs`

**Interfaces:**
- `resolveActiveBackend(db, config, now = Date.now()) -> string`: preferred = `config.llm.backend ?? 'claude'`; if preferred not exhausted at `now` → preferred (no approval; clears superseded proposals); else the latest approved, unexhausted proposal's `to_backend`; else preferred (the call then fails fast as exhausted).
- `recordExhaustion(db, backend, { resetAt, error }) `: sets `exhausted_until = resetAt ?? now + 3_600_000`; creates a proposal to the next unexhausted backend in `config.llm.backend_order ?? ['claude','codex','omp']` unless an open one exists; writes audit `llm_backend_exhausted`.
- An exhausted call throws with `error.retryAfter = max(60_000, exhausted_until - now)` so `scripts/daemon/loop.mjs:286-297` keeps the task queued (no busy loop).
- CLI: `ccmem admin llm status` (backend, order, exhaustion, open proposal), `ccmem admin llm use <claude|codex|omp>` (sets `llm.backend` in config with `.bak.<epoch>` backup), `ccmem admin llm order <a,b,c>`, `ccmem admin llm approve` (approves the open proposal; audit `llm_backend_switch {from,to,reason}`), `ccmem admin llm reject`.
- Session start: when an open proposal exists, the context file's first line is `ccmem: <from> quota exhausted until <ISO>; run \`ccmem admin llm approve\` to switch background work to <to>.`

- [ ] **Step 1: Failing tests** (fake clock via `now` param, fake backends): exhaustion → task stays `queued` with `scheduled_for ≥ now+60s`, proposal open, backend unchanged; `approve` → next call uses `codex`, audit row from/to/reason; after `exhausted_until` passes → back to `claude` without approval; all exhausted → no proposal target, task stays queued; proposal notice appears in the context file; `admin llm use codex` backs up config.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(daemon): ask before failing over to another LLM backend`.

### Task 10: Daemon install checks for configured backends

**Files:**
- Modify: `scripts/lib/admin/daemon.mjs:70-83, 280-316, 520-540` (resolve every backend in `{llm.backend} ∪ llm.backend_order` into the plist PATH; capability probe per backend: `claude -p --help` contains `--json-schema` (existing), `codex exec --help` contains `--ephemeral`, `omp --help` contains `--no-extensions`); `scripts/lib/admin/plist-drift.mjs` if PATH composition changes
- Test: extend `tests/integration/admin-daemon-command.test.mjs` (approved rewrite of PATH expectations)

- [ ] **Step 1:** Failing tests: install with fake `codex` lacking `--ephemeral` → install reports `capability check failed` naming codex; with all fakes good → plist PATH contains each binary's dir; missing optional backend (not in order) → not required.
- [ ] **Step 2–4:** FAIL → implement → PASS; run `plist-drift.test.mjs`.
- [ ] **Step 5:** Commit `feat(daemon): check every configured LLM backend at install`.

### Task 11: Docs and registration of out-of-repo writes

**Files:**
- Modify: `README.md` (Codex/OMP install, `/hooks` approval, `admin llm`, uninstall), `docs/ccmem-v0.15-spec.md` only if it exists (else none), `CLAUDE.md` Rule 13 list of out-of-repo paths: `~/.codex/hooks.json`, `~/.omp/agent/extensions/ccmem.ts`, `<dataRoot>/installs/*.json` (trigger, residue on failure)
- [ ] **Step 1:** Write; **Step 2:** full suite `npm test` → record pass/fail counts from the run output file; **Step 3:** Commit `docs: document Codex and OMP support`.

### Task 12: Acceptance

- [ ] **Step 1 (free):** full suite on the branch tip, output redirected to a file and read back whole; plus a scratch end-to-end with temp `CODEX_HOME`/`CCMEM_OMP_AGENT_DIR`/data root: `ccmem install codex`, feed `hook.mjs` the Codex payload shapes, `ccmem uninstall codex` restores bytes; same for omp.
- [ ] **Step 2 (paid — ask the human; not run automatically):**
  - quality: `scripts/acceptance/compare-summarizers.mjs <transcript...>` (create in this task; runs each transcript through each backend against a temp data root, writes a side-by-side markdown with the five criteria as columns for the human to judge);
  - injection read: one real Codex and one real OMP session after install; transcript shows a read of `.ccmem/<session>.md`;
  - cache: tool-reported cache numbers for the same short scripted session with and without ccmem.
- [ ] **Step 3:** Write the results and the open paid items into `docs/handoff/handoff.md` (Chinese).
