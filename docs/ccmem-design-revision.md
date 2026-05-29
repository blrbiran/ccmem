# ccmem-design.md 修订清单

> **目的**：基于 2026-05-22/23 的设计 review 讨论，本文件列出 [`ccmem-design.md`](./ccmem-design.md) 的 **删/改/留/推迟** 决策，作为后续应用到 design.md 的依据。
>
> **不直接 edit design.md**，理由：原文 6005 行，单次重写风险大；先有清单 review 完再分批 apply。
>
> **配套文档**：[`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) 是 v0.1 实施 spec（基于本清单的简化决策）。
>
> **状态约定**：
> - 🗑 **DELETE** — 不实现，design.md 中要删除整段
> - ✂️ **SIMPLIFY** — 保留概念但大幅简化实现，design.md 中需重写
> - ⏳ **DEFER** — 概念保留，v0.1 不做，schema/接口可能预留
> - ✏️ **RENAME** — 命名修正，functional 不变
> - ✓ **KEEP** — 当前设计合理，保留

---

## 一、按类别索引

### 1.1 重命名（RENAME）

| 当前命名 | 改为 | 影响章节 |
|---|---|---|
| `daily_consolidation` cron | `daily_maintenance` | §3 架构图、§7.2、§7.5、§7.8、§14、§15、§17 |
| `weekly_reflection` cron | `weekly_synthesis` | §3 架构图、§7.2、§7.4、§7.8、§14、§15、§17 |
| `weekly_reflection` prompt 中 "deep reflection / abstract uplift" 等措辞 | "deduplicate / synthesize / resolve conflicts" | §7.4 |
| `consolidation_depth` 字段命名 | **保留**字段名（functional 准确），但在 §4.2.1 加注释："This is curation generation, not cognitive depth." | §4.1, §4.2.1 |

### 1.2 完全删除（DELETE，永不实现）

| 项 | design.md 章节 | 理由 |
|---|---|---|
| `task_runs` 表 | §4.1 task_runs schema、§7.6、§7.7 enqueueTaskRun、§7.9 cron list | 用 audit_log 派生观测，无需独立表 |
| `confirm_tokens` 表 + token+hash+cooldown 系统 | §16.4 整章 | 用 verbatim declaration + content hash 即可 |
| `operation_mode` 4 状态机（normal/degraded/safe/bypass）| §16.3 整章 | 合并到 active/shadow/off + try/catch 兜底 |
| Tier 2 加权评分（5 维度 + 阈值）| §10.3 evaluateTier2 + §10.4 helper 函数 | 简化为 match → force_demote |
| `quarantine` 状态 | §4.1、§10.1 | Tier 1 直接拒绝，Tier 2 force_demote 已足够 |
| L1 关键词 + token 重叠归因 | §6.6 inferPrevTurnOutcome 大部分逻辑 | 保留仅 shortId 路径，删除 keyword + Jaccard 模糊归因 |
| L2 transcript 自纠扫描 | §6.6 inferFromTranscript | 移到 v0.2+ cron 内（不在 Stop hook 内）|
| `unhelpful_unattributed` / `unhelpful_partial` outcome | §6.6 全部 | 简化 outcome 枚举为 4 种 |
| `exposure_count` 字段 + slow decay | §4.1、§6.6 (N4/A9) | 让 L4 LLM 复核处理"长期未被引用"，无需独立通道 |
| 项目级 config.json + 4 层 deep-merge | §14.1 | 单层 user-level config + env override 已足够 |
| 配置 `null` 显式删除语义 | §14.1 第 2 条 | 单层无此需求 |
| 运行时 override 层（L4）| §14.1 | 用 env var 替代 |
| `daily_metrics` 表 | §4.1、§13 整章 | 改用 `metrics.jsonl` 文件 |
| Path-escape realpath 检测 | §16.4.4 + checkPathEscapeForPromoteGlobal | 文档化"不要 promote-global 含路径的规则"足够 |
| `pending.jsonl` 重放机制 | §4.1.1 | 引入新失败模式，收益不抵风险 |
| 三级 busy_timeout（critical/important/counter）| §4.1.1 | 统一 5s + WAL 即可 |
| Cerebrum 自动 sync (`daily_consolidation` 内的 cerebrum 子步骤) | §9.2、§9.3 部分 | 仅保留手动 import 命令（v0.2+） |
| Cerebrum SessionStart 增量扫描 (C9) | §9.2 末尾 | 同上 |
| Cerebrum import 三阶段去重（精确/归一/语义）| §9.2 syncCerebrumEntry | 简化为：手动 import 时只新增不更新 |
| Cerebrum import trust 修改 4 条规则 | §9.2.1 (N3/A8) | 只新增不更新 |
| `embedding_model_registry` 5 层防御 | §4.6 整节 + 部分 §10 | 推迟到 v0.5；届时再设计简化版（不需 5 层）|
| `/ccmem:semantic repair-registry` 命令 | §12.5 整节 | 同上推迟 |
| `/ccmem:semantic purge-model` 命令 | §12.6 整节 | 同上推迟 |
| 19 命令 + 17 别名映射 | §12.1 | 简化为 6 个核心命令（含 dual slash/CLI 入口）|
| `/ccmem:admin` 子树 | §12.1.2 | v0.1 无 admin 命令；v0.2+ 按需小批量加入 |
| `consolidated_lineage` 级联降级 ratio 阈值（50%）| §10.7 forgetMemory 部分 | v0.1 forget 只 archive 目标不级联 |

### 1.3 简化（SIMPLIFY，保留概念但重写实现）

| 项 | 当前 design.md | 简化后 | 影响章节 |
|---|---|---|---|
| Tier 2 模式判定 | 5 维度加权评分 + 阈值 + 4 种 action | match → force_demote（user_explicit 例外为 tag_only） | §10.3 |
| Promote 强确认 | token+hash 表 + soft/hard expire + cooldown | verbatim declaration（含 memId + content hash 前 8 位）| §12.3、§12.4、§12.7、§16.4 |
| Project key 解析 | 4 级链路 + registry + 8 步 URL 归一 + 多 remote 选择 | 4 行 fallback：env → file → git remote origin（简化 normalize） → path hash | §8.1 全章 |
| Cron 任务数 | 5 个独立 cron + claudePSemaphore=1 | 2 个：daily_maintenance（无 LLM）+ weekly_synthesis（LLM）+ on-demand summarize_pending | §7.2、§7.8 |
| Cron 锁机制 | cron_task_state.lock_holder + lock_ttl_sec + 多种 catch_up | 单一 tasks 表 + status 字段 + scheduled_for 时间窗 | §4.1、§7.6、§7.7 |
| Daemon 单实例锁 | 5 case：same-pid / hard timeout / soft timeout PID probe / valid / no lock + UNIQUE race retry | 简化为 3 case：same-pid（refresh）/ stale heartbeat（>60s force acquire）/ valid（exit）| §7.7 acquireDaemonLock |
| busy_timeout | 三级 critical/important/counter | 统一 5s + WAL | §4.1.1 |
| 反馈 outcome 枚举 | 6 种值（含 partial / unattributed / implicit / unknown）| 4 种值（helpful / unhelpful / helpful_implicit / unknown）| §4.1 memory_feedback、§6.6 |
| L1 反馈推断 | keyword + Jaccard token attribution + context guards | 仅 shortId 显式引用路径 | §6.6 |
| 注入文本格式 | verbose / compact / raw 三档 | 单一格式（带 ID 前缀的紧凑列表）| §11.4 |
| Memory ID | full ID `mem_<ts>_<rand>` + materialized short_id `m<sha>[:7..12]` + UNIQUE 防碰撞 | `INTEGER PRIMARY KEY AUTOINCREMENT` | §4.1、§11.3 |
| 注入 cache 重生 | version 字段 + race-prevention conditional UPDATE + 异步入队 + 重试 | 同步 INSERT OR REPLACE（每次写记忆都重生当前 scope，简单覆盖）| §7.4.2 regenerateInjectionCache |
| Cron 任务调度状态 | cron_task_state（schedule cron expression + last_success / next_due / max_catch_up_window）| tasks 表（每次成功后入队下一次，电脑休眠未跑 → 启动后只跑最新一条 due）| §4.1、§7.6 |
| 容量保护 | soft + hard limit + 95%/95% 双阈值 + 原子 INSERT 条件 + strictMode 配置 | 单一 maxActivePerScope + 超过时 stderr warn + 入队 force_consolidation（v0.2 实现）| §10.1 第 6 步、§10.1.1 |
| daemon 启动检查 | 完整 verifyDatabaseHealth（4 项 check）+ classifyDbError（5 类）+ degradation log | try/catch 失败则 stderr + exit 0 | §16.3 |

### 1.4 推迟到 v0.2+（DEFER）

| 项 | design.md 章节 | 推迟到 | 备注 |
|---|---|---|---|
| Daemon 进程 | §7 整章 | v0.2 | tasks 表 schema 在 v0.1 预留 |
| `summarize_pending` cron | §7.3 | v0.2 | |
| `daily_maintenance` cron（含 half-life decay 状态转移、archive、dedup） | §7.5 | v0.2 | |
| `weekly_synthesis` cron（含 LLM 合成）| §7.4 | v0.2 | |
| `security_audit` cron | §10.6 | v0.2 | |
| `revalidation_audit` cron | §10.5 | v0.3+ | 时效复核场景少 |
| Trust 数值系统（不对称调整 / source max / probation）| §4.3、§4.4、§4.5 | v0.2 | v0.1 schema 预留 trust_score=1.0 默认 |
| `consolidation_depth` 功能逻辑 | §4.2.1、§7.4 | v0.2 | v0.1 schema 预留默认 0 |
| `type='consolidated'` 实际写入 | §4.2 | v0.2 | v0.1 schema CHECK 允许但永不写入 |
| 反馈推断 L3（沉默通过）| §6.6 L3 | v0.2 | 需要 trust 系统 |
| 反馈推断 L4（LLM 复核）| §6.6 L4 | v0.2 | 需要 daemon + LLM |
| 反馈推断 L1（仅 shortId）| §6.6 L1 简化版 | v0.2 | 需要 trust 系统 |
| `memory_feedback` 表 | §4.1 | v0.2 | |
| Stop / SessionEnd hook | §6.4 | v0.2 | 入队 pending_summarize |
| PreCompact hook | §6.3 | **永不** | Stop 已覆盖 |
| Cerebrum 手动 import 命令 | §9 部分 | v0.2 | `/ccmem:import --cerebrum` |
| Embedding / Hybrid 检索 | §4.6、§5.2 HybridProvider、§4.1 vec_*  | v0.5+ | FTS5 验证假设后再决定 |
| `/ccmem:semantic *` 命令族 | §12.1.2、§12.5、§12.6 | v0.5+ | 与 embedding 同步 |
| `/ccmem:admin import` / `/ccmem:admin export` | §12.1.2 | v0.3+ | v0.1 用 `ccmem list --json` + `sqlite3 CLI` 替代 |
| `/ccmem:admin migrate <old> <new>` | §12.1.2 | v0.3+ | 实际遇到再做 |
| `/ccmem:admin purge` | §12.1.2、§12.7 | v0.3+ | 用户先 `rm -rf .ccmem/` 替代 |
| `/ccmem:promote` / `/ccmem:promote-global` | §12.3、§12.4 | v0.2 | 需要 trust + cron 上下文 |
| `/ccmem:audit` 命令 | §12.1.1 | v0.2 | v0.1 直接 `sqlite3 .. select * from audit_log` |
| `/ccmem:stats` 命令 | §13 | v0.2 | v0.1 用 jq 直接查 metrics.jsonl |
| 跨平台 launchd / systemd / win-task 模板 | §15 platform/ | v0.2 | 跟 daemon 一起 |
| Capacity force_consolidation 任务 | §10.1.1 | v0.2 | 需要 cron |
| Audit log 滚动归档 | §7.5 rotateAuditLog | v0.3 | v0.1 表内累积，需要时手工清理 |

### 1.5 保留（KEEP）

设计中有几处判断在 review 中被验证为合理，**保留不动**：

| 项 | design.md 章节 | 保留理由 |
|---|---|---|
| 4 hook 阶段的语义分工原则 | §6 章首 | 即便 v0.1 只用 2 个，分工原则正确（每个 hook 干它独有能力的事）|
| stdout JSON `additionalContext` 注入协议 | §1.3、§6.1、§6.2 | Claude Code 官方契约，spec 描述准确 |
| Trust 不对称调整原则（错误退场快于正确进场）| §4.4 | v0.2 实现时遵循此原则 |
| 三路检索 fallback 链思维（hybrid → lexical 优雅降级）| §5.2 | v0.5 实现 hybrid 时遵循此原则；v0.1 lexical-only |
| Tier 1 prompt-injection 模式 | §10.2 | minimum viable security |
| Secret-in-global 拦截 | §10.1 第 2 步 | 必须保留 |
| Hook 内绝对禁止 LLM 调用 / 网络 / spawn 子进程 | §1.1 | 性能边界硬约束 |
| Hook 失败必须 exit 0（不阻塞 Claude Code）| §1.1、§6.7 | 用户体验红线 |
| `~/.claude/ccmem/` 与 `<project>/.ccmem/` 物理分离 | §15 | 便于迁移 / 清理 / 隐私 |
| 强确认对高危操作（promote / purge）| §12.3、§12.4 | 必须保留，但简化为 verbatim declaration（删 token 表）|
| Mode = off 的 kill switch | §16.2 | 用户最终控制权 |
| Daemon LLM semaphore = 1（v0.2 实现时）| §7.1.1 | API 配额保护 |
| Cron 任务永不在 `await callClaudeP()` 内持 SQLite 事务 | §7.4.2、§7.6 | v0.2 实现时硬约束 |
| `consolidation_depth` 字段（functional 必要）| §4.1、§4.2.1 | 输入质量隔离用 |
| weekly LLM 合成的 prompt 约束（不发明 / 不抽象超过 source）| §7.4 prompt 约束部分 | 防止 LLM 幻觉关键 |
| `same batch depth span ≤ 2`（避免新鲜原料污染高 depth 合成）| 当前 spec 没有，**新增** | review 讨论中明确 |

---

## 二、按 design.md 章节顺序的逐章决策

### §一、设计目标

| 节 | 状态 | 决策 |
|---|---|---|
| §1 整体目标 8 条 | ✏️ RENAME | 第 4 条 "自动衰减与整合" 中 "整合" 措辞改为"合成"，与 weekly_synthesis 命名统一 |
| §1.1 工程现实校准（轻量边界）| ✓ KEEP | 三条边界（< 200ms / 不打扰 / 显式可见可关闭）保留 |
| §1.2 与 OpenWolf 关系 | ✂️ SIMPLIFY | 删除 §1.2 第 3 段"ccmem 可以单向只读消费 OpenWolf 的 cerebrum.md"——v0.1 不实现 cerebrum 同步；v0.2+ 通过手动 `/ccmem:import` 命令实现 |
| §1.3 用户感知边界 3 个出口 | ✓ KEEP | 设计原则正确 |

### §二、技术选型

| 节 | 状态 | 决策 |
|---|---|---|
| sqlite-vec | ⏳ DEFER | 推迟到 v0.5；v0.1 表中删除 sqlite-vec 行，改注："Phase 5+ when embedding enabled" |
| FTS5 + 内存 Jaccard | ✂️ SIMPLIFY | v0.1 仅 FTS5。Jaccard 推迟到 v0.5 hybrid 模式 |
| Embedding 模型 | ⏳ DEFER | 推迟到 v0.5 |
| Cron 实现 | ⏳ DEFER | v0.2 用 setInterval-based polling 而非 node-cron（任务数 ≤ 3，无需复杂 cron 表达式）|
| 项目根目录定位 | ✓ KEEP | `CLAUDE_PROJECT_DIR` env var 优先 |
| 数据存储路径 | ✓ KEEP | |
| Daemon 文件触发器 | ⏳ DEFER | v0.2 实现 |

### §三、架构总览

| 节 | 状态 | 决策 |
|---|---|---|
| 架构图（4 hook + 8 表 + daemon + 5 cron）| ✂️ SIMPLIFY | 重画为 v0.2 版本：2 hook(v0.1) → 加 Stop(v0.2) → 加 PreCompact(永不)；表 8 → 6（删 task_runs / daily_metrics / memory_feedback 推迟）；cron 5 → 2 |

### §四、数据模型

| 节 | 状态 | 决策 |
|---|---|---|
| §4.1 schema 整体 | ✂️ SIMPLIFY | 重写。详见 v0.1-spec §3.1 + v0.2 增量 |
| `memories.short_id` + materialized + UNIQUE | 🗑 DELETE | 改用 INTEGER PRIMARY KEY |
| `memories.exposure_count` 字段 | 🗑 DELETE | |
| `memories.requires_revalidation` 字段 + 触发器 | 🗑 DELETE | revalidation_audit 推迟到 v0.3+ |
| `memories_fts` schema | ✓ KEEP | |
| `consolidated_lineage` 表 | ⏳ DEFER | v0.2 加入 |
| `injection_cache.version` 字段 + race prevention | ✂️ SIMPLIFY | v0.1 简单覆盖（INSERT OR REPLACE）；race 不存在因为单进程串行 |
| `cron_task_state` 表 | 🗑 DELETE | 与 tasks 表合并 |
| `pending_summarize` 表 | 🗑 DELETE | 用 tasks 表 type='summarize_pending' |
| `memory_feedback` 表 | ⏳ DEFER | v0.2 加入；v0.1 schema 不预留 |
| `memory_audit_log` 表 | ✏️ RENAME | 改为 `audit_log`（去掉 memory_ 前缀，因为不止记忆相关）|
| `embedding_*` 系列表 | ⏳ DEFER | 全部推迟到 v0.5 |
| `session_context` 表 | ⏳ DEFER | v0.2 与 Stop hook 一起 |
| `daily_metrics` 表 | 🗑 DELETE | 改为 metrics.jsonl |
| `mode_state` 表 | ✂️ SIMPLIFY | 改为 config_kv 表中 key='mode' 的一行 |
| `daemon_lock` 表 | ⏳ DEFER | v0.2 |
| `task_runs` 表 | 🗑 DELETE | |
| §4.1.1 busy_timeout 三级分层 | ✂️ SIMPLIFY | 统一 5s + WAL |
| §4.2 类型表（rule/fact/episode/consolidated）| ✓ KEEP | base_priority + half_life 数值保留作为 v0.2 默认 |
| §4.2.1 consolidation_depth 设计原理 | ✏️ RENAME + 加注释 | 字段保留；段首加："consolidation_depth tracks curation generation, not cognitive depth. It exists to prevent fresh raw memories from polluting curated ones during weekly_synthesis." |
| §4.3 来源分级 trust | ⏳ DEFER | v0.2 与 trust 系统一起 |
| §4.4 trust 不对称调整 | ⏳ DEFER | v0.2 |
| §4.5 SOURCE_MAX_TRUST 常量 | 🗑 DELETE | 删除独立常量文件，所有 trust 上限从 config 读 |
| §4.6 Embedding Model Identity 5 层防御 | ⏳ DEFER | v0.5；届时简化（不需 5 层，2-3 层够）|

### §五、优先级与检索

| 节 | 状态 | 决策 |
|---|---|---|
| §5.1 优先级公式（base × recency × frequency × trust）| ⏳ DEFER | v0.1 注入排序简化为：pinned > rule > fact > episode + recency。完整公式 v0.2 加入 |
| §5.2 RetrievalProvider 抽象（Lexical/Hybrid/DaemonIpc/Prefetch）| ✂️ SIMPLIFY | v0.1 直接 inline FTS5 检索，无 Provider 抽象。v0.2 引入 LexicalProvider；v0.5 加 Hybrid |
| §5.3 Jaccard 实现 | ⏳ DEFER | v0.5 |
| §5.4 召回反馈机制 | ⏳ DEFER | v0.2 与 memory_feedback 一起 |

### §六、Hook 设计

| 节 | 状态 | 决策 |
|---|---|---|
| §6.1 SessionStart 整段实现 | ✂️ SIMPLIFY | 重写：1 SELECT 读 injection_cache，无 lazy_catch_up（v0.1 无 cron），无 recordFeedback（v0.1 无 trust）。详见 v0.1-spec §4.1 |
| §6.1.1 composeInjectionBlock 裁剪逻辑 | ✂️ SIMPLIFY | 删除多段 budget + overflow_trim_order；v0.1 单一 max_chars 截断 |
| §6.2 UserPromptSubmit 整段实现 | ✂️ SIMPLIFY | 重写：单一 FTS5 检索，无 inferPrevTurnOutcome（推迟），无 recordFeedback。详见 v0.1-spec §4.2 |
| §6.3 PreCompact hook | 🗑 DELETE | Stop 已覆盖，PreCompact 无独有价值 |
| §6.4 Stop / SessionEnd hook | ⏳ DEFER | v0.2，含 transcript stat 计算 + pending_summarize 入队 |
| §6.4 updateSessionContext 函数 | ⏳ DEFER | v0.2 与 session_context 表一起 |
| §6.5 settings.json 注册 | ✂️ SIMPLIFY | v0.1 只注册 SessionStart + UserPromptSubmit |
| §6.6 反馈推断 4 层 | ✂️ SIMPLIFY | v0.1 不实现；v0.2 实现 L3 + L4 + L1（仅 shortId）。删除 keyword + Jaccard 模糊归因、L2、exposure_count |
| §6.7 性能预算表 | ✂️ SIMPLIFY | v0.1 调整：SessionStart p95 < 50ms（基于预渲染 cache），UserPromptSubmit p95 < 100ms |
| §6.7 Timeout 行为规范 | ✓ KEEP | Promise.race + fallback 模式正确 |
| §6.8 Transcript 辅助函数 | ⏳ DEFER | v0.2 与 Stop hook 一起 |

### §七、Cron 任务设计

| 节 | 状态 | 决策 |
|---|---|---|
| §7.1 调度方式 | ✂️ SIMPLIFY | v0.2 用 setInterval polling 替代 node-cron（任务数少，schedule 简单）|
| §7.1.1 LLM 子进程并发控制 | ✓ KEEP | claudePSemaphore = 1 原则保留 |
| §7.2 任务清单（5 个）| ✂️ SIMPLIFY | 缩减到 3 个：summarize_pending（on-demand）+ daily_maintenance + weekly_synthesis |
| §7.3 summarize_pending prompt | ✂️ SIMPLIFY | 删除"dangerous operations 必须 type='episode'"中的部分硬约束（已被 Tier 2 force_demote 覆盖），保留 secret 检测 |
| §7.4 weekly_synthesis prompt | ✂️ SIMPLIFY | **重写 prompt**：删除 "deep reflection / abstract uplift" 措辞；改为 "deduplicate / synthesize / resolve conflicts"。新增约束："synthesized memory must use language no more abstract than the most general source"（防止 LLM 幻觉抽象）。新增 "same batch depth span ≤ 2" 约束 |
| §7.4.1 LLM 响应解析 | ✓ KEEP | parseMemoriesFromLlm 实现合理 |
| §7.4.2 consolidated 写入事务 | ✂️ SIMPLIFY | 删除 injection_cache version 字段 race prevention（v0.1 串行无 race）；保留每条独立事务原则 |
| §7.5 daily_consolidation 伪代码 | ✏️ RENAME + ✂️ SIMPLIFY | 改名 daily_maintenance；删除 runShallowConsolidationBatched（depth 0→1 浅层合并归入 weekly_synthesis 或不做）；保留：half-life decay / probation / dedup（可选 hybrid 模式）/ trust 兜底 / 14 天硬删 / audit rotation |
| §7.6 补打与幂等三层防御 | ✂️ SIMPLIFY | 删除 Layer 1 hook lazy_catch_up（v0.1 无 cron）；v0.2 简化为：daemon 启动时扫 tasks 表 scheduled_for < now 的，按 type 取最新一条执行（其余 mark skipped_stale）|
| §7.7 Daemon 主循环 | ✂️ SIMPLIFY | 简化 acquireDaemonLock 为 3 case；删除 fs.watch + 轮询 fallback 双路径，统一用文件 mtime 轮询 + 更短轮询间隔；删除 enqueueTaskRun（因为 task_runs 表删除）|
| §7.8 cron_task_state 默认 | 🗑 DELETE | 表已删除；改为 daemon 启动时初始入队 |
| §7.9 手动触发 cron 命令 | ✏️ RENAME | `/ccmem:admin cron run <task_id>` 推迟到 v0.2；命令 task_id 集合改为 3 个 |

### §八、双层作用域

| 节 | 状态 | 决策 |
|---|---|---|
| §8.1.1 解析优先级 4 级 | ✂️ SIMPLIFY | 改为 4 级：env CCMEM_PROJECT_KEY → `<project>/.ccmem/project_key` 单行文件 → git remote origin 简化归一 → path hash。删除：项目级 config.json 中的 project_key 字段 |
| §8.1.2 多 remote 选择（registry + override）| 🗑 DELETE | v0.1 只看 origin；多 remote 用户可用 env var override |
| §8.1.3 URL 同形归一 8 步 + Azure DevOps host-path 重写 | ✂️ SIMPLIFY | v0.1 简化为 4 步：lowercase / strip protocol / strip credentials / strip trailing .git。Azure DevOps 等长尾推迟到 v0.3+ |
| §8.1.4 手动 override | ✓ KEEP（部分）| 保留：env var + 单行文件 path。删除：项目级 config 字段 |
| §8.1.5 `/ccmem:show-key` 命令 | ⏳ DEFER | v0.2；v0.1 用户可直接 `ccmem list --json` 看 project_key 字段判断 |
| §8.2 scope 判断 | ⏳ DEFER | v0.1 默认 project，用户 `--global` 改；v0.2 LLM 自动判断 |
| §8.3 检索 scope filter | ✓ KEEP | |

### §九、与 OpenWolf 协同

整章 ✂️ SIMPLIFY：

- 立场 A（无 OpenWolf 依赖）已在 review 中确认
- v0.1：不实现 cerebrum sync
- v0.2：实现 `/ccmem:import --cerebrum <path>` 手动一次性导入
- 删除：daily 内 cerebrum 自动 sync、SessionStart 增量扫描、3 阶段去重、4 条 trust 修改规则
- 保留：`hasCerebrumSource()` 检测函数（仅作为 import 命令的前置 check）

| 节 | 状态 | 决策 |
|---|---|---|
| §9.1 共存原则 | ✂️ SIMPLIFY | 删除 4 条单向只读规则中的 3 条（自动 sync 相关）；保留"ccmem 不写 .wolf/" |
| §9.2 cerebrum 段落映射 | ⏳ DEFER | v0.2 实现 `/ccmem:import --cerebrum`；保留段落映射表作为参考 |
| §9.2.1 import 通道 trust 修改规则 | 🗑 DELETE | v0.2 import 只新增不更新 |
| §9.2 三阶段去重 | ✂️ SIMPLIFY | v0.2 仅做精确匹配（Stage 1）跳过；归一化和语义匹配推迟 |
| §9.3 cerebrum 检测 | ✓ KEEP | hasCerebrumSource 函数保留 |

### §十、安全防护

| 节 | 状态 | 决策 |
|---|---|---|
| §10.1 写入闸门主流程 | ✂️ SIMPLIFY | v0.1 只跑：Tier 1 + secret-in-global + 长度 check + insert + cache regen。删除：Tier 2 评分、quarantine、语义矛盾检测、capacity 软硬上限分离、requires_revalidation 设置 |
| §10.1.1 容量检查语义 | ✂️ SIMPLIFY | 单一 maxActivePerScope；超过时 stderr warn + audit；不做 strictMode + 原子 INSERT 条件 |
| §10.2 Tier 1 patterns | ✓ KEEP | 模式列表保留 |
| §10.3 Tier 2 patterns + 评分 | ✂️ SIMPLIFY | 模式列表保留；删除 evaluateTier2 函数（加权评分），改为简单 match → user_explicit 时 tag_only / 其它 source 时 force_demote |
| §10.4 上下文判别 helper | 🗑 DELETE | isInCodeBlock / isInQuotes / hasImperativePrefix 等不再需要（Tier 2 不评分）|
| §10.5 周期复核（revalidation_audit）| ⏳ DEFER | v0.3+ |
| §10.6 security_audit 兜底 | ⏳ DEFER | v0.2 与 daemon 一起 |
| §10.7 `/ccmem:forget` 同步级联 | ✂️ SIMPLIFY | v0.1 forget 只 archive 目标，不级联（无 lineage）。v0.2 加入级联，但 ratio 阈值改为可配置（默认 50% 但允许调整）|

### §十一、注入格式

| 节 | 状态 | 决策 |
|---|---|---|
| §11.1 SessionStart 注入示例 | ✂️ SIMPLIFY | 删除 `<!--m1a2b3c-->` 注释 ID（v0.1 无 short_id）；改用 `[42]` 整数 ID；删除 "Citation hint (ref: ...)" 提示（未验证有效）|
| §11.2 UserPromptSubmit 注入示例 | ✂️ SIMPLIFY | 同上；删除 status_suffix `!ctx` `!p`（v0.1 无 trust 状态机）|
| §11.3 Memory ID 格式 | 🗑 DELETE | v0.1 INTEGER PRIMARY KEY；short_id / sha256 截断 / UNIQUE 防碰撞全删 |
| §11.4 格式三档（verbose/compact/raw）| ✂️ SIMPLIFY | 单一格式 |

### §十二、用户管理命令

| 节 | 状态 | 决策 |
|---|---|---|
| §12.1 命令清单（10 顶级 + 9 admin）| ✂️ SIMPLIFY | v0.1: 6 个 slash + 6 个 CLI（共享底层）：list / show / save / forget / pin / mode |
| §12.1.4 别名映射 17 条 | 🗑 DELETE | 不发布无兼容压力 |
| §12.2 mode 实现 | ✂️ SIMPLIFY | v0.1：删除 mode_state 表；用 config_kv 表 key='mode'。删除 shadow → audit 写法（v0.1 用 stderr "[shadow] would inject ..." 即可）|
| §12.3 `/ccmem:promote` 强确认 | ⏳ DEFER + ✂️ SIMPLIFY | v0.2 实现；用 verbatim declaration（含 memId + content hash 前 8 位），删除 token+hash 表 |
| §12.4 `/ccmem:promote-global` | ⏳ DEFER + ✂️ SIMPLIFY | 同上；删除 path-escape realpath 检测；保留 dangerous_command / contains_secret 硬阻断 |
| §12.5 `/ccmem:semantic repair-registry` | ⏳ DEFER | v0.5+ |
| §12.6 `/ccmem:semantic purge-model` | ⏳ DEFER | v0.5+ |
| §12.7 `/ccmem:purge-*` | ⏳ DEFER | v0.3+；用户 v0.1 可手动 `rm -rf .ccmem/` |

### §十三、评估指标

整章 ✂️ SIMPLIFY：

- 删除 daily_metrics 表 + computeDailyMetrics 函数
- 改用 metrics.jsonl 文件 + 按需聚合
- 删除 §13.2 复杂的多级 metrics JSON schema；改为简单事件流（hook 事件 / 命令事件）
- `/ccmem:stats` 推迟到 v0.2 实现（jq 直接查 jsonl 已可用）

### §十四、配置文件

| 节 | 状态 | 决策 |
|---|---|---|
| §14.1 配置 4 层合并语义 | 🗑 DELETE | 单层 user-level config + env override |
| §14.2 配置示例 | ✂️ SIMPLIFY | 大幅缩减：v0.1 5-8 个 config key；v0.2 增加 trust + cron 配置；v0.5 增加 retrieval / embedding |

### §十五、目录结构

| 节 | 状态 | 决策 |
|---|---|---|
| 插件目录 scripts/ 下子目录 | ✂️ SIMPLIFY | 删除 platform/（v0.2 加）、cron/（v0.2 加）。新增 lib/cmd/（slash 与 CLI 共享底层）|
| commands/ 下文件清单 | ✂️ SIMPLIFY | 19 → 6 |
| `~/.claude/ccmem/` 用户目录 | ✏️ 部分 | 删除 daemon.pid / daemon.log / daemon.wake / daemon.sock（v0.2 加）；删除 embeddings/（v0.5 加）；新增 metrics.jsonl |
| `<project>/.ccmem/` 项目目录 | ✂️ SIMPLIFY | v0.1 可选；新增 project_key 单行文件（手动 override 用）|

### §十六、安全删除与逃生口

| 节 | 状态 | 决策 |
|---|---|---|
| §16.1 safe-fs 模块 | ⏳ DEFER | v0.3+；v0.1 直接 fs.unlink + 简单 sanity check |
| §16.2 Kill switch (`/ccmem:mode off`) | ✓ KEEP | |
| §16.3 数据库故障容错 4 模式 | 🗑 DELETE | 改为 try/catch + stderr warn + exit 0 |
| §16.4 确认窗口 token+hash | ✂️ SIMPLIFY | 改为 verbatim declaration（含 memId + content hash 前 8 位）；删除 confirm_tokens 表、ttl、cooldown |
| §16.4.4 path-escape realpath 检测 | 🗑 DELETE | |
| §16.4.5 declaration 兼容路径 | ✓ KEEP（升级为唯一路径）| 现在 declaration 不再是"遗留"，是唯一确认方式 |

### §十七、实施路线图

整章 ✂️ SIMPLIFY：

- M0-M6 改为 v0.1-v0.5
- v0.1（即 M0+M1 简化版）：2-3 周（详见 ccmem-v0.1-spec.md §12）
- v0.2：daemon + cron + trust + L3/L4 反馈 + Stop hook + cerebrum 手动 import（约 4-5 周）
- v0.3：promote/purge/audit 命令 + 级联降级 + safe-fs + import/export（约 2-3 周）
- v0.5：embedding + hybrid 检索 + semantic 命令族（约 3-4 周）

测试覆盖矩阵相应缩减：v0.1 测试目标见 ccmem-v0.1-spec.md §12.1。

### §十八、Known unknowns

✓ KEEP（部分）：
- Embedding 下载体验
- Windows 守护进程
- 多机同步
- 多用户共享项目

🗑 DELETE：
- prompt cache 利用率（已不在 metrics 追踪）
- 多 Claude Code 窗口反馈冲突 C15.1（推迟到 v0.2 反馈系统再讨论）
- 自适应轮询档位最优值（v0.2 daemon 上线再说）
- L4 反馈复核采样频率（v0.2）
- URL normalizer 长尾（v0.3）
- Daemon liveness 探测阈值（v0.2）
- Exposure decay 与 trust 衰减叠加（exposure_count 已删，问题不存在）

新增：
- v0.1 假设验证：ship 后 1-2 周自用，看 helpful 比例 / saves 频率 / inject 污染感
- 注入文本的"过期 / 失效 / 错误"信号传递给用户的最佳方式（v0.1 不解决）

---

## 应用进度（2026-05-23 session,完成）

| 批次 | 状态 | 说明 |
|---|---|---|
| **B 重命名** | ✅ 完成 | `daily_consolidation`→`daily_maintenance`、`weekly_reflection`→`weekly_synthesis`、prompt 措辞、文件名全部替换 |
| **A 删除** | ✅ 完成 | 整段 DELETE:§4.1.1 / §4.5 / §4.6 / §6.3 / §10.4 / §12.5 / §12.6 / §16.1 / §16.3 / §16.4.1-.4 / §12.1.4 / §14.1 / exposure_count slow decay / cerebrum 增量扫描 / show-key / multi-remote 选择;inline 引用扫尾完成,残余仅在「永不」锚点中作为否定声明出现 |
| **C 简化** | ✅ 完成 | §4.1 schema 整张表重写为 v0.1-spec 对齐版 / §6.1-6.5 hook 全部重写(含反馈推断 §6.5)/ §7 cron 整章重写(5 cron → 3 task type)/ §8.1.3 URL 归一 8→4 步 / §10.1 写入闸门简化 / §10.7 forgetMemory 简化 / §11 注入格式 三档→单档 / §13 metrics 改 jsonl / §16.4 改 verbatim declaration |
| **D 锚点** | ✅ 完成 | 18 个一级章节均已加 v0.1 / v0.2 / v0.5+ / 永不 锚点 |

### 行数变化

| 阶段 | 行数 | 减幅 |
|---|---|---|
| 起始 | 6005 | — |
| Agent 初步删除 | 5747 | -258 |
| Batch A 主体删除 + B renames + D 锚点 | 4915 | -832 |
| Batch C part 1(§8.1.3 / §10.1 / §10.7 / §11)| 4540 | -375 |
| Batch C part 2(§4.1 / §6 / §7) | 3163 | -1377 |
| Batch C inline cleanup | 3163 | (微调) |
| **最终** | **3163** | **-2842(-47.3%)** |

### 残余说明

- `task_runs` / `cron_task_state` / `memory_audit_log` / `daily_metrics` / `confirm_tokens` / `exposure_count` 等关键词仍在 design.md 中出现,但**仅在「永不」锚点中作为否定声明**(例如:「> **永不**: cron_task_state 表 / task_runs 表」)。grep 扫描仍会命中,但语义已正确。
- 已用 grep + python 扫描确认所有 inline 残留(非「永不」语境)都已清理。
- design.md 与 v0.1-spec.md 在叙事和代码示例细节上现已对齐。

---

## 三、应用清单的建议顺序

如果决定把本清单 apply 到 ccmem-design.md，建议分 4 批操作避免大规模冲突：

### 批次 A：删除（最安全，先做）

按 §1.2 列表逐个删除整段。每删一段后跑一次 markdown lint 确保链接 / 锚点没断。

预计削减：~1500 行。

### 批次 B：重命名（机械性）

全文搜索 + 替换：

- `daily_consolidation` → `daily_maintenance`（保留代码 examples 中的引用，因为是函数名）
- `weekly_reflection` → `weekly_synthesis`
- "deep reflection" / "abstract uplift" / "深度反思" / "抽象提升" → "deduplicate / synthesize / resolve conflicts" / "去重 / 合成 / 冲突解决"

代码示例中的函数名（如 `dailyConsolidation()`）也对应改名。

### 批次 C：简化（重写量最大）

按 §1.3 列表对每节做局部重写。建议从短节开始：

1. §11 注入格式（短）
2. §10.7 forgetMemory 级联（短）
3. §16.4 确认窗口（中）
4. §8.1 project_key（中，但删 8 步归一）
5. §10.1 写入闸门（中）
6. §6.1/6.2 hook 实现（长）
7. §7 cron 整章（长）
8. §4.1 schema 整张表（长，与 §7 联动）

### 批次 D：v0.1 锚点

在 design.md 章节首部加 v0.1/v0.2/v0.5 标记：

```markdown
## §六、Hook 设计

> **v0.1**: 实现 SessionStart + UserPromptSubmit
> **v0.2**: 加入 Stop / SessionEnd
> **永不**: PreCompact（被 Stop 覆盖）
```

让读者一眼看到哪些是当前 / 近期 / 长期。

---

## 四、争议项 / 已决定

2026-05-23 review 会话中决议：

1. **DB 布局**：✅ **单 global.db**（v0.1）
   - 所有记忆一张表，scope + project_key 区分
   - 不使用 `<project>/.ccmem/project.db`
   - v0.3 多设备同步需求出现时通过迁移工具拆分
   - design.md §15 中"双 DB"叙述需删除

2. **memory 字符上限**：✅ **300 字符**（v0.1 默认）
   - config 可调
   - v0.1 自用发现常被截断 → v0.2 升 500

3. **FTS5 sanitizer 策略**：✅ **OR-only + trigram tokenizer**
   - schema 改 `tokenize='trigram'`（v0.1-spec §3.1）
   - sanitizer ≥3 字符 token + OR 拼接
   - design.md §4.1 中 FTS5 schema 需相应更新
   - 已知限制：1-2 字 CJK 查询（如"路由"）召回率下降；v0.2 可加 LIKE fallback

4. **daemon 启动方式**：⏳ **推迟到 v0.2 设计阶段**
   - 不影响 v0.1 任何部分
   - 倾向：hook-triggered + 自我维持（跨平台一致）

5. **`/ccmem:undo` 命令**：✅ **不实现，forget 写 trash/<id>.md**
   - v0.1 命令矩阵保持 6 个（list / show / save / forget / pin / mode）
   - forget 时把内容备份到 `~/.claude/ccmem/trash/<id>.md`
   - 用户从 trash/ 复制内容后用 `ccmem save` 重写
   - v0.3+ 如有需求再设计完整 undo 链

---

## 五、2026-05-26 session — 10 项追加决议(T-1 ~ T-10)

> 基于 design.md / v0.1-spec / motivation 综合 review,补充 10 项决策。
> **应用清单**:见各项 "应用清单",由后续 batch apply 落到三份文档中。
> **状态约定** 同 §一前缀(🗑/✂️/⏳/✏️/✓)。

### T-1 v0.1 保留 v0.2 reserved 钩子 ✓ KEEP

**决定**: 现状保留(v0.1 schema 保留 trust_score / consolidation_depth / recall_count / trust_history 等 reserved 字段;tasks / task_runs / schema_migrations 表 v0.1 即建)。

**理由**: 避免 v0.2 ADD COLUMN + ALTER CHECK 痛点;接受 v0.1 实现者要懂 reserved 字段语义。Reviewer review 时需识别 reserved 字段不参与 v0.1 逻辑(N-1 hook 白名单 + N-2 排序简化已定义边界)。

**否决备选**:
- A 真正最小化:v0.1 删除全部 reserved 字段与表 → v0.2 ADD COLUMN/CREATE TABLE。否决理由:v0.2 ADD CHECK 在 SQLite 需 rename→recreate→copy,migration 痛点比 v0.1 多写注释字段更大。
- C 折中:留 reserved 字段删 reserved 表。否决理由:tasks/task_runs 在 K-1 lazy SQL 模式即需要,删除会让 K-1 失效。

**应用清单**: 无 spec 改动;只在 v0.1-spec §3.1 reserved 字段注释处补一行 "保留理由见 revisions T-1"。

---

### T-2 Consolidation 保留完整 lineage ✓ KEEP

**决定**: 现状保留(consolidation_depth + parent_ids tree + weekly_synthesis 完整 synthesis + max+1 depth + cycle ref detection + `/ccmem:show --lineage` 递归)。

**理由**: lineage 是 debug / 审计的关键路径——consolidated 出错时必须能反追到具体 source episode;dedup-only 简化丢失"为什么这条 rule 被合成出来"的反向追溯能力。

**否决备选**:
- A v0.2 只做 dedup 不做 synthesis。否决理由:dedup 不能解决"重复 rule 累积"的根本问题;且 lineage 表本身就是 LLM 整合质量的兜底审计工具。
- B depth ≤ 1 简化。否决理由:多轮整合是真实场景(weekly 把上周 daily 整合再整合),硬限 depth=1 会让"长期积累的高 depth 规则"无法形成。

**风险**: LLM 整合质量难以独立评估,可能放大错误。**缓解策略**:weekly_synthesis prompt 中 "language no more abstract than source" + L4 复核 + `/ccmem:show --lineage` 用户可主动审计。

**应用清单**:
- design.md §4.2.1 段首加一段 callout 引 revisions T-2,提醒读者 lineage 是 functional 必要不可简化。

---

### T-3 Trust 正反馈源:Stop hook 引用检测 ✂️ SIMPLIFY + 部分 DEFER

**决定**:
- **B 实施**(v0.2):Stop hook 读 transcript,检测 assistant 是否引用了上轮注入 mem 的 shortId 或核心 token → `+0.025 helpful_implicit`
- **A 推迟**(v0.3+ 实验):L1 关键词正面信号(POS pattern,与 NEG/COR 对称)推迟,因中文"对/嗯/好的"歧义高,误判风险大

**理由**: trust 系统需要可靠正反馈源;沉默不算 helpful + L4 5% 抽样太慢 → trust 几乎只跌不涨。B 准确度高于 A,且复用现有 Stop hook 读 transcript 的基础设施(已在做 L2 self-correct 检测)。

**应用清单**:
- design.md §6.6 加新小节 "L2.5 Stop-hook reference detection(helpful_implicit 来源 B)"
- design.md §6.5 反馈推断分层概览表加一行 L2.5
- design.md §4.4 trust 调整说明中 helpful_implicit 触发源增补 "L2.5 reference detection / L4 LLM 复核确认"
- design.md §17 M2 milestone 范围增补 L2.5 实现
- v0.3+ Known unknowns 加一项 "L1 POS 关键词模式实验"

---

### T-4 Exposure 改为 opt-in 命令 🗑 DELETE 自动机制 + ✏️ NEW 命令

**决定**:
- **删除**:`monthly_low_trust_exposure` cron / `exposure_queue` 表 / SessionStart `[EXPOSURE]` 段 / R-2 weekly exposure miss audit / S-1 pool-proportional sampling / P-3 exposure 预算桶 / 配套配置项
- **保留**:I-3 `effective_trust = max(trust, 0.2)` floor(独立机制,与 exposure 无关,死锁防护)
- **新增**:`/ccmem:resurrect [--bottom N] [--tag X]` 命令——用户主动 list grey-zone 记忆(trust ∈ [0.1, 0.3]),逐条选择 keep / forget
- **辅助**:`/ccmem:stats` 顶部显示 grey-zone 记忆计数 + 提示"Run /ccmem:resurrect to review"

**理由**: 自动 exposure 每月强制注入 40 条灰区记忆,等同于消耗用户没主动请求的注意力——与 motivation"用户感知边界 3 个出口"原则冲突。Trust 灰区是"被否定 / 长期未用"的自然沉底,不应替用户决定复活。

**应用清单**:
- design.md 删除段落:§4.1 v0.2 增量 exposure_queue / §7.3 monthly task + 表行 / §7.3.1 调优指南整节 / §7.5.1 exposure miss audit / §7.5.2 L4 100% 覆盖 exposure / §11.1.1 EXPOSURE 段渲染规则 / §14 cron.monthly_low_trust_exposure 配置 / §11.1 注入示例中 EXPOSURE 段
- design.md §12.1.1 新增 `/ccmem:resurrect` 命令规范
- design.md §13 / `/ccmem:stats` 段加 grey-zone 计数显示
- v0.1-spec §1.2 不在 v0.1 也不在 v0.2(已 implicit)
- known-limitations.md 不影响

---

### T-5 Daemon-optional 双档定位 ✂️ SIMPLIFY + 重新定位

**决定**:
- **Tier 1 (always-on, daemon-free)**: 注入(SessionStart / UserPromptSubmit)/ 检索 / 用户命令(list / save / show / forget / pin / mode / promote / stats)/ Tier 1 安全闸门
- **Tier 2 (daemon-required, 缺席不降级)**: summarize_pending / weekly_synthesis / L4 复核 / daily_maintenance(trust 兜底 archive + 14d 硬删)/ consolidation 整合 / Stop hook L2/L2.5/L1 反馈推断的 trust 调整(异步写入路径)
- daemon 不可用时:Tier 2 功能**直接缺席,不再 lazy SQL 降级**;`/ccmem:stats` 顶部显式提示"Tier 2 unavailable"

**理由**: K-1 lazy 模式让用户无法感知 Tier 2 是否在工作,容易"以为系统在学习,实际只有静态注入"——比明确缺席更危险。

**否决备选**:
- B daemon-free 重新设计:`/ccmem:tick` 命令让用户每天手动跑 LLM 任务。否决:违反 motivation"对用户零打扰"。
- C 现状 lazy + 提示:K-1 现行设计。否决理由:用户对"挂起队列"的认知成本高于"功能不可用"的认知成本。

**应用清单**:
- design.md §7.10.1 重写为 "Tier 1 / Tier 2 分档说明",删除 lazy SQL daily_maintenance 路径
- design.md §15 加 `ccmem install` 检测 launchd / systemd 可用性,失败时 stderr 明确提示 "Tier 2 unavailable on this system"
- design-motivation.md "daemon 失联也不抢用户注意力(K-1)" 段落改写为"daemon-optional 定位说明"——明确 Tier 1 / Tier 2 边界
- known-limitations.md CR-04 应对策略改:"daemon 不可用时 Tier 2 功能缺席,Tier 1 仍 100% 工作;`/ccmem:stats` 顶部告知用户"
- design.md §7.7 K-1 SessionStart lazy SQL catch-up 代码删除(对应 v0.1-spec §4.1 tryLazyDailyMaintenance 函数体内容改为永远 skip,只保留 lease 占位以供 v0.2 daemon-path 使用)

---

### T-6 v0.1 schema 加占位 reserved 字段 ✏️ ADD + RENAME

**决定**: v0.1 schema 增补 memories 表 reserved 字段,修复与 design.md 的命名漂移。

**新增字段**(v0.1 即建,reserved no-writes):
- `decay_status TEXT NOT NULL DEFAULT 'active'` — 'active' | 'probation' | 'archived' | 'candidate_expire' | 'quarantine'(v0.2 起激活状态机)
- `last_touched_at INTEGER NOT NULL` — 默认 = created_at;hook UPDATE 时刷新(召回 / pin / edit 都算 touch)
- `helpful_count INTEGER NOT NULL DEFAULT 0` — v0.2 L1/L4 反馈累加
- `unhelpful_count INTEGER NOT NULL DEFAULT 0` — 同上
- `half_life_days INTEGER` — 可空,v0.2 从 type 默认值填充(rule=60 / fact=30 / episode=7 / consolidated=90),允许个例覆盖

**命名修正**:
- v0.1-spec 现有的 `last_recalled_at` → 替换为 `last_touched_at`(与 design.md 对齐)
- 删除 `last_recalled_at` 字段(被 `last_touched_at` 替代)

**理由**: design.md §4.6 / §5.1 / §7.6 大量引用这些字段,v0.1 schema 不建会导致 v0.2 必须 ALTER + reviewer 无法把 design.md 当 v0.2 真值;K-1 lazy maintenance 也需要 last_touched_at 才能跑 14d 硬删。

**应用清单**:
- v0.1-spec §3.1 memories 表 schema 增补 5 字段
- v0.1-spec §3.1 删除 `last_recalled_at` 注释
- v0.1-spec §4.6 hook 白名单允许 SessionStart UPDATE `last_touched_at`(召回时刷新)
- v0.1-spec §4.6 grep checklist 第 1 条更新:UPDATE memories 允许 SET last_touched_at / decay_status / helpful_count / unhelpful_count(后三个 v0.2+ 才允许)
- design.md §4.1 v0.1 schema 段落同步增补字段(保持文档间一致)
- 全文 grep 替换 `last_recalled_at` → `last_touched_at`(若 design.md 还有残留)

---

### T-7 v0.1→v0.2 migration 脚本 stub ✏️ ADD

**决定**: v0.1 ship 时即固化 v0.2 migration 流程,提供 `scripts/migrations/002_v0_2.sql` 骨架文件(注释填充)+ `runMigration()` 通用 helper 框架。v0.2 实施者只需 fill in 实际 SQL,不需要从头设计 migration 机制。

**v0.2 已知需新增**:
- 表:`memory_feedback` / `consolidated_lineage`(若 T-2 lineage 不用独立表则跳过)/ `session_context` / `daemon_lock` / `recent_injections` / `cross_scope_alerts` / `project_key_alias` / `ccmem_blacklisted_sessions`
- 字段:memories.migration_origin TEXT / memories.parent_ids TEXT / memories.status TEXT
- 索引:相应新表的索引

**理由**: schema migration 早做晚做的痛点不一样——晚做时 v0.1 用户量大,迁移失败的 blast radius 大。`runMigration()` 框架在 v0.1 ship 时就跑过 v0→v1 一次,验证流程可用。

**应用清单**:
- v0.1-spec 新增 §7 "v0.2 migration 准备"小节(放在 §6 之后):
  - `runMigration(targetVersion)` helper 通用框架(BEGIN TX / 跑 SQL 文件 / 记 schema_migrations / COMMIT)
  - `scripts/migrations/002_v0_2.sql` 骨架文件结构示意
  - SQLite ALTER 限制说明(不支持 ADD CHECK / 改 NOT NULL)+ rename→recreate→copy→drop pattern
- design.md §17 路线图段加一行 "v0.1 → v0.2 migration 流程在 v0.1 即固化"

---

### T-8 recent_injections / metrics 边界 ✓ KEEP

**决定**: 现状保留(P-2 定义的两表职责分离 + 字段约束)。为后续 debug 留余量,系统稳定后再考虑优化。

**应用清单**: 无 spec 改动。

---

### T-9 命令矩阵大幅简化到 11 个 🗑 DELETE 命令

**决定**: v0.2 命令面简化(从 11 顶级 + 9 admin = 20 → 8 顶级 + 3 admin = 11):

**保留 8 个顶级**: `list / save / show / forget / pin / mode / promote / stats`
**保留 3 个 admin**: `daemon / cron run / diagnose`
**新增**(T-4 + T-5): `resurrect`(T-4)归入顶级 → 实际 9 顶级 + 3 admin = 12

**删除**(替代路径列在每条后):
- `/ccmem:search` → 用 `/ccmem:list --match <keyword>` 代替
- `/ccmem:edit` → 用 `/ccmem:forget <id>` + `/ccmem:save` 代替(更明确的"修改是删旧建新"语义)
- `/ccmem:audit` → 用 `sqlite3 ~/.claude/ccmem/global.db "SELECT * FROM audit_log..."` + `/ccmem:stats` 代替(v0.1 已是这种用法)
- `/ccmem:admin import` / `export` / `migrate` / `purge` / `init` / `semantic` → v0.3+ 按需重新设计(目前用户基数小,用 `rm -rf` / `sqlite3` CLI 直接操作即可)

**配置文件精简**: 默认配置 5-8 个高频可调项:
- `mode` / `inject.max_chars` / `inject.max_per_prompt` / `capacity.maxActivePerScope` / `security.tier1_patterns_extra` / `security.secret_patterns_extra`
- 其它 100+ 个系数(`frequencyBoostCoef`, `unhelpfulPenaltyCoef`, half-life-days, source initial trust 等)硬编码在 `config.default.json`,只在 advanced 用户翻代码时可见

**理由**: motivation"用户感知边界 3 个出口"原则;命令面膨胀违背"轻量"承诺。

**应用清单**:
- design.md §12.1.1 重写顶级命令清单(8 + resurrect = 9)
- design.md §12.1.2 重写 admin 子树(3 个)
- design.md §12.5 / §12.6 / §12.7 删除 semantic/purge/admin 相关子节
- design.md §12.4 promote-global 保留为 `/ccmem:promote --global`(已是别名)
- design.md §14.2 配置示例精简
- design.md §15 commands/ 子目录列表精简
- v0.1-spec §1.1 命令清单确认对齐(v0.1 已 6 个,匹配)
- design.md §16.4 confirm 档位适用命令清单精简

---

### T-10 OpenWolf 关系三文档统一 ✏️ RENAME

**决定**: 三文档统一为 "ccmem 完全独立可用;OpenWolf 仅作为 importer source 之一,不享受任何特权"。

**应用清单**:
- **design-motivation.md "做什么"段** "以 OpenWolf 插件形态存在,复用其 cron-engine、原子写、日志框架,独立时也能跑" → 改为 "**独立可用**:不依赖 OpenWolf。可选地把 OpenWolf 的 `.wolf/cerebrum.md` / `buglog.json` / `anatomy.md` 作为 importer source 一次性导入(`/ccmem:admin import --openwolf`),与 `CLAUDE.md` / `.cursor/rules` 等 importer 平级"
- **design-motivation.md "我们参考了什么"表 OpenWolf 行** 从"Hook 生命周期注册方式、CronEngine 调度器(retry/backoff/dead-letter)、ai_task 异步 LLM、原子写入、CLAUDE_PROJECT_DIR 解析、配置化约束"→ 简化为"Hook 生命周期注册方式、CLAUDE_PROJECT_DIR 解析方式"。cron-engine / ai_task / 原子写不复用(ccmem 自实现)
- **design-motivation.md "与 OpenWolf 的关系"表 "Cron 调度" 行** 从"✅ cron-engine | 复用 / 注册任务" → 改为"✅ cron-engine | ccmem 自带独立 daemon,见 design.md §7.11"
- **design-motivation.md "协作方式" 段** 删除"检测到 `.wolf/cron-manifest.json` 存在时,ccmem 把自己的 cron 任务注册进去;不存在时启动独立 daemon" → 改为 "ccmem 永远启动独立 daemon。`.wolf/cerebrum.md` 不主动读;用户可通过 `/ccmem:admin import --openwolf` 一次性导入"
- design.md §1.2 现已正确表述,无需改动
- revisions 立场 A 已正确,无需改动

---

## 六、应用顺序

按"风险递减 + 受影响章节集中度递增"排序:

1. **本节(决议持久化)** — ✅ 已完成
2. **T-10 motivation OpenWolf** — 3 段简单替换,受影响 1 文件
3. **T-6 schema 加字段 + 重命名** — focused on §3.1,影响 v0.1-spec + design.md §4.1 局部
4. **T-7 migration stub** — 新增 §7 in v0.1-spec
5. **T-4 删除 exposure 自动机制** — 多段删除 in design.md,需小心 cross-ref
6. **T-5 daemon-optional 双档** — design.md §7.10.1 / §15 重写 + motivation 一段
7. **T-9 命令简化** — design.md §12 重写 + §14 配置精简
8. **T-3 Stop hook 引用检测** — design.md §6.6 加 L2.5 小节
9. **T-1 / T-2 KEEP rationale callout** — 两处小标注
10. **.wolf/anatomy + memory 更新** — 收尾

---

## 七、2026-05-26 session(后续)— 9 项追加决议(U-1 ~ U-9)

> 基于 design / v0.1-spec / motivation / revisions / known-limitations 五份文档的相互对照 review,补充 9 项决策。
> 决策状态约定同 §一前缀。所有 9 项均已在本 session 内 apply 完成。

### U-1 Daemon-optional 三档定位 ✂️ SIMPLIFY(修正 T-5)

**决议**:在 T-5 的 Tier 1 / Tier 2 二档基础上,**加入 Tier 1.5**:trust 兜底 archive / 14d 硬删 / decay_status 状态机 / recent_injections 14d 清理 / task_runs 30d 清理 — **纯 SQL,无 LLM**,在用户主动调命令(`/ccmem:stats` / `/ccmem:list` 等)前置 prelude 里跑,通过 `task_runs.UNIQUE(type='tier1_5_maintenance', date_key=today)` lease 保证一天最多一次。

**与 K-1 老 lazy 模式区别**:
- K-1 在 SessionStart hook 里跑 → 静默 → 用户以为 daemon 在工作(T-5 否决理由)
- U-1 在用户主动命令 prelude 里跑 → 显式("ran 2h ago, archived 3"在 stats 顶部)→ T-5 否决理由不再适用

**关键收益**:daemon down 场景下 ccmem 价值从"30%(只剩静态注入)"提升到"70%(失去 LLM 整合但记忆卫生维持)"。

**应用清单**:design.md §7.10.1 重写;`/ccmem:stats` 输出加三档可视化;motivation T-5 段同步。

### U-2 short_id → `[m42]` 渲染格式 ✏️ RENAME

**决议**:memories.id 仍是 `INTEGER PRIMARY KEY AUTOINCREMENT`(revisions §1.3 决议不变),但**渲染时加 `m` 前缀**。L1 行级归因 regex 从 `\bm[0-9a-f]{7,12}\b` 改为 `\bm\d+\b`。

**原 spec bug**:revisions 删了 short_id 列,但 design.md §6.6 / T-3 L2.5 仍写假定有 `mNNN` 引用 — 与 INTEGER PK 不兼容。U-2 用"渲染加 `m` 前缀"补这个 gap,既不引入新字段也修复显式引用路径。

**应用清单**:design.md §6.6 attributeFeedback regex + §11 注入示例 + T-3 L2.5 注释;v0.1-spec §4.4 / §4.5 / §5.3.1 同步;design.md §6.6 删除 SELECT 不存在的 short_id 列。

### U-3 (合并入 U-1,不单列)

### U-4 LIKE fallback for short CJK queries ✏️ NEW(v0.1)

**决议**:v0.1 即引入 LIKE fallback。FTS5 返回 < 3 条时,抽 prompt 中的 2-3 字 CJK 连续段(上限 5),用 `WHERE content LIKE '%<term>%' OR ...` 兜底召回。仅匹配 CJK Unicode,避免 `LIKE '%a%'` 全表扫;< 2000 行记忆下实测 < 30ms。

**为什么 v0.1 就实现**:trigram tokenizer 对中文 1-2 字 query(如"路由"、"组件")召回为 0。v0.1 dogfood 期一旦中文用户撞到这个就直接证伪假设。30 行代码 + 30 行单测的投入值得。

**应用清单**:v0.1-spec §4.2 加 LIKE fallback 实现 + §7.1/§7.3 default config;design.md §5 章首加 U-4 段;known-limitations.md SQ-05 应对策略更新。

### U-5 Trust 上限统一 1.0 ✂️ SIMPLIFY(替代 source-specific 上限)

**决议**:**所有 source / type 的 trust 上限统一为 1.0**。原 user_explicit=0.9 / cron_consolidated=0.85 / external=0.7 等"永久上限差异"取消。差异化只体现在"初始 trust"与"观察期天数"。probation 期内仍保留 ≤ 0.6 锁(临时,非永久)。

**核心理由**:
1. 上限差异 = 永久污名化,违反"反馈机制必须有出路"原则
2. F-1 v0.1→v0.2 迁移问题自动消失(trust=1.0 在 v0.2 仍是合法值,无悄悄降级)
3. trust 模型简化:1 个上限 + 1 个 probation 锁(临时),减少特殊分支

**配套**:`/ccmem:pin` 不再 set trust=0.95,改为仅 set pinned=1(pin 与 trust 正交)。`trust-constants.mjs` 中 SOURCE_MAX_TRUST 常量删除。

**应用清单**:design.md §4.2 type 表 + §4.3 source 表 + §4.4 不对称调整 + §4.5 4×4 示例 + §12.1.1 /ccmem:pin + §15 trust-constants.mjs;v0.1-spec §3.1 schema 注释 + §5.5 pin 命令。

### U-6 Shadow 严格干跑模式 ✂️ SIMPLIFY(明确语义)

**决议**:`mode=shadow` 严格 **read-only diagnostic**:
- ✅ 读 injection_cache / 跑 FTS5 检索 / 写 metrics.jsonl
- ❌ 不写 recent_injections / 不写 audit(error 除外)/ 不跑 L1/L2/L2.5/L4 反馈推断 / 不输出 additionalContext

**核心理由**:L1/L2 反馈推断基于"用户对注入的反应",shadow 下用户没看到注入 → 反馈归因从根上是错的 → 不能跑。
三档语义清晰:`off=什么都不做` / `shadow=读但不写` / `active=读写`。"暂停注入但保持学习"是伪需求(暂停注入就丢了反馈源头)。

**应用清单**:design.md §6.1 / §6.2 / §6.3.1 加 shadow gate;§12.2 mode 命令输出明确三档语义;v0.1-spec §4.1 / §5.6 同步。

### U-7 删除 probation_boost ×1.3 与 inject 权重 ×0.5 ✂️ SIMPLIFY

**决议**:从 §5.1 优先级公式中**删除 probation_boost** 与"观察期 ×0.5 注入权重"两个机制。probation 仅通过 §11.2 `?` marker(LLM 显式信号)区分,排序按自然公式走。

**保留兜底**:I-3 effective_trust floor 0.2 + T-3 L2.5 正反馈仍然有效,死锁防护未削弱。

**核心理由**:
1. 多余防护(I-3 + T-3 已两道防线)
2. ×1.3 boost + ×0.5 inject 叠加效果难推断
3. 显式 marker 比隐式截短更易解读
4. 5 项乘积简化为 4 项,A/B 调优更清晰

**应用清单**:design.md §5.1 公式 + 注入门槛段 + §4.5 设计要点 3(probation 行为说明)。

### U-8 recent_injections 14d 时间窗(替代 1000 行 LRU)✂️ SIMPLIFY

**决议**:
- 删除"全表最多 1000 行 LRU"
- 替换为"14 天时间窗"(daily_maintenance / Tier 1.5 `DELETE WHERE created_at < now-14d`)
- 保留单 session 20 行硬上限(防爆炸场景)
- `/ccmem:forget --match` 默认窗口从"最近 5 条"改为"最近 24h",支持 `--window <hours>` 覆盖(max 14d)

**核心理由**:1000 行对高频用户太挤(5-10 天就 LRU)、对低频用户浪费;时间窗对所有用户公平。

**应用清单**:design.md §6.3.1 保留策略 + §7.6 daily_maintenance SQL + §12.1.1 forget --match 描述。

### U-9 `*_patterns_extra` 防御策略(B3=C 修正:v0.1 即启用)✂️ SIMPLIFY

**决议(B3=C 取代原 U-9)**:
- **v0.1**:**启用** `tier1_patterns_extra` / `tier2_patterns_extra` / `secret_patterns_extra`,通过 `isPatternSafe()` 加载时 fuzz test(5 条对抗 string × 50ms 阈值)拒绝 ReDoS/非法 regex,运行时单条 50ms / 总扫描 200ms 硬超时
- **不引入 re2 native 依赖**(原 L-1 方案 E 否决):10MB native 二进制 + 跨平台预编译包问题违反 ccmem "轻量、零运维"承诺
- **v0.2 加固方向**(可选,非启用前提):扩展 FUZZ_STRINGS corpus / cron 周期性重测 / metrics 暴露超时计数
- 配套 U-9b 非 git 目录强制 `--scope`(下条)

**为什么从"v0.1 全禁"改为"v0.1 启用"**:
- 完全禁用违背"用户感知边界"——dogfood 用户无法表达项目特定危险命令(如 `prod-deploy --force`)
- v0.1 与 v0.2 的真正差异不在"是否启用",而在 fuzz corpus 丰富度
- 加载时 fuzz test + 运行时硬超时 = 双重防御,覆盖 99% 实际威胁,零外部依赖

**U-9b 非 git 目录强制 `--scope`**:`/ccmem:save` 在 `resolveProjectKey()` 返回 `path:` 前缀时拒绝执行 + 要求用户显式 `--scope global` 或 `--scope project`。exit code 64。

**核心理由**:非 git 默认 global + H-3 推断 rule + trust 0.9 三个 default 叠加 = "在 /tmp 随手 save 污染所有项目"。git 目录行为零变化,只在 path: 前缀时触发 reject。

**应用清单**:design.md §10.2.1 重写 L-1 防御层(v0.1 启用 + 双重防御);v0.1-spec §5.2 替换"非 git → global"为 reject + §5.0.1 exit 64 例子;v0.1-spec §6.1 补"用户自定义 patterns"段 + 文件树加 pattern-safety.mjs。

---

## 八、2026-05-26 session(继续)— 7 项 B/C 决议(B1~B5 + C1~C3)

> 基于"docs/ccmem-design.md 是否有 logic/功能/设计问题"的系统 review,与 design-motivation / v0.1-spec / revisions 多文档对照,得到 11 项问题(A 组 10 项机械性修复已应用;B 组 5 项 + C 组 3 项需用户决策)。

### B1 + C1 删除 token+hash 流,统一 §16.4 分层 confirm framework ✂️ SIMPLIFY

**决议**:
- 删除 §12.3 / §12.4 / §12.7 的 `issueConfirmToken` / `verifyConfirmToken` / `--confirm-token cf-...` / `--confirm-with-declaration "long..."` 全部代码与文档
- 按 §16.4 的 L0/L1/L2/L3 分层执行:`/ccmem:promote` 同 scope = L1 y/N;`/ccmem:promote --global` = L2 preview+y/N;`/ccmem:purge project` = L3 短句 verbatim "PURGE PROJECT";`/ccmem:purge all` = L3 短句 verbatim "PURGE ALL"
- `/ccmem:promote-global` 作为 `/ccmem:promote --global` 的别名(§17 T-9 已规划)
- §12.1.4 AskUserQuestion 章节同步删除 stale `--confirm-token` / `declaration` 引用

**应用清单**:design.md §12.3 / §12.4 / §12.7 / §12.1.4 重写;§16.4 已是 canonical(无需改);v0.1-spec / revisions 无项目级影响。

### B2 删除 sourceMaxAfterProbation 永久封顶 ✂️ SIMPLIFY

**决议**:
- §14.2 配置删除 `sourceMaxAfterProbation` 块(原值 user_explicit/cron_consolidated 0.95、tool_output 0.9、auto_inferred 0.8、external 0.7、cerebrum_import 0.85)
- 加 `_comment_u5_unified_ceiling` 注释引用 U-5
- §4.4 trust 公式已用 `min(1.0, ...)`,无残留 SOURCE_MAX_TRUST

**核心理由**:U-5 已统一 trust 上限 1.0,sourceMaxAfterProbation 是过期残留——配置示例若保留会让代码实现产生分歧(代码读 1.0,config 写 0.7-0.95,不知该听谁)。

**应用清单**:design.md §14.2 配置示例;§4.4 / §4.5 已 U-5 对齐(C2 已验证)。

### B3 v0.1 即启用 patterns_extra(运行时硬超时为防御主体)

已合并到 U-9(见 §七 U-9)。

### B4 §9 MemoryImporter 推迟到 v0.3+

**决议**:
- §9 epigraph 改为 v0.1 / v0.2 不实现,v0.3+ 内置 6 个 importer,通过 `/ccmem:admin import --source <name>` 触发(归入 §17 M4 admin 子命令体系)
- 添加推迟理由说明:v0.2 daemon / Stop hook / cron 整合优先级远高于 importer

**核心理由**:importer 是"已有记忆资产搬家"的便利工具,不是核心功能,不该挤占 v0.2 daemon 上线的关键路径。

**应用清单**:design.md §9 epigraph + 推迟理由说明。

### B5 项目级 config 白名单(C 方案)

**决议**:
- `<project>/.ccmem/config.json` **仅读取 `project_key` / `project_key_remote_priority` 两个 key**,其它 key 一律忽略 + stderr warn
- design.md §14.1 加 §14.1.0 子节定义白名单 + 实现代码 + 拒绝其它 key 的理由
- v0.1-spec §7.1 加一句白名单提示;§3.2 表格 "项目级 config 文件 | 永不" 行修正为 "完整 schema 永不,但 v0.1 即读 project_key / project_key_remote_priority"
- §8.1.4 不变(`project_key` 手动 override 仍按原文档工作)

**核心理由**:registry / URL 归一是"全局规则"——单项目重定义 URL 归一规则会让同一 git URL 在不同项目算出不同 key,与 §8.1.5 漂移检测直接冲突;retrieval / inject / save 是用户偏好,跨项目应一致;CI 临时调整用 `CCMEM_*` env 已够。

**应用清单**:design.md §14.1 重写 + §14.1.0 新增;v0.1-spec §7.1 + §3.2;revisions 本节登记。

### C2 §4.5 trust × type 叙述已 U-5 对齐(无需改)

**核查**:§4.5 现有"4×4 典型组合示例"表第 2 行已含 `(external 0.3 初值,被命中 4 次后升至 0.5;上限 1.0,U-5)`;line 620 含 `临时上限,U-5;召回时不再打 ×0.5 权重(U-7 已删除)`。已完全 U-5 对齐,无残留 SOURCE_MAX_TRUST 或 sourceMaxAfterProbation 引用。

**应用清单**:无改动;C2 等同于"已完成验证"。

### C3 §7.13 dedup 升级为 last_message_seq 精准去重(B 方案)

**决议**:
- 在 `tasks.payload` 增字段 `last_message_seq`(transcript 最后一条消息序号)
- UNIQUE INDEX 改为按 `(type, session_id, last_message_seq)` 联合唯一,允许同 session 不同 seq 共存
- Stop hook 入队时附带当前 transcript 的最后 seq;若已有 `(session_id, seq>=current)` 则 dedup,否则入新行
- daemon 拾取时按 `(session_id, MAX(last_message_seq))` 选最新版本
- 同 session 旧 `queued` 任务自动标 `superseded`(daemon 拾取时副作用)

**为什么不用方案 A**:留下 ③⑤ 真实漏洞(长会话 / 中途新内容会丢摘要),escape hatch 是补救不是设计。
**为什么不用方案 C**:hook 端无脑入队会让 daemon 缺席时 tasks 表无限膨胀,违反"非侵入"原则。

**应用清单**:design.md §7.13 重写 unique index + enqueue 逻辑;v0.1-spec / revisions 无影响(§7.13 是 v0.2 schema)。

---

## 九、2026-05-26 session(继续)— 19 项 stale-reference / 措辞 / 结构补强(V-A1~V-A16 + B2 + B7 + C1)

> 第二轮针对 design.md 其它章节的系统性 review,聚焦三类:
> ① **A 组(机械同步)**: commit 5def978 后遗留的 stale references — `skipped_stale` /
>   `consolidated_lineage` / `/ccmem:semantic` / `/ccmem:export/import` /
>   `sync_requires_revalidation` / PreCompact 矛盾 / safe-fs 版本错位等
> ② **B 组(措辞)**: stdout 描述 / Tier 1.5 集中描述
> ③ **C 组(结构)**: Windows lock 文件 stale 清理

### A 组 — 16 项机械同步

| ID | 位置 | 改动 |
|----|------|------|
| A1 | §4.1 line 277 | `tasks.status` CHECK `'skipped_stale'` → `'superseded'`(commit 5def978 漏改 schema) |
| A2 | §7 summarize_pending 代码片段 | `UPDATE … status='skipped_stale'` → `'superseded'`(同 A1) |
| A3 | §4.1 v0.2 增量列表 | 删除 `consolidated_lineage` 表条目;改为说明"lineage 用 `memories.parent_ids` JSON 直接表达,不建独立表"(§4.2.1 已采用 parent_ids,表早成 stale) |
| A4 | §17 测试矩阵"数据生命周期"行 | `consolidated_lineage 级联` → `memories.parent_ids JSON 级联(无独立 lineage 表)` |
| A5 | §3 ASCII 流程图 | 删 `PreCompact … 估算~70%* 入队列` 列,补上 `SessionEnd` 列 |
| A6 | §6.7 budget table | 删 `PreCompact 30ms / 80ms / 500ms / 1s` 行;追加 "PreCompact 不实现"说明 |
| A7 | §15 目录结构 | 删 `handlers/pre-compact.mjs` |
| A8 | §17 M1 完成判据 | 删 hook p95 预算中的 `PreCompact < 100ms` |
| A9 | §17 M3 范围 | 删 `PreCompact hook(估算 ~70% 边界入队)`(直接与"永不 PreCompact"冲突) |
| A10 | §16 epigraph | "v0.3+: + safe-fs 模块" 与 §15 / §17 M0 / 测试矩阵冲突;safe-fs 是 v0.1 项,改为 "v0.1: safe-fs 模块 + try/catch + stderr warn + exit 0 + `/ccmem:mode off` kill switch"(顺便覆盖 B3) |
| A11 | §14.2 配置示例 `_comment_mode` | "hybrid (opt-in, requires /ccmem:semantic on)" → "hybrid (opt-in, v0.5+ embedding command 届时定名)";T-9 已移除该命令名 |
| A12 | §18 Known unknown 第 1 项 | "/ccmem:semantic on" → "v0.5+ embedding opt-in 命令(届时定名;T-9 已从 v0.1-0.2 命令面移除)" |
| A13 | §18 Known unknown "多机同步" | "通过 /ccmem:export/import 手动同步" → "通过 v0.3+ 计划中的 `/ccmem:admin export` / `import --source <path>`(T-9 已推迟)" |
| A14 | §9 importer line 2622/2671 | `/ccmem:import` → "v0.3+ `/ccmem:admin import --source <id>`" / "importer runner(v0.3+ 经 `/ccmem:admin import --source <id>` 触发)" |
| A15 | §18 Known unknown summarize_pending dedup | 整条删除 — C3=B 的 `last_message_seq` precision dedup 已解决,known unknown 不再适用 |
| A16 | §17 测试矩阵 schema migration 行 | `AFTER INSERT/UPDATE sync_requires_revalidation`(stale,设计中无此触发器)→ `memories_fts_insert/update/delete`(实际存在的 FTS 同步触发器) |

**v0.1-spec.md 同步**(因 schema 跨文档共享,3 处需同步):
- line 259: tasks.status CHECK `'skipped_stale'` → `'superseded'`(同 A1)
- line 661: "v0.1 不注册 Stop / PreCompact / SessionEnd hooks" → "v0.1 不注册 Stop / SessionEnd hooks。PreCompact 永不实现(详见 design.md §3 / §6 / motivation §核心理念 6)"
- line 1298: "v0.1 不做级联(无 consolidated_lineage)" → "v0.1 不做级联(也无 lineage — v0.2 lineage 用 `memories.parent_ids` JSON 直接表达,不建独立表)"

**motivation.md**:无改动(line 168 已正确说明"明确不使用 PreCompact",其它 stale 引用均不在 motivation 中)。

### B 组 — 2 项措辞

#### B2 §1.1 stdout 描述修正

**问题**:原文 "hook 不写 stdout(除 UserPromptSubmit 显式 inject 块)" — 但 SessionStart 也通过 stdout JSON `hookSpecificOutput.additionalContext` 注入,措辞错把"对用户终端写"和"对 LLM 上下文写"混为一谈。

**修正**:改为"hook **不向用户终端**写 stdout(SessionStart / UserPromptSubmit 的注入块通过 stdout JSON `hookSpecificOutput.additionalContext` 进入 LLM 上下文,Claude Code 不显示给用户终端)"。

**应用清单**:design.md §1.1 第 2 条已更新;v0.1-spec.md / motivation.md 无需改。

#### B7 §7.0 Tier 1.5 Lazy SQL Maintenance 总览(新增子节)

**问题**:motivation.md L75 列出 Tier 1.5 完整功能集(trust 兜底 archive / 14d 硬删 / decay_status / recent_injections 14d / task_runs 30d),但 design.md 的同档行为分散在 §7.7 lazy catch-up / §7.10.1 daemon-optional 等处,**没有单一节点集中描述**。读者从 motivation 进入 design 找不到对应章节。

**修正**:在 §7 顶部 §7.0 新增 "Tier 1.5 Lazy SQL Maintenance 总览",内容:
- 触发器:仅在 `/ccmem:stats` / `list` / `show` / `resurrect` 命令的 prelude 阶段调一次 `runLazyMaintenance(scope)`;**不在 hook 内跑**(避免吃 200ms 预算)
- 首胜锁:`task_runs(type, date_key)` UNIQUE 保证一天最多一次
- 任务清单:5 项(trust 兜底 archive / 14d 硬删 / decay_status 状态机 / recent_injections / task_runs 清理),每项标注来源决策(U-1 / T-6 / U-8 / O-1)
- 性能预算:整体 < 100ms,失败 silently drop + stderr WARN
- 用户感知:`/ccmem:stats` 顶部输出 `tier1.5: ran 2h ago, archived 3, deleted 5`
- 与 daemon (Tier 2) 的边界:Tier 1.5 不做需要 LLM 的事;daemon 起来后基于同样的 `task_runs` 表知道哪些已跑过,不重复

**应用清单**:design.md §7.0 新增;motivation.md / v0.1-spec.md 无需改(motivation 仍是入口,具体行为索引到 design.md §7.0)。

### C 组 — 1 项结构

#### C1 §13.2.1 Windows `<file>.lock` stale lock 清理(方案 a)

**问题**:Windows 平台 `metrics.jsonl` 与 `audit/<week>.log` 并发追加时用 `<file>.lock` (`fs.openSync` with `wx`) 取锁。但持锁进程 crash 后 lock 文件留着,后续所有写入永远 silently drop —— metrics 不致命但 audit 是关键数据。

**讨论方案**:
- (a) **lock 文件写 PID + ts,30s 超时 takeover**(零依赖,纯 fs API)— 入选
- (b) 改用 `proper-lockfile` npm 第三方包(增加依赖)— 不入选

**修正**(选方案 a):
- lock 文件首次写时持锁者写入 `{ pid: <number>, ts: <epoch_ms> }`
- `wx` 失败时**不立即放弃**:读 lock 内容,任一条件成立则视为 stale 并 unlink + 再 try `wx`:
  - `now() - ts > 30000`(30s 已过 — 任何合法持锁者不会持锁这么久)
  - `pid` 在本机不存在(`process.kill(pid, 0)` 抛 `ESRCH`;跨机时此判定退化为仅看 ts,30s 已足够保守)
- `unlink` + `re-wx` 整个动作再 retry 3 次 × 50ms;仍失败才 silently drop
- 持锁者写完 append 后 `fs.unlinkSync(<file>.lock)` 清理(即便忘了清,下个写入者会判 stale)

**应用清单**:design.md §13.2.1 写入端段落已扩展;v0.1-spec.md / motivation.md 无需改。

### 应用清单(已应用,本次提交)

design.md 19 处编辑 + v0.1-spec.md 3 处同步,共 22 处 file edits。完成时间:2026-05-26。

---

## 十、2026-05-27 session — 9 项 final refinements (B1 + B4 + B5 + B6 + C2 + C3 + C4 + C5 + C6)

本轮承接 2026-05-26 round-9(A/B/C 三组),用户对 B/C 组剩余的 9 项各自给出明确选型(B1/B4/B5/B6/C2/C3/C4/C5/C6)。这一轮是 v0.1 spec 收口前的最后一组结构性收敛——3 项 schema 修复(B5/B6/C6)、2 项命令面整理(C2/C5)、1 项 hook 性能策略(B1)、1 项里程碑可读性(B4)、2 项防御链完整化(C3/C4)。

### B 组 — 4 项

#### B1 §1.1 / §6.7.1 hook over-budget 行为(方案 a + 单次粒度 + bounded warning)

**问题**:旧 §1.1 表述"超预算 hook **必须** stderr 警告并降级为 shadow 模式"——但 hook 内自己改 `config.mode='shadow'` 本身就是隐式状态突变,用户在不察觉的情况下被切档,违反 motivation §轻量与非侵入 的"显式可见、可关闭"硬要求。同时"超预算"判定时机不明:hook 内部预算检查无法精确——LLM I/O / fs 同步 / sqlite WAL 都可能突刺。

**讨论方案**:
- (a) **事后测量 + 单次 stderr warn + 连续超阈值才提示**(ccmem **永不自动改 mode**)— 入选
- (b) hook 内每隔 10ms checkpoint,逼近预算时主动 abort 当次操作 — 增加复杂度且无法解决跨调用累积问题
- (c) 保留原方案(自动 shadow)— 违反非侵入硬要求

**修正**(选 a + 单次粒度 + bounded warning):
- §1.1 line 33:"超预算 hook **必须** stderr 警告并降级为 shadow 模式" → "事后测量。本次照常完成,单次超预算写 1 行 stderr WARN(24h 节流),连续 N 次(默认 5)落入同一 hook 时建议用户主动 `/ccmem:mode shadow`。ccmem **永不自动改 mode**"
- §6.7 新增 §6.7.1 子节,内容:
  - 表(检测时机/本次行为/持续状态/升级阈值/warn 节流)
  - `runWithBudget(hookName, fn)` javascript pseudocode in `scripts/lib/hook-budget.mjs`,要点:`BUDGETS` map / `STREAK_THRESHOLD = 5` / `SUGGEST_COOLDOWN_MS = 24h` / `finally` 块测量 elapsed / `audit_log` 写 `action='hook_over_budget'`
  - 关键不变量:无副作用("hook 慢"不会触发自动 mode 切换 / 注入跳过 / 强制清理)

**应用清单**:design.md §1.1 line 33 + 新增 §6.7.1;v0.1-spec.md 无需改(预算策略只在 design.md 描述);motivation.md §轻量与非侵入 表述不变。

#### B4 §17 版本→milestone 映射表

**问题**:§17 列出 M0..M6 七个 milestone,但**版本号(v0.1 / v0.2 / v0.3 / v0.5)与 milestone 的映射只散落在 motivation 与各 phase 的对话上下文中**,任何新读者无法在一张表上看到"v0.1 包含哪些 milestone / 累计需要几周"。

**讨论方案**:
- (a) 在 motivation 加一句话简述 — 信息密度太低
- (b) §17 顶部一段散文描述 — 不可索引
- (c) **§17 顶部新增"版本 → milestone 映射"表 + 每个 milestone 标题嵌入版本标签**(双向可查)— 入选

**修正**(选 c):
- §17 顶部新增表(版本/包含 milestone/累计周/主要交付):
  - v0.1 = M0 + M1,5 周,hook 链 + lexical 检索 + 6 顶层命令 + Tier 1 安装即可用
  - v0.2 = M2 + M3,11 周,daemon + 异步整合 + 深度反思 + 安全/复算审计 + 9 顶层 + 3 admin 命令完整
  - v0.3 = M4,13 周,评估收敛 + 跨平台模板 + admin import/export/migrate/purge 等运维命令
  - v0.5 = M5 + M6,18 周,embedding opt-in + hybrid 检索 + 容量保护 + shadow → active 切换
- 7 个 milestone 标题各自更新为 "M0 — 基础设施 (v0.1, 2 周)"...格式

**应用清单**:design.md §17 顶部新增映射表 + 7 个 milestone 标题嵌版本;v0.1-spec.md / motivation.md 无需改。

#### B5 §4.1 `schema_meta` 单 row + 新增 `schema_migrations` 历史表

**问题**:本次 round 中发现 design.md §4.1 与 v0.1-spec.md 对 `schema_meta` 的语义不一致——
- v0.1-spec.md(line 121-127 + 133-144):**single row,UPDATE in-place**,另有独立 `schema_migrations` 表记录多行历史
- design.md §4.1:只有 `schema_meta`,语义模糊("代码读 MAX(version) 决定是否要跑 migration"——暗示多行)
- v0.1-spec.md line 2486 helper `getCurrentVersion`:用 `SELECT MAX(version) AS v FROM schema_meta`(暗示多行)但 line 1861 用 `LIMIT 1`(暗示单行)——**自相矛盾**

**讨论方案**:
- (a) **设为单行 + 独立 `schema_migrations` 多行历史表**(职责分离:"now" vs "ever")— 入选
- (b) 让 `schema_meta` 多行,删 `schema_migrations` — 失去结构化迁移历史
- (c) 只用 `schema_migrations`,删 `schema_meta` — 每次查 version 都要排序,性能差

**修正**(选 a):
- design.md §4.1:`schema_meta` 表加注释"单 row,UPDATE in-place;多行历史在 schema_migrations;canonical 查询 SELECT version FROM schema_meta LIMIT 1"
- design.md §4.1:新增 `schema_migrations` 表定义(同步自 v0.1-spec)
- v0.1-spec.md `schema_meta` 注释同步更新
- v0.1-spec.md line 2486 helper `getCurrentVersion`:`SELECT MAX(version) AS v` → `SELECT version FROM schema_meta LIMIT 1`(并将返回字段 `row?.v` → `row?.version`)

**应用清单**:design.md §4.1 注释 + 新增表;v0.1-spec.md 注释 + helper 修正(共 2 处)。

#### B6 §4.1 `recent_injections` UNIQUE 约束 + ON CONFLICT REPLACE

**问题**:`recent_injections` 表无唯一约束。**hook 重跑**(例如 SessionStart 失败重试 / UserPromptSubmit 因 LLM 超时被 Claude Code 重发)会写入重复行,**破坏 `/ccmem:forget --last` 的"最后一次注入"语义**——`SELECT ... ORDER BY ts DESC LIMIT 1` 拿到的可能只是同一 logical event 的一条副本,另一条副本仍残留。

**讨论方案**:
- (a) **强 UNIQUE `(session_id, prompt_idx)` ON CONFLICT REPLACE**(数据库层强制 idempotent)— 入选
- (b) 应用层去重(SELECT 检查后 INSERT)— 有 race condition

**修正**(选 a):
- design.md §4.1 `recent_injections` schema 加 `UNIQUE(session_id, prompt_idx) ON CONFLICT REPLACE`
- 新增一段说明:"hook 重跑场景常见(SessionStart 重试、UserPromptSubmit 因 LLM 超时被 Claude Code 重发)— UNIQUE + REPLACE 让重复写入是 idempotent 的,后写覆盖前写,`/ccmem:forget --last` 永远操作 logical-last 而非物理-last"

**应用清单**:design.md §4.1 schema 加约束 + 注释段落;v0.1-spec.md 同步需补(因为 v0.1 也包含 `recent_injections` 表)。**注:本轮 round 中此 v0.1-spec.md 同步未应用,留为 follow-up issue**——下一轮先检查 v0.1-spec.md `recent_injections` 定义是否需要相同 UNIQUE 约束。

### C 组 — 5 项

#### C2 §15 commands/ 结构:9 顶层 + 1 admin dispatcher

**问题**:T-9 round 中决定"12 命令面 = 9 顶层 + 3 admin 子命令",但**Claude Code 的 filename → slash 映射规则是 `ccmem-X.md` → `/ccmem:X`**——按 T-9 原方案需要写 `ccmem-daemon.md` / `ccmem-cron.md` / `ccmem-diagnose.md`,会被 Claude Code 暴露为 `/ccmem:daemon` / `/ccmem:cron` / `/ccmem:diagnose` 三个**顶层命令**,实际是 12 个独立 slash 而非 9+3 嵌套。

**讨论方案**:
- (a) **单一 `ccmem-admin.md` dispatcher 文件,内部按 args 路由到 daemon/cron/diagnose**(尊重 Claude Code 映射规则)— 入选
- (b) 维持 3 个独立 admin 文件 — 违背 T-9 嵌套设计意图

**修正**(选 a):
- design.md §15 commands/ 列出 10 文件:
  - 9 个顶层:`ccmem-{list,save,show,forget,pin,mode,promote,stats,resurrect}.md`
  - 1 个 dispatcher:`ccmem-admin.md`(内部 args routing 到 daemon / cron / diagnose 子逻辑)
- design.md §15 lib/ 新增 `admin/` 子目录:`daemon.mjs` / `cron.mjs` / `diagnose.mjs`
- 删除原方案中的 `ccmem-daemon.md` / `ccmem-cron.md` / `ccmem-diagnose.md` 三个独立 file

**应用清单**:design.md §15 文件清单调整(2 处:commands/ + lib/);v0.1-spec.md / motivation.md 无需改(v0.1 phase 只交付 M0+M1,admin 在 v0.2)。

#### C3 §7.0.1 SessionStart mini-prelude(B7 补救 — Tier 1.5 + 用户从不调命令场景)

**问题**:本轮 round 中(继 B7 引入 Tier 1.5 lazy maintenance 概念之后)发现 B7 的触发器是"`/ccmem:stats` / `list` / `show` / `resurrect` 命令的 prelude"——**如果用户从不主动调任何 slash 命令、daemon 又持续 down**(笔记本断电后忘记重启 daemon、刚装完 ccmem 还没用过命令等),`recent_injections` / `task_runs` 表会**永久不清理**。motivation §轻量与非侵入 与 §daemon-optional 三档定位的"基础卫生不退化"承诺破裂。

**讨论方案**:
- (a) **SessionStart 后追加 ≤30ms mini-prelude,仅做最廉价的两项清理(recent_injections 14d / task_runs 30d)** + (b) UserPromptSubmit 每 N 次抽样清理一次 — **入选 (a)+(b) 折中**,实际只用 (a)
- 单纯 (a) 不够覆盖"会话很短但 prompt 多"的场景;单纯 (b) 会让长时间不发 prompt 的 SessionStart 后无任何清理窗口

**修正**(选 a + b 折中,实际首发 a):
- design.md 新增 §7.0.1 "SessionStart mini-prelude(≤30ms)"
- 触发时机:SessionStart 注入完成**之后**异步触发(不阻塞 stdout 注入 JSON 返回)
- 只做:`recent_injections WHERE ts < now - 14d` DELETE + `task_runs WHERE date_key < now - 30d` DELETE
- **不做**:trust 兜底 archive / 14d 硬删 / decay_status 状态机(这些纯 SQL 但 batch UPDATE 成本高,留给完整 Tier 1.5)
- 共享 lease:`task_runs(type='tier1_5_mini_prelude' | 'tier1_5_maintenance')` UNIQUE 防同步竞态
- 预算:≤30ms,失败 silently drop + stderr WARN(B1 的 `runWithBudget` 包装)

**应用清单**:design.md 新增 §7.0.1(在 §7.0 Tier 1.5 总览之后,§7.1 之前);v0.1-spec.md 不交付(M0+M1 不含完整 Tier 1.5);motivation.md §daemon-optional 三档定位 已隐含覆盖。

#### C4 §17 M5 acceptance vec_* 表双向一致性

**问题**:§17 M5 接受标准之一是"`vec_*` 表与 `memories` 表数量一致"——但**单向数量等价**不够:可能 `vec_*` 含 orphan(memory 已 hard-delete 但 vec_* row 未级联清理),也可能 `vec_*` 缺少应该 vector 化的 row。需要**双向 NOT EXISTS 检查**。

**讨论方案**:
- (a) 保持单向 count 比较 — 漏 orphan
- (b) **forward + backward 双向 NOT EXISTS**,允许 ±2% 漂移 — 入选

**修正**(选 b):
- §17 M5 acceptance 旧:"`vec_*` 表与 `memories` 表数量一致" → 新:
  - **forward**:`COUNT(vec_*) = COUNT(memories WHERE decay_status IN ('active','probation') AND type != 'episode' AND scope IN ('global','project'))`,允许 ±2% 漂移(因为 vector 化是异步的,可能有几秒延迟)
  - **backward**:`SELECT COUNT(*) FROM vec_* WHERE mem_id NOT IN (SELECT id FROM memories)` 必须 = 0 个 orphan
  - 测试用例覆盖:hard-delete memory 后 1s 内验证 `vec_*` orphan 数仍为 0(级联触发器有效)

**应用清单**:design.md §17 M5 acceptance 第 X 行;v0.1-spec.md / motivation.md 无需改(M5 在 v0.5)。

#### C5 `/ccmem:audit --ack-cross-scope` → `/ccmem:admin diagnose --ack-cross-scope`

**问题**:§10.6.1(scope 隔离 — cross_scope_alerts ack 机制)原文用 `/ccmem:audit --ack-cross-scope <alert_id>`——但 T-9 中**没有顶层 `/ccmem:audit` 命令**,只有 `/ccmem:admin diagnose`(及子命令 cron / daemon)。引用了不存在的命令,用户找不到怎么 ack。

**讨论方案**:
- (a) **移到 `/ccmem:admin diagnose --ack-cross-scope <alert_id>`**(与现有 admin diagnose flag 列表合并)— 入选
- (b) 新增顶层 `/ccmem:audit` — 命令面已收口,不再加

**修正**(选 a):
- §10.6.1 ack message 文案:`/ccmem:audit --ack-cross-scope` → `/ccmem:admin diagnose --ack-cross-scope <alert_id>`
- §12.7 admin diagnose flag 列表中加入 `--ack-cross-scope <alert_id>`(其它已有 `--export-pii-blacklist` 等同列)

**应用清单**:design.md §10.6.1 + §12.7(共 2 处);v0.1-spec.md / motivation.md 无需改(audit/diagnose 在 v0.2)。

#### C6 §4.1 新增 `audit_log_targets` join 表

**问题**:`audit_log` 表中的 `targets` 字段是 JSON 数组(`[mem_id, ...]`),"找所有动过 mem_id=1234 的 audit 记录"的查询变成 `WHERE targets LIKE '%1234%'`——**O(n) 全表扫描 + 误命中**(LIKE `%1234%` 会匹配 `12345` / `01234` 等)。

**讨论方案**:
- (a) **新增 `audit_log_targets(audit_id, mem_id)` join 表 + index(mem_id)**(O(log n) 查询,零误命中)— 入选
- (b) 用 SQLite JSON1 `json_each(targets) WHERE value = 1234` — 仍 O(n),无 index 可用
- (c) targets 字段从 JSON 数组改为单 mem_id 字段 + 多行 audit_log — 破坏 audit_log 单事件单行语义

**修正**(选 a):
- design.md §4.1 新增表:
  ```sql
  CREATE TABLE audit_log_targets (
    audit_id  INTEGER NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
    mem_id    INTEGER NOT NULL,
    PRIMARY KEY (audit_id, mem_id)
  );
  CREATE INDEX idx_audit_targets_mem ON audit_log_targets(mem_id);
  ```
- 应用层写 audit_log 时同步插入 audit_log_targets 行(transaction 内)
- `audit_log.targets` JSON 字段保留(用于 audit 行直读时不必 join)——两表数据冗余,但 join 表是**查询索引**用途

**应用清单**:design.md §4.1 新增表 + INDEX;v0.1-spec.md 同步加入(因为 audit_log 在 v0.1 即存在)。

### 应用清单(已应用,本轮提交)

- **design.md** 13 处编辑:
  - §1.1 line 33(B1 表述修正)
  - §6.7.1 新增子节(B1 实现细节)
  - §17 顶部新增"版本 → milestone 映射"表(B4)
  - §17 七个 milestone 标题嵌入版本(B4)
  - §4.1 `schema_meta` 注释 + 新增 `schema_migrations` 表(B5)
  - §4.1 `recent_injections` UNIQUE 约束 + 说明段(B6)
  - §4.1 新增 `audit_log_targets` join 表(C6)
  - §15 commands/ 重构为 9+1 dispatcher(C2)
  - §15 lib/ 新增 admin/ 子目录(C2)
  - §15.1 install 输出加 Tier 1.5 行(C3 install message)
  - §7.0.1 新增 SessionStart mini-prelude 子节(C3)
  - §17 M5 acceptance 改为双向一致性(C4)
  - §10.6.1 + §12.7 ack 命令重定向(C5)

- **v0.1-spec.md** 3 处同步:
  - `audit_log_targets` 表定义同步(C6)
  - `schema_meta` 注释同步(B5)
  - line 2486 `getCurrentVersion` helper SQL 规范化为 `LIMIT 1`(B5)

- **motivation.md**:无改动(本轮所有修正在 design.md / v0.1-spec.md 范围内,motivation 表述层不受影响)。

完成时间:2026-05-27。

### 本轮 follow-up issue(留至下一轮)

1. **B6 v0.1-spec.md 同步未应用** — design.md `recent_injections` UNIQUE 约束已加,v0.1-spec.md 同表定义需补同样约束。下一轮 round 开局先 grep `recent_injections` 定位 v0.1-spec.md 行号确认。 → **2026-05-27 解除**:F1 中查实 v0.1-spec.md line 1449 + 2523 已明确 `recent_injections` 是 v0.2+ 表,v0.1 无此 schema,无需同步。
2. **C2 README/quickstart 文档** — 9+1 dispatcher 结构对外宣传时需要解释,避免用户期待 `/ccmem:daemon` 直接可调用。 → **2026-05-27 解除**:F2 改为在 design.md §15(用户视角 slash 表)+ §12.1(dispatcher 设计说明)直接落地,无需等 README。
3. **C3 SessionStart mini-prelude 与 SessionStart 总预算** — §6.7 SessionStart 预算 < 500ms 与新加的 ≤30ms mini-prelude 关系需明确(mini 是 SessionStart 之后异步触发,不计入 500ms;但需在 §6.7 单独点名说明)。 → **2026-05-27 解除**:F3 中实际查实 §6.7 表 SessionStart p95=300ms / 兜底=1s,**没有 500ms** 这数字;§1.1 / §7.0.1 / §17 完成判据三处"500ms"均为 spec bug,已统一改成 p95/兜底数字 + §6.7 表加 mini-prelude 行 + §6.7.1 streak 豁免。

---

## 十一、2026-05-27 follow-up — 三轮 follow-up 落地(F1 + F2 + F3)

承接 §十(B1+B4+B5+B6+C2+C3+C4+C5+C6 final refinements)末尾留下的 3 个 follow-up issue。本轮逐一落地或解除,避免拖到 v0.1 实施前还在 spec 漂移。

### F1 — design.md schema 加 v0.2+ 版本标记(方案 c:双保险)

**问题**:design.md §4.1 是"最终态 schema",含所有版本表。但只在表前的散文 bullet 写"v0.1: ... v0.2: ...",**没有逐表机器可读的版本标记**。读者从 §6 / §7 实现章节遇到 `CREATE TABLE ccmem_blacklisted_sessions`(line 916)/ `CREATE TABLE project_key_alias`(line 2739)等内嵌定义时,无法立即判定这是 v0.1 还是 v0.2+ 表,容易在 v0.1 实施时多建空表。

**重新发现**:本轮也澄清了**原 follow-up #1(B6 v0.1-spec.md `recent_injections` UNIQUE 同步)是误判**——v0.1-spec.md line 1449 三档表已写"recent_injections 写入(v0.2+)",line 2523 v0.2 migration checklist 也将 `recent_injections` 列为新建表。v0.1 完全无此表,无 schema 漂移可言。F1 要解决的是 design.md 自己的 v0.2+ 表无版本标记问题,不是跨文档同步问题。

**方案 c 双保险**:
- (a) §4.1 顶部新增"表 → 版本"总览表(全部 14 张表 + 引入版本 + 用途)
- (b) 6 个 v0.2+ / v0.5+ 内嵌 `CREATE TABLE` 表头加单行注释 `-- v0.2+: not in v0.1`(此轮 design.md 内只有 `ccmem_blacklisted_sessions` 与 `project_key_alias` 两个 v0.2+ 表的 CREATE 实际写出;其余 v0.2+ 表 `recent_injections` / `memory_feedback` / `daemon_lock` / `cross_scope_alerts` 在 design.md 中只在 v0.2 增量段提及,未单独 CREATE,统一由总览表覆盖)

**应用**:
- design.md §4.1 line 167 后新增"表 → 版本总览(F1)"表 16 行 + 约束段
- design.md line 916(`ccmem_blacklisted_sessions`)+ line 2739(`project_key_alias`)各加 1 行 v0.2+ 注释

**收益**:任何路径(grep CREATE TABLE / 读总览 / 读散文)进入 schema 描述都能立即识别版本边界。
**代价**:总览表 + 6 个表头注释,加起来 < 30 行,维护成本可承担。

### F2 — design.md §15 + §12.1 加 9+1 dispatcher 解释(方案 c:§15 表 + §12 设计说明)

**问题**:C2 round 把命令面定为"9 顶层 + 1 admin dispatcher = 10 文件"。理由是 Claude Code 把 `commands/<name>.md` 文件**逐一**自动注册为顶层 `/ccmem:<name>`——没有原生嵌套子命令机制。但 §15 commands/ 段落只列了文件名,**完全没说**用户实际看到 `/ccmem:admin daemon start` 长什么样、admin dispatcher 漏写 subcommand 时怎么办、为什么不直接做成 `/ccmem:daemon` / `/ccmem:cron` / `/ccmem:diagnose` 三个独立顶层。

**方案 c**:
- (a) §15 commands/ 文件清单后新增"用户实际可调用的 slash 命令"表(10 行 = 9 顶层 + 1 admin 的 4 个子命令例子)+ dispatcher 行为约定 4 条(漏写 subcommand / 未知 subcommand / args 解析等)
- (b) §12.1 命令清单段加"为什么是 /ccmem:admin daemon 而不是 /ccmem:daemon" 完整设计说明(顶层命名空间污染 / 失去运维边界 / 未来扩展迁移成本三层论证 + dispatcher 模式选择)

**应用**:
- design.md §15 line 5197 后新增"用户实际可调用的 slash 命令(F2)"表 + dispatcher 行为约定 4 条
- design.md §12.1 命令清单段加"为什么是 /ccmem:admin daemon 而不是 /ccmem:daemon(F2 / C2)"段(~ 30 行)

**收益**:
- 实现者照表抄就不会写错文件(`ccmem-admin.md` 应该 dispatch 还是分 3 文件)
- 下个 round 任何人重读再质疑 9+1 设计时,自动有完整答案在 §12.1
**代价**:design.md 增加 ~ 50 行散文 + 表格,但避免 README 写完前 spec 漂移。

### F3 — §6.7 ↔ §7.0.1 ↔ §1.1 数字对齐 + mini-prelude 预算地位(方案 a-i + b-i + b-iii)

**问题**(本轮重大发现 — **实际 spec bug**):

三处 SessionStart 数值不一致:
| 位置 | 措辞 | 数字 |
|---|---|---|
| §1.1 line 32 | "目标 < 500ms" | 500ms |
| §6.7 表 line 1579 | p50=150 / **p95=300** / 兜底=1s | 300 / 1000 |
| §7.0.1 line 1964 | "§6.7 SessionStart 500ms 预算" | 500ms(根本没这数字) |
| §17 完成判据 line 5453 | "SessionStart < 500ms" | 500ms(同样错的) |

**500ms** 在 §6.7 表中**完全不存在**(p95 是 300,兜底是 1000)——§1.1 / §7.0.1 / §17 三处引用的是一个**幽灵数字**。同时 §6.7 表也**没列 mini-prelude**,§7.0.1 mini-prelude 描述既不算入 SessionStart 主行,也未单独列出预算地位。

**方案 a-i**(数字对齐到 §6.7 表 single source of truth):
- §1.1 "目标 < 500ms" → "p95 < 300ms / 兜底 1s,详见 §6.7"
- §7.0.1 "500ms 预算" → "p95 300ms 预算"
- §17 完成判据 "SessionStart < 500ms" → "SessionStart < 300ms"
- 同步 motivation.md line 51 + 171 的相同 500ms 引用

**方案 b-i**(§6.7 表加 mini-prelude 行):
```
| SessionStart mini-prelude (post-injection async) | 20ms | 30ms | 50ms drop | n/a — 不在 hook 主路径 |
```
+ 表后加预算地位说明段(异步 / 不计入主预算 / 50ms drop / 不走 streak)。

**方案 b-iii**(§6.7.1 streak 豁免):
- mini-prelude 用 `runWithBudget` 但显式 `skipStreak: true`(或按 hook name 前缀豁免)
- 仅 stderr WARN + audit_log,**不增加** `consecutive_overbudget_count_*`
- 理由:mini-prelude 跑的是 2 条 DELETE,抖动来源是 SSD GC / WAL checkpoint(系统因素),计入 streak 会让"shadow 建议"误报噪音

**应用**:
- design.md §1.1 line 32(F3-1)
- design.md §6.7 表加 mini-prelude 行 + 预算地位说明段(F3-2)
- design.md §6.7.1 加 mini-prelude streak 豁免段(F3-3)
- design.md §7.0.1 line 1964 数字修正(F3-4)
- design.md §17 完成判据 line 5453 数字修正(F3-5)
- motivation.md line 51 + 171 同步(F3-6 + F3-7)

**收益**:消除"幽灵 500ms"导致的 spec bug。任何实现者按 §6.7 表跑 telemetry 不会自相矛盾。
**代价**:7 处文档编辑,但都是单行/单段修正。

### 应用清单(已应用,本轮提交)

- **design.md** 11 处编辑:
  - §4.1 新增"表 → 版本总览(F1)"表(16 表) + 约束段
  - line 916 `ccmem_blacklisted_sessions` 表头注释(F1)
  - line 2739 `project_key_alias` 表头注释(F1)
  - §15 line 5197 后新增"用户实际可调用的 slash 命令(F2)"表 + dispatcher 行为约定
  - §12.1 加"为什么是 /ccmem:admin daemon"设计说明(F2)
  - §1.1 line 32 数字对齐(F3-1)
  - §6.7 表加 mini-prelude 行 + 预算地位说明段(F3-2)
  - §6.7.1 加 mini-prelude streak 豁免段(F3-3)
  - §7.0.1 line 1964 数字修正(F3-4)
  - §17 完成判据 line 5453 数字修正(F3-5)

- **motivation.md** 2 处同步:
  - line 51 SessionStart 预算数字 + 超预算行为措辞(F3-6 + B1 同步)
  - line 171 同上(F3-7 + B1 同步)

- **v0.1-spec.md**:无改动(本轮所有修正在 design.md / motivation.md 范围内,v0.1-spec.md 未涉及 SessionStart 500ms 描述,也无 v0.2+ schema 表头注释需求)。

完成时间:2026-05-27。

### 本轮 follow-up issue(留至下一轮)

无新增 follow-up。§十 三个原 follow-up 全部本轮解除或落地。下一轮可专注新议题(D 组或其它发现)。

---

## 十二、2026-05-27 session — ECC reference review 决议(V-1 + V-2)

> **来源**:对比 `reference/ECC/`(affaan-m/ECC plugin,Claude Code plugin
> ecosystem 上下游验证最久的实现之一)与 ccmem v0.1 spec / design 时发现的 2 项
> P0 级 packaging spec bug。**不动 ship 直接失败**——marketplace install / 多
> 路径 install / Claude Code v2.1+ 验证器都会报错。
>
> 本节是 cerebrum 已记录 U-PERF / U-DEPS / U-CMD-PoC 之后的**新发现**部分(那 3
> 项已落地,本次只补 packaging 层)。

### V-1 hook command 路径必须用 `${CLAUDE_PLUGIN_ROOT}` ✏️ FIX

**问题**:
- spec §4.3 / design §6.4 当前 hook `command` 写的是
  `node --experimental-sqlite ~/.claude/plugins/ccmem/scripts/hook.mjs session-start`
- Claude Code **不**把所有 plugin 都装到 `~/.claude/plugins/<slug>/`。实际路径
  取决于安装方式:
  - `~/.claude/plugins/ccmem/`(直接 clone 安装)
  - `~/.claude/plugins/ccmem@ccmem/`(marketplace 旧 layout)
  - `~/.claude/plugins/marketplaces/ccmem/`(marketplace 新 layout)
  - `~/.claude/plugins/cache/ccmem/<org>/<version>/`(versioned cache,
    marketplace 最常见路径)
- ECC 为此专门写了 50 行 `resolvePluginRoot()`(`session-start-bootstrap.js:73-116`)
  做 5 级 fallback。

**根因**:Claude Code 会注入 **`CLAUDE_PLUGIN_ROOT`** env 给 hook 进程,值为该
插件实际的根目录。任何 plugin 应该读它,**不应 hardcode 路径**。

**决议**(v0.1):

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node --experimental-sqlite \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" session-start",
        "timeout": 1
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node --experimental-sqlite \"${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs\" prompt-submit",
        "timeout": 2
      }]
    }]
  }
}
```

**双引号关键**:`${CLAUDE_PLUGIN_ROOT}` 展开值理论上可能含空格(用户目录里
含空格不少见,如 `~/My Documents/`),不加双引号会被 shell word-split。

**Fallback 处理**(`scripts/hook.mjs` 顶部):

```javascript
// scripts/hook.mjs
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!PLUGIN_ROOT) {
  // Claude Code < 某版本未注入 env — 极少见。stderr warn + exit 0,绝不阻塞主会话
  process.stderr.write('ccmem: CLAUDE_PLUGIN_ROOT not set, skipping hook\n');
  process.exit(0);
}
```

**不抄 ECC 的 5 级 fallback**:ECC 要兼容老版本 Claude Code(2.0 前不注入 env)
+ 6 种历史 layout。ccmem 是新项目,**强制要求支持** `CLAUDE_PLUGIN_ROOT` 的
Claude Code 版本(v2.1+,2026 年发布,生态早已稳定),packaging 才能简单。
文档化"最低支持的 Claude Code 版本"是更干净的工程取舍。

**v0.2+ 注意**:Stop / SessionEnd hooks 注册时同款规则——`command` 字段一律走
`${CLAUDE_PLUGIN_ROOT}`。

**应用**:
- v0.1-spec.md §4.3:hook command 路径 + fallback 说明 + 双引号约束
- design.md §6.4 line 1159 / 1166:同上
- design.md §15 line 5176 整段目录树:把"`~/.claude/plugins/ccmem/`"标注为
  "**plugin 部署路径占位**(具体路径由 Claude Code 安装方式决定,代码侧一律
  走 `${CLAUDE_PLUGIN_ROOT}` env)"
