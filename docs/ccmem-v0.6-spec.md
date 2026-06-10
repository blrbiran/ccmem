# ccmem v0.6 实施 spec

> 这是 v0.6 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) /
> [`ccmem-v0.2-spec.md`](./ccmem-v0.2-spec.md) / [`ccmem-v0.3-spec.md`](./ccmem-v0.3-spec.md) /
> [`ccmem-v0.4-spec.md`](./ccmem-v0.4-spec.md) / [`ccmem-v0.5-spec.md`](./ccmem-v0.5-spec.md) 平级，
> 共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.5 让 ccmem 稳定下来（self-restart / CLI init / container fallback）；
> v0.6 让它**懂意思**——引入 embedding 三路混合检索（FTS5 + Jaccard + Cosine），让检索从
> "词汇匹配"升级到"语义理解"；同时用 embedding cosine 解决反复 defer 的 L1 正向反馈问题，
> 并迁移 `audit_log.ts` 到毫秒精度消除 race 风险。
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。
> design.md 引用仅作为决策 rationale 的指针。
>
> ---
> **2026-06-05 dogfood 修订**：以下 7 处 errata 源自 dogfood 验证（见 `ccmem-v0.6-dogfood.md` §十）。
>
> | # | 节 | 原文 | 修订 |
> |---|---|---|---|
> | E1 | §6.4 L551 | `useEmbedding = provider?.isLoaded()` 只检查 | hook 进程 `isLoaded()` 永远 false → 改为主动 `await provider.load()`（cold load ~65ms from cache） |
> | E2 | §二 架构图 L137 | "embedding 开启且已加载?" | 应为"embedding 开启 → 自动加载（~65ms）" |
> | E3 | 附录 A #45 | "hook 内不调 `provider.load()`" | lib/retrieval.mjs 现在调 load()；grep #45 仍 scoped 到 handlers/（PASS），但语义改为"handler 层不调 load，lib 层按需加载" |
> | E4 | 附录 D 降级表 | daemon 不跑时三路检索依赖 save 命令是否 load 过 | hook 自行 load，daemon 不跑也能用三路融合 |
> | E5 | §6.2 代码 | 无 mirror config | 加了 `env.remoteHost` / `env.remotePathTemplate`（config `embedding.remote_host`） |
> | E6 | §7.3 stats 输出 | "✓ loaded / not loaded" | 改为 "✓ active / pending backfill / enabled"（基于 embedded 计数） |
> | E7 | §4.2 性能预算 | "+embed 30-50ms" | 实测 hook 进程 embedding ON: ms_total ~194ms（含 cold load 65ms + embed 4ms + cosine + DB 查询），在 350ms 预算内 |

---

## 〇、与 v0.5 的关系与关键约定

### 0.1 v0.5 已实现的基线（不重复）

v0.5 已 ship 以下能力，v0.6 在其上叠加，**不重写**：

- daemon self-restart on schema mismatch（心跳检测 + graceful exit）
- CLI first-install `ensureSchema`（`cli.mjs` switch 前初始化 DB）
- cron config wire-up（`daily_at` / `weekly_at` 从 config 读）
- Container/Docker daemon fallback（probe systemd → PID+wrapper loop）
- migration backup 增殖修复（单次 backup + 跨进程去重 + 自动清理）

### 0.2 关键实现约定（沿用 v0.2/v0.3/v0.4/v0.5）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务。v0.6 不引入新 LLM 任务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.6 不引入新 LLM 调用 |
| **stdout/stderr 都进 LLM 上下文** | 元数据走 `audit_log`，stderr ≤ 2 行 LLM-safe 指针 |
| **命令 prelude 调 `maybeRunTier15`** | v0.6 新命令同样遵守 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |
| **`{XXX}` 模板占位符** | install 时由 `renderPlist` / `renderUnit` 替换 |

### 0.3 版本号

- `config.default.json::version` 从 `"0.5"` 升到 `"0.6"`
- schema `schema_meta.version` 从 `6` 升到 `7`（migration `007_v06.sql`）
- `config.default.json::security.scan_patterns_version` **不 bump**（v0.6 不动 patterns，避免无谓 revalidation）

### 0.4 v0.6 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — SessionStart | **零变化** |
| Hook 行为 — UserPromptSubmit | **增量**：embedding 路径 + L1 正向反馈（embedding 关闭时行为不变） |
| Hook 行为 — Stop | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **微增**：save 命令 INSERT 后同步 embed（不改闸门管线本身） |
| Trust 系数 / 优先级公式 | 零变化 |
| L1 否定关键词 / L2 / L2.5 / L4 | **零变化**（v0.6 新增 L1 正向路径，不改已有路径） |
| summarize_pending / weekly_synthesis / security_audit / revalidation | 零变化 |
| daily_maintenance | **微增**（step 15 vec_backfill + step 16 pending embedding 的 metrics_daily_rollup 字段） |
| Tier 1.5 lazy maintenance | 零变化 |
| daemon self-restart / container fallback | 零变化 |

---

## 一、范围与时间预算

### 1.1 v0.6 做什么（M7，约 4 周）

| Tier | # | 能力 | 说明 |
|---|---|---|---|
| **A** | A1 | **EmbeddingProvider 抽象 + Transformers.js 本地后端** | 接口 `{embed, dim, modelId, isLoaded, load, unload}`；v0.6 只 ship `transformers-local`（`Xenova/all-MiniLM-L6-v2`, 384-dim, 量化 ~23MB）；opt-in `embedding.enabled=true` |
| **A** | A2 | **三路混合检索** | FTS5(0.4) + Jaccard(0.2) + Cosine(0.4) 加权融合；向量存 `memories.embedding` BLOB 列；JS 层 cosine 计算；embedding 关闭/未加载时降级回两路 |
| **A** | A3 | **embedding 生成：同步+异步混合** | `save` 同步 embed 1 条(+50ms)；`summarize_pending` 产出留 NULL → daemon `vec_backfill` 批量 embed；升级后老记忆由 daemon 启动时 catch-up |
| **A** | A4 | **L1 正向反馈改为 embedding cosine** | 复用 retrieveMemories 的 queryVec + 肯定语气模式双门槛；取代反复 defer 的中文关键词方案 |
| **A** | A5 | **`audit_log.ts` 秒→毫秒迁移** | migration 内 `UPDATE ts = ts * 1000 WHERE ts < 10^10`；全部读写点统一毫秒；消除 v0.4 dogfood V13 race 风险 |
| **B** | B1 | **systemd `RestartLimitBurst`** | unit 文件加 2 行 |
| **B** | B2 | **import/export 基础版** | `ccmem export --json` / `ccmem import backup.json`；CLI-only |

### 1.2 v0.6 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 语义矛盾检测（跨记忆 LLM 比对） | v0.7+ | 先用 embedding 稳定后评估；cross_scope_alerts 已覆盖主要场景 |
| `monthly_meta_synthesis`（W-4） | v0.7+ | consolidated 池未膨胀到需要 |
| `project_key_alias` 漂移检测 | v0.7+ | 非核心闭环 |
| Windows scheduled task | v0.7+ | platform layer 留 `unsupported` 出口 |
| OpenAI / Jina / Voyage embedding 后端 | v0.7+ | EmbeddingProvider 接口预留；v0.6 只 ship transformers-local |
| better-sqlite3 + sqlite-vec 迁移 | v0.7+ | 个人用户 < 10K mems，JS cosine ~3ms 足够 |
| `loginctl enable-linger` 自动化 | 永不 | 需 sudo / polkit |
| 自动 nudge thresholds | 永不 | turf war + 用户 config 风险 |

### 1.3 完成判据（M7）

**A1 — EmbeddingProvider + Transformers.js**：
1. `embedding.enabled=true` 后 `/ccmem:admin semantic status` 显示 model + dim + loaded；`false` 时显示 disabled
2. `provider.embed(['test'])` 返回 `Float32Array[384]`；`cosine(vec, vec)` ≈ 1.0
3. 首次 `load()` 自动下载量化模型 ~23MB 到 Transformers.js cache
4. `embedding.enabled=false`（默认）时完全不 import `@xenova/transformers`，hook 行为 = v0.5

**A2 — 三路混合检索**：
5. embedding 开启时 UserPromptSubmit 检索结果含 cosine score；`/ccmem:list <query> --score` 显示三路 breakdown
6. embedding 关闭时检索结果与 v0.5 一致（回归测试 hash 比对）
7. `memories.embedding IS NULL` 的 mem 参与 FTS/Jaccard 但不参与 cosine（降级安全）

