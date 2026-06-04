# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-04T00:02:49.843Z
> Files: 105 tracked | Anatomy hits: 0 | Misses: 0

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

- `admin.md` (~70 tok)
- `audit.md` (~36 tok)
- `forget.md` (~39 tok)
- `list.md` — Declares rule (~56 tok)
- `mode.md` (~43 tok)
- `pin.md` (~37 tok)
- `promote.md` (~44 tok)
- `resurrect.md` (~49 tok)
- `save.md` — Declares rule (~52 tok)
- `show.md` (~37 tok)
- `stats.md` (~42 tok)

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

- `cli.mjs` — db: getOptionValue, createStdinLineReader, formatAgeDays (~4600 tok)
- `hook.mjs` — T_ENTRY: writeHookOutput, isBlacklistedSession (~595 tok)

## scripts/daemon/

- `claude-p.mjs` — Exports callClaudeP (~1121 tok)
- `dispatch.mjs` — Exports dispatchTask (~194 tok)
- `lock.mjs` — Exports acquireDaemonLock, refreshHeartbeat, releaseDaemonLock, isDaemonAlive (~371 tok)
- `loop.mjs` — Exports weeklyLeaseKey, securityAuditLeaseKey, scheduleCronTasks, runTask, mainLoop (~1570 tok)
- `main.mjs` — Declares db (~160 tok)
- `wake.mjs` — Exports touchWakeFile, wakeRecently (~135 tok)

## scripts/daemon/tasks/

- `daily-maintenance.mjs` — Exports runDailyMaintenance (~562 tok)
- `security-audit.mjs` — Exports selectAuditCandidates, runSecurityAudit (~2167 tok)
- `summarize-pending.mjs` — Exports runSummarizePending (~2043 tok)
- `weekly-synthesis.mjs` — Exports runWeeklySynthesis (~433 tok)

## scripts/handlers/

- `prompt-submit.mjs` — Exports sanitizeFtsQuery, renderRetrievedBlock, handlePromptSubmit (~880 tok)
- `session-start.mjs` — Exports handleSessionStart (~577 tok)
- `stop.mjs` — Exports handleStop (~538 tok)

## scripts/lib/

- `audit.mjs` — Exports writeAudit, writeAuditMany (~390 tok)
- `config.mjs` — Exports loadConfig (~605 tok)
- `db.mjs` — Exports getDataRoot, getDbPath, getSchemaVersion, runMigration + 2 more (~435 tok)
- `feedback.mjs` — NEGATIVE_FEEDBACK: getLastAssistantText, parseJsonArray, getLastUnknownFeedback + 76 more (~8407 tok)
- `hook-safety.mjs` — Exports withHookSafety (~329 tok)
- `injection-cache.mjs` — Exports rebuildInjectionCache (~424 tok)
- `llm-parse.mjs` — Exports parseLlmJson (~262 tok)
- `metrics.mjs` — Exports recordMetric (~91 tok)
- `mode.mjs` — Exports getMode, setMode (~104 tok)
- `priority.mjs` — Exports recencyFactor, frequencyFactor, computePriority (~232 tok)
- `project-key.mjs` — Exports normalizeRemoteUrl, fallbackProjectKey, resolveProjectKey (~229 tok)
- `recent-injections.mjs` — Exports getNextPromptIdx, writeRecentInjection (~147 tok)
- `render.mjs` — Exports renderStableContext (~172 tok)
- `task-runs.mjs` — Exports RAN_BY, tryClaimLease, markLeaseComplete (~173 tok)
- `threat-scan.mjs` — Exports evaluateTier1, evaluateTier2, evaluateTier3 (~583 tok)
- `tier15.mjs` — Exports runSessionStartMiniPrelude, maybeRunTier15 (~1143 tok)
- `transcript.mjs` — Exports parseTranscript, countTranscriptLines, computeSessionStats, extractAssistantText (~224 tok)
- `trust.mjs` — Exports getSourceInitialTrust, adjustTrust (~327 tok)
- `type-heuristic.mjs` — Exports inferType (~117 tok)

## scripts/lib/admin/

- `cron.mjs` — Exports cmdAdminCron (~1515 tok)
- `daemon.mjs` — Exports renderPlist, cmdAdminDaemon (~2180 tok)
- `diagnose.mjs` — Exports cmdAdminDiagnose (~1553 tok)

## scripts/lib/cmd/