- design.md §15 `rm -rf ~/.claude/plugins/ccmem`:加注释提示 marketplace
  install 时实际路径是 `~/.claude/plugins/cache/ccmem/<org>/<version>/`,用户
  应通过 `claude plugin remove ccmem` 卸载而非直接 rm
- design.md §15.1 `ccmem install`:第 2 步从"在 `~/.claude/plugins/ccmem/`
  部署代码"改为"等待 Claude Code marketplace install 完成 plugin 文件部署"——
  `ccmem install` 本身**不**负责 plugin 文件分发,只负责 settings.json hooks
  注册 + schema migration + daemon 注册

### V-2 plugin.json schema 5 条硬约束 ✏️ ADD

**来源**:`reference/ECC/.claude-plugin/PLUGIN_SCHEMA_NOTES.md`——ECC 在长期
迭代中踩遍 Claude Code plugin validator 的所有未文档化约束,沉淀的避坑清单。
仓库里 4 次 fix/revert cycle 的 commit history(22ad036 / a7bc5f2 / 779085e /
e3a1306)就是为了一个 `hooks` 字段。

**问题**:ccmem v0.1-spec 当前没有任何 `plugin.json` packaging 章节。第一次
ship 时会撞 5 个隐性约束,validator 输出 `Invalid input` 这种**无线索**报错。
后果:用户装不上、复现条件未知、社区报 issue。