**A3 — embedding 生成**：
8. `/ccmem:save "test"` 在 embedding 开启且已加载时同步写入 embedding BLOB（`SELECT embedding FROM memories WHERE id=? → NOT NULL`）
9. `vec_backfill` daemon 任务批量填充 NULL embedding；`admin cron run vec_backfill` 手动触发
10. daemon 启动时 pending > 0 连续 backfill 到 0

**A4 — L1 正向反馈**：
11. 用户 prompt "对，就这样" 且上一轮 injection 有 cosine > 0.65 的 mem → `memory_feedback.outcome='helpful_implicit_partial'`（`applyOutcomeToSubset` 自动追加 `_partial` 后缀）+ 被归因 mem 的 `memories.trust_score +0.025`
12. 否定关键词命中时不进入正向路径（否定优先）
13. "对，但是这个不对" → AFFIRMATIVE_NEGATED 排除，不调 trust

**A5 — audit_log.ts 迁移**：
14. migration 后 `SELECT ts FROM audit_log LIMIT 1` → 毫秒级（> 10^12）
15. `writeAudit` 写入 `Date.now()` 毫秒；全部读取点统一毫秒
16. v0.5 测试套全量回归通过（`audit_log` 相关断言更新）

**通用**：
17. v0.5 测试套全量回归 100% 通过
18. embedding 关闭时所有 hook 输出与 v0.5 字符级一致

---

## 二、架构（v0.6 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart (v0.6 零变化)                                           │
│  UserPromptSubmit (v0.6 增量):                                        │
│    ┌─────────────────────────────────────────────────────────────┐   │
│    │ embedding 开启且已加载?                                       │   │
│    │  YES → embed(prompt) → 三路融合检索 (FTS+Jaccard+Cosine)    │   │
│    │        → L1 正向反馈 (cosine + 肯定语气双门槛)               │   │
│    │  NO  → 两路检索 (FTS+Jaccard, v0.5 行为)                    │   │
│    └─────────────────────────────────────────────────────────────┘   │
│  Stop (v0.6 零变化)                                                   │
├──────────────────────────────────────────────────────────────────────┤
│  写入路径 (lib/cmd/save.mjs::insertMemory)                            │
│    Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine              │
│    → INSERT memory                                                    │
│    → 同步 embed (provider 已加载时, +50ms; 否则留 NULL)               │
│    → regenerate cache                                                 │
├──────────────────────────────────────────────────────────────────────┤
│  Tier 1.5 lazy maintenance (v0.6 零变化)                              │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.6 增量)                                                   │
│   ├ 启动时: embedding.enabled → load() + catch-up backfill            │
│   ├ summarize_pending       (v0.2, 零变化; 产出 embedding=NULL)      │
│   ├ daily_maintenance       (v0.5, +step 15 vec_backfill              │
│   │                                +step 16 rollup embedding 字段)   │
│   ├ weekly_synthesis 03:17  (v0.2, 零变化)                            │
│   ├ security_audit  03:47   (v0.3, 零变化)                            │
│   ├ revalidation_audit      (v0.4, 零变化)                            │
│   └ vec_backfill            (v0.6 新增, 挂在 daily + 启动 catch-up)  │
├──────────────────────────────────────────────────────────────────────┤
│  Embedding 子系统 (v0.6 新增)                                         │
│   lib/embedding/                                                      │
│   ├ provider.mjs       getProvider(config) → EmbeddingProvider | null │
│   ├ transformers-local.mjs  @xenova/transformers 后端 (v0.6 唯一)    │
│   └ cosine.mjs         cosineSimilarity + vecToBlob + blobToVec       │
│                                                                       │
│   lib/retrieval.mjs    三路融合检索 (从 prompt-submit.mjs 提取)       │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite                                                               │
│   memories (+embedding BLOB 列)                                       │
│   audit_log (ts 迁移为毫秒)                                           │
│   metrics_daily_rollup (+vec_backfill_embedded 字段, v0.6 新增)       │
│   (其它 v0.5 表无变化)                                                │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 新增 / 修改模块清单

```
scripts/
├── lib/
│   ├── embedding/                     # 【新增】embedding 子系统
│   │   ├── provider.mjs               # 接口定义 + getProvider() 工厂
│   │   ├── transformers-local.mjs     # @xenova/transformers 后端
│   │   └── cosine.mjs                 # cosine similarity + BLOB 序列化
│   ├── retrieval.mjs                  # 【新增】三路融合检索 (从 prompt-submit.mjs 提取)
│   ├── feedback.mjs                   # 【改】+ inferPositiveFeedback (L1 cosine)
│   ├── audit.mjs                      # 【改】writeAudit ts 改为 Date.now() 毫秒
│   ├── metrics-rollup.mjs             # 【改】audit_log 查询统一毫秒 + vec_backfill 字段
│   ├── cmd/
│   │   ├── save.mjs                   # 【改】INSERT 后同步 embed
│   │   ├── list.mjs                   # 【改】--score 加 cosine 列
│   │   ├── stats.mjs                  # 【改】+ Semantic 行
│   │   └── audit.mjs                  # 【改】ts 显示删 * 1000
│   └── admin/
│       ├── semantic.mjs               # 【新增】on / off / status
│       ├── cron.mjs                   # 【改】白名单加 'vec_backfill'
│       └── platform/
│           └── linux.mjs              # 【改】B1 RestartLimitBurst
├── handlers/
│   └── prompt-submit.mjs             # 【改】调 retrieval.mjs + L1 正向
├── daemon/
│   ├── main.mjs                       # 【改】启动时 load embedding + catch-up backfill
│   ├── tasks/
│   │   ├── daily-maintenance.mjs      # 【改】+step 15 vec_backfill +step 16 rollup 字段
│   │   └── vec-backfill.mjs           # 【新增】批量 embed 任务
│   └── loop.mjs                       # 【改】dispatch 加 vec_backfill case
├── commands/
│   └── admin.md                       # 【改】加 semantic 子命令描述
└── migrations/
    └── 007_v06.sql                    # 【新增】v0.6 schema
```

---

## 三、Schema 迁移（v0.5 → v0.6）

### 3.1 迁移文件 `migrations/007_v06.sql`

v0.5 已实现 `ensureSchema → runMigration` 始终调用 + 失败 hard-exit + 自动备份 + 单次 backup +
跨进程去重。v0.6 只需新增 007 文件。

```sql
-- ============================================================
-- migrations/007_v06.sql — v0.6 schema (embedding + audit_log ts migration)
-- ============================================================

-- ---- 1. memories: 新增 embedding BLOB 列 ----
-- Float32Array 序列化为 binary, 读写效率比 JSON 字符串高 ~5x, 省空间 ~50%。
-- NULL = 尚未生成（vec_backfill 和 save 同步 embed 都靠 NULL 判断）。
-- 不建索引 — JS 层全量 cosine, 索引 BLOB 无意义且增大 DB 文件。
ALTER TABLE memories ADD COLUMN embedding BLOB;

-- ---- 2. audit_log.ts 秒 → 毫秒迁移 (A5) ----
-- 安全判定: ts < 10_000_000_000 (= 2286-11-20 in seconds) 一定是秒级;
-- ts >= 10_000_000_000 已经是毫秒 (不动)。
-- 幂等: 已经是毫秒的行不会被再乘 1000。
UPDATE audit_log SET ts = ts * 1000 WHERE ts < 10000000000;

-- ---- 3. metrics_daily_rollup: 新增 vec_backfill 字段 ----
-- daily_maintenance step 16 写入当日 backfill 产出。
ALTER TABLE metrics_daily_rollup ADD COLUMN vec_backfill_embedded INTEGER NOT NULL DEFAULT 0;

-- ---- 4. schema 版本推进 ----
UPDATE schema_meta SET version = 7, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (6, 7, 'v0.6: embedding BLOB + audit_log ts sec-to-ms + vec_backfill rollup',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值（无 schema 变更）

| action | 写入时机 | mem_id | details JSON 关键字段 |
|---|---|---|---|
| `vec_backfill_run` | `runVecBackfill` 每次跑完 | null | `{embedded, remaining, duration_ms}` |
| `vec_backfill_error` | `runVecBackfill` 失败 | null | `{error, embedded_before_fail}` |
| `semantic_enabled` | `/ccmem:admin semantic on` | null | `{model, dim}` |
| `semantic_disabled` | `/ccmem:admin semantic off` | null | `{}` |

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.5 老 memories `embedding=NULL` | ALTER 默认 NULL，不动；vec_backfill catch-up 逐步填充 |
| v0.5 audit_log.ts 秒级行 | `WHERE ts < 10^10` 批量 ×1000 迁移；已是毫秒的不动 |
| v0.5 daemon（in-memory schema=6）看到 DB schema=7 | A1 self-restart 自动处理：20s 内检测 → graceful exit(0) → 拉新 daemon |
| v0.1-v0.5 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002-007 |
| `embedding.enabled=false`（默认） | 完全不加载 `@xenova/transformers`；hook/检索/反馈 = v0.5 行为 |

---

## 四、Hooks（v0.6 增量）

### 4.1 SessionStart（零变化）

不动。v0.6 回归断言：注入文本与 v0.5 字符级一致。

### 4.2 UserPromptSubmit（增量：embedding 检索 + L1 正向）

v0.5 已实现 FTS5 + LIKE fallback + L1 否定关键词扫描 + `recent_injections` 写入。v0.6 增量：

1. 检索逻辑抽到 `lib/retrieval.mjs`（§六），handler 只调 `retrieveMemories()` + 渲染
2. embedding 开启且已加载时：`embed(prompt)` → 三路融合 → 返回 `{rows, queryVec}`
3. embedding 关闭时：两路检索 → 返回 `{rows, queryVec: null}`（v0.5 行为）
4. L1 正向反馈（§六.4）：否定未命中时调 `inferPositiveFeedback(db, sessionId, prompt, queryVec)`

```javascript
// scripts/handlers/prompt-submit.mjs (v0.6 增量)
import { retrieveMemories } from '../lib/retrieval.mjs';
import { inferPositiveFeedback } from '../lib/feedback.mjs';