- `audit.mjs` — Exports cmdAuditShow (~32 tok)
- `forget.mjs` — Exports cmdForget (~197 tok)
- `list.mjs` — Exports cmdList (~288 tok)
- `mode.mjs` — Exports cmdMode (~55 tok)
- `pin.mjs` — Exports cmdPin (~145 tok)
- `promote.mjs` — Exports cmdPromote (~562 tok)
- `resurrect.mjs` — Exports cmdResurrect (~2290 tok)
- `save.mjs` — Exports cmdSave (~755 tok)
- `show.mjs` — Exports cmdShow (~56 tok)
- `stats.mjs` — Exports cmdStats (~1140 tok)

## scripts/lib/llm-prompts/

- `security-audit.mjs` — Exports parseSecurityAuditJson, buildSecurityAuditPrompt (~849 tok)

## scripts/migrations/

- `001_initial.sql` — SQL: tables: schema_meta, schema_migrations, memories, injection_cache (~731 tok)
- `002_v02.sql` — SQL: tables: memory_feedback, recent_injections, daemon_lock, ccmem_blacklisted_sessions (~573 tok)
- `003_v03.sql` — SQL: tables: cross_scope_alerts (~304 tok)

## tests/integration/

- `admin-cron-command.test.mjs` — dataRoot: resetCronTables, seedCronFixture, seedCronIssuesFixture, seedHealthyCronFixture (~13206 tok)
- `admin-daemon-command.test.mjs` — dataRoot: resetAdminTables, seedAliveDaemon, sleep + 5 more (~2448 tok)
- `admin-diagnose-command.test.mjs` — dataRoot: resetDiagnoseTables, seedSessionDiagnostics, seedAliveDaemon, seedSecurityDiagnostics (~3334 tok)
- `audit-command.test.mjs` — Declares db (~255 tok)
- `cli-mode-audit.test.mjs` — Declares dataRoot (~382 tok)
- `daemon-loop.test.mjs` — resetRuntimeTables: setClaudeBridgeEnv, setTaskTimeoutConfig (~49723 tok)
- `forget-pin-cache.test.mjs` — resetCommandTables: seedStaleMaintenanceState, assertPreludeCleanup, insertMemory + 13 more (~3197 tok)
- `migration-v1-to-v2.test.mjs` — Declares db (~442 tok)
- `mode-command.test.mjs` — Declares db (~238 tok)
- `promote-command.test.mjs` — dataRoot: resetPromoteTables, seedStaleMaintenanceState, assertPreludeCleanup, insertPromoteMemory (~2394 tok)
- `prompt-submit-retrieval.test.mjs` — API routes: GET (3 endpoints) (~3306 tok)
- `resurrect-command.test.mjs` — dataRoot: resetResurrectTables, seedGreyZoneMemories, seedQuarantinedMemory, seedCrossScopeAlert (~2611 tok)
- `save-list-session-start.test.mjs` — NODE: resetSaveListTables, seedQuarantinedListFixture (~4193 tok)
- `security-audit-task.test.mjs` — dataRoot: resetSecurityAuditTables, saveProjectMemory, saveGlobalMemory, markPoolCCandidate (~2250 tok)
- `stats-command.test.mjs` — dataRoot: resetStatsTables, insertMemory, seedStatsFixture, seedSecurityStatsFixture (~2406 tok)
- `stop-daemon-flow.test.mjs` — wakePath: resetStopDaemonState, setClaudeBridgeEnv, clearClaudeBridgeEnv + 99 more; running same-seq bridge dedupe e2e (~24150 tok)
- `stop-hook-dispatch.test.mjs` — dataRoot: openStopDb, resetStopState, setStoredMode + 4 more (~4954 tok)
- `tier15-feedback.test.mjs` — Declares db (~1780 tok)

## tests/unit/

- `db.test.mjs` — Declares db (~256 tok)
- `llm-parse.test.mjs` — Declares raw (~576 tok)
- `plugin-manifest.test.mjs` — Declares readManifest (~198 tok)
- `priority.test.mjs` — Declares score (~123 tok)
- `project-key.test.mjs` (~174 tok)
- `render.test.mjs` — Declares text (~154 tok)
- `task-runs.test.mjs` — Declares db (~714 tok)
- `threat-scan.test.mjs` — Declares result (~98 tok)
- `trust.test.mjs` (~77 tok)
- `type-heuristic.test.mjs` (~121 tok)