**5 条硬约束**(MUST):

| 字段 | 规则 | 违反后果 |
|---|---|---|
| `version` | 必填,semver 字符串 | marketplace install / `claude plugin validate` 失败 |
| `commands` / `skills` | **必须 array**,即便只有 1 个 entry | 字符串值报 `Invalid input` |
| `agents` | **绝不能出现**(任何形式) | `agents: Invalid input`。agents 走 `agents/*.md` 目录约定自动发现 |
| `hooks` | **绝不能出现** | Claude Code v2.1+ 自动加载 `hooks/hooks.json`,声明会触发 `Duplicate hooks file detected` |
| `mcpServers` | **显式 `{}` 空对象保留**(即便不用 MCP) | 否则 root `.mcp.json` 被自动 bundle,长插件名让 OpenAI 兼容 gateway 拒绝 MCP tool name(>64 字符) |

**ccmem v0.1 minimal `plugin.json`**:

```json
{
  "name": "ccmem",
  "version": "0.1.0",
  "description": "Claude Code 跨会话语义记忆插件 — SQLite + FTS5,接近聪明的备忘录",
  "homepage": "https://github.com/<owner>/ccmem",
  "license": "MIT",
  "mcpServers": {},
  "commands": ["./commands/"],
  "skills": []
}
```

