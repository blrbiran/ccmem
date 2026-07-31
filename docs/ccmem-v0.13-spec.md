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

- `config.default.json::version` 从 `"0.11"` 升到 `"0.13"`

  > ⚠ **已发现的遗留问题**：根 `config.default.json` 当前是 `"0.11"`，而 schema 已是 15（v0.12）。
  > **v0.12 漏了这次 version bump。** v0.13 一并补上，直接跳到 `"0.13"`（不补写 `"0.12"`，
  > 因为该版本已 ship，回填一个从未存在过的中间值没有意义）。
  > 同时新增不变量 #120（附录 A）防止再次漏 bump。

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
| active `auto_inferred` 中 `type='rule'` | **2571**（71%） | type 通胀（rule = 最高 base_priority）|
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
| 图检索 / 多跳 / GraphRAG | 不做 | 注入预算 ≤6 条、库千条量级，非真实痛点；见 §0.7 |
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
1. 每个有注入的 turn，Stop hook 为每条被注入记忆写一行 `metrics.jsonl`，含 `l25_cov` / `l25_lcp` / `l25_id_literal` / `mem_len` / `reply_len`
2. **trust 零变化**：A1 代码路径不调用 `adjustTrust` / `markOutcomeForIds`（不变量 #121）
3. probe 失败（transcript 缺失 / 解析失败）不阻断 Stop hook 其余逻辑
4. Stop hook p95 仍 `< 200ms`（≤6 条记忆 × 1 次回复的 token set 运算）
5. `diagnose --feedback` 新子命令输出 probe 特征分布（p50/p75/p90/p95/max + 各阈值命中率）
6. `feedback.l25_probe.enabled=false` 时完全不产生 probe 记录

**A2 — 入口收紧**：
7. summarize prompt 含"环境性失败"与"否定性断言"两条 DO-NOT-EXTRACT
8. `checkQuality` 新增 `env_failure` / `negative_assertion` 两条规则，均可经 `rules_enabled` 单独关闭
9. **误伤回归**：一组合法记忆样本（含"这个项目不支持 CommonJS"这类合法否定式约定）全部 `pass`（§5.2.2）
10. 新规则命中时 `quality_gate_reject` audit 的 `reason` 字段能区分到具体规则名

**B1 — embedding 签名**：
11. `memories.embedding_sig` 列存在；写入向量时同步写签名 `provider:model:dim`
12. cosine 路只对 `embedding_sig = <当前签名>` 的行计算；签名不符的行被排除且计数
13. `query_embedding_cache` 的 key 含 dim（改用签名而非裸 model 名）
14. `diagnose --retrieval` 输出 stale 向量数（签名不符 / 签名为 NULL 但 embedding 非空）
15. `vec_backfill` 优先处理签名不符的行

**B2 / B3**：
16. `cmd/save.mjs` 的 INSERT 列清单含 `temporal_type` / `summary_meta`，显式传 NULL
17. 新增不变量测试：含 ccmem 注入标记的 fixture transcript 经 `extractEntryText` 后**不含**任何标记

**通用**：
18. v0.12 测试套全量回归 100% 通过
19. `config.default.json::version` = `"0.13"`
20. **Migration 不可变纪律**：已执行过的 migration 文件内容不再修改；补充改动一律新开下一号
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
│   ├── quality-gate.mjs          # 【改】+env_failure +negative_assertion (A2)
│   ├── retrieval.mjs             # 【改】cosine 路签名过滤 + cache key 用 sig (B1)
│   ├── cmd/save.mjs              # 【改】INSERT 补 temporal_type / summary_meta (B2)
│   ├── embedding/signature.mjs   # 【新增】currentEmbeddingSig() (B1)
│   └── admin/diagnose.mjs        # 【改】--feedback 子命令 (A1) + --retrieval stale 行 (B1)
├── daemon/tasks/
│   ├── summarize-pending.mjs     # 【改】prompt +2 条 DO-NOT-EXTRACT (A2)
│   └── vec-backfill.mjs          # 【改】优先处理签名不符行 (B1)
├── config.default.json           # 【改】version 0.13 + feedback.l25_probe 段
└── migrations/
    └── 016_v013.sql              # 【新增】embedding_sig + version bump
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

