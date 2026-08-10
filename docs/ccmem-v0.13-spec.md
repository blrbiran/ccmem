# ccmem v0.13 实施 spec

> 这是 v0.13 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) …
> [`ccmem-v0.12-spec.md`](./ccmem-v0.12-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.12 完成了"检索硬化 + 可观测性"。v0.13 处理一个由 **live DB 实测**暴露的结构性问题——
> **记忆库是个棘轮：入口 ~78 条/天，出口 ≈0 条/天。** 根因是四层反馈闭环在生产中近乎停摆，
> 导致 trust 恒定、归档不触发、库无界增长。
>
> v0.13 **不**直接改 trust 判定逻辑——因为定阈值所需的数据当前不存在（见 §0.5）。
> v0.13 做两件确定的事：**给反馈闭环装量表**（只观测、不调分）+ **收紧入口**，
> 并把 L2.5 的真修复留到 v0.14 用实测数据做。
>
> **设计依据**：[`ccmem-v0.12-dogfood.md`](./ccmem-v0.12-dogfood.md) §七 + 本文档 §0.4 的 live DB 实测
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。

---

## 〇、与 v0.12 的关系与关键约定

### 0.1 v0.12 已实现的基线（不重复）

v0.12 已 ship 以下能力，v0.13 在其上叠加，**不重写**：

- retrieval 四态可观测性（`retrieval_path` A / B-fail / B-off / B-circuit）
- embedding 熔断（kv-backed circuit breaker + `diagnose --embedding-circuit`）
- retrieval benchmark（`admin/retrieval-check.mjs` + seed corpus）
- temporal tag（`memories.temporal_type` → `effectiveHalfLifeDays`）
- 结构化 session summary（`memories.summary_meta`）
- query embedding 缓存（`query_embedding_cache` + daily 清理）
- 015 corrective migration（修复 interim-014 造成的半截 schema）

### 0.2 关键实现约定（沿用 v0.2–v0.12）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.13 不引入新 LLM 调用 |
| **stdout/stderr 分流** | SessionStart 稳定上下文走 stdout `additionalContext`；检索结果走 `.ccmem/context-{sid}.md`；元数据走 stderr + `audit_log` |
| **命令 prelude 调 `maybeRunTier15`** | v0.13 新命令同样遵守 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |
| **hook 预算** | 普通 hook `< 200ms`；v0.13 新增的 L2.5 probe 必须落在此预算内 |

### 0.3 版本号

- **DEFAULT_CONFIG（runtime 权威）** 版本号从 `'0.11'` 升到 `'0.13'` 
- `config.default.json` 版本号从 `"0.11"` 升到 `"0.13"`（用户可见参考 + 测试保持同步）

  > ⚠ **已发现的遗留问题**：`loadConfig()` 从不读 `config.default.json`——它合并的是 in-code `DEFAULT_CONFIG` 与用户配置。
  > 因此版本号的权威来源是 `scripts/lib/config.mjs:3` 的 `DEFAULT_CONFIG.version`，不是 `config.default.json`。
  > **v0.12 漏了同步 DEFAULT_CONFIG，导致 runtime 版本恒为 `"0.11"` 而 CI 检查只看文件。**
  > v0.13 同时补上两处：(1) `DEFAULT_CONFIG.version` 升到 `'0.13'`；(2) `config.default.json::version` 升到 `"0.13"`；
  > (3) 新增测试（不变量 #120 + #121）确保两者保持同步，防止再次漏 bump。
  > 直接跳到 `"0.13"`（不补写 `"0.12"`，因为该版本已 ship，回填一个从未存在过的中间值没有意义）。

- schema `schema_meta.version` 从 `15` 升到 `16`（migration `016_v013.sql`）
- `config.default.json::security.scan_patterns_version` **不 bump**（v0.13 不动 Tier 1/2 patterns）

### 0.4 v0.13 的实测依据（live DB，2026-07-31）

对用户真实 `~/.claude/ccmem/global.db`（`schema_meta.version=15`，daemon 在线）的只读实测：

| 指标 | 实测值 | 含义 |
|---|---|---|
| active 记忆 | **3631**（总 4076） | — |
| 近 7 天新增 | **200–350 条/天** | 入口速率 |
| 14d `summarize_pending_applied` | **1088**（≈78/天） | 被接收的抽取 |
| 14d `summarize_skip_duplicate` | 187 | Tier 2.5 查重在工作（~15%） |
| 14d `quality_gate_reject` | 118 | quality gate 在工作（~10%） |
| 全生命周期 `archived` | **23**（0.6%） | 出口速率 ≈ 0 |
| `memory_feedback` outcome | unknown **1879** / unhelpful 48 / **helpful_implicit 2** | 反馈闭环停摆 |
| active `auto_inferred` 停在初始 trust | **3437 / 3544（97%）** | trust 从未分化 |
| active `auto_inferred` 中 `type='rule'` | **2571 / 3544（72.5%）** | type 通胀（rule = 最高 base_priority）|
| 有 embedding 的记忆 | **0** | 语义路从未启用 |

**根因（已定位到行）**：`scripts/lib/feedback.mjs:68`

```javascript
function matchesImplicitReference(assistantText, memory) {
  // ...
  return text.includes(content) || text.includes(`m${memory.id}`);
}
```

L2.5 引用检测——design.md 称之为"trust 正反馈的**主要来源**"——要求 assistant 回复**逐字包含整条记忆全文**
（v0.11 Finding 11 把内容上限从 300 放宽到 500 字符，**让命中更不可能**）。
实测：**0/799**（session 级配对），全生命周期 **2/1929**。

**后果链（闭合）**：

```
L2.5 不命中 (0.1%)
  → 无正向 trust
    → trust 恒为 0.5（97% 未动）
      → effective_trust 均匀 → priority ≈ base_priority × recency
        → 无记忆跌破 0.1
          → 不归档、不硬删 → 出口关闭
            → 入口 78/天 + 出口 0/天 = 棘轮（~2400 条/月）
```

这与 design-motivation.md 开篇引用的论文结论"**信息堆积 ≠ 能力提升**"正是同一个失效，
也是 v0.12 多轮 fusion review 反复抓到的 **wired-but-inert** 模式（Finding 1 `summary_meta`、
Finding 16 半截 migration）的又一实例——**只是这次 inert 的是整个反馈闭环**。

### 0.5 为什么 v0.13 **不**直接修 L2.5 ⚠ 关键决策

修 L2.5 需要一个阈值。为定这个阈值做了两次实测：

| 测量 | 样本 | 结果 |
|---|---|---|
| session 级词汇重叠 | **799** 对 | 单峰、集中在 cov≈0.2、max **0.588**——**无分离度**（即任意两段同话题文本的基线重叠）|
| 按轮对齐词汇重叠 | **7** 对 | 样本量不足以判断（`recent_injections` 有 14 天保留期，老 session 注入记录已清）|

**结论**：现有数据**不足以**判定"按轮对齐后是否存在可用分离度"。
这条不确定性是实质性的——它决定 L2.5 该"换更好的匹配算法"还是"这个信号源本身不可得"。
若后者成立，朴素修法会把噪音当信号灌进 trust，**比现状更糟**。

因此 v0.13 采用 v0.10/v0.11 已用过的**数据驱动 defer** 模式：先装量表，跑一周拿到数千个真实对齐样本，
**v0.14 再用实测数据动 trust**。

**明确拒绝的替代方案**：把"注入即算正向用量"（hermes 的 `view` 语义）。
理由：这与 ccmem 明确废弃 L3「沉默不算正反馈」是同一个陷阱——一条靠关键词反复命中的**错**记忆会自我强化，
而这正是 design-motivation.md §核心设计理念 2 点名要避免的。要走这条路需单独论证，不夹带进 v0.13。

### 0.6 v0.13 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — SessionStart / UserPromptSubmit | **零变化** |
| Hook 行为 — Stop | **微增**（只追加 L2.5 probe 的 metrics 记录，**不改任何 trust 判定**）|
| 写入闸门 Tier 1 / 2 / 2.5 | **零变化** |
| **Trust 系数 / 优先级公式 / 归档阈值** | **零变化**（v0.13 是"让信号变可测"，不是"改判定"）|
| L1 否定/正向 / L2 / L2.5 判定逻辑 / L4 | **零变化** |
| 三路检索算法 / 熔断 / query cache 命中逻辑 | 零变化（B1 只加签名过滤）|
| weekly_synthesis / security_audit / contradiction_audit / revalidation | 零变化 |
| Tier 1.5 lazy maintenance / daemon self-restart | 零变化 |
| file-based injection（`.ccmem/context-{sid}.md`）| 零变化 |

---

## 一、范围与时间预算

### 1.1 v0.13 做什么（M14，约 2 周）

| 阶段 | # | 能力 | 说明 |
|---|---|---|---|
| **P1** | A1 | **反馈闭环量表（observe-only）** | Stop hook 按轮对齐记录 L2.5 候选特征进 `metrics.jsonl`，**不调 trust** |
| **P1** | A2 | **入口收紧** | summarize prompt 负面清单 + quality gate 两条新规则 |
| **P2** | B1 | **embedding 签名/版本化** | `memories.embedding_sig` + cosine 路过滤 + cache key 含 dim |
| **P2** | B2 | **Finding 17 修复** | `cmd/save.mjs` INSERT 补 `temporal_type` / `summary_meta` |
| **P2** | B3 | **召回回环不变量测试** | 把当前意外获得的防护钉成回归测试 |

### 1.2 v0.13 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| **L2.5 匹配器真修复（改 trust）** | **v0.14** | 阈值需 A1 量表跑一周的实测数据（§0.5）|
| 注入即算正向用量（hermes `view` 语义）| 需单独论证 | 与已废弃的 L3「沉默不算正反馈」同构（§0.5）|
| 出口参数调整（归档阈值 / 半衰期）| v0.14+ | **出口没坏，是没有输入**——先修信号再谈参数 |
| type 通胀治理（71% 被标 `rule`）| v0.14 | 需先确认是 prompt 导致还是 LLM 倾向；A2 的负面清单可能已部分缓解 |
| 图检索 / 多跳 / GraphRAG | 不做 | 注入预算 ≤6 条、库千条量级，多跳推理与"语料级全局问题"均非真实痛点；`retrieval-technology` §3 亦警告"别反过来过度设计" |
| rerank（cross-encoder）| 不做 | hook 内禁模型调用；库规模下收益远低于文档 RAG 场景 |
| benchmark corpus ≥100 + per-lane recall | v0.14 | v0.12 Finding 6 遗留，与本版主线无关 |
| better-sqlite3 + sqlite-vec ANN | v0.14+ | 0 条记忆有向量，无性能压力 |

### 1.3 依赖关系

```
016 schema (embedding_sig + version bump)
    → feedback.mjs (A1 probe, observe-only)
        → quality-gate.mjs + summarize-pending.mjs (A2)
            → retrieval.mjs + embedding/* (B1)
                → cmd/save.mjs (B2) + tests (B3)   [独立，可并行]
                    → config + 回归
```

### 1.4 完成判据（M14）

**A1 — 反馈闭环量表**：
1. 每个有注入的 turn，Stop hook 为每条被注入记忆写一行 `metrics.jsonl`，含 `prompt_idx` / `l25_cov` / `l25_lcp` / `l25_id_literal` / `l25_legacy_hit` / `mem_len` / `reply_len`
2. **trust 零变化**：A1 代码路径不调用 `adjustTrust` / `markOutcomeForIds`（不变量 #122）
3. **probe 数据源是 `recent_injections` 而非 `memory_feedback`**，且只取 `inject_source='user_prompt_submit'`（不变量 #130 / #131；理由见 §4.1 R1）
4. **`l25_legacy_hit=true` 的样本确实会出现**——即 legacy 命中的 turn 不被 probe 漏掉（这是 #3 的可观测证据；构造性测试）
5. probe 失败（transcript 缺失 / 解析失败）不阻断 Stop hook 其余逻辑
6. Stop hook p95 仍 `< 200ms`（≤6 条记忆 × 1 次回复的 token set 运算）
7. `diagnose --feedback` 新子命令输出 probe 特征分布（p50/p75/p90/p95/max + 各阈值命中率）
8. `feedback.l25_probe.enabled=false` 时完全不产生 probe 记录
9. **`metrics.jsonl` 轮转已落地**（8MB 单代）**且 `readMetricsLines` 同时读 `.1`**（§5.1.1）

**A2 — 入口收紧**：
10. summarize prompt 含"环境性失败"与"否定性断言"两条 DO-NOT-EXTRACT
11. `checkQuality` 新增 `env_failure` / `negative_assertion` 两条规则，均可经 `rules_enabled` 单独关闭
12. **误伤回归**：§5.2.2 表中标 `pass` 的**四行**全部通过——含"这个项目不支持 CommonJS"这类
    合法否定式约定，**以及"遇到 command not found 时先跑 nvm use 22"这类带补救措施的长文本**（R2）
13. `env_failure` 带 `text.length < 120` 闸门（§5.2.2 (a)）；`negative_assertion` **不带**长度闸门
14. 新规则命中时 `quality_gate_reject` audit 的 `reason` 字段能区分到具体规则名

**B1 — embedding 签名**：
15. `memories.embedding_sig` 列存在；写入向量时同步写签名 `provider:model:dim`
16. cosine 路只对 `embedding_sig = <当前签名>` 的行计算；签名不符的行被排除且计数
17. `query_embedding_cache` 的 key 含 dim（改用签名而非裸 model 名）
18. `diagnose --retrieval` 输出 stale 向量数（签名不符 / 签名为 NULL 但 embedding 非空）
19. `vec_backfill` 优先处理签名不符的行

**B2 / B3**：
20. `cmd/save.mjs` 的 INSERT 列清单含 `temporal_type` / `summary_meta`，显式传 NULL
21. 新增不变量测试：含 ccmem 注入标记的 fixture transcript 经 `extractEntryText` 后**不含**任何标记

**通用**：
22. v0.12 测试套全量回归 100% 通过
23. `config.default.json::version` = `"0.13"`（文件在**仓库根**，不在 `scripts/` 下）
24. **Migration 不可变纪律**：已执行过的 migration 文件内容不再修改；补充改动一律新开下一号
    `.cjs` 幂等 migration（Finding 16 的防复发措施，见 §3.1）

### 1.5 与两篇参考文章的对应关系

| 文章结论 | v0.13 落点 |
|---|---|
| `agent-self-improvement` §10-1：别记环境性失败和否定性断言（hermes + openclaw 措辞逐字撞车）| **A2** |
| `agent-self-improvement` §10-3：用量决定去留 | 诊断出 ccmem 的 `frequency_factor` 因 `helpful` 恒 0 而失效 → **A1** 让它可测 |
| `agent-self-improvement` §10-8：召回回环防护 | **B3**（实测证伪 ccmem 存在该问题，但防护是意外获得的 → 钉成不变量）|
| `agent-self-improvement` §10-9：只有过程指标，没有结果指标 | A1 是朝这个方向的**最小一步**（把"记忆被用上了吗"从不可测变可测）|
| `retrieval-technology` §10.2：换模型/维度必须签名 + 版本化 | **B1** |
| `retrieval-technology` §3：别过度设计可插拔 / §13 图检索选型 | §1.2 明确拒绝图检索与 rerank |

> **一个必须记录的元结论**：`agent-self-improvement.md` 核对基准是 `ccmem v0.12.0-1-ge378dde`（即当前 HEAD），
> 它把 ccmem 评为七家中**唯一**把"判错"一路走到"消失"的一家。但该文 §11 明确写了"**实际跑过的：无**"。
> §0.4 的 live 数据说明：**设计是对的、代码也在，但生产速率差约 50 倍。**
> 教训——**读代码验证不了速率类不变量**，必须有 live 数据的定期体检（见 §十 backlog #1）。

---

## 二、架构（v0.13 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart / UserPromptSubmit (v0.13 零变化)                       │
│                                                                       │
│  Stop (v0.13 微增 A1):                                                │
│    v0.12 行为全部保留 (session_context / summarize 入队 / L2 / L2.5)  │
│    + recordL25Probe()  ← 新增, observe-only                          │
│        对 last unknown feedback 的每条 injected mem:                  │
│          计算 cov / lcp / id_literal → metrics.jsonl                 │
│        ⚠ 绝不调用 adjustTrust / markOutcomeForIds                     │
├──────────────────────────────────────────────────────────────────────┤
│  写入链路 (v0.13 增量 A2):                                            │
│    summarize_pending → LLM (prompt +2 条 DO-NOT-EXTRACT)             │
│      → checkQuality (+env_failure, +negative_assertion)              │
│        → Tier 1/2/2.5 (零变化) → insertMemory                        │
├──────────────────────────────────────────────────────────────────────┤
│  检索 (v0.13 增量 B1):                                                │
│    cosine 路 SELECT ... WHERE embedding_sig = ?  ← 新增过滤          │
│    query cache key = sha256(sig + prompt)        ← sig 含 dim        │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (v0.13 增量):                                                 │
│    memories.embedding_sig (新列)                                     │
│    schema_meta.version 15 → 16 (migration 016)                       │
└──────────────────────────────────────────────────────────────────────┘

Daemon 缺席影响：A1 / B3 全在 Tier 1（hook 层），100% 工作。
A2 的 quality gate 在 Tier 1，prompt 侧在 Tier 2（daemon 缺席时不抽取，自然无影响）。
B1 的签名过滤在 Tier 1；backfill 在 Tier 2。
```

### 2.1 新增 / 修改模块清单

```
scripts/
├── handlers/
│   └── stop.mjs                  # 【改】调用 recordL25Probe (A1)
├── lib/
│   ├── feedback.mjs              # 【改】新增 recordL25Probe + 特征计算 (A1)
│   ├── metrics.mjs               # 【改】8MB 单代轮转 (A1 前置, R7)
│   ├── quality-gate.mjs          # 【改】+env_failure +negative_assertion (A2)
│   ├── retrieval.mjs             # 【改】cosine 路签名过滤 + cache key 用 sig (B1)
│   ├── cmd/save.mjs              # 【改】INSERT 补 temporal_type / summary_meta (B2)
│   ├── embedding/signature.mjs   # 【新增】currentEmbeddingSig() (B1)
│   └── admin/diagnose.mjs        # 【改】--feedback 子命令 (A1) + --retrieval stale 行 (B1)
├── daemon/tasks/
│   ├── summarize-pending.mjs     # 【改】prompt +2 条 DO-NOT-EXTRACT (A2)
│   └── vec-backfill.mjs          # 【改】优先处理签名不符行 (B1)
└── migrations/
    └── 016_v013.sql              # 【新增】embedding_sig + version bump

config.default.json               # 【改】仓库根（不在 scripts/ 下）：
                                  #       version 0.13 + feedback.l25_probe 段
tests/
└── unit/v013-*.test.mjs          # 【新增】
```

---

## 三、Schema 迁移（v0.12 → v0.13）

### 3.1 迁移文件 `migrations/016_v013.sql`

```sql
-- ============================================================
-- migrations/016_v013.sql — v0.13 schema (embedding signature)
-- ============================================================

-- B1: 每条向量记录它是由哪个 (provider, model, dim) 产生的。
-- NULL 表示 v0.12 及更早写入的向量（来源未知）——按 stale 处理。
ALTER TABLE memories ADD COLUMN embedding_sig TEXT;

CREATE INDEX idx_memories_embedding_sig
  ON memories(embedding_sig) WHERE embedding IS NOT NULL;

UPDATE schema_meta SET version = 16, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (15, 16, 'v0.13: embedding_sig for model/dim versioning',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

> **A1 不需要 schema**：probe 特征走 `metrics.jsonl`，与 v0.10 的 `context_file_written`
> 同一设计取向——**每 turn 产生的高频观测数据不进 `audit_log`**，避免 audit 噪音。

> **015 教训的应用**：Finding 16 的根因是 live DB 跑过一份 interim-014，文件定稿后
> migration guard 见 13→14 已记录就永久跳过，缺的列再也补不上。
> **016 不存在这个风险**：`scripts/migrations/` 当前最高是 015，016 是全新文件，
> 未被任何环境执行过，因此纯 `.sql` 是安全的。
>
> **但由此确立一条纪律**（防止 Finding 16 再现）：**migration 文件一旦被任何环境执行过，
> 就不得再修改其内容**——需要补充的改动一律新开下一号 `.cjs` 幂等 migration。
> 落地为 §1.4 判据 #20。

### 3.2 `audit_log.action` 新增值

v0.13 **无新增 audit action**。A2 的新拒绝理由复用现有 `quality_gate_reject`，
通过 `details.reason` 区分（`env_failure` / `negative_assertion`）。

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.12 daemon（in-memory schema=15）看到 DB schema=16 | v0.5 self-restart 自动处理 |
| 存量 `embedding IS NOT NULL AND embedding_sig IS NULL` | 视为 stale：排除出 cosine 路 + 计入 `diagnose --retrieval` + 交给 `vec_backfill` 重算。**live DB 实测此类 0 行**（0 条记忆有向量），故实际迁移无痛 |
| v0.1–v0.12 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 |
| 存量 `query_embedding_cache` 行（R9）| B1 把 hash 输入从 `modelId` 改为签名 → **所有存量行的 `prompt_hash` 再也命中不了**，成为孤儿。无害（只是白占空间），由 daily_maintenance 的 30 天清理自然回收。**不**做一次性 purge——多写一段迁移代码去删一批注定过期的缓存不值得 |

---

## 四、Hooks（v0.13 改造）

### 4.1 Stop（A1：L2.5 probe，observe-only）

v0.12 行为：`runStop` → session_context + enqueue summarize_pending + L2/L2.5 反馈 + wake daemon。
v0.13 变更：**在现有 L2.5 之后追加一次 probe**，只记录特征，不参与任何判定。

```javascript
// scripts/handlers/stop.mjs (v0.13 增量)

// 现有导入（v0.12）：
//   import { inferFromTranscript, inferL25FromTranscript } from '../lib/feedback.mjs';
// v0.13 追加：
import { recordL25Probe } from '../lib/feedback.mjs';

// ... 现有 runStop 逻辑完全不变 ...
// 在现有 inferL25FromTranscript(...) 调用之后追加：

try {
  recordL25Probe(db, hookData.session_id, hookData.transcript_path, config);
} catch (e) {
  // probe 是纯观测，任何失败都不得影响 Stop hook 主流程
  process.stderr.write(`ccmem: l25 probe skipped (${e.message})\n`);
}
```

**关键约束**：

- probe 的数据源**必须是 `recent_injections`，不能是 `memory_feedback`** ⚠

  > **为什么（R1，spec review 抓到的阻塞级设计缺陷）**：`memory_feedback.outcome` 会被
  > 现有反馈逻辑就地改写——`updateImplicitHelpful`（`feedback.mjs:175`）在 L2.5 命中时调
  > `updateUnknownFeedback(..., 'helpful_implicit', ...)`（`:184`），`updateSelfCorrection`（`:194`）
  > 与 neg_keyword 路径（`:213`）同理。而 `getLastUnknownFeedback`（`:28`）**只返回仍是 `unknown` 的行**。
  >
  > 若 probe 跑在现有逻辑之后又去读 `memory_feedback`，则**凡是 legacy L2.5 命中的 turn，
  > probe 都会 early-return 什么都不记** → 采集到的 `l25_legacy_hit` **恒为 false**，
  > §5.1 决策表里"记录 legacy 判定作对照基线"整条失效。
  >
  > 更危险的是采样偏差方向：所有产生过任何反馈信号的 turn 都被排除，样本被系统性偏向
  > "无信号"那一侧——**这会把 v0.14 推向"词汇层无分离度"的结论，且从数据上看不出来。**
  >
  > `recent_injections` 从不被反馈逻辑改写，读它可让 probe 与反馈状态**完全解耦**，
  > 这也更符合 observe-only 的本意。

- probe **只取 `inject_source = 'user_prompt_submit'` 的注入行** ⚠
  SessionStart 的 `prompt_idx = 0` 批量注入（20–50 条）**必须排除**：它不是 turn-aligned，
  且 design.md 本就规定 session_start 反馈跳过 L1。混进来会污染分布。
- probe **绝不**调用 `adjustTrust` / `markOutcomeForIds` / `noteFeedback`（不变量 #122）
- probe 失败被 try/catch 吞掉并 stderr 告警——与 v0.11 `recordWriteHistory` 的失败处理一致

### 4.2 SessionStart / UserPromptSubmit（零变化）

不动。

---

## 五、核心改动

### 5.1 A1 — 反馈闭环量表

```javascript
// scripts/lib/feedback.mjs (v0.13 新增)

const CJK_OR_WORD = /[\p{L}\p{N}]+/gu;

/**
 * probe 需要 type / source 做分组分析，而现有 getRecentMemories 只 SELECT id, content
 * 且按 session 最近一次注入取——语义不同。故新增独立 helper，不改动现有函数。
 */
function probeMemoriesByIds(db, ids) {
  if (!ids.length) return [];
  return db.prepare(
    `SELECT id, content, type, source
     FROM memories
     WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
}

/** 归一化分词：小写 + 只保留字母数字段 + 丢弃长度 <2 的词 */
function featureTokens(text) {
  const out = new Set();
  for (const m of String(text ?? '').toLowerCase().matchAll(CJK_OR_WORD)) {
    if (m[0].length >= 2) out.add(m[0]);
  }
  return out;
}

/** memory-side coverage：这条记忆的词有多大比例出现在回复里 */
function memoryCoverage(memTokens, replyTokens) {
  if (memTokens.size === 0) return 0;
  let hit = 0;
  for (const t of memTokens) if (replyTokens.has(t)) hit += 1;
  return hit / memTokens.size;
}

/** 最长公共连续词串长度（以词为单位），上界受 memory 长度约束 */
function longestCommonPhrase(memWords, replyText) {
  const reply = replyText.toLowerCase();
  let best = 0;
  for (let i = 0; i < memWords.length; i += 1) {
    // 只在还有可能刷新纪录时继续扩展
    for (let len = best + 1; i + len <= memWords.length; len += 1) {
      if (!reply.includes(memWords.slice(i, i + len).join(' '))) break;
      best = len;
    }
  }
  return best;
}

/**
 * 取本 session 最近一次 **UserPromptSubmit** 注入的 mem_ids。
 *
 * ⚠ 数据源必须是 recent_injections 而非 memory_feedback——后者的 outcome 会被
 * 现有反馈逻辑就地改写，probe 跑在其后会系统性漏掉所有"有信号"的 turn（见 §4.1 R1）。
 * recent_injections 从不被反馈逻辑改写，读它可让 probe 与反馈状态完全解耦。
 *
 * inject_source 过滤排除 SessionStart 的 prompt_idx=0 批量注入（非 turn-aligned）。
 */
function latestPromptInjectionIds(db, sessionId) {
  const row = db.prepare(
    `SELECT mem_ids, prompt_idx
     FROM recent_injections
     WHERE session_id = ? AND inject_source = 'user_prompt_submit'
     ORDER BY prompt_idx DESC, id DESC
     LIMIT 1`
  ).get(sessionId);
  const ids = parseJsonArray(row?.mem_ids)
    .map(Number)
    .filter(Number.isFinite);
  return { ids, promptIdx: row?.prompt_idx ?? null };
}

/**
 * v0.13 A1：为本 session 最近一次 prompt 注入的每条记忆记录 L2.5 候选特征。
 * OBSERVE-ONLY —— 本函数及其调用链绝不修改 trust / outcome / decay_status。
 * 输出进 metrics.jsonl，供 v0.14 用实测分布定阈值。
 */
export function recordL25Probe(db, sessionId, transcriptPath, config) {
  if (config?.feedback?.l25_probe?.enabled === false) return;
  if (!sessionId) return;

  const replyText = lastAssistantTextOrEmpty(transcriptPath);
  if (!replyText) return;

  const { ids, promptIdx } = latestPromptInjectionIds(db, sessionId);
  if (!ids.length) return;

  const maxProbe = Number(config?.feedback?.l25_probe?.max_per_turn ?? 8);
  const replyTokens = featureTokens(replyText);
  const rows = probeMemoriesByIds(db, ids.slice(0, maxProbe));

  for (const mem of rows) {
    const content = String(mem.content ?? '');
    const memTokens = featureTokens(content);
    if (memTokens.size < 3) continue;   // 太短的记忆特征无意义

    const memWords = [...content.toLowerCase().matchAll(CJK_OR_WORD)].map((m) => m[0]);

    recordMetric({
      hook: 'stop',
      l25_probe: true,
      prompt_idx: promptIdx,   // turn 对齐锚点，供 v0.14 复原上下文
      mem_id: mem.id,
      mem_type: mem.type,
      mem_source: mem.source,
      l25_cov: Number(memoryCoverage(memTokens, replyTokens).toFixed(4)),
      l25_lcp: longestCommonPhrase(memWords, replyText),
      l25_id_literal: new RegExp(`\\bm${mem.id}\\b`).test(replyText),
      // v0.12 现役匹配器的判定，作为对照基线
      l25_legacy_hit: replyText.toLowerCase().includes(content.trim().toLowerCase()),
      mem_len: content.length,
      mem_tokens: memTokens.size,
      reply_len: replyText.length,
    });
  }
}
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 输出位置 | `metrics.jsonl` | 每 turn ≤8 行的高频观测；进 `audit_log` 会淹没 audit（与 v0.10 同取向）。**须配轮转，见 §5.1.1** |
| **数据源** | **`recent_injections`** | `memory_feedback.outcome` 会被现有逻辑就地改写 → 对照基线失效 + 采样偏差（§4.1 R1）|
| 是否改 trust | **否** | §0.5——阈值未知时改 trust 比不改更糟 |
| 同时记录 legacy 判定 | 是（`l25_legacy_hit`）| v0.14 需要"新指标 vs 现役匹配器"的对照，否则无法证明改进 |
| `max_per_turn` 上限 | 8 | 注入默认 ≤6；留 buffer 同时防止异常 feedback 行导致 hook 超预算 |
| 特征选择 | cov / lcp / id_literal | cov 已知无分离度（§0.5），但需要基线；lcp 是"逐字引用"的强信号；id_literal 检测 `[mNN]` 回显 |

> **诚实的限定**：这三个特征都是**词汇层面**的。若 v0.14 的实测数据显示三者**都**没有分离度，
> 那么结论就是"引用信号在词汇层不可得"，v0.14 必须转向别的信号源（而不是继续调阈值）。
> **A1 的价值在于它能把这个结论证伪或证实**，而不在于它假设了哪个特征会赢。

#### 5.1.1 `metrics.jsonl` 轮转（R7，A1 的前置条件）

`recordMetric`（`scripts/lib/metrics.mjs`）当前是**裸 `appendFileSync`，无任何大小上限或轮转**：

```javascript
export function recordMetric(event) {
  mkdirSync(getDataRoot(), { recursive: true });
  appendFileSync(path.join(getDataRoot(), 'metrics.jsonl'),
    `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}