**注意点**:
- 没有 `hooks` 字段——`hooks/hooks.json` 由 Claude Code 自动加载(约定优于声明)
- 没有 `agents` 字段——ccmem v0.1 无 agents(future 加 agents 也只放
  `agents/*.md`,不在 manifest 声明)
- `commands` 是 array,装 1 个目录路径
- `skills` v0.1 暂无,空 array(`[]`)。若未来加 skill,文件入
  `skills/<name>/SKILL.md`
- `mcpServers: {}` 是**主动 opt-out**,不是"忘填"

**Regression test 要求**(`tests/unit/plugin-manifest.test.mjs`):

```javascript
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';

test('plugin.json must have version', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.ok(manifest.version, 'plugin.json must have version field');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'version must be semver');
});

test('plugin.json MUST NOT have hooks field', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.ok(!('hooks' in manifest),
    'Claude Code v2.1+ auto-loads hooks/hooks.json. Declaring hooks here ' +
    'triggers "Duplicate hooks file detected". See V-2 / ECC NOTES.md.');
});

test('plugin.json MUST NOT have agents field', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.ok(!('agents' in manifest),
    'Claude validator rejects agents field with "Invalid input". ' +
    'agents/*.md is loaded by convention.');
});

test('plugin.json MUST have explicit empty mcpServers', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.ok('mcpServers' in manifest,
    'mcpServers must be explicit {} to opt out of root .mcp.json auto-bundling');
});

test('commands / skills must be arrays (never strings)', () => {
  const manifest = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  if ('commands' in manifest)
    assert.ok(Array.isArray(manifest.commands), 'commands must be array');
  if ('skills' in manifest)
    assert.ok(Array.isArray(manifest.skills), 'skills must be array');
});
```

