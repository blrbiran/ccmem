# ccmem v0.12 实施 spec

> 这是 v0.12 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) …
> [`ccmem-v0.11-spec.md`](./ccmem-v0.11-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.11 的 dogfood（Finding 10）暴露了一个系统性问题——embedding API 无超时导致
> **60 次 prompt_submit hook 连续 1500ms 超时**，`.ccmem/` 零 context 文件、`context_write_log` 0 行，
> v0.11 的 A1/A2 在生产里**从未真正跑过**。AbortController + Path B 降级虽已 ship（`retrieval.mjs:53`），
> 但那是**反应式补丁**：每次失败都重新尝试 embed，没有熔断、没有可观测信号、没有定量基线。
>
> v0.12 的主题是 **"检索硬化 + 可观测性优先，小功能增量其次"**：
> - 把"反应式降级"升级为**系统性熔断 + 失败可观测**（P1.1 + P1.2）
> - 建立**定量检索基线**，让后续检索演进（Entity linking / 预过滤 / 权重调优）有数据依据（P1.3）
> - 三个低成本高回报的小功能：temporal tag、结构化 session summary、query embedding 缓存（P2）
>
> **设计依据**：
> - [`ccmem-v0.11-dogfood.md`](./ccmem-v0.11-dogfood.md) Finding 10/11/12
> - [`docs/comparison-mem0.md`](./comparison-mem0.md) §三（Temporal Reasoning / Benchmark）
> - [`docs/comparison-claude-mem.md`](./comparison-claude-mem.md) §三（结构化 session summary）
> - 多模型融合分析（llmfusion）的 panel + Judge 共识
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。
>
> **📌 Review 修正（2026-06-23，多模型融合 review 后）**：初稿经 panel+Judge 评审发现 8 个 P0 + 一批 P1 问题，已全部修订并就地标注 `P0 修正` / `P1 修正`。核心修订：
> - P0-1/2/3：helper 名最终以当前代码为准（`maybeRunTier15`）；`config_kv` 读写未抽成独立 kv helper module，而是以内联 helper 形式保留在 `embedding/provider.mjs` / `admin/diagnose.mjs`；表名 `metrics_daily_rollup`（单数）
> - P0-4：路径从三态改**四态**（`A`/`B-off`/`B-fail`/`B-circuit`）——熔断 open 走的 `timing:null` 分支必须显式标 `B-circuit`，否则 P1.1+P1.2 互相抵消
> - P0-5/6：benchmark 强制 `embedding.enabled=false` 走 Path B（否则 `retrieveMemories` 会联网调 embed）；`cmdRetrievalCheck` 改 `async` + `await`
> - P0-7：`insertMemory` INSERT 分支列名扩展（否则 `summary_meta` 静默丢失）+ `buildSummarizePrompt` 同步更新（否则 LLM 不输出 4 字段）
> - P0-8：`effectiveHalfLifeDays` 接进 `computePriority`（`priority.mjs:35`）；并修正 §5.5 论证（depth 缩放的是 base_priority 不是 half-life）
> - P1：cache-hit 分支删 `recordEmbedSuccess`（避免半开探活被缓存命中错误关闭）、`getProviderWithCircuit` 接 `db` 参数、benchmark 写 `retrieval_check_run` audit 供 diagnose 读取 last-run、`vecToBlob`/`currentModelId` 补齐、circuit 测试隔离
>
> **📌 二次 Review 修正（2026-06-24，多模型融合 re-review 后）**：上一轮 8 个 P0 修正 6/8 持住，发现 2 个"声称修了其实没修到"的真问题 + 几个局部回退，已就地标注 `P1 修正（二次 review）` / `P0 修正（二次 review）`：
> - P0（§5.2）：`dayMetricsPromptSubmit` 是虚构变量——`aggregateHookLatencies` 只存 `ms_total` 丢弃 path 字段。改用新增的 `aggregateRetrievalPaths(dataRoot, start, end)` 函数真正读 path/fallback 字段
> - P0（§5.5）：P0-8 接线对但运行时 inert——`injection-cache.mjs:11` 的 SELECT cols 不含 `temporal_type`（`computePriority` 唯一调用方），必须同步加入该列，否则 `effectiveHalfLifeDays` 读到的 `temporal_type` 永远 undefined
> - P1（§5.1）：`getProviderWithCircuit` line 413 仍 `loadConfig()` 违反 P0 修正 #5 → 改用传入的 `config`
> - P1（§5.3）：删 `awaitRetrieveMemories` 占位 + 同步 `items.map` 包 await（产出 Promise[]）→ 改 `for...of await` 串行循环
> - P1（migration 014 + §6.3）：加 `path_a_count` 列，否则 diagnose 的 "Path A: 842" 无法从存储列派生
> - 措辞（§0.4 / §1.5 #31）：澄清"3 字段（其中 `retrieval_path` 取 4 值）"，消除字段数 vs 取值数混淆

---

## 〇、与 v0.11 的关系与关键约定

### 0.1 v0.11 已实现的基线（不重复）

v0.11 已 ship 以下能力，v0.12 在其上叠加，**不重写**：

- 多窗口并发隔离（session-scoped `context-{session_id[:8]}.md`）
- context 写入历史（`context_snapshots` + `context_write_log` + `cmdContextHistory` 诊断）
- embedding API 800ms AbortController 超时 + Path B 降级（Finding 10 修复）
- memory 内容 500 字符上限 + AI 精炼管道（Finding 11/12 修复，`content-refiner.mjs`）

### 0.2 关键实现约定（沿用 v0.2-v0.11）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **stdout/stderr 分流** | SessionStart 稳定上下文走 stdout `additionalContext`；UserPromptSubmit 检索结果走 `.ccmem/context-{session_id[:8]}.md` 文件；元数据走 stderr + `audit_log` |
| **命令 prelude 调 `maybeRunTier15`** | v0.12 新命令同样遵守；当前实现位于 `scripts/lib/tier15.mjs` |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |
| **insertMemory 位置** | `scripts/lib/cmd/save.mjs:31` |
| **config_kv 读写** | `config_kv.value` 是 `TEXT NOT NULL`（`001_initial.sql:118`）。**清除 key 用 `DELETE FROM config_kv WHERE key=?`，不能写 null**。当前 shipped branch 没有单独的 kv helper module；相关读写 helper 以内联函数形式分布在 `scripts/lib/embedding/provider.mjs` 与 `scripts/lib/admin/diagnose.mjs` |

### 0.3 版本号

- `config.default.json::version` 从 `"0.11"` 升到 `"0.12"`
- schema `schema_meta.version` 的 shipped state 为 `15`（`014_v012.sql` + corrective `015_v012_repair.cjs`）
- `package.json::version` 不改（独立版本号）

### 0.4 v0.12 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — SessionStart | **零变化** |
| Hook 行为 — UserPromptSubmit | **微增**：metrics 新增 3 个字段（`retrieval_path` / `retrieval_embed_error` / `retrieval_fallback`，其中 `retrieval_path` 取 4 值：`A`/`B-off`/`B-fail`/`B-circuit`）（P1.2） |
| Hook 行为 — Stop | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **零变化** |
| Trust 系数 | 零变化 |
| 优先级公式 | **微增**：P2.1 引入 `temporal_type` 对 half-life 的调制（仅 weekly_synthesis 产出的记忆） |
| L1 否定/正向 / L2 / L2.5 / L4 | 零变化 |
| summarize_pending | **微增**：P2.2 schema 扩展 4 字段（可选） |
| weekly_synthesis / security_audit / contradiction_audit / revalidation / monthly_meta | **微增**：weekly_synthesis 新增 temporal 标注（P2.1） |
| daily_maintenance | **零变化** |
| Tier 1.5 lazy maintenance | **微增**：P2.3 query embedding cache 清理 |
| daemon self-restart / container fallback / platform 层 | 零变化 |
| EmbeddingProvider 三路检索算法 / CJK tokenize / per-session dedup | **零变化**（算法不变，仅 provider 入口加熔断） |
| quality gate v2 / transcript_cleaner / cross_project_patterns | 零变化 |
| 降级开关 `file_based=false` | 不变 |

---

## 一、范围与时间预算

### 1.1 v0.12 做什么（M13，约 2-3 周）

实施顺序锁定为 **P1.2 → P1.1 → P1.3 → P2**：P1.1 熔断需要 P1.2 的失败指标作为触发信号；P1.3 benchmark 不依赖前两者但放后面以便用硬化后的链路测真实 recall。

| 优先级 | # | 能力 | Tier | 说明 |
|---|---|---|---|---|
| **P1.2** | B1 | **retrieval 可观测性补全** | Tier 1 / 1.5 | `metrics.jsonl` 新增 `retrieval_embed_error` / `retrieval_path` / `retrieval_fallback`；`metrics-rollup` 日聚合新增 embed error rate。**这是 P1.1 的前置** |
| **P1.1** | B2 | **embedding 熔断 + 降级链硬化** | Tier 1 | 连续 N 次 embed 失败 → 熔断期内直接跳过向量路走 Path B，周期性探活恢复。状态持久化在 `config_kv`（hook 是一次性进程，进程内状态无效） |
| **P1.3** | B3 | **retrieval benchmark 套件** | Tier 1.5（纯 SQLite，离线） | 新命令 `ccmem admin retrieval-check`：跑 100 条 coding prompt-memory 对，测 FTS5 / Jaccard / cosine 各自 recall@K + 三路融合增益。**后续所有检索演进的决策依据** |
| **P2.1** | B4 | **temporal tag（permanent/temporary/time-bound）** | Tier 2 | weekly_synthesis 标注记忆时间属性，permanent 记忆衰减系数=0。价值部分被现有 `half_life_days` 吸收，主要增量在 fact/episode |
| **P2.2** | B5 | **结构化 session summary** | Tier 2 | summarize_pending 输出 investigated/learned/completed/next_steps，存为 **side JSON 列**（不拆 `content`，保护 FTS5 索引） |
| **P2.3** | B6 | **query embedding 缓存** | Tier 1.5 | SQLite 表缓存 query→embedding，API provider 重复 prompt 命中缓存。**启动前需 SQLite 并发写入 mini-design（WAL + INSERT OR IGNORE）** |

### 1.2 v0.12 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 跨项目冷启动继承 | v0.13+ | v0.11-spec §十自认 promote_candidates 已够用 |
| better-sqlite3 + sqlite-vec ANN | v0.13+ | JS cosine 60ms@5k mems 无性能压力；作默认违反零依赖 |
| 检索候选预过滤优化 | v0.13+（数据驱动） | 需 P1.2 证明 retrieval p95 > 100ms |
| MCP search tool | v0.13+ | 与"三个出口"哲学有张力；hook 注入覆盖 >90%。等 P1.3 benchmark 证明存在 hook 召不回的盲区 |
| Entity linking | v0.13+ / 数据驱动 | 需 P1.3 benchmark 证明 FTS5 trigram 对 coding 实体有召回缺口。**别先建图再找问题** |
| Knowledge corpus 可交互知识库 | v0.13+ | consolidated rule 已覆盖 80% |
| Windows scheduled task | v0.13+ | 无 dogfood 设备 |
| memory 内容长度策略调整 | **冻结** | Finding 11/12 刚 ship（300→500 + AI 精炼），v0.12 不再碰长度语义，让它跑一个版本积累数据（避免与检索/标注改动同时上线导致回归归因困难） |

### 1.3 明确拒绝（Reject，附哲学依据）

| 功能 | 拒绝理由 |
|---|---|
| ADD-only（mem0 v3） | 直接对抗"惩罚优先于奖励"+ trust + 衰减，记忆库无限膨胀，违反"可观测可控制" |
| Multi-IDE | 违反 design-motivation"只服务 Claude Code 这一个宿主" |
| React UI viewer / Express HTTP / Redis / PostgreSQL / PostHog | 违反"轻量、本地优先、零依赖" |
| Neo4j / graph memory | coding 场景实体关系简单，价值不明确 |
| Reranker 插件体系 | 通用平台才需要的灵活性 |
| SessionEnd 清理 context.md | v0.11 spec 已拒：Stop hook 无法区分 turn vs session 结束 |

### 1.4 依赖关系

```
014 schema (memories.temporal_type + memories.summary_meta + query_embedding_cache 表)
    │
    ├─ P1.2: metrics.mjs 新增 3 字段 emission + prompt-submit.mjs 透传
    │       → metrics-rollup.mjs 新增 embed error rate 聚合
    │           ↓
    ├─ P1.1: embedding/provider.mjs 熔断门 (config_kv 持久化)
    │       + retrieval.mjs 失败/成功计数
    │           ↓
    ├─ P1.3: scripts/lib/admin/retrieval-check.mjs (新) + 默认 corpus
    │           ↓
    ├─ P2.2: summarize-pending.mjs schema 扩展 4 字段 + cmd/save.mjs 写 summary_meta
    │           ↓
    ├─ P2.1: weekly_synthesis prompt 标注 temporal_type + priority.mjs half-life 调制
    │           ↓
    └─ P2.3: query_embedding_cache 表 + retrieval.mjs 缓存查询 (WAL mini-design)
            → daily-maintenance.mjs 追加缓存清理 step
                → config + 回归
```

### 1.5 完成判据（M13）

**P1.2 — retrieval 可观测性补全**：
1. Path A（embed 成功）：`metrics.jsonl` 记 `retrieval_path:"A"`, `retrieval_embed_error:null`, `retrieval_fallback:false`
2. Path B-fail（embed 失败降级）：记 `retrieval_path:"B-fail"`, `retrieval_embed_error:"<message>"`, `retrieval_fallback:true`
3. Path B-off（embedding 关闭）：记 `retrieval_path:"B-off"`, `retrieval_embed_error:null`, `retrieval_fallback:false`
4. Path B-circuit（熔断 open 跳过）：记 `retrieval_path:"B-circuit"`, `retrieval_embed_error:null`, `retrieval_fallback:false`（**关键**：熔断触发与"用户关 embedding"必须区分，否则 P1.1+P1.2 互相抵消）
5. `metrics_daily_rollup` 日聚合新增 `embed_error_rate`（当日 B-fallback / 总 prompt_submit）+ 四态 path 分布
6. `diagnose --metrics` 展示 embed error rate + 近 7 天 fallback 趋势

**P1.1 — embedding 熔断**：
6. 连续 `threshold`（默认 3）次 embed 失败 → `config_kv` 写入 `embedding.circuit_open_until = now + cooldown_ms`
7. 熔断期内 `getProvider` 返回 null → retrieveMemories 走 Path B，**不尝试 embed**（不再每次失败都重试）
8. 熔断期内每 `probe_interval_ms`（默认 60s）探活一次：成功则关闭熔断并重置计数
9. embed 成功 → `consecutive_failures` 清零
10. 熔断状态变更写 `audit_log`（`embedding_circuit_open` / `embedding_circuit_close`）
11. 熔断期内 hook 延迟显著下降（Path B 无 embed 调用，目标 < 200ms）

**P1.3 — retrieval benchmark**：
12. `ccmem admin retrieval-check` 跑默认 corpus（≥ 100 条 prompt-memory 对）
13. 输出每路（FTS5 / Jaccard / cosine）及三路融合的 recall@K / precision@K
14. corpus 含 **adversarial miss case**（已知 FTS5 召不回的语义查询），防止自评偏差给出虚假乐观 recall
15. 支持 `--corpus <path>` 自定义语料、`--k 1,3,5` 调 K 值
16. 纯 SQLite，离线跑，不调 LLM、不联网

**P2.1 — temporal tag**：
17. `weekly_synthesis` prompt 输出 `temporal_type`（permanent / temporary / time-bound，默认 null = 不标注）
18. `temporal_type` 存入 `memories.temporal_type` 列
19. `priority.mjs` 半衰期计算：`temporal_type='permanent'` → effective half_life = Infinity（不衰减）；其它走原逻辑
20. 仅 weekly_synthesis 产出的 consolidated 记忆标注；用户显式 save / summarize_pending 的记忆不强制标注

**P2.2 — 结构化 session summary**：
21. `SUMMARIZE_SCHEMA` 新增可选字段 `investigated` / `learned` / `completed` / `next_steps`（均 string，maxLength 200）
22. `insertMemory` 把 4 字段序列化为 JSON 存入 `memories.summary_meta`（**side column，不拆 `content`**）
23. `content` 仍为 FTS5 索引单元，保持自由格式（向后兼容：旧记忆 `summary_meta` 为 NULL）
24. 检索时不按字段过滤（v0.12 仅存储，不做字段级检索——避免过度设计）

**P2.3 — query embedding 缓存**：
25. 新表 `query_embedding_cache(prompt_hash PK, embedding BLOB, model TEXT, created_at INTEGER)`
26. retrieveMemories Path A：hash prompt[:2000] → 命中缓存用缓存 embedding，未命中则 embed + `INSERT OR IGNORE`
27. 多窗口并发用 WAL 模式 + `INSERT OR IGNORE` 避免写冲突（mini-design 落地）
28. `daily_maintenance` 清理 30d 前缓存
29. 仅 API provider（openai/jina）走缓存；transformers-local 本地计算不缓存（无延迟收益）

**通用**：
30. v0.11 测试套全量回归 100% 通过（1079 tests）
31. embedding 关闭时所有 hook 输出与 v0.11 字符级一致（仅 metrics 新增 3 字段：`retrieval_path` / `retrieval_embed_error` / `retrieval_fallback`，其中 `retrieval_path` 取 4 值）
32. `diagnose --retrieval` 输出熔断状态 + embed error rate + benchmark 摘要（benchmark last-run 从 `audit_log` action=`retrieval_check_run` 读取——`cmdRetrievalCheck` 必须写该 audit row）

---

## 二、架构（v0.12 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart (v0.12 零变化)                                          │
│                                                                       │
│  UserPromptSubmit (v0.12 微增):                                       │
│    retrieveMemories:                                                  │
│      ┌─ P1.1: getProvider 先查 config_kv 熔断门                       │
│      │    熔断 open → 返回 null → Path B (不尝试 embed)               │
│      │    熔断 closed / probe 期 → 正常 embed                         │
│      │                                                                │
│      │  Path A (embed 成功):                                          │
│      │    P2.3: 先查 query_embedding_cache → 命中跳过 embed           │
│      │    embed → P1.1: recordEmbedSuccess (清零计数)                 │
│      │    → cosine scan → 三路融合                                    │
│      │  Path B (embed 失败 / 关闭 / 熔断):                            │
│      │    P1.1: recordEmbedFailure (计数++, 可能开熔断)               │
│      │    → FTS5 + Jaccard                                            │
│      │                                                                │
│      └─ P1.2: 返回 timing 含 path/embedError/fallback                │
│    → prompt-submit.mjs recordMetric 透传 3 新字段                     │
│    → writeContextFile (v0.11 行为不变)                                │
│    additionalContext = '' (始终为空) ✅                               │
│                                                                       │
│  Stop (v0.12 零变化)                                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.12 微增):                                                 │
│    weekly_synthesis: P2.1 标注 temporal_type                          │
│    summarize_pending: P2.2 schema 扩展 4 字段 + 写 summary_meta       │
│    daily_maintenance: P2.3 追加 query_embedding_cache 清理 step        │
│    其它 cron 零变化                                                   │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (v0.12 增量, migration 014):                                  │
│    memories.temporal_type  (新列, NULL default)                       │
│    memories.summary_meta   (新列, TEXT JSON, NULL default)            │
│    query_embedding_cache   (新表)                                      │
│    config_kv: 新 keys (embedding.circuit_open_until / .consecutive_   │
│                       failures / .last_probe_at)                     │
│    schema_meta.version 13 → 14 (migration 014)                        │
└──────────────────────────────────────────────────────────────────────┘