export async function handlePromptSubmit(hookData) {
  return withHookSafety('prompt_submit', 500, async () => {
    // ... mode / config / db / projectKey / prompt 检查 (不变) ...

    // v0.6: 统一检索入口 (内部按 embedding 状态分路)
    const { rows, queryVec } = await retrieveMemories(db, searchPrompt, projectKey, config);

    if (rows.length === 0) {
      await recordMetric({ hook: 'prompt_submit', matched: 0, empty: true });
      return { additionalContext: '' };
    }

    // ... recent_injections / memory_feedback / recordMetric (不变) ...

    // L1 反馈推断 (v0.2 已有否定路径)
    if (mode !== 'shadow' && config.feedback?.l1_enabled !== false) {
      inferPrevTurnOutcome(db, hookData.session_id, hookData.prompt);
      // v0.6 新增: 否定未命中时尝试正向 (queryVec 来自 retrieveMemories 副产物)
      if (config.feedback?.l1_positive?.enabled !== false) {
        inferPositiveFeedback(db, hookData.session_id, hookData.prompt, queryVec);
      }
    }

    const block = renderRetrievedBlock(rows);
    return { additionalContext: mode === 'shadow' ? '' : block };
  });
}
```

**性能预算**（v0.6 更新）：

| 指标 | 含义 | embedding OFF p95 | embedding ON p95 | hard timeout |
|---|---|---|---|---|
| `ms_business` | 业务逻辑 | **< 100ms**（= v0.5） | **< 150ms**（+embed 30-50ms） | — |
| `ms_total` | hook entry → stdout | **< 300ms**（= v0.5） | **< 350ms** | 1000ms |

Transformers.js 单条 embed ~30-50ms（WASM 推理，量化模型）。全量 cosine 1000 mems × 384-dim ~3ms。
总计 embedding 路径增加 ~33-53ms，在预算内。

### 4.3 Stop（零变化）

不动。L2/L2.5 反馈推断路径不受 embedding 影响。

---

## 五、写入闸门（v0.6 微增）

`insertMemory` 的 Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine pipeline **不动**。
v0.6 在 INSERT 成功**之后**追加同步 embed：

```javascript
// scripts/lib/cmd/save.mjs (v0.6 增量, INSERT 之后 regenerateInjectionCache 之前)
import { getProvider } from '../embedding/provider.mjs';
import { vecToBlob } from '../embedding/cosine.mjs';

// ... INSERT INTO memories ... 得到 memId ...