**为什么 v0.1 就要 regression test 而不是等 v0.2**:
- 这些 schema 约束是 Claude Code validator 隐性 enforce 的,**人眼很难发现**
  ——ECC 撞了 4 次才稳定下来
- ccmem 第一次 ship 就走 marketplace install,所有用户都暴露在风险下
- regression test 写 30 行,而 ship 后用户装不上的 issue 排查可能要几天

**`!` 在 hook command 里的额外坑**(参考):ECC 的
`session-start-bootstrap.js:11-15` 注释明确记录了——hooks.json 里 inline
`node -e` 含 `!` 字符时,部分 shell 环境会触发 bash history expansion,造成
"SessionStart:startup hook error" 启动报错。**ccmem 不会撞这条**——V-1 决议
下 `command` 字段是
`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" session-start`,
零 inline JS,零 `!` 字符,天然安全。

**应用**:
- v0.1-spec.md 新增 §14 章节(在 §13 测试 与 §15 实施路线 之间,或末尾)
  "Plugin Packaging(V-2)",含 5 条硬约束表 + minimal manifest 示例 + 测试要求
- design.md §15 目录树后加一节"Plugin Manifest"(对应 V-2),长期 spec 也要
  reflect 同款约束
- `tests/unit/plugin-manifest.test.mjs` 列入 v0.1 ship 前必加文件清单