Daemon 缺席影响：
- P1.1 熔断状态在 config_kv（Tier 1，hook 内纯 SQL 读写）→ daemon 死也照常熔断/恢复 ✅
- P1.2 metrics 在 metrics.jsonl（Tier 1）→ daemon 死也照常记录 ✅
- P1.3 benchmark 是用户主动命令（Tier 1.5）→ 不依赖 daemon ✅
- P2.1 / P2.2 需 LLM → daemon 缺席时不跑，daemon 启动后追上（Tier 2）✅
- P2.3 缓存查询在 hook 内（Tier 1.5）→ daemon 死也照常缓存 ✅
  缓存清理在 daily_maintenance（Tier 1.5）→ daemon 缺席期间缓存表增长，至 30d 清理
```

---

## 三、Schema 迁移（v0.11 → v0.12）

### 3.1 迁移文件 `migrations/014_v012.sql`

v0.12 新增 2 列 + 1 表，不修改现有列语义。

```sql
-- ============================================================
-- migrations/014_v012.sql — v0.12 schema (retrieval hardening + temporal + structured summary)
-- ============================================================

-- ---- 1. memories.temporal_type (P2.1) ----
-- weekly_synthesis 标注的时间属性。NULL = 未标注（向后兼容）。
-- permanent → half-life 调制为 Infinity（不衰减）。
ALTER TABLE memories ADD COLUMN temporal_type TEXT;
-- CHECK 约束在 INSERT/UPDATE 时校验（SQLite ALTER ADD COLUMN 不能直接加 CHECK，
-- 由 cmd/save.mjs 的 insertMemory / weekly-synthesis 在写入时校验 enum）
-- 合法值: NULL | 'permanent' | 'temporary' | 'time-bound'