```

live 环境该文件已达 **218KB**，而 A1 要在**频率最高的 hook** 上每 turn 再加 ≤8 行。
按 §0.4 的实测节奏，这是数倍增长——**不加轮转，A1 会把一个已知无上限的文件推到不可控。**

因此 A1 **必须**同时落地轮转，否则不得合入：

```javascript
// scripts/lib/metrics.mjs (v0.13 增量)
const MAX_METRICS_BYTES = 8 * 1024 * 1024;   // 8MB

export function recordMetric(event) {
  mkdirSync(getDataRoot(), { recursive: true });
  const file = path.join(getDataRoot(), 'metrics.jsonl');
  try {
    if (statSync(file).size > MAX_METRICS_BYTES) {
      // 单代轮转：.1 被覆盖，不做多代归档（诊断只需近期数据）
      renameSync(file, `${file}.1`);
    }
  } catch { /* 文件不存在或 stat 失败 → 直接写 */ }
  appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}
```

> **读取侧同步改造**：`readMetricsLines`（v0.10 从 `aggregateRetrievalTiming` 抽出的工具函数）
> 需在 `metrics.jsonl` 之外**也读 `metrics.jsonl.1`**，否则轮转当天所有 diagnose 输出会突然塌陷。
> 这是本条最容易漏的一半——轮转不是只加一个 rename。

### 5.2 A2 — 入口收紧

#### 5.2.1 summarize prompt 负面清单

```javascript
// scripts/daemon/tasks/summarize-pending.mjs — buildSummarizePrompt (v0.13 增量)
// 在现有 "Additional DO NOT extract rules:" 列表末尾追加两条：