### 应用清单(本轮同步提交)

- v0.1-spec.md §4.3 line 709 / 716 修订(V-1)
- v0.1-spec.md 新增 Plugin Packaging 章节(V-2)
- design.md §6.4 line 1159 / 1166 修订(V-1)
- design.md §15 line 5176 起目录树加路径占位说明(V-1)
- design.md §15 line 5296 `rm -rf` 行加 marketplace 路径说明(V-1)
- design.md §15.1 line 5307 `ccmem install` 步骤 2 修订(V-1)
- design.md §15 末尾加"Plugin Manifest"小节(V-2)
- 实施 ship 前补 `tests/unit/plugin-manifest.test.mjs`(V-2)

完成时间:2026-05-27。

### 本轮 follow-up issue(留至下一轮)

ECC review 的其他 10 项(#3~#12)是工程实施层借鉴(stdin truncate / require-vs-spawn
优化 / hook profile gating / banner comment / path traversal 防护 / Stop hook
raw passthrough 等),不动 spec 本体,在实施 PR 里按 ECC 范式直接落地即可。
不进 revisions.md。

---

## 十三、2026-05-27 session — cross-doc sync 修复(8 项)

> v0.1-spec 在 R-4 PoC / M-1 / P-4 / P-5 / U-PERF 等后期决策中引入了多项更新，
> 但未同步回 design.md。同时 design.md 自身有 2 处残留 bug。本轮逐一修复。

