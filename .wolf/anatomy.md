# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-30T02:30:55.513Z
> Files: 77 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `CLAUDE.md` — OpenWolf (~57 tok)
- `package.json` — Node.js package manifest (~99 tok)

## .claude-plugin/

- `plugin.json` (~63 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## bin/

- `ccmem` (~30 tok)

## commands/

- `audit.md` (~36 tok)
- `forget.md` (~39 tok)
- `list.md` — Declares rule (~56 tok)
- `mode.md` (~43 tok)
- `pin.md` (~37 tok)
- `save.md` — Declares rule (~52 tok)
- `show.md` (~37 tok)

## docs/

- `ccmem-design.md` — Claude Code 记忆插件设计方案 v3.0 (~37417 tok)
- `claude-code-behavior-uncertainties.md` — Claude Code 行为验证清单 (~2337 tok)
- `design-deep-analysis.md` — ccmem 设计深入分析 (~5248 tok)
- `design-motivation.md` — 设计初衷：为什么要做这个记忆系统 (~523 tok)
- `hermes-mem.md` (~319 tok)
- `research.md` — Agent 记忆系统：应用层解决方案研究 (~4027 tok)

## docs/superpowers/plans/

- `2026-05-30-ccmem-v01-v02-implementation.md` — ccmem v0.1 + v0.2 Implementation Plan (~18880 tok)

## docs/superpowers/specs/

- `2026-05-30-ccmem-v01-v02-implementation-design.md` — ccmem v0.1 + v0.2 implementation design (~2859 tok)

## hooks/

- `hooks.json` (~249 tok)

## scripts/

- `cli.mjs` — Declares db (~325 tok)
- `hook.mjs` — Declares T_ENTRY (~327 tok)

## scripts/daemon/

- `lock.mjs` — Exports acquireDaemonLock, refreshHeartbeat, isDaemonAlive (~332 tok)
- `loop.mjs` — Exports mainLoop (~138 tok)
- `main.mjs` — Declares db (~114 tok)
- `wake.mjs` — Exports touchWakeFile, wakeRecently (~135 tok)

## scripts/handlers/

- `prompt-submit.mjs` — Exports sanitizeFtsQuery, renderRetrievedBlock, handlePromptSubmit (~434 tok)
- `session-start.mjs` — Exports handleSessionStart (~198 tok)
- `stop.mjs` — Exports handleStop (~397 tok)

## scripts/lib/

- `config.mjs` — Exports loadConfig (~158 tok)
- `db.mjs` — Exports getDataRoot, getDbPath, getSchemaVersion, runMigration + 2 more (~435 tok)
- `feedback.mjs` — Exports inferPrevTurnOutcome, inferFromTranscript (~469 tok)
- `hook-safety.mjs` — Exports withHookSafety (~329 tok)
- `injection-cache.mjs` — Exports rebuildInjectionCache (~395 tok)
- `metrics.mjs` — Exports recordMetric (~91 tok)
- `mode.mjs` — Exports getMode, setMode (~104 tok)
- `priority.mjs` — Exports recencyFactor, frequencyFactor, computePriority (~232 tok)
- `project-key.mjs` — Exports normalizeRemoteUrl, fallbackProjectKey, resolveProjectKey (~229 tok)
- `recent-injections.mjs` — Exports getNextPromptIdx, writeRecentInjection (~147 tok)
- `render.mjs` — Exports renderStableContext (~172 tok)
- `task-runs.mjs` — Exports RAN_BY, tryClaimLease (~110 tok)
- `threat-scan.mjs` — Exports evaluateTier1 (~118 tok)
- `tier15.mjs` — Exports maybeRunTier15 (~193 tok)
- `transcript.mjs` — Exports parseTranscript, countTranscriptLines, computeSessionStats, extractAssistantText (~224 tok)
- `trust.mjs` — Exports getSourceInitialTrust, adjustTrust (~327 tok)
- `type-heuristic.mjs` — Exports inferType (~117 tok)

## scripts/lib/cmd/

- `audit.mjs` — Exports cmdAuditShow (~32 tok)
- `forget.mjs` — Exports cmdForget (~172 tok)
- `list.mjs` — Exports cmdList (~63 tok)
- `mode.mjs` — Exports cmdMode (~55 tok)
- `pin.mjs` — Exports cmdPin (~120 tok)
- `save.mjs` — Exports cmdSave (~289 tok)
- `show.mjs` — Exports cmdShow (~31 tok)

## scripts/migrations/

- `001_initial.sql` — SQL: tables: schema_meta, schema_migrations, memories, injection_cache (~731 tok)
- `002_v02.sql` — SQL: tables: memory_feedback, recent_injections, daemon_lock, ccmem_blacklisted_sessions (~573 tok)

## tests/integration/

- `audit-command.test.mjs` — Declares db (~255 tok)
- `cli-mode-audit.test.mjs` — Declares dataRoot (~382 tok)
- `daemon-loop.test.mjs` — Declares db (~293 tok)
- `forget-pin-cache.test.mjs` — Declares db (~334 tok)
- `migration-v1-to-v2.test.mjs` — Declares db (~412 tok)
- `mode-command.test.mjs` — Declares db (~238 tok)
- `prompt-submit-retrieval.test.mjs` — Declares db (~274 tok)
- `save-list-session-start.test.mjs` — Declares db (~296 tok)
- `stop-daemon-flow.test.mjs` — Declares db (~242 tok)
- `stop-hook-dispatch.test.mjs` — Declares dataRoot (~438 tok)
- `tier15-feedback.test.mjs` — Declares db (~736 tok)

## tests/unit/

- `db.test.mjs` — Declares db (~256 tok)
- `plugin-manifest.test.mjs` — Declares readManifest (~198 tok)
- `priority.test.mjs` — Declares score (~123 tok)
- `project-key.test.mjs` (~174 tok)
- `render.test.mjs` — Declares text (~154 tok)
- `task-runs.test.mjs` (~78 tok)
- `threat-scan.test.mjs` — Declares result (~98 tok)
- `trust.test.mjs` (~77 tok)
- `type-heuristic.test.mjs` (~121 tok)