// v0.6: 同步 embed (provider 已加载时)
const provider = getProvider(loadConfig());
if (provider?.isLoaded()) {
  try {
    const [vec] = await provider.embed([content]);
    db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`)
      .run(vecToBlob(vec), Number(memId));
  } catch {
    // embed 失败不阻塞 save — 留给 vec_backfill
  }
}

// ... regenerateInjectionCache (不变) ...
```

**关键约束**：embed 失败静默降级（try/catch），不影响 save 命令的 exit code 和 stdout 输出。
用户感知：save +50ms（embedding 开启且已加载时）；关闭时零变化。

---

## 六、v0.6 核心改动

### 6.1 EmbeddingProvider 抽象接口（`lib/embedding/provider.mjs`）

```javascript
// scripts/lib/embedding/provider.mjs

/**
 * EmbeddingProvider 接口约定:
 * {
 *   modelId: string,              // e.g. 'Xenova/all-MiniLM-L6-v2'
 *   dim: number,                  // e.g. 384
 *   embed(texts: string[]): Promise<Float32Array[]>,  // batch embed
 *   isLoaded(): boolean,
 *   load(): Promise<void>,        // 首次加载模型 (可能下载 ~23MB)
 *   unload(): void,
 * }
 */

import { loadConfig } from '../config.mjs';
import { openDb } from '../db.mjs';
// M1: 静态 import — 模块顶层声明不执行 pipeline(), 只有 load() 时才动态 import('@xenova/transformers')。
// getProvider 因此保持同步, 不需要 await import()。
import { transformersLocal } from './transformers-local.mjs';

let _cachedProvider = null;
let _cachedEnabled = null;

export function getProvider(config) {
  // C2 关键: embedding.enabled 可来自两个源:
  //   1. loadConfig() (JSON 文件层 — 用户手编 config.json)
  //   2. config_kv 表 (runtime toggle — /ccmem:admin semantic on/off)
  // config_kv 覆盖 JSON 层, 保证 toggle 跨进程/重启持久化。
  // 模式与 getMode() 读 config_kv('mode') 一致。
  const fileCfg = config?.embedding ?? loadConfig().embedding ?? {};
  const kvEnabled = readConfigKv('embedding.enabled');   // null | 'true' | 'false'
  const enabled = kvEnabled !== null ? kvEnabled === 'true' : !!fileCfg.enabled;
  if (!enabled) return null;

  // 缓存: 避免重复 import
  if (_cachedProvider && _cachedEnabled === true) return _cachedProvider;

  // M1 修正: getProvider 是同步函数。transformers-local.mjs 用静态顶层 import 引入
  // (模块声明不执行 pipeline, 只有 load() 时才动态 import('@xenova/transformers'))。
  // embedding.enabled=false 时 getProvider 返回 null, 模块被 import 但 load() 永远不调。
  const name = fileCfg.provider ?? 'transformers-local';
  switch (name) {
    case 'transformers-local': {
      _cachedProvider = transformersLocal;  // 静态 import, 同步
      _cachedEnabled = true;
      return _cachedProvider;
    }
    // v0.7+: case 'openai': ...
    default:
      throw new Error(`Unknown embedding provider: ${name}`);
  }
}

function readConfigKv(key) {
  try {
    const row = openDb().prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key);
    return row?.value ?? null;
  } catch { return null; }   // DB 不存在时静默降级
}

// 测试用: 重置缓存
export function _resetProviderCache() {
  _cachedProvider = null;
  _cachedEnabled = null;
}
```

### 6.2 Transformers.js 后端（`lib/embedding/transformers-local.mjs`）

```javascript
// scripts/lib/embedding/transformers-local.mjs
import { loadConfig } from '../config.mjs';

let extractor = null;

export const transformersLocal = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  dim: 384,

  isLoaded() { return extractor !== null; },

  async load() {
    if (extractor) return;
    const cfg = loadConfig().embedding ?? {};
    // 动态 import: 只在 load() 时才拉 @xenova/transformers
    const { pipeline } = await import('@xenova/transformers');
    extractor = await pipeline('feature-extraction',
      cfg.model ?? this.modelId,
      { quantized: cfg.quantized !== false }   // 默认量化
    );
  },

  async embed(texts) {
    if (!extractor) await this.load();
    const results = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      results.push(new Float32Array(output.data));
    }
    return results;
  },

  unload() {
    extractor = null;
  },
};
```

**关键设计点**：

| 决策 | 取值 | 理由 |
|---|---|---|
| `@xenova/transformers` 是 `optionalDependencies` | npm install 时自动装（~5MB）；装不上不 break install | `embedding.enabled=false` 时不 import 不 load；`load()` 时才动态 `import()` 触发模型下载 ~23MB |
| 动态 `import()` | 只在 `load()` 时 | 避免 module top-level 拉整个库（~5MB） |
| `quantized: true` | 默认 | 模型 ~23MB vs 原版 ~80MB，精度损失 <2% |
| `pooling: 'mean', normalize: true` | MiniLM 标准用法 | 产出单位向量，cosine = dot product |
| 逐条 embed | `for (const text of texts)` | Transformers.js 不支持真 batch；但 50 条 ~2s 在 daemon 内可接受 |

### 6.3 cosine 工具（`lib/embedding/cosine.mjs`）

```javascript
// scripts/lib/embedding/cosine.mjs

export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(buf) {
  // SQLite BLOB → Buffer → Float32Array
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}
```

### 6.4 三路混合检索（`lib/retrieval.mjs`）

从 `prompt-submit.mjs` 提取检索逻辑为独立模块，内部按 embedding 状态分两路：

```javascript
// scripts/lib/retrieval.mjs
import { cosineSimilarity, blobToVec } from './embedding/cosine.mjs';
import { getProvider } from './embedding/provider.mjs';
// M3: 导入来源说明 — 从现有模块 re-export 或新增到 search-utils.mjs:
//   sanitizeFtsQuery  ← 现有 fts-sanitize.mjs (re-export)
//   tokenize           ← 现有 text-util.mjs (re-export)
//   extractShortTokens ← 现有 prompt-submit.mjs 内联 (提取)
//   likeSearch         ← 现有 prompt-submit.mjs 内联 (提取)
//   dedupeMerge        ← 现有 prompt-submit.mjs 内联 (提取)
//   jaccardSimilarity  ← 新增 (word-token Jaccard, 区别于 dedup.mjs::jaccard() 的字符 trigram)
import { sanitizeFtsQuery, extractShortTokens, likeSearch, dedupeMerge,
         tokenize, jaccardSimilarity } from './search-utils.mjs';

/**
 * 统一检索入口。
 *
 * 路径 A (embedding 已加载):
 *   FTS5 top-N×3 → LIKE fallback → embed(prompt) → 全量 cosine top-N×2
 *   → 候选池合并 → 三路 score 归一化 + 加权融合 → pinned 优先 → top-limit
 *
 * 路径 B (embedding 关闭/未加载):
 *   FTS5 top-limit → LIKE fallback → pinned + type + recency 排序 (v0.5 行为)
 *
 * @returns {{ rows: Array, queryVec: Float32Array|null }}
 */
export async function retrieveMemories(db, prompt, projectKey, config) {
  const limit = config.inject?.max_per_prompt ?? 6;
  const provider = getProvider(config);
  const useEmbedding = provider?.isLoaded() ?? false;

  // ── Lane 1: FTS5 (词汇) ──
  const ftsQuery = sanitizeFtsQuery(prompt);
  const ftsLimit = useEmbedding ? limit * 3 : limit;
  let ftsRows = ftsQuery
    ? ftsSearch(db, ftsQuery, projectKey, ftsLimit)
    : [];

  // ── Lane 1.5: LIKE fallback (v0.1 U-4/I-4, 不变) ──
  if (ftsRows.length < (config.retrieval?.like_fallback?.trigger_when_fts_below ?? 3)) {
    const likeRows = likeSearch(db, prompt, projectKey, limit - ftsRows.length);
    ftsRows = dedupeMerge(ftsRows, likeRows);
  }

  if (!useEmbedding) {
    // 路径 B: 降级, v0.5 行为
    return { rows: ftsRows.slice(0, limit), queryVec: null };
  }

  // ── 路径 A: 三路融合 ──

  // embed(prompt)
  const [queryVec] = await provider.embed([prompt.slice(0, 2000)]);

  // ── Lane 2: Jaccard (对 FTS 候选集计算) ──
  const promptTokens = new Set(tokenize(prompt));

  // ── Lane 3: Semantic (全量 cosine) ──
  // M2: 必须同时过滤 status='active' (排除 superseded) 和 decay_status (排除 quarantine/archived)
  const allVecs = db.prepare(`
    SELECT id, embedding FROM memories
    WHERE embedding IS NOT NULL
      AND status = 'active'
      AND decay_status IN ('active', 'probation')
      AND (scope = 'global' OR project_key = ?)
  `).all(projectKey);

  const cosineScores = new Map();
  for (const row of allVecs) {
    cosineScores.set(row.id, cosineSimilarity(queryVec, blobToVec(row.embedding)));
  }

  // 合并候选 id (FTS 命中 + cosine top-N×2)
  const candidateIds = new Set(ftsRows.map(r => r.id));
  const cosineTop = [...cosineScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 2);
  for (const [id] of cosineTop) candidateIds.add(id);

  // 加载候选 mem 元数据
  // M2: 必须过滤 status='active' (排除 weekly_synthesis superseded 的老记忆)
  const candidates = candidateIds.size > 0
    ? db.prepare(`SELECT id, type, content, scope, pinned, trust_score,
                         decay_status, last_touched_at
        FROM memories WHERE id IN (${[...candidateIds].map(() => '?').join(',')})
          AND status = 'active'
          AND decay_status IN ('active', 'probation')`)
        .all(...candidateIds)
    : [];

  // 三路融合评分
  const w = config.retrieval?.weights ?? { fts: 0.4, jaccard: 0.2, semantic: 0.4 };

  const scored = candidates.map(mem => {
    const ftsRow = ftsRows.find(r => r.id === mem.id);
    const ftsScore = ftsRow ? normalizeRank(ftsRow.rank, ftsRows) : 0;
    const jaccardScore = jaccardSimilarity(promptTokens, new Set(tokenize(mem.content)));
    const cosineScore = cosineScores.get(mem.id) ?? 0;
    const fused = w.fts * ftsScore + w.jaccard * jaccardScore + w.semantic * cosineScore;
    return { ...mem, fused, ftsScore, jaccardScore, cosineScore };
  });

  // pinned 优先 → fused DESC → trust DESC
  scored.sort((a, b) =>
    (b.pinned - a.pinned) || (b.fused - a.fused) || (b.trust_score - a.trust_score));

  return { rows: scored.slice(0, limit), queryVec };
}

// BM25 rank 归一化到 [0, 1] — BM25 越负越好, 翻转+归一化
function normalizeRank(rank, allRows) {
  if (allRows.length <= 1) return 1;
  const ranks = allRows.map(r => r.rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  if (max === min) return 1;
  return (max - rank) / (max - min);  // 翻转: 最负 → 1, 最正 → 0
}

function ftsSearch(db, ftsQuery, projectKey, limit) {
  return db.prepare(`
    SELECT m.id, m.type, m.content, m.scope, m.pinned, m.trust_score,
           bm25(memories_fts) AS rank, 'fts' AS lane
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND (m.scope = 'global' OR m.project_key = ?)
      AND m.status = 'active'
      AND m.decay_status IN ('active', 'probation')
    ORDER BY m.pinned DESC, rank ASC
    LIMIT ?
  `).all(ftsQuery, projectKey, limit);
}
```

```javascript
// search-utils.mjs — jaccardSimilarity 定义 (M3)
// 注: 这是 word-token Jaccard, 区别于 dedup.mjs::jaccard() 的字符 trigram Jaccard。
// word-token 适合检索评分(语义信号更强);字符 trigram 适合去重(字面近似度)。
// CJK 文本: tokenize() 按空格/标点切分, CJK 连续段整段作为一个 token,
// 故中文 Jaccard 粒度较粗(句级而非词级)——v0.6 可接受, v0.7+ 可引入分词改进。
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  return intersection / (setA.size + setB.size - intersection);
}
```

**降级时权重重分配**：embedding 关闭时 `retrieveMemories` 直接走路径 B（v0.5 原逻辑），
不做权重重分配——路径 B 用 v0.5 的 pinned + type + recency 硬排序，与权重无关。

### 6.5 vec_backfill daemon 任务（`daemon/tasks/vec-backfill.mjs`）

```javascript
// scripts/daemon/tasks/vec-backfill.mjs
import { getProvider } from '../../lib/embedding/provider.mjs';
import { vecToBlob } from '../../lib/embedding/cosine.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';

/**
 * 批量生成缺失的 embedding。三个触发源:
 *   1. daily_maintenance step 15 (每日定时)
 *   2. daemon 启动后首次 mainLoop (catch-up 老记忆)
 *   3. manual: /ccmem:admin cron run vec_backfill
 */
export async function runVecBackfill(db, _task) {
  const t0 = Date.now();
  const cfg = loadConfig();
  const provider = getProvider(cfg);

  if (!provider) {
    writeAudit(db, 'vec_backfill_run', null, {
      skipped: 'embedding_disabled', duration_ms: Date.now() - t0,
    });
    return { embedded: 0, skipped: 'embedding_disabled' };
  }

  if (!provider.isLoaded()) {
    await provider.load();
  }

  const BATCH = cfg.embedding?.backfill_batch_size ?? 50;

  const candidates = db.prepare(`
    SELECT id, content FROM memories
    WHERE embedding IS NULL
      AND decay_status IN ('active', 'probation')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(BATCH);

  if (candidates.length === 0) {
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: 0, skipped: 'none_pending', duration_ms: Date.now() - t0,
    });
    return { embedded: 0 };
  }

  const texts = candidates.map(c => c.content);
  const vectors = await provider.embed(texts);

  const stmt = db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`);
  db.exec('BEGIN');
  let embedded = 0;
  try {
    for (let i = 0; i < candidates.length; i++) {
      stmt.run(vecToBlob(vectors[i]), candidates[i].id);
      embedded++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    writeAudit(db, 'vec_backfill_error', null, {
      error: String(e).slice(0, 200),
      embedded_before_fail: embedded,
    });
    throw e;
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM memories
    WHERE embedding IS NULL AND decay_status IN ('active','probation')`).get().n;

  writeAudit(db, 'vec_backfill_run', null, {
    embedded, remaining, duration_ms: Date.now() - t0,
  });
  return { embedded, remaining };
}