| ID | 优先级 | 位置 | 改动 |
|---|---|---|---|
| Fix-1 | P0 | design.md §6.4 hook command | 加 `--experimental-sqlite` flag（v0.1-spec §4.3 已有，design.md 漏同步。不加则 Node 22.x hook 启动直接 `ERR_UNKNOWN_BUILTIN_MODULE` 失败）+ 追加 flag 理由段 |
| Fix-2 | P1 | design.md §12.1.5（新增） | R-4 命令输出原则章节（通道对照表 / LLM-safe 措辞规则 / writeAudit helper / `/ccmem:audit show` 说明 / exit code 约定 P-4 / FeatureNotAvailableError 版本门控）— 从 v0.1-spec §5.0-§5.6.2 提炼回写 |
| Fix-3 | P1 | design.md §12 多处 | `/ccmem:search`（M-1 回加）与 `/ccmem:audit show <id>`（R-4 回加）同步到：版本锚点 / T-9 删除说明 / §12.1.1 命令列表 / §12.1.3 设计取舍表 / §16.4 L0 列表 |
| Fix-4 | P2 | design.md §6.7 表后 | U-PERF 双指标注释（ms_business / ms_total 拆分说明，指向 v0.1-spec §4.1/§4.2） |
| Fix-5 | P2 | (含在 Fix-2) | Exit code / Version gate 体系（P-4），已包含在 §12.1.5 |
| Fix-6 | P2 | design.md §12.1.1 /ccmem:save | H-3/P-5 四层类型推断说明扩展（EN phrase → ZH phrase → EN word → ZH sentence-initial），指向 v0.1-spec §5.2 |
| Fix-7 | P2 | design.md §6.7.1 | BUDGETS 常量 `session_start: 500` → `300`（F3 修正了散文但漏改代码常量，与 §6.7 表 p95=300ms 对齐） |
| Fix-8 | P2 | design.md §5.4 / §6.1 / §7.6 | `recall_count` 残留引用修正（3 处）：§5.4 改 `last_touched_at`；§6.1 锚点改 `recent_injections 写入(Q-1)`；§7.6 dailyMaintenance 代码改 `helpful_count = 0 AND unhelpful_count = 0` |