---

## 四、Hooks（v0.13 改造）

### 4.1 Stop（A1：L2.5 probe，observe-only）

v0.12 行为：`runStop` → session_context + enqueue summarize_pending + L2/L2.5 反馈 + wake daemon。
v0.13 变更：**在现有 L2.5 之后追加一次 probe**，只记录特征，不参与任何判定。

```javascript
// scripts/handlers/stop.mjs (v0.13 增量)

import { recordL25Probe } from '../lib/feedback.mjs';

// ... 现有 runStop 逻辑完全不变 ...
// 在现有 applyStopFeedback(...) 之后追加：

try {
  recordL25Probe(db, hookData.session_id, hookData.transcript_path, config);
} catch (e) {
  // probe 是纯观测，任何失败都不得影响 Stop hook 主流程
  process.stderr.write(`ccmem: l25 probe skipped (${e.message})\n`);
}
```

**关键约束**：
- probe **必须**在现有反馈逻辑**之后**——它读的是同一批 `injected_ids`，
  但绝不能影响那批逻辑看到的状态
- probe **绝不**调用 `adjustTrust` / `markOutcomeForIds` / `noteFeedback`（不变量 #121）
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
 * v0.13 A1：为最近一次 unknown feedback 的每条被注入记忆记录 L2.5 候选特征。
 * OBSERVE-ONLY —— 本函数及其调用链绝不修改 trust / outcome / decay_status。
 * 输出进 metrics.jsonl，供 v0.14 用实测分布定阈值。
 */