export function pendingEmbeddings(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM memories
    WHERE embedding IS NULL AND decay_status IN ('active','probation')`).get().n;
}
```

**daemon 启动时 catch-up（`daemon/main.mjs` 增量）**：

```javascript
// scripts/daemon/main.mjs (v0.6 增量, ensureSchema 之后 mainLoop 之前)
import { runVecBackfill, pendingEmbeddings } from './tasks/vec-backfill.mjs';
import { getProvider } from '../lib/embedding/provider.mjs';

// ... ensureSchema(db) / acquireDaemonLock / reclaimStaleLeases / startupCtx ...

// v0.6: embedding 启动 + catch-up backfill
const embeddingCfg = loadConfig().embedding ?? {};
if (embeddingCfg.enabled) {
  try {
    const provider = getProvider(loadConfig());
    if (provider && !provider.isLoaded()) {
      await provider.load();
    }
    // M5: catch-up 有上限, 防止 10K mems 导致 ~8min 启动延迟阻塞所有 cron
    // 默认 10 batches × 50/batch = 500 条, ~25s。剩余由 daily step 15 逐天追完。
    const maxBatches = embeddingCfg.max_startup_backfill_batches ?? 10;
    let batchesRun = 0;
    while (pendingEmbeddings(db) > 0 && batchesRun < maxBatches) {
      await runVecBackfill(db);
      batchesRun++;
    }
    const remaining = pendingEmbeddings(db);
    if (remaining > 0) {
      process.stderr.write(`ccmem: ${remaining} embeddings still pending (daily backfill will catch up)\n`);
    }
  } catch (e) {
    process.stderr.write(`ccmem: embedding load/backfill failed: ${e.message}\n`);
    // 非致命: daemon 继续跑, 检索降级回两路
  }
}

await mainLoop(db, () => stop, startupCtx);
```

**daily_maintenance 增量**：

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.6 增量)

// step 15: vec_backfill (embedding 开启时)
if (loadConfig().embedding?.enabled) {
  try {
    await runVecBackfill(db);
  } catch (e) {
    writeAudit(db, 'vec_backfill_error', null, {
      error: String(e).slice(0, 200),
    });
  }
}
```

**dispatch 路由**：

```javascript
// scripts/daemon/loop.mjs (v0.6 增量)
case 'vec_backfill':
  return runVecBackfill(db, task);
```

### 6.6 L1 正向反馈：embedding cosine（`lib/feedback.mjs` 增量）

```javascript
// scripts/lib/feedback.mjs (v0.6 增量)
import { cosineSimilarity, blobToVec } from './embedding/cosine.mjs';
import { getProvider } from './embedding/provider.mjs';
import { applyOutcomeToSubset } from './trust.mjs';
import { loadConfig } from './config.mjs';

