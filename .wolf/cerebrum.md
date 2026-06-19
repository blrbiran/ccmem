# Cerebrum

> OpenWolf's long-term learning memory.
> Compacted on 2026-06-19; archive snapshots: `cerebrum.archive.2026-06-04.md`, `cerebrum.archive.2026-06-19.md`
> Last updated: 2026-06-19

## User Preferences

- **Conversation language**: Chinese (中文)
- **Documentation language** (`docs/**`): Chinese (中文, prose 与注释)
- **Code, comments, git commit messages, and user-facing runtime strings**: English
- **Workflow**: docs-first then PoC. When the user says “先 X 再 Y”, execute sequentially rather than parallelizing.
- **Implementation workflow**: default to TDD. Write or adjust a failing test first, then implement the minimal code to make it pass.
- **Housekeeping**: when slimming `.wolf` operational files, prefer archival compaction over deletion and keep only a short recent raw tail in `memory.md`.

## Durable Constraints

- **Hook / daemon boundary**: hooks stay synchronous and lightweight; daemon owns async, LLM, spawn, and network work.
- **LLM-visible terminal output**: Claude Code slash-command stdout and stderr both enter model context; metadata belongs in audit/state, not raw terminal output.
- **Plugin runtime split**: slash commands should invoke PATH `ccmem`; hooks should use `${CLAUDE_PLUGIN_ROOT}`.
- **Runtime capability over path heuristics**: FTS5 availability is a runtime capability, not a binary-path heuristic.
- **Entrypoint invariants**: launcher, hook, and daemon paths must stay aligned on real-path resolution, sqlite/runtime flags, warning behavior, and bridge command wiring.
- **Lease semantics**: daily and weekly leases are local-calendar concepts; use shared helpers and carry `lease_key` through task payloads.
- **Bridge selection**: task-layer real-bridge execution should depend on configured command/args, not on a release-only env gate.
- **Runtime config precedence**: `config_kv` toggles must take precedence over static config defaults when both exist.
- **External comparisons**: trust checked source code over README or marketplace copy when comparing reference projects.

## Durable Lessons

- **Retry coverage means closure**: prove queueing, rerun-to-success, user-visible side effects, and lease completion instead of stopping at “retry was scheduled”.
- **`summarize_pending` supersede rule**: delayed retries must still yield to newer `last_message_seq` state before rerun.
- **Structured bridge contract**: tasks that parse Claude output as JSON must enforce `--output-format json --json-schema` and tolerate Claude's `{ type: 'result', result: '...' }` envelope.
- **Transcript parsing**: shared helpers must tolerate both array and string `message.content` shapes; Stop hooks should return `{}` rather than `hookSpecificOutput` payloads.
- **Long-session summarization**: summarize from the transcript tail, then refine or truncate after parsing rather than during parse.
- **Full-suite closure discipline**: schema advances, config-gate changes, and large same-file refactors require broad suite reruns because stale fixtures and version assertions hide outside targeted slices.
- **Test/runtime alignment**: this repo's sqlite-dependent verification should use `/usr/local/bin/node`; broad `npm test` coverage must match that runtime.
- **Context-history surface**: file-based injection reviewability depends on both `context_snapshots` and `context_write_log`, and cleanup must avoid clobbering active parallel sessions.

## Do-Not-Repeat

- Do not answer spec, packaging, or marketplace details from memory alone; verify against current files or current UI behavior.
- Do not treat `/usr/local/bin/node` path alignment as the fix for sqlite capability gaps; capability-probe the active runtime.
- Do not derive lease keys from UTC date slices or recompute them from completion-time `new Date()`.
- Do not rely on empty-stderr assertions in hook or daemon suites.
- Do not hard-code inserted memory ids or project keys in integration fixtures.
- After large same-file helper extraction or replacement, grep for duplicate declarations before broad test runs.

## Long-Lived Decisions

- **Runtime architecture**: the daemon-optional model remains — Tier 1 works without daemon, Tier 1.5 runs opportunistically, Tier 2 needs daemon.
- **Retrieval architecture**: FTS-backed retrieval is an optimization, not a schema requirement.
- **Operational file policy**: `.wolf` files may be compacted periodically, but only after creating dated archive snapshots.