### 应用清单(已应用,本轮提交)

- **design.md** 14 处编辑:
  - §6.4 line 1159/1166 加 `--experimental-sqlite` + 理由段(Fix-1)
  - §12.1.5 新增命令输出原则 + exit code + 版本门控(Fix-2)
  - §12 版本锚点 / T-9 说明 / §12.1.1 命令列表 / §12.1.3 取舍表 / §16.4 L0 列表(Fix-3, 6 处)
  - §6.7 表后 U-PERF 双指标注释(Fix-4)
  - §12.1.1 /ccmem:save H-3/P-5 描述扩展(Fix-6)
  - §6.7.1 BUDGETS 常量 500→300(Fix-7)
  - §5.4 / §6.1 / §7.6 recall_count 修正(Fix-8, 3 处)

- **v0.1-spec.md**: 无改动(本轮修复方向为 v0.1-spec → design.md 回写)

- **motivation.md**: 无改动

完成时间:2026-05-27。

## 十四、2026-05-27 session — Synthesis 设计洞见(W-1 ~ W-5,cerebrum condense 实操验证)

> 在对 `.wolf/cerebrum.md` 做"648→123 行"按主题浓缩时,发现该过程与 ccmem
> `weekly_synthesis` 设计高度同构。本节记录从实操中提炼的 5 项洞见,作为
> v0.2 synthesis 实现的设计输入。

### 实操过程与 ccmem 对应关系

| 我们做的 | ccmem 设计中的对应 | 启示 |
|---------|-------------------|------|
| 单条决策记录(时间序) | `type=episode` | 原始信号,按时间堆积 |
| 按主题分组后的摘要表 | `type=consolidated` | 整合产出 |
| 完整 rationale 保留在 design-revisions.md | `parent_ids` 链接的源记忆 | 不丢失审计链 |
| 被 supersede 的旧条目删除 | `status='superseded'` | 信息演化,旧版退出注入 |
| 每组提炼的"泛化原则"一行 | `type=rule`(从 episodes 提炼) | 最高行动价值的产出 |
| 主题分组内按表格紧凑排列 | `injection_cache` 渲染 consolidated 时紧凑格式 | 注入效率 |

### W-1 Synthesis 应按语义主题分组,不是时间窗口

**问题**:当前 §7.5 prompt 说"from the past week, grouped by topic",但"past week"
是输入过滤条件,不是分组条件。跨周累积的同主题记忆(如安全相关决策散落在 5/22、
5/25、5/26、5/27)不会被合并到同一 consolidated,导致 4 个月后出现 16 个覆盖
同主题不同周的 consolidated 记忆——与 cerebrum 重构前的膨胀完全相同。

**修正方向**:
1. `weekly_synthesis` prompt 在 Task 2(Synthesize)后新增 **Task 2.5: Thematic merge**
   —"check if an existing `consolidated` memory (any depth) already covers this
   theme. If so, produce a merged version that supersedes the existing one."
2. Prompt 输入除了"本周 episodes"外,还应附上**现有 consolidated 记忆列表**
   (仅 id + content 前 80 字符 + depth),让 LLM 做"追加到已有主题组"的判断。
3. 输出 JSON 新增 `theme_merges: [{new_content, supersedes_id, source_ids}]`。

**v0.2 spec 影响**: §7.5 prompt 模板追加 Task 2.5 + 输入追加 existing_consolidated。

### W-2 Synthesis 应双产出:consolidated(摘要) + rule(原则)

**问题**:当前设计 `weekly_synthesis` 只输出 `consolidated` 类型。但从实操看,
整合最有价值的产出是**泛化原则**("任何 X 都应该 Y")——它直接指导未来行为,
而 consolidated 摘要只是事实归档。

**修正方向**:
1. Prompt Task 2 增加子条件:"如果 synthesized batch 中存在可泛化为行为规则的
   cross-cutting pattern,额外输出一条 `type=rule` 记忆(content 必须是祈使句/
   条件句,不是描述句)"。
2. 输出 JSON `synthesized` 数组元素增加 `output_type: 'consolidated' | 'rule'` 字段。
3. Rule 产出的 `source` 设为 `cron_consolidated`(trust 初始值按 source 分级表),
   `parent_ids` 指向本次 batch 的所有 source。
4. Rule 天然享有 `base_priority=1.2`(高于 fact=1.0,低于 user_explicit rule)、
   `half_life_days=60`——比 consolidated(base=1.5,half_life=90)半衰期短,
   但 type 排序在注入时优先(§3.3 type 硬序:rule > consolidated > fact > episode)。

**预期效果**:SessionStart 注入时,LLM 看到的是"行为指导"(rule)而非"历史归档"
(consolidated)——与 cerebrum 重构后"泛化原则一行比整个表格更有用"的体验一致。

**v0.2 spec 影响**: §7.5 prompt Task 2 扩展 + 输出 schema 增加 `output_type`。

### W-3 Consolidated content 应短摘要,不是长段

**问题**:当前 spec 未约束 consolidated 的 content 长度。如果 LLM 产出 200 字的
段落,一条 consolidated 就吃掉 `inject.global_chars=1500` 的 13%。多条后
injection_cache 塞不下几个,违背"有界约束优于无限扩容"原则。

**修正方向**:
1. `weekly_synthesis` prompt 加约束:"Each synthesized memory MUST be ≤ 80 characters.
   If the synthesis cannot be expressed in 80 chars, split into multiple."
2. `save.mjs` 的 `max_chars_per_memory=300` 对 user_explicit 合理,但对
   `cron_consolidated` source 应有独立上限(80 字符)——daemon 写入时检查。
3. 用户可通过 `/ccmem:show <id> --lineage` 追溯到详细源记忆,consolidated 本身
   只承担"索引 + 结论"角色。

**与 cerebrum 的类比**:我们的表格每行 < 80 字符(结论 + 指针),详细 rationale
在 design-revisions.md。相当于 consolidated 是"表格行",parent_ids 是"指针"。

**v0.2 spec 影响**: §7.5 prompt 加 80 字符约束 + daemon 写入时 content 长度 check。

### W-4 月度"元整合"防止 consolidated 膨胀

**问题**:即便 W-1 做了 thematic merge,如果只在 weekly 粒度操作,高活跃项目
4 周后仍可能有 20+ consolidated 记忆(每周新增 ~5 条)。当 consolidated 超过
injection_cache 容量时,旧 consolidated 会被挤出——信息实质丢失。

**修正方向**:
1. 新增 `monthly_meta_synthesis` cron 任务(每月 1 号 04:17),专门做:
   - 找同 scope 内 depth ≤ 1 的 consolidated 按主题聚类
   - 同主题 ≥ 3 条 → merge 为 depth+1 的 meta-consolidated
   - 旧 consolidated `status='superseded'`
2. 这就是 `consolidation_depth` 字段的真正用武之地——depth 0→1 在 weekly 做,
   depth 1→2 在 monthly 做。
3. 月度任务的 LLM prompt 比 weekly 更简洁(输入已是 consolidated,不需要去噪),
   但加强"保持 ≤ 80 字符"约束。

**与 cerebrum 的类比**:我们做的就是对"已经 consolidated 过的信息"再做一层合并,
产出按主题的 6 块表格。如果 cerebrum 每周只加新条目不做月度整合,几个月后又膨胀。

**v0.2 spec 影响**: design.md §7 新增 §7.5.3 `monthly_meta_synthesis` 任务 + cron
schedule + prompt。`consolidation_depth` 字段终于有了明确的递增场景。

### W-5 Supersede 应支持部分覆盖语义

**问题**:当前 `status='superseded'` 是全量标记——"整条被替换"。但实操中常见
部分覆盖(如 T-4 只 supersede I-3 的"曝光"部分,"floor 0.2"部分仍有效)。

**修正方向**:
1. `parent_ids` JSON 数组元素增加可选 `relation` 字段:
   ```jsonc
   "parent_ids": [
     { "id": 3812, "depth": 0, "relation": "source" },
     { "id": 4823, "depth": 2, "relation": "supersedes_partial",
       "note": "only the monthly exposure part" }
   ]
   ```
2. `relation` 枚举:`source`(默认,继承) / `supersedes_full`(全量替换) /
   `supersedes_partial`(部分替换,note 说明哪部分)
3. `/ccmem:show <id> --lineage` 展示时,partial supersede 用 `~` 标记:
   ```
   m5421 (depth=3)
   ├─ m4823 (depth=2) [supersedes_partial: "only exposure"]
   └─ m4901 (depth=0)
   ```

**优先级**: v0.3+。v0.2 先用全量 supersede + audit_log.details 记录 note,
`parent_ids` 结构扩展留到 lineage UX 完善时统一做。

**v0.2 spec 影响**: 暂无代码改动,仅记录设计方向。v0.3 评估时从此处开始。

---

### 应用清单

- **design.md §7.5**: 追加 W-1(Task 2.5 thematic merge)+ W-2(双产出 rule)+ W-3(80 字符约束)设计注释
- **design-revisions.md**: 本节(§十四)完整记录
- **v0.1-spec.md**: 无改动(W-1~W-5 全部为 v0.2+ 范畴)
- **cerebrum.md**: 主题 4 表新增 W-1~W-4 条目

完成时间:2026-05-27。