-- ---- 2. memories.summary_meta (P2.2) ----
-- summarize_pending 输出的结构化字段（investigated/learned/completed/next_steps）
-- 序列化为 JSON 存这里。content 仍是 FTS5 索引单元，保持自由格式。
-- NULL = 非 summarize_pending 产出 / 旧记忆（向后兼容）。
ALTER TABLE memories ADD COLUMN summary_meta TEXT;

-- ---- 3. query_embedding_cache (P2.3) ----
-- 缓存 query prompt → embedding 映射，API provider 重复 prompt 命中缓存。
-- prompt_hash = sha256(prompt[:2000]).slice(0,16)，与 retrieval.mjs 计算一致。
CREATE TABLE query_embedding_cache (
  prompt_hash  TEXT PRIMARY KEY,       -- 16-char hex
  embedding    BLOB NOT NULL,          -- Float32Array 序列化（与 memories.embedding 同格式）
  model        TEXT NOT NULL,          -- 缓存时的 provider+model 标识，模型变更时失效
  prompt_len   INTEGER NOT NULL,       -- 原始 prompt 长度（诊断用）
  created_at   INTEGER NOT NULL,       -- Unix ms
  hit_count    INTEGER DEFAULT 1       -- 命中次数（诊断用）
);
CREATE INDEX idx_qec_created ON query_embedding_cache(created_at);

-- ---- 4. config_kv 已存在（v0.6+），熔断状态写入新 keys（无需建表）----
-- embedding.circuit_open_until   INTEGER | NULL
-- embedding.consecutive_failures INTEGER DEFAULT 0
-- embedding.last_probe_at        INTEGER | NULL

-- ---- 4b. metrics_daily_rollup 新增列（P1.2 聚合输出，表名单数见 005_v04.sql:16）----
-- P1 修正（二次 review）：加 path_a_count，否则 §6.3 diagnose 的 "Path A: 842 (87%)" 无法从存储列派生
ALTER TABLE metrics_daily_rollup ADD COLUMN embed_error_rate REAL;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_a_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_off_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_circuit_count INTEGER NOT NULL DEFAULT 0;

