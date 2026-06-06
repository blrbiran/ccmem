# Cerebrum

> OpenWolf's long-term learning memory.
> Compacted on 2026-06-04; full pre-compaction snapshot: `cerebrum.archive.2026-06-04.md`
> Last updated: 2026-06-04

## User Preferences

- **Conversation language**: Chinese (中文)
- **Documentation language** (`docs/**`): Chinese (中文, prose 与注释)
- **Code, comments, and git commit messages**: English
- **User-facing message strings in code output**: English, including stderr/stdout notices, prompts, thrown errors, logs, and audit-facing reason/action fields.
- **Workflow**: docs-first then PoC. When the user says “先 X 再 Y”, execute sequentially rather than parallelizing.
- **Implementation workflow**: default to TDD. Write or adjust a failing test first, then implement the minimal code to make it pass, then refactor if needed.
- **Housekeeping**: when slimming `.wolf` operational files, prefer archival compaction over deletion, and keep a short recent raw tail in `memory.md` for active debugging context.

## Key Learnings

- **Project**: ccmem — Claude Code 跨会话语义记忆插件。
- **Hook / daemon boundary**: hooks are limited to synchronous SQLite I/O and JSON output. Any LLM call, spawn, or network work belongs in the daemon.
- **LLM-visible command output**: Claude Code slash-command stdout and stderr both enter model context. Metadata should go to audit/state, not raw terminal output.
- **Plugin runtime split**: slash commands do not inherit `CLAUDE_PLUGIN_ROOT`; slash commands should invoke the PATH `ccmem` CLI, while hooks should use `${CLAUDE_PLUGIN_ROOT}`.
- **Local verification runtime**: this repo's sqlite-dependent tests and scripts should use `/usr/local/bin/node`, not the default PATH `node`.
- **Schema / code consistency**: every table or column referenced by code must exist explicitly in migrations/schema docs; schema drift is a recurring failure mode.
- **Cross-process test state**: library calls and spawned CLI tests must share the same `CCMEM_DATA_ROOT`, or they will appear to read different databases.
- **Lease semantics**: daily and weekly leases are local-calendar concepts. Use shared helpers for lease keys and carry `lease_key` through task payloads instead of recomputing from completion time.
- **Retry coverage standard**: retry tests are only meaningful when they prove the full rerun closure — queued retry, rerun, user-visible/audit side effect, and lease completion where applicable.
- **`summarize_pending` supersede rule**: delayed retries must still yield to a newer `last_message_seq` before rerun, both in daemon-worker tests and stop→daemon end-to-end tests.
- **Admin-cron boundary**: unsupported tasks must fail at the CLI boundary with consistent exit semantics instead of enqueueing impossible payloads.
- **Task-layer verification**: cron/admin surface coverage is not enough for complex tasks; task behavior itself needs direct regression coverage (for example `security_audit`).
- **Packaging invariants**: user-facing launcher, hook, and daemon entrypoints must stay aligned on real-path resolution, sqlite flags, warning behavior, and bridge-enabling environment.
- **Bridge gating semantics**: task-layer bridge execution should not depend on `CCMEM_ENABLE_REAL_CLAUDE_P`. If a real bridge command/args are configured, tasks should use them; stub behavior should remain only as an explicit no-bridge fallback in test mode.
- **Structured bridge output**: if a daemon task parses `claude -p` output as JSON, the bridge call must enforce `--output-format json --json-schema`; otherwise the task can complete successfully while prose output parses to zero inserted rows.
- **Claude JSON envelopes**: `claude -p --output-format json` may wrap the real structured payload inside a top-level `{ type: 'result', result: '...' }` envelope. `parseLlmJson()` must unwrap that envelope before looking for arrays or `{ synthesized }`, or summarize/weekly tasks can still complete with zero inserted memories.
- **Daemon install strategy**: do not hard-code a Claude Code minimum version in daemon install logic. Capture the `claude` binary resolved from the install shell PATH, then capability-probe `claude -p --help` for `--json-schema`; block install if the captured binary lacks that flag.
- **Long-session summarize extraction**: `summarize_pending` must prioritize the transcript tail, not the head. Once schema output is fixed, long sessions can still complete with zero inserts if the excerpt truncation only preserves the beginning of the conversation.
- **Launchd restart semantics**: after `bootout`, a launchd job may be unloaded; `kickstart` alone is not a reliable restart path. Launchd `start`/`restart` flows must recover by `bootstrap`ing the plist when `kickstart` cannot revive the service.
- **External install docs**: do not invent unverified official marketplace slugs; point users to the exact plugin entry shown by Claude Code.
- **Real transcript shape**: Claude transcripts include many non-message meta rows, and `message.content` may be either an array of parts or a plain string. Shared transcript helpers must tolerate both shapes before task or feedback code reads text.
- **Hook output contract**: `hookSpecificOutput.additionalContext` is only for SessionStart/UserPromptSubmit-style injection. Stop hooks should return an empty JSON object instead of emitting `hookSpecificOutput` with `hookEventName: "Stop"`.
- **Timeout test fixtures**: timeout regressions must use `CCMEM_CONFIG_PATH` / `claude_p_timeout_per_task` once task-specific config takes precedence; the legacy `CCMEM_CLAUDE_P_TIMEOUT_MS` env no longer reliably drives `summarize_pending` timeout paths.
- **Full-suite closure discipline**: targeted green runs can still miss stale migration/version assertions in older suites. When schema advances, re-check legacy migration/integration tests for hard-coded version numbers and platform-specific temp-path assumptions before claiming completion.

## Do-Not-Repeat

- Do not answer spec, packaging, or marketplace details from memory alone; verify against current files or current UI behavior.
- Do not derive daily lease keys from UTC `toISOString().slice(0, 10)` or recompute daily/weekly lease keys from completion-time `new Date()`.
- Do not let scheduler, worker, manual entrypoints, and tests derive lease windows differently; use shared helpers.
- Do not rely on empty-stderr assertions in hook/daemon suites; Node/runtime warnings can be present without indicating a product failure.
- Do not stop retry regressions at “queued retry exists”; lock the rerun, side effects, and lease completion as a closure.
- Do not let `summarize_pending` queued retries bypass supersede semantics when a newer transcript seq arrives.
- Do not resolve `bin/ccmem` relative script paths from the symlink location; resolve the real launcher path first.

## Decision Log

### Runtime architecture

- Hooks stay synchronous and lightweight; daemon owns async/LLM work.
- The daemon-optional model remains: Tier 1 works without daemon, Tier 1.5 runs opportunistically, Tier 2 needs daemon.
- Runtime flags and warning policy are entrypoint invariants, not launcher-only details.

### Command and UX

- LLM-visible output must stay LLM-safe because stdout and stderr both enter context.
- Command friction is based on authorship and intent, not just technical capability.
- Unsupported CLI surfaces should fail explicitly with stable exit codes instead of leaking raw internal exceptions.

### Memory lifecycle

- Trust recovery remains user-driven rather than forced by periodic exposure.
- The highest-value synthesis output is a reusable rule/principle, not just a chronological summary.
- Operational memory files may be periodically compacted, but full snapshots should be archived before slimming.

### Packaging

- Slash commands run via PATH `ccmem`; hooks run via `${CLAUDE_PLUGIN_ROOT}`.
- Launcher behavior must be correct for both in-repo execution and symlinked installation paths.