// 肯定语气模式 (中英文, 宽松但有边界)
const AFFIRMATIVE = /^(对|好|嗯|是的|没错|正确|对的|好的|就这样|可以|行|OK|yes|yeah|right|correct|exactly|perfect|great|good|that'?s right|that works)/i;

// 排除: 肯定词后紧跟转折/否定
const AFFIRMATIVE_NEGATED = /^(对|好|嗯|是的|OK|yes|yeah).{0,5}(但是|不过|可是|然而|but|however|though|except)/i;

/**
 * L1 正向反馈: embedding cosine 路径。
 *
 * 触发条件 (全部满足):
 *   1. embedding 已加载 (provider.isLoaded())
 *   2. queryVec 非 null (retrieveMemories 产出)
 *   3. 当前 prompt 未命中否定关键词 (调用方保证: NEG/COR 命中后 early-return)
 *   4. 当前 prompt 匹配肯定语气模式
 *   5. 当前 prompt 与某条 injected mem 的 cosine > 阈值
 *
 * 只调 helpful_implicit (+0.025), 与 L2.5 平级。
 * 只对最高 cosine 的 1 条 mem 调 trust。
 */
export function inferPositiveFeedback(db, sessionId, prompt, queryVec) {
  const provider = getProvider(loadConfig());
  if (!provider?.isLoaded() || !queryVec) return;

  const trimmed = prompt.trim();
  if (!AFFIRMATIVE.test(trimmed)) return;
  if (AFFIRMATIVE_NEGATED.test(trimmed)) return;

  const cfg = loadConfig().feedback?.l1_positive ?? {};
  const cosineThreshold = cfg.cosine_threshold ?? 0.65;

  // 上一轮 user_prompt_submit injection
  const last = db.prepare(`
    SELECT id, injected_ids FROM memory_feedback
    WHERE session_id = ? AND outcome = 'unknown' AND outcome_locked = 0
      AND injection_source = 'user_prompt_submit'
      AND recorded_at > ?
    ORDER BY recorded_at DESC LIMIT 1
  `).get(sessionId, Date.now() - 5 * 60 * 1000);
  if (!last) return;

  const injectedIds = JSON.parse(last.injected_ids);
  if (injectedIds.length === 0) return;

  // 加载 injected mems 的 embedding
  const mems = db.prepare(`
    SELECT id, embedding FROM memories
    WHERE id IN (${injectedIds.map(() => '?').join(',')})
      AND embedding IS NOT NULL
  `).all(...injectedIds);

  // 找最高 cosine 的 mem
  let bestId = null, bestCosine = 0;
  for (const m of mems) {
    const sim = cosineSimilarity(queryVec, blobToVec(m.embedding));
    if (sim > bestCosine) { bestCosine = sim; bestId = m.id; }
  }

  if (bestCosine < cosineThreshold || bestId === null) return;

  applyOutcomeToSubset(db, last.id, [bestId], 'helpful_implicit',
    `l1_positive_cosine:${bestCosine.toFixed(3)}`);
}
```

**L1/L2/L2.5/L4 优先级协同（v0.6 更新）**：

```
同轮否定 (L1 NEG/COR) → 跳过 L1 正向 → L2 自纠 → 跳过 L2.5
同轮无否定 + 肯定语气 → L1 正向 cosine → L2 不触发 → L2.5 可叠加
```

L1 正向和 L2.5 可叠加：都是 +0.025，叠加 = 一次 helpful(+0.05)。
用户说"对"且 LLM 引用了记忆 = 强正信号，叠加 by design。

### 6.7 audit_log.ts 毫秒迁移——code 层联动

Schema 迁移在 §3.1 定义。code 层改动：

**写入点统一（两处改动）**：

```javascript
// scripts/lib/audit.mjs — writeAudit (v0.4 唯一签名)
export function writeAudit(db, action, mem_id, details) {
  const ts = Date.now();   // v0.6: 毫秒 (原: Math.floor(Date.now() / 1000))
  // ... 其余不变
}

// scripts/lib/audit.mjs — logAudit (v0.2/v0.3 backward-compat adapter)
// ⚠ C1 关键: logAudit 也必须改为 Date.now()——否则 memory-write.mjs 的 quarantine
// audit 和 daily-maintenance.mjs 的 sunset audit 仍写秒级 ts,在迁移后的毫秒表中
// 落在 ~10^9 范围,被所有 query window 跳过。
export function logAudit(db, { action, affected_ids, details }) {
  // ... 内部 forward 到 writeAudit (已改为 Date.now()), 自动统一毫秒
}
```

> **C1 批注**：`logAudit` 虽然 v0.4 起标为 backward-compat adapter，但仍有 2 个活跃调用点
> （`memory-write.mjs` quarantine audit + `daily-maintenance.mjs` sunset audit）。
> 由于 `logAudit` 内部 forward 到 `writeAudit`，只要 `writeAudit` 改了 `Date.now()`，
> `logAudit` 自动受益。但 **CI grep 不变量**必须同时覆盖 `logAudit` 自身不含 `Date.now()/1000`。
> 另注：`loop.mjs:179` 直接写 `Date.now()` 的已有路径在迁移后自然正确（已是毫秒）。

**读取点改动清单**（~15 处，统一删除 `/1000` 或 `*1000` 换算）：

| 文件 | 改动 |
|---|---|
| `metrics-rollup.mjs` | 删除 `dayStartSec`/`dayEndSec` 变量，统一用 `dayStartMs`/`dayEndMs` |
| `security-audit.mjs` | `ts BETWEEN ? AND ?` 参数改为毫秒 |
| `resurrect.mjs --revalidation` | `a.ts > ?` cutoff 改为毫秒 |
| `cmd/audit.mjs` show | `new Date(row.ts)` 删除 `* 1000` |
| `daily-maintenance.mjs` | security audit 聚合的 ts 窗口改为毫秒 |
| `diagnose.mjs --restart-history` | `new Date(row.ts)` 删除 `* 1000` |
| `diagnose.mjs --tuning` | audit_log 查询窗口改为毫秒 |
| `diagnose.mjs --metrics` | fetchWindow 统一毫秒 |

**CI grep 不变量**：

```bash
# v0.6 后禁止秒级 ts 写入 (writeAudit + logAudit 两个函数都检查)
grep -rn 'Date.now() / 1000\|Date.now()/1000' scripts/lib/audit.mjs
# → 应为空 (logAudit forward 到 writeAudit, 自身不含 ts 计算)
# 扩展检查: 全项目无遗漏
grep -rn 'Math.floor(Date.now()\s*/\s*1000)' scripts/
# → 应为空 (loop.mjs 原有 Date.now() 直写路径已安全)
```

---

## 七、命令延伸

所有命令遵守 v0.1 R-4 原则。命令 prelude 调 `maybeRunTier15`。

### 7.1 命令矩阵（v0.6 新增 / 扩展）

| Slash | CLI | 实现 | 类型 |
|---|---|---|---|
| `/ccmem:admin semantic <on\|off\|status>` | `ccmem admin semantic <verb>` | `lib/admin/semantic.mjs` | 新增 |
| `/ccmem:admin cron run vec_backfill` | 同 | `lib/admin/cron.mjs` 白名单加 | 扩展 |
| `/ccmem:list [query] --score` | 同 | `lib/cmd/list.mjs` | 扩展（加 cosine 列） |
| `/ccmem:stats` | 同 | `lib/cmd/stats.mjs` | 扩展（加 Semantic 行） |
| `ccmem export --json [--scope X]` | CLI only | `lib/cmd/export.mjs` | 新增 (Tier B) |
| `ccmem import <file>` | CLI only | `lib/cmd/import.mjs` | 新增 (Tier B) |

### 7.2 `/ccmem:admin semantic`

```javascript
// scripts/lib/admin/semantic.mjs
import { getProvider, _resetProviderCache } from '../embedding/provider.mjs';
import { loadConfig } from '../config.mjs';
import { writeAudit } from '../audit.mjs';
import { openDb } from '../db.mjs';

export async function cmdAdminSemantic(db, verb) {
  switch (verb) {
    case 'on': {
      setConfigKv(db, 'embedding.enabled', 'true');
      _resetProviderCache();
      const provider = getProvider({ embedding: { enabled: true } });
      await provider.load();
      const pending = db.prepare(`SELECT COUNT(*) AS n FROM memories
        WHERE embedding IS NULL AND decay_status IN ('active','probation')`).get().n;
      writeAudit(db, 'semantic_enabled', null, {
        model: provider.modelId, dim: provider.dim,
      });
      process.stdout.write(
        `ccmem: semantic search enabled (${provider.modelId}, ${provider.dim}-dim)\n`);
      if (pending > 0) {
        process.stderr.write(
          `ccmem: ${pending} memories pending embedding — run /ccmem:admin cron run vec_backfill or wait for daily\n`);
      }
      break;
    }
    case 'off': {
      setConfigKv(db, 'embedding.enabled', 'false');
      const provider = getProvider(loadConfig());
      if (provider) provider.unload();
      _resetProviderCache();
      writeAudit(db, 'semantic_disabled', null, {});
      process.stdout.write(
        `ccmem: semantic search disabled (retrieval falls back to FTS5+Jaccard)\n`);
      break;
    }
    case 'status': {
      const cfg = loadConfig();
      const provider = getProvider(cfg);
      if (!provider) {
        process.stdout.write(`ccmem: semantic search disabled\n`);
        break;
      }
      const pending = db.prepare(`SELECT COUNT(*) AS n FROM memories
        WHERE embedding IS NULL AND decay_status IN ('active','probation')`).get().n;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM memories
        WHERE embedding IS NOT NULL`).get().n;
      process.stdout.write(
        `ccmem: semantic search ${provider.isLoaded() ? 'loaded' : 'not loaded'}\n` +
        `  model: ${provider.modelId} (${provider.dim}-dim)\n` +
        `  embedded: ${total} / pending: ${pending}\n`);
      break;
    }
    default:
      process.stderr.write(`ccmem: unknown semantic verb '${verb}' (allowed: on/off/status)\n`);
      process.exit(64);
  }
}

function setConfigKv(db, key, value) {
  db.prepare(`INSERT INTO config_kv (key, value, set_at)
    VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, set_at=excluded.set_at`)
    .run(key, value, Date.now());
}
```

### 7.3 `/ccmem:stats` 增量

embedding 开启时加一行：

```
Semantic : ✓ loaded (Xenova/all-MiniLM-L6-v2, 384-dim, 12 pending backfill)
```

embedding 关闭时不打印（省 LLM token）。

### 7.4 `/ccmem:list --score` 增量

query 模式 + `--score` 时输出加 cosine 列（embedding 开启时）：

```
ID     Type  Scope    Pin  FTS    Jaccard  Cosine  Fused   Content
m42    rule  global        0.82   0.45     0.91    0.79    用户偏好简洁直接的回答风格
m78    fact  project       0.71   0.30     0.55    0.57    API 路由统一放在 /app/api/
```

embedding 关闭时 Cosine 列显示 `—`。

### 7.5 Tier B 命令（如有余力）

**B1 — systemd RestartLimitBurst**：`linux.mjs::renderUnit` 在 `[Unit]` section 加 2 行：

```ini
[Unit]
Description=ccmem daemon
After=default.target
StartLimitBurst=10
StartLimitIntervalSec=600
```

**B2 — import/export**：

```javascript
// scripts/lib/cmd/export.mjs — CLI only
export function cmdExport(db, { scope, projectKey, json }) {
  let sql = `SELECT id, scope, project_key, type, content, pinned, source,
                    trust_score, tags, created_at, updated_at
             FROM memories WHERE decay_status IN ('active','probation')`;
  const params = [];
  if (scope === 'global') { sql += ` AND scope='global'`; }
  else if (scope === 'project') { sql += ` AND project_key=?`; params.push(projectKey); }
  const rows = db.prepare(sql).all(...params);
  process.stdout.write(JSON.stringify({ version: '0.6', exported_at: Date.now(), memories: rows }, null, 2));
}

// scripts/lib/cmd/import.mjs — CLI only, 走 insertMemory 完整管线
export async function cmdImport(db, { filePath }) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let imported = 0, skipped = 0;
  for (const m of data.memories) {
    try {
      await insertMemory(db, {
        content: m.content, type: m.type,
        scope: m.scope, project_key: m.project_key,
        source: 'external',                    // import = external source
        trust_score: getSourceInitialTrust('external'),  // 0.3 + 观察期
        tags: JSON.parse(m.tags || '[]'),
      });
      imported++;
    } catch { skipped++; }
  }
  process.stdout.write(`ccmem: imported ${imported}, skipped ${skipped}\n`);
}
```

import 走 `insertMemory` 完整管线（Tier 1/2/2.5/3 闸门），source=`external`，初始 trust 0.3 + 观察期。
**注**：import 走 `insertMemory`（不是 `cmdSave`），因此**不**触发同步 embed——导入的记忆
embedding 全为 NULL，由 `vec_backfill` 异步补充。这是 by design：批量导入时同步 embed
每条 +50ms 会让整体导入时间不可控。

---

## 八、配置（v0.6 增量）

`config.default.json` 升到 `"version": "0.6"`。新增段：

```jsonc
{
  "version": "0.6",
  "embedding": {
    "enabled": false,                           // opt-in, 默认关闭
    "provider": "transformers-local",           // v0.6 唯一后端; v0.7+ 加 openai/jina/voyage
    "model": "Xenova/all-MiniLM-L6-v2",        // Transformers.js 模型 id
    "quantized": true,                          // 量化版 ~23MB (false → 原版 ~80MB)
    "backfill_batch_size": 50,                  // vec_backfill 每批条数
    "max_startup_backfill_batches": 10,         // M5: daemon 启动时最多跑 10 批 (500 条, ~25s)
    "cache_dir": null,                          // null = Transformers.js 默认 (node_modules/@xenova/transformers/.cache/)
    "remote_host": null,                       // null = huggingface.co; 中国用户设 "https://hf-mirror.com"
    "remote_path_template": "{model}/resolve/{revision}/"
  },
  "retrieval": {
    // v0.1-v0.5 已有 like_fallback 等, 不重复
    "weights": {
      "fts": 0.4,                               // FTS5 BM25 词汇匹配权重
      "jaccard": 0.2,                           // Jaccard 词重叠权重
      "semantic": 0.4                           // cosine 语义相似度权重
    }
    // embedding 关闭时三路 weights 不生效, 走 v0.5 原路径 (pinned+type+recency 硬排序)
  },
  "feedback": {
    // v0.2 已有 l1_enabled / attribution / l4 等, 不重复
    "l1_positive": {
      "enabled": true,                          // L1 正向反馈开关
      "cosine_threshold": 0.65                  // 双门槛之一: cosine > 此值
    }
  }
}
```

4 层合并（default < user < project < env）沿用。项目级 config **不接受** `embedding.*` 覆盖——
避免单项目改全局 embedding 配置。`retrieval.weights.*` 和 `feedback.l1_positive.*` **允许**项目级覆盖——
不同项目可能需要不同的检索权重和反馈阈值。

---

## 九、测试策略

| 类别 | 覆盖对象 | 关键断言 |
|---|---|---|
| **Schema migration** | `007_v06.sql` 幂等；v0.5 DB(version=6) 升 7 | `embedding` BLOB 列加成功；`audit_log.ts` 行全部 > 10^12（毫秒）；`metrics_daily_rollup.vec_backfill_embedded` 列加成功；老数据 `embedding=NULL` |
| **Unit: cosine** | `cosineSimilarity` 纯函数 | 同向量 → 1.0；正交 → 0.0；反向 → -1.0；维度不匹配 → NaN（不 throw） |
| **Unit: vecToBlob / blobToVec** | round-trip | `Float32Array → BLOB → Float32Array` 字节精确一致 |
| **Unit: getProvider** | enabled/disabled/unknown | `false` → null；`true` + `transformers-local` → provider 对象；unknown → throw |
| **Unit: transformersLocal** | mock `@xenova/transformers` | `load()` 调 `pipeline()`；`embed(['test'])` 返回 `Float32Array[384]`；`isLoaded()` 正确反映状态；`unload()` 清理 |
| **Unit: retrieveMemories 路径 B** | embedding 关闭 | 返回与 v0.5 `handlePromptSubmit` 一致的结果集（id 列表 + 排序）；`queryVec=null` |
| **Unit: retrieveMemories 路径 A** | embedding 开启 | FTS + cosine 候选合并正确；融合分计算正确；pinned 优先；embedding=NULL 的 mem 不参与 cosine 但仍参与 FTS |
| **Unit: normalizeRank** | BM25 翻转归一化 | 最负 → 1.0；最正 → 0.0；单行 → 1.0 |
| **Unit: inferPositiveFeedback** | 双门槛真值表 | 肯定语气 + cosine > 0.65 → helpful_implicit；无肯定语气 → skip；cosine < 0.65 → skip；AFFIRMATIVE_NEGATED → skip；queryVec=null → skip；embedding=NULL mems → skip；否定优先（调用方保证） |
| **Unit: AFFIRMATIVE regex** | 中英文正向词 | "对。" → match；"yes" → match；"对了，这个文件" → no match（不在 AFFIRMATIVE 列表）；"好像" → no match |
| **Unit: AFFIRMATIVE_NEGATED regex** | 转折排除 | "对，但是不对" → match；"好，不过要改" → match；"对，就这样" → no match |
| **Unit: runVecBackfill** | batch embed + 事务 | NULL → embed → BLOB 正确写入；embedding disabled → skip + audit；empty candidates → skip + audit；embed 失败 → ROLLBACK + throw |
| **Unit: pendingEmbeddings** | COUNT(*) | 有 NULL 和非 NULL 行时计数正确 |
| **Unit: cmdAdminSemantic** | on/off/status 三分支 | on → config_kv + load + audit；off → config_kv + unload + audit；status 输出含 model/dim/pending |
| **Unit: writeAudit ts 毫秒** | 迁移后写入 | `writeAudit` 写入的 ts 是毫秒级（> 10^12）；不再有 `/1000` |
| **Unit: audit 读取点毫秒统一** | metrics-rollup / security-audit / resurrect / diagnose / audit show | 所有 `ts BETWEEN` 参数为毫秒；`new Date(row.ts)` 无 `*1000` |
| **Integration: embedding 开启 e2e** | 开启 → save → list --score → 关闭 | save 写入 embedding BLOB；list 显示 cosine score；关闭后回退两路 |
| **Integration: vec_backfill e2e** | 插入 5 条 NULL embedding → runVecBackfill → 全部 NOT NULL | audit `vec_backfill_run` embedded=5 remaining=0 |
| **Integration: daemon 启动 catch-up** | 插入 100 条 NULL → daemon 启动 → while loop 全部填充 | pendingEmbeddings(db) = 0 |
| **Integration: L1 正向 e2e** | 注入 m42 → 用户 "对，就这样" → verify trust | memory_feedback.outcome='helpful_implicit'；m42.trust_score +0.025 |
| **Integration: L1 否定优先** | 注入 m42 → 用户 "不对，错了" → verify | L1 否定命中；inferPositiveFeedback 不调用；m42.trust_score -0.10 |
| **Integration: audit_log.ts 迁移端到端** | v0.5 DB 含秒级 ts → 升级 → 验证全部毫秒 | `SELECT MIN(ts) FROM audit_log` > 10^12 |
| **回归: v0.5 全套** | embedding 关闭时 hooks 输出哈希 / FTS5 结果集 / Stop 入队 payload | 与 v0.5 字符级一致 |
| **回归: Tier 1/2/2.5/3 写入闸门** | 全套真值表 | 零变化 |
| **性能: hook 预算** | UserPromptSubmit embedding ON | p95 `ms_total` < 350ms (含 embed ~50ms + cosine ~3ms) |
| **B1: systemd unit** | renderUnit snapshot | 含 `StartLimitBurst=10` + `StartLimitIntervalSec=600` |
| **B2: export/import** | round-trip | export → import → 内容一致；import 走 Tier 1/2/3 闸门；source=external trust=0.3 |

**强制门禁**：
- Schema migration + cosine unit + provider unit 通过
- embedding 关闭回归 100% 通过（与 v0.5 行为一致）
- 三路融合检索 integration 通过
- L1 正向反馈真值表通过
- audit_log.ts 迁移端到端通过
- v0.5 全量回归 100% 通过

---

## 十、实施顺序（4 周 / M7）

### Week 1 — schema + embedding 基础设施

1. `migrations/007_v06.sql`（embedding BLOB + ts 迁移 + rollup 字段）+ migration 测试
2. `lib/embedding/cosine.mjs`（cosineSimilarity + vecToBlob + blobToVec）+ unit
3. `lib/embedding/provider.mjs`（getProvider + 工厂 + 缓存）+ unit
4. `lib/embedding/transformers-local.mjs`（load/embed/unload）+ mock unit
5. `lib/admin/semantic.mjs`（on/off/status）+ unit
6. `lib/audit.mjs` writeAudit ts 改 `Date.now()` + 全部读取点毫秒统一（~15 处）+ audit_log 回归测试

### Week 2 — 三路检索 + vec_backfill

7. `lib/retrieval.mjs`（三路融合检索核心）+ 路径 A/B 分路 unit
8. `lib/search-utils.mjs`（从 prompt-submit.mjs 提取 sanitizeFtsQuery / extractShortTokens / likeSearch / dedupeMerge / tokenize / jaccardSimilarity）
9. `handlers/prompt-submit.mjs` 改调 `retrieveMemories()` + 回归测试（路径 B = v0.5 行为）
10. `daemon/tasks/vec-backfill.mjs`（runVecBackfill + pendingEmbeddings）+ unit
11. `daemon/loop.mjs` dispatch 加 `vec_backfill` + `lib/admin/cron.mjs` 白名单
12. `daemon/main.mjs` 启动时 load + catch-up backfill
13. `daemon/tasks/daily-maintenance.mjs` step 15 vec_backfill + step 16 rollup 字段
14. Integration: embedding 开启 e2e（save → list --score → backfill → 检索含 cosine）

### Week 3 — L1 正向反馈 + 命令 + Tier B

15. `lib/feedback.mjs` inferPositiveFeedback（AFFIRMATIVE/NEGATED regex + cosine 双门槛）+ 真值表 unit
16. `handlers/prompt-submit.mjs` 接入 L1 正向反馈（否定优先 + queryVec 复用）
17. `lib/cmd/save.mjs` INSERT 后同步 embed + unit
18. `lib/cmd/list.mjs --score` 加 cosine 列 + `lib/cmd/stats.mjs` Semantic 行
19. Tier B1: `linux.mjs` renderUnit 加 RestartLimitBurst + snapshot 测试更新
20. Tier B2: `lib/cmd/export.mjs` + `lib/cmd/import.mjs`（如有余力）+ round-trip 测试
21. `commands/admin.md` 更新（加 semantic 子命令描述）

### Week 4 — 集成 + 加固

22. Integration: L1 正向反馈 e2e（肯定 + 否定优先 + 转折排除）
23. Integration: audit_log.ts 迁移端到端（v0.5 DB → v0.6 → 全部毫秒验证）
24. Integration: daemon 启动 catch-up backfill（100 条 NULL → 全部填充）
25. 性能: UserPromptSubmit embedding ON p95 < 350ms 验证
26. 回归: v0.5 全量测试套 + embedding 关闭回归
27. 回归: Tier 1/2/2.5/3 写入闸门全套真值表
28. mode 矩阵: shadow/off 下 embedding + L1 正向行为
29. `config.default.json` bump 到 0.6 + embedding/retrieval/feedback 新段
30. **M7 验收**（§1.3 完成判据 18 条）

### 依赖关系

```
007 schema → cosine.mjs → provider.mjs → transformers-local.mjs
                ↓                              ↓
           retrieval.mjs ←──────── prompt-submit.mjs
                ↓                              ↓
           vec-backfill ←──── daily step 15    L1 positive feedback
                ↓                              ↓
           daemon catch-up                semantic on/off/status
                                               ↓
                                          stats + list --score

audit.mjs ts 毫秒 → 全部读取点 (横穿 Week 1)
Tier B (B1/B2) 独立, 可并行
```

---

## 附录 A：v0.6 不变量 checklist（CI grep）

沿用 v0.5 附录 A 全部 41 条，新增 v0.6 专属：

42. `@xenova/transformers` 仅在 `transformers-local.mjs` 内 import
    （`grep -rn '@xenova/transformers' scripts/` 应只在该文件）
43. `getProvider` 在 `embedding.enabled=false` 时返回 null，不 import 模型库
    （unit test 覆盖：mock config `enabled:false` → `getProvider` 返回 null 且不调 require/import）
44. `retrieveMemories` 路径 B（embedding 关闭）不含任何 cosine / embed 调用
    （`grep -n 'cosine\|embed' scripts/lib/retrieval.mjs` 全部在 `useEmbedding` 条件块内）
45. hook 内不调 `provider.load()`
    （`grep -rn 'provider.load\|\.load()' scripts/handlers/` 应为空——hook 只调 `isLoaded()` 和 `embed()`）
46. `writeAudit` 写入 `Date.now()` 毫秒（不除以 1000）
    （`grep -rn 'Date.now() / 1000\|Date.now()/1000' scripts/lib/audit.mjs` 应为空）
47. `inferPositiveFeedback` 仅在否定未命中时被调用
    （code review 验证：`inferPrevTurnOutcome` 在 NEG/COR 命中后 early-return，`inferPositiveFeedback` 在其之后调用）
48. `vec_backfill` 事务包裹（`BEGIN`/`COMMIT`/`ROLLBACK`）
    （`grep -n 'BEGIN\|COMMIT\|ROLLBACK' scripts/daemon/tasks/vec-backfill.mjs` 各 ≥ 1）
49. `save.mjs` 同步 embed 在 try/catch 内，失败不影响 save 结果
    （`grep -A3 'provider.embed' scripts/lib/cmd/save.mjs` 包含 catch）
50. `allVecs` 全量 cosine 查询含 `status = 'active'` + `decay_status IN ('active','probation')` 双过滤（M2）
    （`grep -n "status = 'active'" scripts/lib/retrieval.mjs` 至少 3 处：ftsSearch + allVecs + candidates）
51. `embedding` BLOB 列无 INDEX
    （`grep -rn 'CREATE INDEX.*embedding' scripts/migrations/` 应为空）
52. v0.6 新增文件 100% 用 `writeAudit`，禁用 `logAudit`
    （`grep -rn 'logAudit(' scripts/lib/embedding/ scripts/lib/retrieval.mjs scripts/lib/admin/semantic.mjs scripts/daemon/tasks/vec-backfill.mjs` 应为空）

---

## 附录 B：从 v0.5 spec 引用的关键约定速查

| 约定 | 出处 | v0.6 沿用 |
|---|---|---|
| 同步 DatabaseSync API | v0.2 §0.2 | ✓ |
| `await callClaudeP` 不持锁 | v0.2 §7.4 | ✓（v0.6 无新 LLM 任务） |
| LLM 输出走 parseLlmJson + JSON schema | v0.2 §8.5 | ✓（无新 schema） |
| stdout/stderr 都进 LLM 上下文 | v0.1 R-4 / v0.2 §5.0.2 | ✓ |
| writeAudit helper | v0.1 §5.6.2 / v0.4 §6.5 统一 | ✓（v0.6 改 ts 为毫秒） |
| daemon 防递归 | v0.2 §4.0 / §7.4 | ✓ |
| task_runs lease 防重复 | v0.2 §八 | ✓ |
| Tier 1.5 lazy maintenance | v0.2 §8.4 | ✓（v0.6 不动） |
| daemon-optional 三档定位 | motivation §三 / v0.2 §1.2 | ✓ |
| migration 失败 hard-exit + 自动备份 | v0.2 §3.3 / v0.5 A5 | ✓ |
| Tier 3 quarantine 写入闸门 | v0.3 §五 | ✓（v0.6 不动） |
| security_audit cron | v0.3 §6 | ✓ |
| revalidation_audit | v0.4 §6.1 | ✓ |
| metrics_daily_rollup | v0.4 §6.4 | ✓（v0.6 加 vec_backfill_embedded 字段） |
| platform 抽象层 | v0.4 §6.6 | ✓（v0.6 B1 systemd unit 微调） |
| daemon self-restart | v0.5 §6.0-6.5 | ✓（schema 6→7 自动触发） |
| container fallback | v0.5 §6.12-6.19 | ✓ |

---

## 附录 C：未在 v0.6 实现但已埋设的钩子（for v0.7+）

| 钩子 | 已在 v0.6 准备 | v0.7+ 用途 |
|---|---|---|
| `EmbeddingProvider` 接口 + `getProvider` 工厂 | ✓ | v0.7 加 `openai` / `jina` / `voyage` 后端：只需新增文件 + switch case |
| `embedding.provider` config 字段 | ✓ | v0.7 用户切换后端：`config.embedding.provider='openai'` |
| `embedding.cache_dir` config 字段 | ✓ | v0.7 用户自定义模型缓存位置 |
| `retrieval.weights` config 可调 | ✓ | v0.7 `--tuning` 加 embedding 权重建议规则 |
| `memories.embedding` BLOB 列 | ✓ | v0.7 如切到 better-sqlite3 + sqlite-vec，BLOB 列直接作为 ANN 输入；JS cosine 路径保留作降级 |
| `vec_backfill_run` audit action | ✓ | v0.7 `--metrics` 加 embedding 进度和质量跟踪 |
| `feedback.l1_positive.cosine_threshold` config | ✓ | v0.7 `--tuning` 加 L1 正向阈值建议 |
| B2 import/export `source='external'` | ✓ | v0.7 跨设备同步基础 |

---

## 附录 D：daemon 缺席降级表（v0.6 更新）

| daemon 状态 | 三路检索 | L1 正向 | vec_backfill | save 同步 embed | Tier 1.5 | security_audit |
|---|---|---|---|---|---|---|
| ✅ 跑 | ✓（embedding 已 load） | ✓ | ✓（daily + 启动 catch-up） | ✓ | ✓ | ✓ |
| ❌ 不跑 | ✓*（hook 内 embedding 如已被 save 命令 load 过则可用；否则降级两路） | ✓* | ✗ 跳过 | ✓（save 命令内同步 load + embed） | ✓ | ✗ |

`*` — daemon 不跑时 embedding 模型的加载取决于用户是否在当前进程中跑过 `save` 或 `admin semantic on`。
实际场景：daemon 死后用户仍可 `save`（同步 load + embed），但 backfill 老记忆不会发生。
`/ccmem:stats` 三档显示仍一致。

---

## 附录 E：dogfood 记录（待 dogfood 期填）

> 真实使用过程中发现的行为偏差、阈值不合理、误判等记录在这里。

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| TBD | (待 dogfood 期填) | | |

---

**End of v0.6 spec.**
