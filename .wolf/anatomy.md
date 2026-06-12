# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-12T16:28:41.087Z
> Files: 175 tracked | Anatomy hits: 0 | Misses: 0

## ../../../.claude/projects/-Users-biran-code-skills-ccmem/memory/

- `feedback-tdd-workflow.md` (~157 tok)
- `MEMORY.md` (~35 tok)

## ./

- `.gitignore` — Git ignore rules (~36 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `config.default.json` (~1174 tok)
- `package.json` — Node.js package manifest (~132 tok)
- `README.md` — Project documentation (~757 tok)

## .claude-plugin/

- `plugin.json` (~63 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .wolf/

- `anatomy.md` — Project file index with token estimates (~350 tok)
- `buglog.archive.2026-06-04.json` — Full pre-compaction bug history snapshot (~18000 tok)
- `buglog.json` — Compacted bug pattern log; verbose history moved to dated archive snapshot (~2600 tok)
- `cerebrum.archive.2026-06-04.md` — Full pre-compaction cerebrum snapshot (~7000 tok)
- `cerebrum.md` — Long-term user preferences, constraints, and durable lessons (~1400 tok)
- `config.json` — OpenWolf local configuration (~220 tok)
- `cron-manifest.json` — Cron task metadata snapshot (~350 tok)
- `cron-state.json` — Cron runtime state snapshot (~60 tok)
- `daemon.log` — OpenWolf daemon log output (~1800 tok)
- `designqc-report.json` — Most recent design QC summary (~40 tok)
- `identity.md` — Project identity note for OpenWolf (~120 tok)
- `memory.archive.2026-06-04.md` — Full pre-compaction memory log snapshot (~14000 tok)
- `memory.md` — Compacted operational history with recent raw session tail (~2600 tok)
- `OPENWOLF.md` — OpenWolf operating protocol and maintenance rules (~1200 tok)
- `reframe-frameworks.md` — UI framework selection matrix and migration prompts (~3500 tok)
- `suggestions.json` — Lightweight suggestion state (~30 tok)
- `token-ledger.json` — Token accounting ledger for OpenWolf activity (~5000 tok)

## .wolf/hooks/

- `_session.json` — OpenWolf hook session state (~80 tok)
- `package.json` — Hook package manifest (~80 tok)
- `post-read.js` — Post-read hook (~180 tok)
- `post-write.js` — Post-write hook (~180 tok)
- `pre-read.js` — Pre-read hook (~180 tok)
- `pre-write.js` — Pre-write hook (~180 tok)
- `session-start.js` — Session-start hook (~220 tok)
- `shared.js` — Shared OpenWolf hook utilities (~260 tok)
- `stop.js` — Stop hook (~220 tok)

## bin/

- `ccmem` (~105 tok)

## commands/

- `admin.md` (~149 tok)
- `audit.md` (~36 tok)
- `forget.md` (~39 tok)
- `list.md` — Declares rule (~56 tok)
- `mode.md` (~43 tok)
- `pin.md` (~37 tok)
- `promote.md` (~44 tok)
- `resurrect.md` (~68 tok)
- `save.md` — Declares rule (~52 tok)
- `show.md` (~37 tok)
- `stats.md` (~46 tok)

## docs/

- `ccmem-design.md` — Claude Code 记忆插件设计方案 v3.0 (~37417 tok)
- `ccmem-v0.4-dogfood.md` — ccmem v0.4 dogfood / 验证清单 (~3731 tok)
- `ccmem-v0.4-spec.md` — ccmem v0.4 实施 spec (~18395 tok)
- `ccmem-v0.5-dogfood.md` — ccmem v0.5 dogfood / 验证清单，含 A4 容器 fallback 验证记录 (~1200 tok)
- `ccmem-v0.5-spec.md` — ccmem v0.5 实施 spec，覆盖 self-restart、diagnose 扩展与 A4 容器 fallback (~15000 tok)
- `ccmem-v0.8-spec.md` — ccmem v0.8 实施 spec (~17341 tok)
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

- `hooks.json` (~261 tok)

## scripts/

- `cli.mjs` — args: getDb, printHelp, getOptionValue + 8 more (~10292 tok)
- `hook.mjs` — T_ENTRY: buildHookOutput, writeHookOutput, isBlacklistedSession (~618 tok)

## scripts/daemon/

- `claude-p.mjs` — Exports callClaudeP with optional structured-output schema args (~1450 tok)
- `dispatch.mjs` — Exports dispatchTask (~366 tok)
- `lock.mjs` — Exports acquireDaemonLock, refreshHeartbeat, releaseDaemonLock, isDaemonAlive (~371 tok)
- `loop.mjs` — Exports parseDailyAt, parseWeeklyAt, weeklyLeaseKey, securityAuditLeaseKey + 5 more (~2489 tok)
- `main.mjs` — semanticRuntimeEnabled: warmSemanticProvider (~771 tok)
- `self-restart.mjs` — Exports getStartupSchemaVersion, writeDaemonStartupState, checkSchemaStaleness, scheduleGracefulRest (~873 tok)
- `wake.mjs` — Exports touchWakeFile, wakeRecently (~135 tok)

## scripts/daemon/tasks/

- `contradiction-audit.mjs` — Exports runContradictionAudit (~1568 tok)
- `daily-maintenance.mjs` — Exports runDailyMaintenance (~1417 tok)
- `monthly-meta-synthesis.mjs` — Exports runMonthlyMetaSynthesis (~1139 tok)
- `revalidation-audit.mjs` — Exports runRevalidationAudit (~108 tok)
- `security-audit.mjs` — Exports selectAuditCandidates, runSecurityAudit (~2174 tok)
- `summarize-pending.mjs` — Exports runSummarizePending (~2400 tok)
- `vec-backfill.mjs` — Exports pendingEmbeddings, runVecBackfill (~623 tok)
- `weekly-synthesis.mjs` — API routes: GET (1 endpoints) (~4616 tok)

## scripts/handlers/

- `prompt-submit.mjs` — Exports sanitizeFtsQuery, renderRetrievedBlock, handlePromptSubmit (~908 tok)
- `session-start.mjs` — Exports handleSessionStart (~577 tok)
- `stop.mjs` — Exports handleStop (~538 tok)

## scripts/lib/

- `audit.mjs` — Exports writeAudit, writeAuditMany (~390 tok)
- `config.mjs` — Exports loadConfig (~1330 tok)
- `db.mjs` — Exports getDataRoot, getDbPath, getSchemaVersion, hasUsableFts (~3941 tok)
- `dedup.mjs` — Exports dedupCheck (~974 tok)
- `feedback.mjs` — NEGATIVE_FEEDBACK: getLastAssistantText, parseJsonArray, getLastUnknownFeedback + 71 more (~9065 tok)
- `hook-safety.mjs` — Exports withHookSafety (~391 tok)
- `injection-cache.mjs` — Exports rebuildInjectionCache (~439 tok)
- `llm-parse.mjs` — Exports parseRawLlmOutput, parseLlmJson (~500 tok)
- `metrics-rollup.mjs` — Exports aggregateHookLatencies, detectLLMDeadLetters, writeMetricsDailyRollup (~2241 tok)
- `metrics.mjs` — Exports recordMetric (~91 tok)
- `mode.mjs` — Exports getMode, setMode (~104 tok)
- `priority.mjs` — Exports recencyFactor, frequencyFactor, computePriority (~232 tok)
- `project-key.mjs` — Exports normalizeRemoteUrl, fallbackProjectKey, resolveProjectKey (~229 tok)
- `quality-gate.mjs` — Exports checkQuality (~208 tok)
- `recent-injections.mjs` — Exports getNextPromptIdx, writeRecentInjection (~147 tok)
- `render.mjs` — Exports renderStableContext (~172 tok)
- `retrieval.mjs` — Exports sanitizeFtsQuery, tokenize, extractShortTokens, jaccardSimilarity + 3 more (~2470 tok)
- `revalidation.mjs` — Exports revalidationAuditCore (~1494 tok)
- `synthesis-quality.mjs` — Exports scoreSynthesisOutput (~240 tok)
- `task-runs.mjs` — Exports RAN_BY, tryClaimLease, markLeaseComplete (~220 tok)
- `threat-scan.mjs` — Exports tier1Scan, secretScan, evaluateTier1, evaluateTier2, evaluateTier3 (~820 tok)
- `tier15.mjs` — Exports runSessionStartMiniPrelude, maybeRunTier15 (~1434 tok)
- `transcript-cleaner.mjs` — Exports cleanTranscript (~556 tok)
- `transcript.mjs` — Exports parseTranscript, extractEntryText, countTranscriptLines, computeSessionStats, extractAssista (~304 tok)
- `trust.mjs` — Exports getSourceInitialTrust, adjustTrust, applyOutcomeToSubset (~467 tok)
- `type-heuristic.mjs` — Exports inferType (~117 tok)

## scripts/lib/admin/

- `alias.mjs` — Exports cmdAdminAlias (~346 tok)
- `cron.mjs` — Exports cmdAdminCron (~2404 tok)
- `daemon.mjs` — Exports renderPlist, maybeRespawnContainerFallback (~5211 tok)
- `diagnose.mjs` — SESSION_LIMIT: firstValue, parseMemIds, parseDetails + 17 more (~8314 tok)
- `semantic.mjs` — Exports cmdAdminSemantic (~1060 tok)

## scripts/lib/cmd/

- `audit.mjs` — Exports cmdAuditShow (~32 tok)
- `export.mjs` — Exports cmdExport (~180 tok)
- `forget.mjs` — Exports cmdForget (~197 tok)
- `import.mjs` — Exports cmdImport (~369 tok)
- `list.mjs` — Exports cmdList (~388 tok)
- `mode.mjs` — Exports cmdMode (~55 tok)
- `pin.mjs` — Exports cmdPin (~145 tok)
- `promote.mjs` — Exports cmdPromote (~562 tok)
- `resurrect.mjs` — clampLimit: normalizeGreyDecision, normalizeAlertDecision, normalizeRevalidationDecision + 8 more (~5082 tok)
- `save.mjs` — Exports insertMemory, cmdSave (~1296 tok)
- `show.mjs` — Exports cmdShow (~56 tok)
- `stats.mjs` — Exports cmdStats (~2057 tok)

## scripts/lib/embedding/

- `cosine.mjs` — Exports cosineSimilarity, vecToBlob, blobToVec (~181 tok)
- `jina.mjs` — Exports jinaEmbedding (~662 tok)
- `openai.mjs` — Exports openaiEmbedding (~669 tok)
- `provider.mjs` — Exports getProvider, _resetProviderCache (~656 tok)
- `transformers-local.mjs` — Exports transformersLocal (~463 tok)

## scripts/lib/llm-prompts/

- `contradiction-audit.mjs` — Exports CONTRADICTION_SCHEMA, parseContradictionAuditJson, buildContradictionPrompt (~828 tok)
- `contradiction-merge.mjs` — Exports MERGE_SCHEMA, buildMergePrompt (~269 tok)
- `monthly-meta-synthesis.mjs` — Exports MONTHLY_META_SCHEMA, buildMonthlyMetaPrompt (~327 tok)
- `security-audit.mjs` — Exports parseSecurityAuditJson, buildSecurityAuditPrompt (~849 tok)
- `stale-check.mjs` — Exports STALE_CHECK_SCHEMA, buildStaleCheckPrompt (~289 tok)
- `weekly-synthesis-v2.mjs` — Exports SYNTHESIS_V2_SCHEMA, buildSynthesisPromptV2 (~597 tok)

## scripts/migrations/

- `001_initial.sql` — SQL: core SQLite schema tables; initial bootstrap no longer hard-requires FTS virtual tables (~711 tok)
- `002_v02.sql` — SQL: tables: memory_feedback, recent_injections, daemon_lock, ccmem_blacklisted_sessions (~573 tok)
- `003_v03.sql` — SQL: tables: cross_scope_alerts (~304 tok)
- `004_v04.sql` — SQL: tables: metrics_daily_rollup (~337 tok)
- `005_v04_compat.sql` (~73 tok)
- `006_v05.sql` (~77 tok)
- `007_v06.sql` — SQL: v0.6 embedding/audit-ts/rollup schema changes; optional FTS artifacts handled in db.mjs (~143 tok)
- `008_v07.sql` — SQL: tables: contradiction_alerts (~294 tok)
- `009_v08.sql` — SQL: tables: contradiction_alerts (~470 tok)
- `010_v08_backlog.sql` (~206 tok)

## tests/integration/

- `admin-cron-command.test.mjs` — dataRoot: resetCronTables, seedCronFixture, seedCronIssuesFixture, seedHealthyCronFixture (~16479 tok)
- `admin-daemon-command.test.mjs` — dataRoot: writeFakeLaunchctlScript, resetFakeLaunchctlScript, createFakeClaudeBinary + 20 more (~8274 tok)
- `admin-diagnose-command.test.mjs` — dataRoot: resetDiagnoseTables, seedSessionDiagnostics, seedAliveDaemon, seedRollupRow, seedSecurityD (~5892 tok)
- `audit-command.test.mjs` — Declares db (~255 tok)
- `cli-mode-audit.test.mjs` — Declares dataRoot (~382 tok)
- `daemon-loop.test.mjs` — baseConfigPath: resetRuntimeTables, setClaudeBridgeEnv, setRuntimeConfig, setTaskTimeoutConfig (~49681 tok)
- `forget-pin-cache.test.mjs` — resetCommandTables: seedStaleMaintenanceState, assertPreludeCleanup, insertMemory + 13 more (~3200 tok)
- `migration-v1-to-v2.test.mjs` — Declares db (~443 tok)
- `mode-command.test.mjs` — Declares db (~238 tok)
- `promote-command.test.mjs` — dataRoot: resetPromoteTables, seedStaleMaintenanceState, assertPreludeCleanup, insertPromoteMemory (~2395 tok)
- `prompt-submit-retrieval.test.mjs` — Prompt-submit retrieval/mode/blacklist integration coverage, including no-FTS fallback (~3122 tok)
- `resurrect-command.test.mjs` — dataRoot: resetResurrectTables, seedGreyZoneMemories, seedQuarantinedMemory + 3 more (~3858 tok)
- `save-list-session-start.test.mjs` — NODE: resetSaveListTables, seedQuarantinedListFixture (~5444 tok)
- `security-audit-task.test.mjs` — dataRoot: resetSecurityAuditTables, saveProjectMemory, saveGlobalMemory, markPoolCCandidate (~2250 tok)
- `stats-command.test.mjs` — dataRoot: seedRollupRow, resetStatsTables, insertMemory, seedStatsFixture, seedSecurityStatsFixture (~3203 tok)
- `stop-daemon-flow.test.mjs` — baseConfigPath: resetStopDaemonState, setClaudeBridgeEnv, clearClaudeBridgeEnv + 44 more (~26239 tok)
- `stop-hook-dispatch.test.mjs` — dataRoot: openStopDb, resetStopState, setStoredMode + 4 more (~4917 tok)
- `tier15-feedback.test.mjs` — Declares db (~1799 tok)

## tests/unit/

- `db.test.mjs` — Declares withEnv (~1112 tok)
- `llm-parse.test.mjs` — Declares raw, including Claude JSON envelope parsing regression (~758 tok)
- `plugin-manifest.test.mjs` — Declares readManifest (~198 tok)
- `priority.test.mjs` — Declares score (~123 tok)
- `project-key.test.mjs` (~174 tok)
- `render.test.mjs` — Declares text (~154 tok)
- `self-restart.test.mjs` — Declares withConfig (~1251 tok)
- `task-runs.test.mjs` — Declares db (~714 tok)
- `threat-scan.test.mjs` — Declares result (~98 tok)
- `trust.test.mjs` (~77 tok)
- `type-heuristic.test.mjs` (~121 tok)