-- ---- 5. schema 版本推进 ----
UPDATE schema_meta SET version = 14, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (13, 14, 'v0.12: temporal_type + summary_meta + query_embedding_cache',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值

| action | 触发 | details |
|---|---|---|
| `embedding_circuit_open` | P1.1 熔断打开 | `{ failures, cooldown_ms, open_until }` |
| `embedding_circuit_close` | P1.1 熔断关闭（探活成功或手动） | `{ reason: 'probe_success'\|'manual' }` |
| `retrieval_check_run` | P1.3 benchmark 执行 | `{ total, recall_at_3, run_at }` —— 供 `diagnose --retrieval` 读取 last-run |

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.11 daemon（in-memory v13）看到 DB schema=15 | v0.5 self-restart 自动处理 |
| v0.1-v0.11 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002-015 |
| `memories.temporal_type` / `summary_meta` 空列 | 新列，旧记忆为 NULL，向后兼容 |
| `query_embedding_cache` 空表 | 新表，无数据迁移 |
| `config_kv` 熔断 keys 不存在 | provider 首次读取时按 NULL / 0 处理 |

---

## 四、Hooks（v0.12 改造）

### 4.1 UserPromptSubmit（P1.2：metrics 透传 3 新字段）

v0.11 行为：检索 → 写 context 文件 → `additionalContext` 返回空。
v0.12 变更：`recordMetric` 新增 `retrieval_path` / `retrieval_embed_error` / `retrieval_fallback`。

```javascript
// scripts/handlers/prompt-submit.mjs (v0.12 微增, 仅展示 recordMetric 改动)

const { rows, queryVec, cosineContribution, timing, retrievalPath } = await retrieveMemories(...);
// ↑ retrieveMemories 在 timing 里直接返回 path，避免 handler 重新推断（见 §5.1）

// v0.12 P1.2: retrieveMemories 已在返回值里区分四态，handler 直接透传
// path ∈ {'A', 'B-off', 'B-fail', 'B-circuit'}
const path = retrievalPath ?? (timing == null ? 'B-off' : 'A');
const embedError = timing?.embedError ?? null;
const fallback = (path === 'B-fail');   // 仅"失败降级"算 fallback

// ... 其余逻辑不变 ...

recordMetric({
  hook: 'prompt_submit',
  matched: rows.length,
  // ... v0.11 字段不变 ...
  retrieval_embed_ms: timing?.embedMs,
  retrieval_db_ms: timing?.dbReadMs,
  retrieval_cosine_ms: timing?.cosineMs,
  retrieval_pool: timing?.candidatePool,
  // v0.12 P1.2 新增:
  retrieval_path: path,                 // 'A' | 'B-off' | 'B-fail' | 'B-circuit'
  retrieval_embed_error: embedError,    // string | null
  retrieval_fallback: fallback,         // bool (仅 B-fail 为 true)
  additional_context_empty: true,
  context_file_written: contextFileWritten,
  context_file_bytes: contextFileBytes,
});
```

> **四态而非三态的理由**：`B-off`（embedding 关闭，用户主动选择）、`B-fail`（失败降级，系统问题）、`B-circuit`（熔断 open，系统问题但主动跳过）语义各不同。**关键**：熔断 open 时 `getProviderWithCircuit` 返回 null → `useEmbedding=false` → 走的是 `retrieval.mjs:44` 的 `timing:null` 分支，与 `B-off` 同一路径。**若 retrieveMemories 不主动区分，handler 无法把 `timing:null` 判成 `B-circuit` 还是 `B-off`，两个 headline 功能（P1.1 熔断 + P1.2 路径遥测）会互相抵消**——熔断触发的 Path B 全被记成"用户关了 embedding"。因此 retrieveMemories 必须在内部判定 circuit-open 并显式返回 `path:'B-circuit'`（见 §5.1），handler 不重新推断。P1.1 熔断只对 `B-fail` 计数，`B-off` / `B-circuit` 都不计入失败。

### 4.2 SessionStart / Stop

零变化。

---

## 五、核心改动

### 5.1 P1.1 — embedding 熔断（embedding/provider.mjs + retrieval.mjs）

**状态持久化在 `config_kv`**（hook 是一次性 Node 进程，模块级 `_cachedProvider` 跨 prompt 无效，与 P2.3 同理）。

```javascript
// scripts/lib/embedding/provider.mjs (v0.12 增量)

// shipped code inlines readConfigKvInt / writeConfigKv / clearConfigKv inside provider.mjs

const CIRCUIT_KEYS = {
  openUntil: 'embedding.circuit_open_until',
  failures:  'embedding.consecutive_failures',
  lastProbe: 'embedding.last_probe_at',
};

/**
 * v0.12 P1.1: 检查熔断状态。在 retrieveMemories 入口调用（db 由调用方传入，
 * 避免内部 openDb 开第二个连接 — 测试隔离 + 单例一致性）。
 * - 熔断 closed → 返回 { provider, circuit:'closed' }
 * - 熔断 open 且未到探活时间 → 返回 { provider:null, circuit:'open' }
 * - 熔断 open 且到探活时间 → 返回 { provider, circuit:'half-open' }（允许一次探活）
 *
 * 纯 SQL 读，Tier 1，无 LLM 无网络。daemon 缺席也照常工作。
 */
export function getProviderWithCircuit(db, config) {
  const provider = getProvider(config);   // 现有逻辑（读 embedding.enabled）
  if (!provider) return { provider: null, circuit: 'closed' };

  const openUntil = readKvInt(db, CIRCUIT_KEYS.openUntil);   // null = 未设置 = closed
  if (openUntil == null) return { provider, circuit: 'closed' };

  const now = Date.now();
  if (now >= openUntil) {
    // 熔断期满但还没探活成功 → 允许探活（半开状态）
    const lastProbe = readKvInt(db, CIRCUIT_KEYS.lastProbe) ?? 0;
    // P1 修正（二次 review）：用传入的 config，不要 loadConfig() 重读（与 P0 修正 #5 一致）
    const probeInterval = config?.embedding?.circuit?.probe_interval_ms ?? 60000;
    if (now - lastProbe >= probeInterval) {
      writeKv(db, CIRCUIT_KEYS.lastProbe, String(now));
      return { provider, circuit: 'half-open' };   // 半开：允许一次 embed 探活
    }
    return { provider: null, circuit: 'open' };    // 探活冷却内，仍走 Path B
  }

  return { provider: null, circuit: 'open' };      // 熔断 open 期内，走 Path B
}

// retrieval.mjs 入口改造:
export async function retrieveMemories(db, prompt, projectKey, config) {
  const limit = config.inject?.max_per_prompt ?? 6;
  const { provider, circuit } = getProviderWithCircuit(db, config);   // v0.12: 熔断门
  let useEmbedding = provider?.isLoaded() ?? false;
  // ... load() 逻辑不变 ...

  // v0.12 P1.2: 在 !useEmbedding 分支显式区分 B-off vs B-circuit
  if (!useEmbedding) {
    const path = circuit === 'open' ? 'B-circuit' : 'B-off';
    return { rows: ftsRows.slice(0, limit), queryVec: null, cosineContribution: null,
             timing: null, retrievalPath: path };
  }

  const t0 = Date.now();   // ← t0 在此处声明（仅 Path A 需要）
  let queryVec;
  try {
    [queryVec] = await provider.embed([prompt.slice(0, 2000)]);
    recordEmbedSuccess(db);   // v0.12 P1.1: 成功清零计数 + 关闭熔断
  } catch (e) {
    recordEmbedFailure(db, config);  // v0.12 P1.1: 失败计数++, 可能开熔断
    process.stderr.write(`ccmem: embedding API failed (${e.message}), falling back to lexical retrieval\n`);
    return { rows: ftsRows.slice(0, limit), queryVec: null, cosineContribution: null,
             timing: { embedMs: Date.now() - t0, embedError: e.message }, retrievalPath: 'B-fail' };
  }
  // ... cosine scan + 三路融合 ...
  return { rows: scored.slice(0, limit), queryVec, cosineContribution: avgCosineContribution,
           timing: { embedMs, dbReadMs, cosineMs, candidatePool: allVecs.length }, retrievalPath: 'A' };
}

/**
 * v0.12 P1.1: 失败计数 + 熔断判定。
 * 连续 failures >= threshold → 开熔断 cooldown_ms。
 * 注意：仅在"失败降级"(B-fail)时调用；embedding 关闭(B-off) / 熔断跳过(B-circuit) 不计入。
 */
function recordEmbedFailure(db, config) {
  const cfg = config?.embedding?.circuit ?? loadConfig().embedding?.circuit ?? {};
  const threshold = cfg.failure_threshold ?? 3;
  const cooldownMs = cfg.cooldown_ms ?? 300000;  // 5 min
  const failures = (readKvInt(db, CIRCUIT_KEYS.failures) ?? 0) + 1;
  writeKv(db, CIRCUIT_KEYS.failures, String(failures));
  if (failures >= threshold) {
    const openUntil = Date.now() + cooldownMs;
    writeKv(db, CIRCUIT_KEYS.openUntil, String(openUntil));
    writeAudit(db, 'embedding_circuit_open', null,
      { failures, cooldown_ms: cooldownMs, open_until: openUntil });
    process.stderr.write(
      `ccmem: embedding circuit OPEN after ${failures} failures, cooldown ${cooldownMs}ms\n`
    );
  }
}

function recordEmbedSuccess(db) {
  const wasOpen = readKvInt(db, CIRCUIT_KEYS.openUntil);
  // config_kv.value 是 TEXT NOT NULL — 清除用 DELETE，不能写 null
  clearKv(db, CIRCUIT_KEYS.failures);
  clearKv(db, CIRCUIT_KEYS.openUntil);
  clearKv(db, CIRCUIT_KEYS.lastProbe);
  if (wasOpen != null) {
    writeAudit(db, 'embedding_circuit_close', null, { reason: 'probe_success' });
  }
}
```

> **Shipped state（2026-07-09）**：(1) helper 名最终仍是 `maybeRunTier15`，kv 读写 helper 以内联函数形式放在 `embedding/provider.mjs` / `admin/diagnose.mjs`；(2) `config_kv.value` 仍是 `TEXT NOT NULL`，清除 key 用 `DELETE`；(3) `getProviderWithCircuit` 接收 `db` 参数，不在内部 `openDb()` 开第二连接；(4) 熔断 open 显式返回 `retrievalPath:'B-circuit'`；(5) `recordEmbedFailure` 使用传入 `config`。

**关键设计决策**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 状态存储 | `config_kv`（已存在表） | hook 一次性进程，必须持久化；不新建表 |
| 半开探活 | 熔断期满后每 `probe_interval_ms` 允许一次 embed | 避免熔断永续，又不至于每 prompt 都重试失败 |
| 触发计数源 | 仅 `B-fail`（失败降级） | `B-off`（用户关 embedding）不能误判为失败 |
| 熔断时 provider 返回 null | 复用 retrieveMemories 现有 `provider==null → Path B` 分支 | 零新分支，最小改动 |
| audit | 仅 open/close 边界事件 | 不每次失败都写 audit（避免噪音，与 v0.11 snapshot 不写 audit 同理） |

### 5.2 P1.2 — metrics-rollup 扩展（metrics-rollup.mjs）

```javascript
// scripts/lib/metrics-rollup.mjs (v0.12 增量, step 8)

// 8. Embed error rate + path 分布 (v0.12 P1.2)
//
// P0 修正（二次 review）：原伪代码用 `dayMetricsPromptSubmit` 复用 rollup 现有行变量，
// 但 `aggregateHookLatencies`（metrics-rollup.mjs:186-212）只 push `row.ms_total`，
// 丢弃 retrieval_path / retrieval_fallback 等字段——**没有现成变量可复用**。
// 必须新增一个真正读 path/fallback 字段的聚合函数：
//
//   export function aggregateRetrievalPaths(dataRoot, startMs, endMs) {
//     const buckets = { total: 0, fallback: 0, 'B-fail': 0, 'B-off': 0, 'B-circuit': 0, 'A': 0 };
//     for (const row of iterMetricsLines(dataRoot, startMs, endMs, 'prompt_submit')) {
//       buckets.total++;
//       if (row.retrieval_fallback === true) buckets.fallback++;
//       if (row.retrieval_path) buckets[row.retrieval_path] = (buckets[row.retrieval_path] ?? 0) + 1;
//     }
//     return buckets;
//   }
//
// iterMetricsLines 是 metrics-rollup.mjs 已有的 metrics.jsonl 行迭代器（aggregateHookLatencies
// 内部用的同源读取逻辑，提取为可复用函数）。若该迭代器未导出，直接在 aggregateRetrievalPaths
// 内 inline 读取逻辑（与 aggregateHookLatencies 同样的 fs 流式读 + JSON.parse）。
const pathStats = aggregateRetrievalPaths(dataRoot, dayStartMs, dayEndMs);
const total = pathStats.total;
const fallbackCount = pathStats.fallback;
const pathAFailCount  = pathStats['B-fail'];
const pathBOffCount   = pathStats['B-off'];
const pathBCircuitCnt = pathStats['B-circuit'];
const pathACount      = pathStats['A'];

const embedErrorRate = total > 0 ? +(fallbackCount / total).toFixed(4) : null;
// 写入 metrics_daily_rollup 新列（表名单数 metrics_daily_rollup，见 005_v04.sql:16）
```

> **P0 修正（一次 review）**：(1) 表名是 `metrics_daily_rollup`（**单数**，`005_v04.sql:16`），不是 `daily_rollups`——升级后首次 rollup 会直接抛错；(2) ~~`readMetricsLines` 不存在，复用 rollup 现有的当日行变量~~。
>
> **P0 修正（二次 review）**：上一条的"复用 rollup 现有变量"是错的——`aggregateHookLatencies`（`metrics-rollup.mjs:186-212`）只 push `row.ms_total`，丢弃所有 path/fallback 字段，rollup 内**没有**持有原始 prompt_submit 行的变量（`dayMetricsPromptSubmit` 也是虚构的，implementer 会 ReferenceError）。**必须新增 `aggregateRetrievalPaths(dataRoot, start, end)` 函数**，流式读 metrics.jsonl 的 prompt_submit 行并按 `retrieval_path` 分桶。新列（migration 014 内对 `metrics_daily_rollup` 加 ALTER）：`embed_error_rate REAL`, `path_a_count INTEGER`, `path_b_fail_count INTEGER`, `path_b_off_count INTEGER`, `path_b_circuit_count INTEGER`。

### 5.3 P1.3 — retrieval benchmark（scripts/lib/admin/retrieval-check.mjs，新文件）

```javascript
// scripts/lib/admin/retrieval-check.mjs (v0.12 新增)

import { readFileSync } from 'node:fs';
import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { retrieveMemories } from '../retrieval.mjs';

/**
 * v0.12 P1.3: retrieval benchmark。
 * 跑一个 corpus（prompt → expected_memory_ids[]），测每路及融合的 recall@K / precision@K。
 * 纯 SQLite，离线，不调 LLM 不联网。Tier 1.5。
 *
 * corpus 格式 (JSON):
 *   [{ "prompt": "...", "expected_ids": [12, 34], "note": "optional" }, ...]
 *
 * 必须 contain adversarial miss case（expected_ids 为空或已知 FTS5 召不回），
 * 防止自评偏差给出虚假乐观 recall。
 *
 * P0 修正：retrieveMemories 在 embedding.enabled=true 时会调 provider.embed（联网），
 *         违反"纯离线"承诺。本函数强制 deep-clone config 并把 embedding.enabled 置 false，
 *         走 Path B（FTS5 + Jaccard），保证不触发任何 API 调用。
 *         如需测 cosine 路，需另开 --with-embedding 模式（明确联网，不计入"离线 benchmark"）。
 */
export async function cmdRetrievalCheck(db, { corpus = null, k = null, cwd = process.cwd() } = {}) {
  const corpusPath = corpus ?? defaultCorpusPath();
  const items = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const kList = (k ?? '1,3,5').split(',').map(n => parseInt(n, 10));

  // P0 修正: 强制离线 — deep-clone config, 关闭 embedding, 走 Path B
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    embedding: {
      ...(baseConfig.embedding ?? {}),
      enabled: false
    }
  };
  const projectKey = resolveProjectKey(cwd);

  // P1 修正（二次 review）：retrieveMemories 是 async，必须串行 await 调用。
  const results = [];
  for (const item of items) {
    const { rows } = await retrieveMemories(db, item.prompt, projectKey, config);
    const retrievedIds = rows.map(r => r.id);
    const expected = new Set(item.expected_ids ?? []);
    results.push({
      prompt: item.prompt.slice(0, 60),
      hit: retrievedIds.some(id => expected.has(id)),
      rankOfFirstHit: retrievedIds.findIndex(id => expected.has(id)) + 1 || null,
    });
  }

  // 输出 recall@K / precision@K per K
  for (const K of kList) {
    const recall = results.filter(r => r.rankOfFirstHit && r.rankOfFirstHit <= K).length / results.length;
    process.stdout.write(`recall@${K}: ${(recall * 100).toFixed(1)}%\n`);
  }

  // adversarial miss case 报告
  const adversarial = items.filter(i => (i.expected_ids ?? []).length === 0);
  process.stdout.write(`\nCorpus: ${items.length} items (${adversarial.length} adversarial)\n`);

  // P1 修正: 持久化 last-run, 供 diagnose --retrieval 展示（否则完成判据 #32 不可达）
  const recallAt3 = kList.includes(3)
    ? +(results.filter(r => r.rankOfFirstHit && r.rankOfFirstHit <= 3).length / results.length).toFixed(4)
    : null;
  writeAudit(db, 'retrieval_check_run', null,
    { total: items.length, recall_at_3: recallAt3, run_at: Date.now() });
}

function defaultCorpusPath() {
  return new URL('../benchmark/corpus.json', import.meta.url).pathname;
}
```

> **P0 修正**：(1) `cmdRetrievalCheck` 必须是 `async function`，`retrieveMemories` 调用必须 `await`（原伪代码同步调用 → benchmark 跑空）；(2) 强制 `embedding.enabled=false` 走 Path B，保证"纯离线不调 LLM"承诺成立（否则 `retrieveMemories` 会调 `provider.embed`）；(3) 当前 shipped 实现不额外跑 `maybeRunTier15`；(4) `writeAudit('retrieval_check_run')` 持久化 last-run，供 `diagnose --retrieval` 读取（完成判据 #32）。

**默认 corpus**：`scripts/lib/benchmark/corpus.json`，ship 一份 ≥ 100 条 coding 场景 prompt-memory 对，**必须含 adversarial miss case**（语义查询但库中无对应记忆，期望 0 召回——验证系统不会硬塞不相关记忆）。语料质量在 spec review 阶段由持有领域知识的人把关（fusion review 已标注此风险）。

### 5.4 P2.2 — 结构化 session summary（summarize-pending.mjs + cmd/save.mjs）

```javascript
// scripts/daemon/tasks/summarize-pending.mjs (v0.12 schema 扩展)

const SUMMARIZE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      content: { type: 'string', minLength: 1, maxLength: 500 },
      type: { type: 'string', enum: ['rule', 'fact', 'episode'] },
      scope: { type: 'string', enum: ['project', 'global'] },
      tags: { type: 'array', items: { type: 'string' } },
      // v0.12 P2.2 新增（均可选，仅 episode 类有意义）:
      investigated: { type: 'string', maxLength: 200 },
      learned:      { type: 'string', maxLength: 200 },
      completed:    { type: 'string', maxLength: 200 },
      next_steps:   { type: 'string', maxLength: 200 },
    },
    required: ['content', 'type', 'scope'],
    additionalProperties: false,
  },
};

// 插入时:
const summaryMeta = (it.investigated || it.learned || it.completed || it.next_steps)
  ? JSON.stringify({
      investigated: it.investigated ?? null,
      learned: it.learned ?? null,
      completed: it.completed ?? null,
      next_steps: it.next_steps ?? null,
    })
  : null;

// P0 修正: insertMemory 的 INSERT 分支（cmd/save.mjs）
// 现有列名是写死的 (content, type, scope, tags, source, ...)，必须扩展列列表 +
// VALUES 占位，否则 summary_meta 会被静默丢弃。示例（project 分支）:
//
//   insertMemory(db, {
//     content: it.content,
//     type: it.type,
//     scope: it.scope,
//     tags: it.tags,
//     summaryMeta,
//     temporalType: null,
//   });
//
// global 分支同理。temporal_type 此处留 NULL（仅 weekly_synthesis 产出才标）。
insertMemory(db, {
  content: it.content,          // 仍是 FTS5 索引单元，自由格式
  type: it.type,
  scope: it.scope,
  tags: it.tags,
  summaryMeta,                 // v0.12: side JSON column, 不进 FTS5
  // ...
});
```

> **关键约束（panel A 唯一洞察，Judge 高置信采纳）**：4 字段必须存 side JSON 列 `summary_meta`，**不能拆 `content`**。`content` 是 FTS5 索引单元（`memories_fts`），拆分会让全文索引碎片化、破坏 Path A/B 的 recall。检索时 v0.12 不做字段级过滤（避免过度设计），仅存储供未来 `/ccmem:show` 展示。
>
> **Shipped state（2026-07-09）**：(1) 这条写入链路最终落在 `scripts/lib/cmd/save.mjs`，未抽成独立的 memory-write helper module；(2) `buildSummarizePrompt` 与 parser/insertMemory 已一并打通，`summary_meta` 和 `temporal_type` 都有定向回归；(3) `structured_summary.enabled` 开关没有单独 shipped，当前分支固定采用扩展 schema。

### 5.5 P2.1 — temporal tag（weekly-synthesis.mjs + priority.mjs）

```javascript
// weekly_synthesis prompt 扩展（伪代码）:
//   "...对每条 consolidated 记忆，判断 temporal_type:
//    - permanent: 永久性决策（如"项目用 pnpm"）→ 不衰减
//    - temporary: 临时性事实（如"当前在 debug 阶段"）→ 正常衰减
//    - time-bound: 有时效（如"下周一前要交付"）→ 正常衰减 + 到期归档（v0.13 候选）
//    留空 = 不标注（默认）。"

// schema 同步加 temporal_type enum

// scripts/lib/priority.mjs half-life 调制:
// P0 修正: 必须把 effectiveHalfLifeDays 接进 computePriority。
// 现状 priority.mjs:35 直接调 recencyFactor(days, mem.half_life_days)，
// effectiveHalfLifeDays 定义了却没被任何地方调用 → P2.1 不生效。
function effectiveHalfLifeDays(mem) {
  if (mem.temporal_type === 'permanent') return Infinity;  // 不衰减
  return mem.half_life_days;  // 原逻辑
}

// computePriority (priority.mjs:33) 改造:
export function computePriority(mem) {
  // ...
  const halfLife = effectiveHalfLifeDays(mem);        // ← 接线点（替换原 mem.half_life_days）
  const recency = recencyFactor(days, halfLife);      // priority.mjs:35
  // ... 其余不变 ...
  // 注: recencyFactor 需处理 halfLife === Infinity（daysSinceTouched/HalfLife → 1，不衰减）
}
```

> **P0 修正**：`effectiveHalfLifeDays` 原本定义了却没接进 `computePriority`（`priority.mjs:35` 仍直接用 `mem.half_life_days`）→ P2.1 名存实亡。接线点明确：`priority.mjs:35` 的 `recencyFactor(days, mem.half_life_days)` 改为 `recencyFactor(days, effectiveHalfLifeDays(mem))`。
>
> **P0 修正（二次 review）—— 配套编辑（关键）**：光改 `priority.mjs:35` 不够。`computePriority` 的**唯一调用方**是 `injection-cache.mjs:23`，而它的 SELECT cols 字符串（`injection-cache.mjs:11`）是 `helpful_count, unhelpful_count, half_life_days, consolidation_depth, last_touched_at` —— **不含 `temporal_type`**。因此 `mem.temporal_type` 永远是 `undefined` → `effectiveHalfLifeDays` 恒返回 `mem.half_life_days` → P2.1 运行时 inert（单测过、系统行为不变）。**必须同步把 `temporal_type` 加入 `injection-cache.mjs:11` 的 SELECT cols**（与 `half_life_days` 并列）。这是 P2.1 真正生效的必要条件。
>
> **论证修正（panel C 独家）**：原 §5.5 称"consolidated 已按 depth 缩放半衰期"是错的——`priority.mjs:26-31` 用 `consolidation_depth` 缩放的是 **base_priority**（`1.5 + 0.2*depth`），半衰期是固定值（非按 depth 缩放）。因此 temporal tag 的增量价值**不在**"和 depth 缩放重叠"，而在**让 fact/episode 类的永久性决策（如"项目用 pnpm"）不再随时间衰减**——这才是 P2.1 的真实增量。代码改动（temporal→Infinity half-life）正确，仅论证文字需改。若实施窗口紧，P2.1 可最先 defer 到 v0.13。

### 5.6 P2.3 — query embedding 缓存（retrieval.mjs + daily-maintenance.mjs）

```javascript
// scripts/lib/retrieval.mjs Path A (v0.12 增量)

import { vecToBlob, blobToVec } from './embedding/cosine.mjs';   // P1 修正: vecToBlob 需显式 import（原仅 import blobToVec）

const t0 = Date.now();
let queryVec;
const promptHash = contentHash(prompt.slice(0, 2000));  // sha256[:16]（注: 与 context-file.mjs 的 8-char contentHash 不同，此处用 16-char 避免碰撞）

// v0.12 P2.3: 先查缓存（仅 API provider）
const cached = db.prepare(
  `SELECT embedding, model FROM query_embedding_cache WHERE prompt_hash = ?`
).get(promptHash);
if (cached && cached.model === currentModelId(config)) {     // P1: currentModelId = `${provider}:${model}`，由 provider 暴露或 config 推导
  queryVec = blobToVec(cached.embedding);
  db.prepare(`UPDATE query_embedding_cache SET hit_count = hit_count + 1 WHERE prompt_hash = ?`).run(promptHash);
  // P1 修正: 缓存命中【不】调 recordEmbedSuccess —— 否则半开探活期一次缓存命中会错误关闭熔断
  // （没真正调 API 就把 circuit 标成 closed）。缓存命中只更新 hit_count。
} else {
  try {
    [queryVec] = await provider.embed([prompt.slice(0, 2000)]);
    recordEmbedSuccess(db);   // 仅真实 embed 成功才清零计数
    // 写缓存（shipped code uses INSERT ... ON CONFLICT to refresh payload and timestamp）
    db.prepare(
      `INSERT INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(prompt_hash) DO UPDATE SET
         embedding = excluded.embedding,
         model = excluded.model,
         prompt_len = excluded.prompt_len,
         created_at = excluded.created_at`
    ).run(promptHash, vecToBlob(queryVec), currentModelId(config), prompt.length, Date.now());
  } catch (e) {
    recordEmbedFailure(db, config);
    // ... Path B 降级不变 ...
  }
}
```

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.12 追加 step)