'  - Environment/setup failures (missing binary, command not found, not installed,',
'    unconfigured tool). Record the FIX (what to install/configure) under an existing',
'    convention instead — never record the failure itself.',
'  - Negative assertions about tools ("X does not work", "X is unavailable").',
'    These harden into refusals the agent cites against itself long after the',
'    problem was fixed.',
```

> 措辞直接取自 hermes `_COMBINED_REVIEW_PROMPT` 与 openclaw 经验复审 abstain 清单——
> 两家在这一条上**措辞逐字撞车**（`agent-self-improvement` §10-1），是七家里证据最强的收敛结论之一。

#### 5.2.2 quality gate 两条新规则

```javascript
// scripts/lib/quality-gate.mjs (v0.13 增量)

// 环境性失败：高置信的"工具没装好/没配好"痕迹
const ENV_FAILURE = /(?:command not found|no such file or directory|\bENOENT\b|is not recognized as|not installed|could not be found|找不到命令|未安装|无法找到该?命令)/i;

// 否定性断言：对工具可用性的全称否定
const NEGATIVE_ASSERTION = /(?:\b(?:doesn['’]?t|does not|will not|won['’]?t|cannot|can['’]?t)\s+work\b|\bis (?:not available|unavailable|broken)\b|用不了|没法用|跑不起来|不可用)/i;

// ... 在 checkQuality 内，置于 path_list 规则之后：

// R2: 长度闸门——短文本里出现故障串 = 就是在记这个故障；
// 长文本里出现 = 多半是在记"遇到 X 时该怎么办"，那正是 prompt 鼓励产出的东西。
// 沿用本文件既有的 version_snapshot 规则（`&& text.length < 60`）同款手法。
const ENV_FAILURE_MAX_LEN = 120;

if (enabled.env_failure !== false
    && ENV_FAILURE.test(text)
    && text.length < ENV_FAILURE_MAX_LEN) {
  return { pass: false, reason: 'env_failure' };
}

if (enabled.negative_assertion !== false && NEGATIVE_ASSERTION.test(text)) {
  return { pass: false, reason: 'negative_assertion' };
}
```

**⚠ 误伤风险与取舍（必须实施时守住）**：

**两条新规则都有实质误伤风险**，而且危险方式不同。

**（a）`ENV_FAILURE` 会误伤 prompt 自己要求产出的东西（R2）。**
§5.2.1 的 prompt 写的是"Record the FIX ... never record the failure itself"——
但一条**照此要求写成**的记忆（如「遇到 `command not found` 时先跑 `nvm use 22`」）
必然包含那个故障串，裸 regex 会把它连同故障一起拒掉。**prompt 鼓励的产出被 gate 拒收，
是本版最讽刺的失效模式。** 因此加 `text.length < 120` 闸门：短文本≈纯故障记录，
长文本≈带补救措施。这不完美（长故障报告会漏），但**方向偏向"宁可漏，不可误伤"**。

**（b）`NEGATIVE_ASSERTION` 会误伤否定式的合法约定。** 合法项目约定经常是否定句式：

| 样本 | 期望 | 为什么 |
|---|---|---|
| `这个项目不支持 CommonJS，一律用 ESM` | **pass** | 合法约定；regex 不含"不支持" |
| `不要用 npm，这个项目用 pnpm` | **pass** | 合法偏好；regex 不含"不要用" |
| `Never use console.log in production code` | **pass** | 合法规则；regex 不含 "never use" |
| `遇到 command not found 时先跑 nvm use 22 切到项目要求的 Node 版本` | **pass** | **（a）的长度闸门**：>120 字符，是补救措施不是故障记录 |
| `npm: command not found` | reject | 短文本纯故障记录 |
| `sqlite-vec 在这台机器上跑不起来` | reject | 环境性否定断言 |
| `The MCP server doesn't work` | reject | 无依据的全称否定 |

设计取向：**regex 只抓"对工具可用性的全称否定"，不抓任何"该怎么做"的否定式规则。**
因此刻意**不**收录 `不支持` / `不要用` / `never use` / `avoid` 这些高频出现在合法约定里的词。
宁可漏（prompt 侧兜底），不可误伤——**误伤会直接丢掉最有价值的一类记忆**。

`NEGATIVE_ASSERTION` **不加**长度闸门：一条全称否定无论多长都会硬化成 agent 拒绝自己的理由，
长度不改变它的危害性质。这与（a）的取舍不同，是有意的不对称。

§1.4 判据 #9 要求把上表标 **pass** 的四行全部做成必过回归测试。

### 5.3 B1 — embedding 签名/版本化

```javascript
// scripts/lib/embedding/signature.mjs (v0.13 新增)

/**
 * 决定一条向量"含义"的全部配置：provider + model + dim。
 * 任一项变化都会让旧向量与新查询向量不可比（retrieval-technology §10.2）。
 */
export function currentEmbeddingSig(provider, config = null) {
  const e = config?.embedding ?? {};
  const dim = Number(provider?.dim ?? e.openai_dim ?? 0) || 0;

  let model;
  if (provider?.modelId) {
    model = String(provider.modelId);
  } else {
    switch (e.provider) {
      case 'openai': model = String(e.openai_model ?? 'text-embedding-3-small'); break;
      case 'jina':   model = 'jina-embeddings-v3'; break;
      default:       model = String(e.model ?? 'Xenova/all-MiniLM-L6-v2');
    }
  }
  return `${e.provider ?? 'local'}:${model}:${dim}`;
}
```

三处接线：

1. **写入**：任何写 `memories.embedding` 的地方同步写 `embedding_sig`（`vec_backfill`、`cmd/save.mjs` dedup 路径）
2. **cosine 路过滤**（`retrieval.mjs`）：

```javascript
const sig = currentEmbeddingSig(provider, config);
const allVecs = db.prepare(
  `SELECT id, embedding FROM memories
   WHERE embedding IS NOT NULL AND embedding_sig = ?
     AND status = 'active' AND decay_status IN ('active','probation')
     AND (scope = 'global' OR project_key = ?)`
).all(sig, projectKey);

// 可观测性：被排除的 stale 向量数进 metrics
const staleVecs = db.prepare(
  `SELECT COUNT(*) n FROM memories
   WHERE embedding IS NOT NULL AND (embedding_sig IS NULL OR embedding_sig <> ?)`
).get(sig).n;
```

3. **query cache key**：`promptHash(modelId, prompt)` → `promptHash(sig, prompt)`，
   且 `query_embedding_cache.model` 列改存签名（列名不变，避免 schema 变更）

> **为什么不靠 `cosineSimilarity` 的长度检查兜底**：它在维度不等时 `return 0`——
> **静默**把语义路对存量记忆全废；而同维不同模型时返回**看起来合理的垃圾数**，更难发现。
> 这违反 CLAUDE.md Rule 12「Fail loud」。签名过滤把"不可比"变成显式且可观测。

### 5.4 B2 — Finding 17（`save.mjs` 绕过 `insertMemory`）

`cmd/save.mjs` 用自有 INSERT，列清单不含 `temporal_type` / `summary_meta`，
于是 live DB 上 interim-014 遗留的 `DEFAULT 'temporary'` 对每条新 save 生效，
持续 defeat 015 的 cleanup，违反"NULL = untagged"不变量。

修复：INSERT 列清单补两列并显式传 `null`。**不**重建表移除 DEFAULT（过重）。

### 5.5 B3 — 召回回环不变量测试

实测已证伪 ccmem 存在召回回环（`transcript.mjs:extractContentText` 的
`part.type === 'text'` 过滤把 hook payload 与 tool_result 挡在外面，真实 transcript 上
注入标记 **0 条**进入提取路径）。但这是**意外获得的防护，不是设计出来的**——
将来若有人为拿更丰富上下文放宽该过滤器，回环会无声打开。

因此新增不变量测试：fixture transcript 含 `=== ccmem: stable context ===` /
`=== ccmem: retrieved` / `<!-- ccmem` 三种标记（分别置于 hook payload 形状、
`tool_result` part、`system-reminder` 形状），断言 `extractEntryText` 输出**不含**任何标记。

---

## 六、配置

### 6.1 config.default.json 新增段

```jsonc
{
  "version": "0.13",

  // v0.13 新增
  "feedback": {
    "l25_probe": {
      "enabled": true,        // observe-only 量表；关掉不影响任何判定
      "max_per_turn": 8       // 每 turn 最多 probe 几条记忆（防 hook 超预算）
    }
  },

  "quality": {
    "rules_enabled": {
      // ... 现有规则 ...
      "env_failure": true,          // v0.13 新增
      "negative_assertion": true    // v0.13 新增（误伤风险最高，可单独关）
    }
  }
}
```

### 6.2 配置向后兼容

| 配置 | 默认值 | 行为 |
|---|---|---|
| `feedback.l25_probe.enabled` | `true` | 只写 metrics，不改判定；关掉退化为 v0.12 行为 |
| `quality.rules_enabled.env_failure` | `true` | 缺省即启用（`!== false` 判定）|
| `quality.rules_enabled.negative_assertion` | `true` | 同上；误伤时用户可单独关这一条 |

---

## 七、测试策略

### 7.1 新增测试

| 类别 | 预计数 | 覆盖对象 |
|---|---|---|
| v013-l25-probe | 12 | 写 metrics 各字段（含 `prompt_idx`）/ **不调 trust（关键）** / **数据源是 recent_injections（R1）** / **legacy 命中的 turn 仍被 probe 记录且 `l25_legacy_hit=true`（R1 回归）** / **`inject_source='session_start'` 的注入被排除** / `enabled=false` 静默 / `max_per_turn` 截断 / 无注入时 no-op / transcript 缺失不抛 / mem_tokens<3 跳过 / `l25_legacy_hit` 与现役匹配器判定一致 / Stop 主流程不受 probe 失败影响 |
| v013-metrics-rotate | 3 | 超 8MB 触发 rename 到 `.1` / `readMetricsLines` 同时读 `.1`（R7）/ 首次写入无 `.1` 时不抛 |
| v013-quality-gate | 12 | env_failure 命中 ×2 / negative_assertion 命中 ×2 / **误伤回归 ×4**（§5.2.2 标 pass 的四行，含 R2 的长文本补救措施样本）/ 长度闸门边界 ×2 / rules_enabled 单独关 ×2 |
| v013-embedding-sig | 8 | 签名格式 / dim 变化改签名 / cosine 路过滤 stale / stale 计数 / cache key 含 dim / 写入同步写签名 / NULL 签名视为 stale / backfill 优先处理 |
| v013-save-temporal | 3 | INSERT 含两列 / 显式 NULL / 与 insertMemory 行为一致 |
| v013-recall-loop | 3 | 三种标记形状均不进入 `extractEntryText` |
| migration-016 | 3 | schema 15→16 / 幂等 / v0.1–v0.12 升级链兼容 |

**预计新增**：~44 个测试（12+3+12+8+3+3 = 41 个 `v013-*` + 3 个 `migration-016`）。

### 7.2 回归测试

v0.12 全量测试必须 100% 通过。

**特别关注**：
- `feedback` 现有测试：v0.13 在 Stop 链路上追加了调用，需确认现有 L2/L2.5 断言不受影响
- `quality-gate` 现有测试：新增两条规则位于 `path_list` 之后，不得改变既有 reason 的优先级
- `retrieval` 现有测试：cosine 路新增 `embedding_sig = ?` 过滤，测试 fixture 需写入签名

### 7.3 手工验证（dogfood 前）

| 步骤 | 预期 |
|---|---|
| 正常使用 3 个 prompt | `metrics.jsonl` 出现 `l25_probe:true` 行，字段完整 |
| `sqlite3 global.db "SELECT SUM(trust_score) FROM memories"` 前后对比 | **数值不变**（probe 不改 trust）|
| `ccmem admin diagnose --feedback` | 输出特征分布，样本数 > 0 |
| 构造一条含 `command not found` 的记忆走 save | 被 `env_failure` 拒 |
| 构造 `这个项目不支持 CommonJS，一律用 ESM` | **通过**（不误伤）|

---

## 八、dogfood 验证计划

### P0 — 必须在首日验证

**V1. probe 不改 trust（最关键的不变量）**
- [ ] 记录跑 probe 前后 `SELECT COUNT(*), SUM(trust_score) FROM memories`，确认逐位一致
- [ ] `memory_feedback` 的 outcome 分布不因 probe 改变

**V2. Stop hook 未超预算**
- [ ] `metrics.jsonl` 中 stop hook 的 `duration_ms` p95 仍 `< 200ms`

**V3. quality gate 未误伤**
- [ ] 观察一周内 `quality_gate_reject` 中 `negative_assertion` 的命中样本，**逐条人工过一遍**
- [ ] 若出现合法约定被拒 → 立即 `rules_enabled.negative_assertion=false` 并收窄 regex

### P1 — 首周收集（v0.14 的决策依据）

**V4. L2.5 特征分布（本版的核心产出）**
- [ ] **先验证 R1 修复真的生效**：确认样本里存在 `l25_legacy_hit:true` 的行。
      若一条都没有，**先别信任何分布结论**——要么 R1 没修对（probe 仍漏掉有信号的 turn），
      要么 legacy 匹配器在本周确实一次没命中（也可能，0.1% 命中率下 1000 样本期望仅 1 条）。
      两者靠"构造一条与回复逐字重合的记忆"来区分
- [ ] 累计 ≥1000 条 turn-aligned probe 样本
- [ ] 确认 `metrics.jsonl` 未失控增长；若已轮转，确认 `diagnose --feedback` 数字没有塌陷（R7）
- [ ] `diagnose --feedback` 看 `l25_cov` / `l25_lcp` / `l25_id_literal` 各自分布
- [ ] **决策点**：三者中是否有任一存在双峰 / 可用分离度？
  - 有 → v0.14 用它做匹配器，阈值取自实测
  - 无 → **结论是"引用信号在词汇层不可得"**，v0.14 必须转向别的信号源
- [ ] 人工标注 ~50 条样本（"这轮回复确实用了这条记忆吗"）作为 ground truth，
      否则只有分布、没有 precision/recall——**这一步不能省**

**V5. 入口速率是否下降**
- [ ] 对比 A2 前后的 `summarize_pending_applied` 日均值与 `quality_gate_reject` 构成
- [ ] 目标不是把入口砍到 0，而是**让 78/天里那些环境性/否定性噪音消失**

### P2 — 持续观察

**V6. 棘轮是否仍在**
- [ ] 每周记录 active 记忆数与 archived 数，作为 v0.14 出口修复的基线
- [ ] **注意**：v0.13 不修出口，所以库仍会增长——这是预期的，不是回归

---

## 九、不变量

| 不变量 | 验证方式 |
|---|---|
| **A1 probe 不改任何 trust / outcome / decay_status** | 单元测试 + grep #122 + dogfood V1 |
| **A1 probe 读 `recent_injections`，与反馈状态解耦（R1）** | 单元测试 + grep #130/#131/#132 + dogfood V4 首项 |
| `metrics.jsonl` 有大小上限且读取侧覆盖轮转文件（R7）| 单元测试 + grep #133/#134 |
| Trust 系数 / 优先级公式 / 归档阈值零变化 | 回归测试 |
| L1 / L2 / L2.5 / L4 判定逻辑零变化 | 回归测试 |
| 三路检索融合算法零变化（仅新增签名过滤）| 回归测试 |
| 写入闸门 Tier 1/2/2.5 零变化 | 回归测试 |
| file-based injection 行为零变化 | 回归测试 |
| Stop hook p95 < 200ms | dogfood V2 |
| ccmem 注入内容不进入 `extractEntryText` | 不变量测试（B3）|
| 合法否定式约定不被 quality gate 拒 | 误伤回归测试（§5.2.2）|

---

## 十、backlog 项

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | **live DB 定期体检命令**（速率类不变量：入口/出口比、trust 分化率、feedback 解决率）| v0.13 §1.5 元结论 | **P1** | v0.14——读代码验证不了速率 |
| 2 | 把"migration 不可变纪律"做成 CI 检查（比对已发布 migration 的 hash）| v0.13 §3.1 | P2 | v0.14 |
| 3 | **L2.5 真修复（改 trust）** | v0.13 §0.5 | **P0** | v0.14，依赖 V4 数据 |
| 4 | type 通胀治理（71% auto_inferred 被标 `rule`）| v0.13 §0.4 | P1 | v0.14 |
| 5 | 出口参数调整（归档阈值 / 半衰期）| v0.13 §1.2 | P2 | v0.14+，先修信号 |
| 6 | benchmark corpus ≥100 + per-lane recall | v0.12 Finding 6 | P2 | v0.14 |
| 7 | `synthesized=0` 连续 skip logic | v0.8 遗留 | P3 | 待更多数据 |
| 8 | better-sqlite3 + sqlite-vec ANN | v0.9 defer | P3 | 无压力（0 条向量）|
| 9 | 跨项目冷启动继承 | v0.9 defer | P3 | promote_candidates 已够用 |

---

## 附录 A：v0.13 不变量 checklist（CI grep）

| # | 不变量 | grep 命令 | 预期 |
|---|---|---|---|
| 120 | DEFAULT_CONFIG（runtime 权威）version 与当前版本一致 | `grep "version: '" scripts/lib/config.mjs \| head -1` | contains `version: '0.13'` |
| 121 | config drift 测试存在且可检测 | `ls -1 tests/unit/v013-config-sync.test.mjs` | 文件存在；测试验证 DEFAULT_CONFIG.version ≠ config.default.json.version 时失败 |
| 122 | **A1 probe 绝不调 trust** | `sed -n '/export function recordL25Probe/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'adjustTrust\|markOutcomeForIds\|noteFeedback'` | `0` |
| 123 | probe 输出走 metrics 而非 audit | `sed -n '/export function recordL25Probe/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'writeAudit'` | `0` |
| 124 | cosine 路带签名过滤 | `grep -c 'embedding_sig = ?' scripts/lib/retrieval.mjs` | `≥ 1` |
| 125 | query cache key 用签名而非裸 model 名 | `grep -c 'promptHash(modelId' scripts/lib/retrieval.mjs` | `0`（机械可检；R8 修正了原来那条需人判断的写法）|
| 126 | quality gate 新规则可单独关闭 | `grep -c "enabled.env_failure !== false\|enabled.negative_assertion !== false" scripts/lib/quality-gate.mjs` | `2` |
| 127 | `negative_assertion` regex 不含合法约定高频词 | `grep -n 'NEGATIVE_ASSERTION' scripts/lib/quality-gate.mjs` | 不含 `不支持`/`不要用`/`never use`/`avoid` |
| 128 | `save.mjs` INSERT 含 temporal_type | `grep -c 'temporal_type' scripts/lib/cmd/save.mjs` | `≥ 1` |
| 129 | v0.13 新增文件 100% 用 `writeAudit`，禁止 `logAudit(` | `grep -rl 'logAudit(' scripts/ \| wc -l` 且 `grep -c 'writeAudit(' scripts/daemon/tasks/vec-backfill.mjs` | `0` 且 `≥ 3`（原写法针对 `signature.mjs`，而该文件根本不写 audit，`logAudit(` 也不存在于整个 repo —— 任何改动都无法让它失败，故改为全仓禁令 + 一个真正写 audit 的 v0.13 文件的正向检查）|
| **130** | **probe 数据源是 `recent_injections` 而非 `memory_feedback`（R1）** | `sed -n '/function latestPromptInjectionIds/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'recent_injections'` | `≥ 1` |
| 131 | probe 排除 session_start 批量注入（R1）| `grep -c "inject_source = 'user_prompt_submit'" scripts/lib/feedback.mjs` | `≥ 1` |
| 132 | probe 不读 `memory_feedback`（R1）| `sed -n '/export function recordL25Probe/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'lastUnknownFeedbackOrNull\|feedbackIds'` | `0` |
| 133 | `metrics.jsonl` 有轮转上限（R7）| `grep -c 'MAX_METRICS_BYTES' scripts/lib/metrics.mjs` | `≥ 1` |
| 134 | `readMetricsLines` 同时读轮转文件（R7）| `grep -cF '${base}.1' scripts/lib/admin/diagnose.mjs` | `≥ 1`（原写法**误报失败**：行为在 `` for (const file of [`${base}.1`, base]) `` 处是正确的，但模板字面量里既没有 `metrics.jsonl.1` 也没有 `.1'`，grep 恒返回 0；改为对字面量本身做定长匹配）|
| 135 | `env_failure` 带长度闸门（R2）| `grep -c 'ENV_FAILURE_MAX_LEN' scripts/lib/quality-gate.mjs` | `≥ 2`（定义 + 使用）|
| **136** | **`semantic on` 不带 `--provider` 时清除 `config_kv` 覆盖，而不是重新钉住（Finding 6）** | `grep -c "DELETE FROM config_kv WHERE key = 'embedding.active_provider'" scripts/lib/admin/semantic.mjs` | `≥ 1` |
| **137** | **`openai` 已声明为可安装依赖（Finding 7）** | `grep -A5 optionalDependencies package.json \| grep -c '"openai"'` | `1` —— 必须落在 `optionalDependencies` 块内（与 `@xenova/transformers` 同级，provider 本就可选）。**只 grep `'"openai"'` 不够**：那样把它挪到文件任何位置都仍是绿 |
| **138** | **`npm test` 同时隔离配置路径与数据根（Finding 8 → Finding 12 之后必须两半齐全）** | `grep -c 'u CCMEM_CONFIG_PATH' package.json` 且 `grep -c 'CCMEM_DATA_ROOT=' package.json` | 均 `≥ 3`（`test` / `test:unit` / `test:integration` 各一）。**两半都要钉**：Finding 12 让配置路径回落到数据根之后，只 unset 变量不再构成隔离，测试会读到含 API key 的真实配置 |
| **139** | **`loadConfig()` 在无 `CCMEM_CONFIG_PATH` 时回落到库自己的 `config.json`，而非 `DEFAULT_CONFIG`（Finding 12）** | `sed -n '/export function loadConfig/,/^}/p' scripts/lib/config.mjs \| grep -c 'getConfigPath()'` | `≥ 1` |
| **140** | **每个 hook 都显式声明 harness 超时（Finding 13）** | `grep -c '"timeout":' hooks/hooks.json` 与 `grep -c '"type": "command"' hooks/hooks.json` | **两数必须相等**（当前均为 `3`）。**幅度不由本条守护** —— `externalMs > budget` 且余量 ≥ 1000ms 由 `tests/unit/v013-hook-timeout-budget.test.mjs` 断言；本条只钉"没有 hook 漏声明超时"，而那恰是该测试硬编码的 `HOOK_EVENTS` 覆盖不到的缺口 |
| **141** | **缺失的熔断键读作 absent 而非 `0`（Finding 14）** | `sed -n '/function readConfigKvInt/,/^}/p' scripts/lib/embedding/provider.mjs \| grep -c 'raw == null'` | `≥ 1` —— `Number(null) === 0` 是有限数，没有这道 guard，从未开过的熔断读起来就像开过 |

| **142** | **坏配置被拒绝，且 daemon 拒绝带病启动（Finding 5）** | `sed -n '/export function loadConfig/,/^}/p' scripts/lib/config.mjs \| grep -c 'ConfigError'` 且 `grep -c 'ConfigError' scripts/daemon/main.mjs` | 均 `≥ 2` —— 前者两处（解析失败 + 形状不是对象），后者两处（import + `instanceof` 判别）。**回落 `DEFAULT_CONFIG` 才是这里的坏结局**，不是抛错：那会让 daemon 用 `transformers-local` 去查一库 openai 向量，静默重造 Finding 12 |
| **143** | **`restart` 只在字节不等、环境字典可解析、G1–G4 全过时重写 plist（Finding 10）** | 无 grep 单条命令可钉——机制横跨 `parseEnvDict` / `evaluateGates` / `rewritePlistIfAllowed` 三处；见 `tests/integration/plist-drift.test.mjs` T3–T9、T11、T2 rewrite side | 其余一切情形（字节相等 / 不可解析 / 任一门不过）plist 字节不变，且 `restart` 仍成功。**条件是字节不等，不是 `status === 'drifted'`**：`in_sync` 时照样可能要写 |
| **144** | **延迟探针不得触碰熔断器与查询向量缓存（Finding 15）** | 无 grep 单条命令可钉——隔离横跨 `recordEmbedFailure` / `recordEmbedSuccess` / `query_embedding_cache` 三处；见 `tests/unit/v014-embed-latency-probe.test.mjs` 前两条测试 | `runEmbedLatencyProbe` 不调用 `recordEmbedFailure` / `recordEmbedSuccess`，不写 `query_embedding_cache`，也不预检熔断状态 —— 否则测量工具会制造被测现象：探针自己的超时会去开真实检索的闸门 |

**#143 的验红是部分的，如实记录**：本条由三个合取项组成（字节不等 / 可解析 / G1–G4 全过），
镜像验证只动了 **G1–G4 这一项**——把 `rewritePlistIfAllowed` 里 `if (!verdict.ok) {...}` 那段
注释掉，让门禁判定失效，跑 `tests/integration/plist-drift.test.mjs`：**T9**
（`a blocked gate still lets the restart finish`）与 **`CLI reporting: a blocked gate writes
the remedy to stderr`** 从绿翻红（30/30 → 28/30），其余 28 条不受影响。**字节相等短路**与
**解析失败判定**这两个合取项**未被本次验红触及**——它们是另一段代码，注释掉门禁判定不会碰到它们。
恢复镜像后跑回 30/30。（T3–T8 断言的是 `evaluateGates` 这个纯函数本身，不经过
`rewritePlistIfAllowed`，镜像改动碰不到它们；T11 断言的是解析失败分支，同理不受影响。）

**#144 的验红是部分的，如实记录**：本条由四个合取项组成（不调 `recordEmbedFailure` / 不调
`recordEmbedSuccess` / 不写 `query_embedding_cache` / 不预检熔断状态），镜像验证只动了
**`recordEmbedFailure` 这一项**——在 `runEmbedLatencyProbe` 的 `catch` 分支里接上
`recordEmbedFailure(db, cfg)`，跑 `tests/unit/v014-embed-latency-probe.test.mjs`：第 1 条
（`a probe failure never touches the circuit breaker or the query cache`）从绿翻红
（`config_kv` 计数 `1 !== 0`），其余六条不受影响，包括同一断言族里检查成功路径的第 2 条
（因为改动只落在失败分支，未接 `recordEmbedSuccess`）。**`recordEmbedSuccess` 的接入**、
**`query_embedding_cache` 写入**与**熔断状态预检**这三项**未被本次验红触及**——它们是
同一文件里的另外三段代码，本次镜像改动不会碰到它们。恢复镜像后跑回 7/7。

**Finding 15 的超时取值本身刻意没有条目**（探针的隔离另有 #144 —— 那是已落地的机制，
不是这句在说的、仍未重新推导的超时值）。它已取证但**未修**（`openai_timeout_ms: 800`
落在查询嵌入延迟分布中间），没有任何已落地的行为可钉。为未修的 finding 编一条不变量，

> 🆕🔴 **上一段的事实前提已于 2026-08-10（v0.13 闭合之后）失效**：`openai_timeout_ms` **已抬至 1200
> 并合进 `main`**，因此"未修""没有已落地的行为可钉"两句**只对 v0.13 闭合时点成立**。
> **本清单是 v0.13 的冻结产物，故不追补条目**；但下一版若要补，现在**确实有可钉的行为** ——
> 同一轮已落地一条把"embed 超时 + 词法回落"钉在 harness 硬限内的测试（提交标题
> `test(hook-budget): pin the embed timeout against the harness kill, not the budget that never fires`）。
> 完整状态见 `docs/ccmem-v0.13-dogfood.md` 末节《v0.13 闭合后：Finding 15 的后续》与 `docs/handoff/handoff.md` Ⅺ。

产出的只会是一条恒绿的检查
—— **#129 就是这么来的**：它原本针对 `signature.mjs`，而该文件根本不写 audit、`logAudit(` 也不存在于全仓，
**任何改动都无法让它失败**。（另两条返工是别的毛病，别混为一谈：#125 原写法需人判断，改成机械可检；
#134 原写法**误报失败**，是假红不是恒绿。）同理 Finding 15 的超时取值也无条目。（Finding 5 见 #142，Finding 10 见 #143；Finding 15 的探针隔离见 #144。）

**136–141 的验红方式（附录 A 是人工 checklist，没有 runner）**：把涉及的五个文件镜像到临时目录，
每条**各自单独回退一处修复**后跑同一条命令，实测：
136 `1→0`、137 `1→0`、138a `3→0`、138b `3→0`（**两半分别回退、各验一次**）、
139 `1→0`、140 `3→2`（`"type": "command"` 仍为 3 ⇒ 不等即红）、141 `1→0`、
**142a `2→0`、142b `2→0`**（同法，两半各自回退）。
绿态在真实文件上跑。⇒ 七条在对应修复被撤掉时都会变红，没有一条是恒绿的。

---

**End of v0.13 spec.**