export function recordL25Probe(db, sessionId, transcriptPath, config) {
  if (config?.feedback?.l25_probe?.enabled === false) return;
  if (!sessionId) return;

  const replyText = lastAssistantTextOrEmpty(transcriptPath);
  if (!replyText) return;

  const feedback = lastUnknownFeedbackOrNull(db, sessionId);
  const ids = feedbackIds(feedback);
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
| 输出位置 | `metrics.jsonl` | 每 turn ≤8 行的高频观测；进 `audit_log` 会淹没 audit（与 v0.10 同取向）|
| 是否改 trust | **否** | §0.5——阈值未知时改 trust 比不改更糟 |
| 同时记录 legacy 判定 | 是（`l25_legacy_hit`）| v0.14 需要"新指标 vs 现役匹配器"的对照，否则无法证明改进 |
| `max_per_turn` 上限 | 8 | 注入默认 ≤6；留 buffer 同时防止异常 feedback 行导致 hook 超预算 |
| 特征选择 | cov / lcp / id_literal | cov 已知无分离度（§0.5），但需要基线；lcp 是"逐字引用"的强信号；id_literal 检测 `[mNN]` 回显 |

> **诚实的限定**：这三个特征都是**词汇层面**的。若 v0.14 的实测数据显示三者**都**没有分离度，
> 那么结论就是"引用信号在词汇层不可得"，v0.14 必须转向别的信号源（而不是继续调阈值）。
> **A1 的价值在于它能把这个结论证伪或证实**，而不在于它假设了哪个特征会赢。

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

if (enabled.env_failure !== false && ENV_FAILURE.test(text)) {
  return { pass: false, reason: 'env_failure' };
}

if (enabled.negative_assertion !== false && NEGATIVE_ASSERTION.test(text)) {
  return { pass: false, reason: 'negative_assertion' };
}
```

**⚠ 误伤风险与取舍（必须实施时守住）**：

`NEGATIVE_ASSERTION` 是本版**唯一有实质误伤风险**的改动。合法的项目约定经常是否定式的：

| 样本 | 期望 | 为什么 |
|---|---|---|
| `这个项目不支持 CommonJS，一律用 ESM` | **pass** | 合法约定；regex 不含"不支持" |
| `不要用 npm，这个项目用 pnpm` | **pass** | 合法偏好；regex 不含"不要用" |
| `Never use console.log in production code` | **pass** | 合法规则；regex 不含 "never use" |
| `sqlite-vec 在这台机器上跑不起来` | reject | 环境性否定断言 |
| `The MCP server doesn't work` | reject | 无依据的全称否定 |

设计取向：**regex 只抓"对工具可用性的全称否定"，不抓任何"该怎么做"的否定式规则。**
因此刻意**不**收录 `不支持` / `不要用` / `never use` / `avoid` 这些高频出现在合法约定里的词。
宁可漏（prompt 侧兜底），不可误伤——**误伤会直接丢掉最有价值的一类记忆**。

§1.4 判据 #9 要求把上表前三行做成必过回归测试。

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
| v013-l25-probe | 9 | 写 metrics 各字段 / **不调 trust（关键）** / `enabled=false` 静默 / `max_per_turn` 截断 / 无 unknown feedback 时 no-op / transcript 缺失不抛 / mem_tokens<3 跳过 / `l25_legacy_hit` 与现役匹配器一致 / Stop 主流程不受 probe 失败影响 |
| v013-quality-gate | 10 | env_failure 命中 ×2 / negative_assertion 命中 ×2 / **误伤回归 ×3**（§5.2.2 前三行）/ rules_enabled 单独关 ×2 / reason 字段可区分 |
| v013-embedding-sig | 8 | 签名格式 / dim 变化改签名 / cosine 路过滤 stale / stale 计数 / cache key 含 dim / 写入同步写签名 / NULL 签名视为 stale / backfill 优先处理 |
| v013-save-temporal | 3 | INSERT 含两列 / 显式 NULL / 与 insertMemory 行为一致 |
| v013-recall-loop | 3 | 三种标记形状均不进入 `extractEntryText` |
| migration-016 | 3 | schema 15→16 / 幂等 / v0.1–v0.12 升级链兼容 |

**预计新增**：~36 个测试。

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
- [ ] 累计 ≥1000 条 turn-aligned probe 样本
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
| **A1 probe 不改任何 trust / outcome / decay_status** | 单元测试 + grep #121 + dogfood V1 |
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
| 120 | `config.default.json` version 与当前版本一致 | `grep -m1 '"version"' config.default.json` | `"0.13"` |
| 121 | **A1 probe 绝不调 trust** | `sed -n '/export function recordL25Probe/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'adjustTrust\|markOutcomeForIds\|noteFeedback'` | `0` |
| 122 | probe 输出走 metrics 而非 audit | `sed -n '/export function recordL25Probe/,/^}/p' scripts/lib/feedback.mjs \| grep -c 'writeAudit'` | `0` |
| 123 | cosine 路带签名过滤 | `grep -c 'embedding_sig = ?' scripts/lib/retrieval.mjs` | `≥ 1` |
| 124 | query cache key 用签名而非裸 model 名 | `grep -n 'promptHash(' scripts/lib/retrieval.mjs` | 参数为 sig，不含 `modelId` |
| 125 | quality gate 新规则可单独关闭 | `grep -c "enabled.env_failure !== false\|enabled.negative_assertion !== false" scripts/lib/quality-gate.mjs` | `2` |
| 126 | `negative_assertion` regex 不含合法约定高频词 | `grep -n 'NEGATIVE_ASSERTION' scripts/lib/quality-gate.mjs` | 不含 `不支持`/`不要用`/`never use`/`avoid` |
| 127 | `save.mjs` INSERT 含 temporal_type | `grep -c 'temporal_type' scripts/lib/cmd/save.mjs` | `≥ 1` |
| 128 | v0.13 新增文件 100% 用 `writeAudit`，禁止 `logAudit(` | `grep -rn 'logAudit(' scripts/lib/embedding/signature.mjs` | 为空 |

---

**End of v0.13 spec.**