// step N: 清理 30d 前的 query_embedding_cache
db.prepare(`DELETE FROM query_embedding_cache WHERE created_at < ?`).run(cutoffMs);
```

**并发 mini-design（启动前必出）**：
- DB 开 WAL 模式（若未开）：`PRAGMA journal_mode=WAL`（多窗口读写不互斥）。WAL pragma 在 `db.mjs` `openDb` 初始化时设置一次（全局），不是每次查询设
- 写用 `INSERT OR IGNORE`：并发 prompt 同 hash 时只成功一行，其余静默跳过
- `hit_count` UPDATE 用原子 SQL，不加事务锁
- transformers-local provider 不走缓存（本地计算无延迟收益，省存储）

**P0/P1 修正小结**：(1) cache-hit 分支删掉 `recordEmbedSuccess`——避免半开探活期被缓存命中错误关闭；(2) `vecToBlob` 需 import（`cosine.mjs:11` 有导出）；(3) `currentModelId(config)` 是需新定义的 helper（`provider:model` 标识，模型变更时缓存失效）；(4) WAL pragma 在 `openDb` 全局设一次。

---

## 六、命令延伸

所有命令遵守 v0.1 R-4 原则。当前 shipped command prelude 以 `maybeRunTier15` 为准。

### 6.1 命令矩阵（v0.12 新增 / 扩展）

| Slash | CLI | 实现 | 类型 |
|---|---|---|---|
| `/ccmem:admin retrieval-check [--corpus <path>] [--k 1,3,5]` | 同 | `lib/admin/retrieval-check.mjs` | 新增 |
| `/ccmem:admin diagnose --retrieval` | 同 | `lib/admin/diagnose.mjs` 扩展 | 扩展 |
| `/ccmem:admin diagnose --embedding-circuit <open\|close\|status>` | 同 | `lib/admin/diagnose.mjs` | 扩展（手动控制熔断） |

### 6.2 `/ccmem:admin retrieval-check`

输出 recall@K / precision@K per K + adversarial miss case 报告。详见 §5.3 伪代码。stdout ≤ 30 行（R-4 LLM-safe）。

### 6.3 `/ccmem:admin diagnose --retrieval`

```text
Embedding: enabled (openai)
Circuit: CLOSED
Benchmark: recall@3=1 total=3 last run=2026-07-09 09:00
```

> **Shipped state（2026-07-09）**：当前 `diagnose --retrieval` 实际输出的是 embedding enable/provider、circuit 状态，以及存在 benchmark audit 时的 last-run 摘要；并**没有**单独打印 path 分布、query-cache 命中率或 7 天趋势表。

### 6.4 输出契约（R-4 LLM-safe）

- `retrieval-check` / `diagnose --retrieval` 输出 ≤ 30 行（用户主动查询，允许富格式）
- 元解释走 `audit_log`

---

## 七、配置

### 7.1 config.default.json 新增段

```jsonc
{
  "version": "0.12",

  // v0.12 P1.1 新增
  "embedding": {
    // ... 现有字段不变 ...
    "circuit": {
      "failure_threshold": 3,        // 连续失败次数触发熔断
      "cooldown_ms": 300000,          // 熔断时长 (5 min)
      "probe_interval_ms": 60000     // 半开期探活间隔
    }
  },

  // v0.12 P1.3 新增
  "retrieval": {
    // ... 现有字段不变 ...
    "benchmark": {
      "default_corpus": "scripts/lib/benchmark/corpus.json",
      "default_k": "1,3,5"
    }
  },

  // v0.12 P2.2 新增
  "summarize": {
    // ... 现有字段不变 ...
    "structured_summary": {
      "enabled": true                 // false 时 schema 回退到 v0.11（仅 content/type/scope/tags）
    }
  }

  // ... 其它配置段不变 ...
}
```

### 7.2 配置向后兼容

| 配置 | 默认值 | 行为 |
|---|---|---|
| `embedding.circuit.*` | 见上 | 缺失时按默认值，熔断不启用（等同 v0.11 反应式降级） |
| `retrieval.benchmark.*` | 见上 | 仅 `retrieval-check` 命令使用 |
| `summarize.structured_summary.enabled` | true | false 时 summarize schema 回退 v0.11 |

---

## 八、测试策略

### 8.1 新增测试

| 类别 | 预计数 | 覆盖对象 |
|---|---|---|
| embedding-circuit | 9 | 连续失败达阈值开熔断 / 熔断期 getProviderWithCircuit 返回 circuit:'open' 走 Path B-circuit / 半开探活成功关闭 / 探活失败重置冷却 / 成功清零计数 / B-off 不计入失败 / B-circuit 不计入失败 / audit open/close 事件 / config_kv 持久化跨进程 |
| metrics-retrieval-observability | 6 | Path A 记 path=A / Path B-fail 记 path=B-fail+embedError+fallback / Path B-off 记 path=B-off / Path B-circuit 记 path=B-circuit（熔断触发与关闭区分）/ metrics_daily_rollup embed error rate / diagnose --retrieval 输出 |
| retrieval-check | 5 | 默认 corpus 跑通 / recall@K 计算 / adversarial miss case 报告 / --corpus 自定义 / --k 调参 |
| temporal-type | 4 | weekly_synthesis 标注 / permanent 不衰减 / temporary 正常衰减 / 未标注向后兼容 |
| structured-summary | 5 | schema 4 字段可选 / summary_meta 序列化 / content 不被拆分（FTS5 仍命中）/ 旧记忆 summary_meta=NULL / structured_summary.enabled=false 回退 |
| query-embedding-cache | 6 | 缓存命中跳过 embed / 未命中 embed+INSERT / model 变更失效 / hit_count 递增 / transformers-local 不缓存 / daily 清理 30d |
| migration-014 | 3 | schema 13→14 / 2 列 + 1 表创建 / v0.1-v0.11 升级链兼容 |

**预计新增**：~37 个测试。总计 1079 + 37 = ~1116。

### 8.2 回归测试

v0.11 全量 1079 tests 必须 100% 通过。

**特别关注**：
- `retrieval` 现有测试：`getProvider` 调用点更新为 `getProviderWithCircuit(db, config)`（解构 `{ provider, circuit }`，熔断 closed 时行为与 v0.11 字节级一致）；返回值新增 `retrievalPath` 字段
- `prompt-submit` 现有测试：`recordMetric` 新增 `retrieval_path` / `retrieval_embed_error` / `retrieval_fallback` 后断言更新；解构 `retrievalPath`
- `summarize-pending` 现有测试：schema 扩展后 `additionalProperties:false` 仍校验；`buildSummarizePrompt` 更新断言
- **circuit 测试隔离（P2 盲点）**：circuit 测试必须用 temp DB 或 monkeypatch `openDb`，否则 stale `embedding.circuit_open_until` 污染后续真实 hook 运行

### 8.3 手工验证（dogfood 前）

| 步骤 | 预期 |
|---|---|
| 模拟 embedding API 连续失败 3 次 | 第 3 次后熔断 open，后续 prompt 走 Path B 不尝试 embed |
| 等待 cooldown + probe_interval | 半开探活成功后熔断 close |
| `ccmem admin diagnose --retrieval` | 显示 circuit 状态 + embed error rate |
| `ccmem admin retrieval-check` | 输出 recall@1/3/5 + adversarial 报告 |
| `ccmem admin embedding-circuit status` | 显示当前熔断状态 |

---

## 九、不变量

| 不变量 | 验证方式 |
|---|---|
| 检索算法（FTS5 + Jaccard + cosine 三路融合）零变化 | 回归测试 |
| 写入闸门（Tier 1/2/2.5/3）零变化 | 回归测试 |
| Trust 系数零变化（temporal 仅调制 half-life，不动 trust_score） | 回归测试 |
| `content` 仍是 FTS5 唯一索引单元（summary_meta 不进 FTS5） | 单元测试 + grep `memories_fts` |
| 熔断状态持久化在 config_kv（跨进程） | 单元测试 |
| 熔断仅由 B-fail 触发（B-off 不计入） | 单元测试 |
| query embedding 缓存仅 API provider 走 | 单元测试 |
| retrieval-check 纯 SQLite 不调 LLM 不联网 | 单元测试 |
| `additionalContext` 始终为空（v0.11 file-based 不变） | 回归测试 |

---

## 十、backlog 项

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | time-bound 记忆到期自动归档 | P2.1 延伸 | P3 | v0.13+ |
| 2 | 结构化 summary 字段级检索（按 learned 过滤） | P2.2 延伸 | P3 | 视使用数据 |
| 3 | Entity linking（coding 实体图） | mem0 comparison §1 | P3 | 需 P1.3 benchmark 证明召回缺口 |
| 4 | 检索候选预过滤优化 | v0.10 defer | P3 | 需 P1.2 证明 p95 > 100ms |
| 5 | better-sqlite3 + sqlite-vec ANN | v0.9 defer | P3 | v0.13+ |
| 6 | MCP search tool | claude-mem comparison §1 | P3 | 需 P1.3 证明 hook 召回盲区 |
| 7 | Knowledge corpus 可交互知识库 | claude-mem comparison §3 | P3 | v0.13+ |

---

## 附录 A：v0.12 不变量 checklist（CI grep）

| # | 不变量 | grep 命令 | 预期 |
|---|---|---|---|
| 105 | embedding 熔断门在 retrieval 入口 | `grep -n "getProviderWithCircuit" scripts/lib/embedding/provider.mjs scripts/lib/retrieval.mjs` | ≥ 2 |
| 106 | 熔断状态写 config_kv | `grep -n "embedding.circuit_open_until" scripts/lib/embedding/provider.mjs` | ≥ 1 |
| 107 | recordEmbedFailure/Success 在 retrieval.mjs | `grep -n "recordEmbedFailure\|recordEmbedSuccess" scripts/lib/retrieval.mjs` | ≥ 2 |
| 108 | metrics 透传 retrieval_path（四态） | `grep -n "retrieval_path\|retrievalPath" scripts/handlers/prompt-submit.mjs scripts/lib/retrieval.mjs` | ≥ 2 |
| 109 | retrieval-check 命令存在且 async | `grep -n "async function cmdRetrievalCheck\|await retrieveMemories" scripts/lib/admin/retrieval-check.mjs` | ≥ 2 |
| 110 | temporal_type 列存在 | `grep -n "temporal_type" scripts/migrations/014_v012.sql` | ≥ 1 |
| 111 | summary_meta 存为 side column（不拆 content） | `grep -n "summary_meta" scripts/lib/cmd/save.mjs scripts/migrations/014_v012.sql` | ≥ 2 |
| 112 | query_embedding_cache 表 | `grep -n "CREATE TABLE query_embedding_cache" scripts/migrations/014_v012.sql` | = 1 |
| 113 | retrieval.mjs 已接 query_embedding_cache 读/写 | `grep -n "readQueryEmbeddingCache\|writeQueryEmbeddingCache\|query_embedding_cache" scripts/lib/retrieval.mjs` | ≥ 3 |
| 114 | daily_maintenance 清理缓存 | `grep -n "DELETE FROM query_embedding_cache" scripts/daemon/tasks/daily-maintenance.mjs` | = 1 |
| 115 | metrics_daily_rollup 新列（表名单数，含 path_a_count） | `grep -n "ALTER TABLE metrics_daily_rollup ADD COLUMN" scripts/migrations/014_v012.sql` | = 5 |
| 116 | config_kv helper 就地存在于 provider/diagnose | `grep -n "readConfigKvInt\|writeConfigKv\|clearConfigKv" scripts/lib/embedding/provider.mjs scripts/lib/admin/diagnose.mjs` | ≥ 3 |
| 117 | effectiveHalfLifeDays 接进 computePriority | `grep -n "effectiveHalfLifeDays" scripts/lib/priority.mjs` | ≥ 2（定义 + 调用点） |
| 117b | temporal_type 进 injection-cache SELECT（二次 review 配套编辑） | `grep -n "temporal_type" scripts/lib/injection-cache.mjs` | ≥ 1 |
| 118 | retrieval_check_run audit 写入 | `grep -n "retrieval_check_run" scripts/lib/admin/retrieval-check.mjs` | = 1 |
| 118b | aggregateRetrievalPaths 真正读 path 字段（二次 review） | `grep -n "aggregateRetrievalPaths\|retrieval_path" scripts/lib/metrics-rollup.mjs` | ≥ 2 |
| 118c | getProviderWithCircuit 用传入 config 不调 loadConfig（二次 review） | `grep -n "loadConfig()" scripts/lib/embedding/provider.mjs` | = 0（在 getProviderWithCircuit 范围内） |
| 119 | v0.12 新增文件 100% 用 `writeAudit`，禁止 `logAudit(` | `grep -rn 'logAudit(' scripts/lib/admin/retrieval-check.mjs scripts/lib/embedding/provider.mjs` | 为空 |

---

**End of v0.12 spec.**
