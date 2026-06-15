# ccmem v0.9 实施 spec

> 这是 v0.9 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) /
> [`ccmem-v0.2-spec.md`](./ccmem-v0.2-spec.md) / [`ccmem-v0.3-spec.md`](./ccmem-v0.3-spec.md) /
> [`ccmem-v0.4-spec.md`](./ccmem-v0.4-spec.md) / [`ccmem-v0.5-spec.md`](./ccmem-v0.5-spec.md) /
> [`ccmem-v0.6-spec.md`](./ccmem-v0.6-spec.md) / [`ccmem-v0.7-spec.md`](./ccmem-v0.7-spec.md) /
> [`ccmem-v0.8-spec.md`](./ccmem-v0.8-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.8 让 ccmem 学会了"归纳"（synthesis maturity）；v0.9 让它**自我清洁和自我发现**——
> 低价值记忆通过反馈信号自动退场、注入行为从黑盒变为透明可观测、跨项目知识模式自动浮现。
> 从"存一切然后整合"升级为"干净进 → 精炼出 → 跨项目发现"的自适应管线。
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。
> design.md 引用仅作为决策 rationale 的指针。

---

## 〇、与 v0.8 的关系与关键约定

### 0.1 v0.8 已实现的基线（不重复）

v0.8 已 ship 以下能力，v0.9 在其上叠加，**不重写**：

- 多后端 EmbeddingProvider（OpenAI 兼容 + Jina + Transformers.js 本地）
- 输入管线净化（transcript cleaner 5 规则 + quality gate 3 检查）
- 整合管线重做（clusterBatchV2 两阶段聚类 + promptV2 dedup+synthesize + 质量评分）
- Contradiction merge（`m` 选项 + LLM 合并 + 用户 y/N 确认）
- Synthesis 可观测性（5 个 rollup 列 + `--synthesis` diagnose + stats 行）
- backlog 修复：cron list --verbose、tasks/task_runs duration_ms、parseRawLlmOutput 统一

### 0.2 关键实现约定（沿用 v0.2-v0.8）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.9 不引入新 LLM 调用 |
| **stdout/stderr 都进 LLM 上下文** | 元数据走 `audit_log`，stderr ≤ 2 行 LLM-safe 指针 |
| **命令 prelude 调 `maybeRunTier15`** | v0.9 新命令同样遵守 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |

### 0.3 版本号

- `config.default.json::version` 从 `"0.8"` 升到 `"0.9"`
- schema `schema_meta.version` 从 `10` 升到 `11`（migration `011_v09.sql`）
- `config.default.json::security.scan_patterns_version` **不 bump**（v0.9 不动 patterns，避免无谓 revalidation）

### 0.4 v0.9 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — SessionStart | **零变化** |
| Hook 行为 — UserPromptSubmit | **微增**：`writeRecentInjection` 追加 scores JSON；L1 正向反馈不变 |
| Hook 行为 — Stop | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **零变化**（quality gate v2 在 summarize 内部，不在 insertMemory 管线上）|
| Trust 系数 / 优先级公式 | 零变化 |
| L1 否定/正向 / L2 / L2.5 / L4 | **微改**：`adjustTrust` helpful 路径追加 `last_touched_at` 更新 |
| summarize_pending | **内部改进**（quality gate v2 + prompt 分级提取）|
| weekly_synthesis / security_audit / contradiction_audit / revalidation / monthly_meta | 零变化 |
| daily_maintenance | **微增**（3 个新 step + 1 个条件修改）|
| Tier 1.5 lazy maintenance | 零变化 |
| daemon self-restart / container fallback / platform 层 | 零变化 |
| EmbeddingProvider / 三路检索算法 / CJK tokenize / per-session dedup | 零变化 |

---

## 一、范围与时间预算

### 1.1 v0.9 做什么（M10，约 4 周）

| 阶段 | # | 能力 | 说明 |
|---|---|---|---|
| **P1** | A1 | **输入端治理升级** | quality gate v2（4 条新规则 + 按名开关）+ summarize prompt 分级提取 + transcript_cleaner 用户自定义规则 |
| **P1** | A2 | **整合端提质（三缺口修补）** | candidate_expire 条件放宽 + candidate_expire→archived 30d 转换 + dedup touch 不刷新 last_touched_at + adjustTrust helpful 刷新 last_touched_at + consolidated 60d 快速过期 + synthesis prompt 去重强化 |
| **P2** | B1 | **检索可观测性** | recent_injections 注入评分明细 + never-injected 检测 + show 注入历史 + diagnose --injections + stats 提示 |
| **P2** | B2 | **预防性扩展（监控）** | retrieval timing 写入 metrics.jsonl + diagnose 性能段（预过滤优化推迟到数据证明需要时） |
| **P3** | C1 | **跨项目知识自动发现** | cross_project_patterns cron（cosine 预筛 + 聚类去重 + 全局覆盖检查）+ promote_candidates 表 + resurrect --promote-candidates |

### 1.2 v0.9 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 跨项目冷启动继承 | v0.10 | 先让自动发现跑稳，积累数据再设计继承策略 |
| better-sqlite3 + sqlite-vec ANN | v0.10+ | JS cosine 5000 mems 内 ~60ms，无性能压力 |
| 检索候选预过滤优化 | v0.10+（数据驱动） | B2 监控数据证明 retrieval p95 > 100ms 时再启动 |
| query embedding 缓存（API provider） | v0.10+ | 需先积累 API provider 用户的延迟数据 |
| Voyage / Cohere embedding 后端 | v0.10+ | OpenAI 兼容 + Jina 已覆盖 |
| Windows scheduled task | v0.10+ | 无 dogfood 设备 |
| contradiction-aware 跨项目过滤 | v0.10+（数据驱动） | dogfood 期 false positive > 30% 时再做 |
| 自动 nudge thresholds | 永不 | turf war + 用户 config 风险 |
| `synthesized=0` 连续 skip logic（v0.8 backlog #4） | v0.10+（数据驱动） | 需更多 weekly_synthesis 运行数据验证 v0.8 pipeline 修复后是否仍有此问题 |
| 跨项目自动清理重复副本 | 永不 | 误杀风险 > 手动清理不便 |

### 1.3 完成判据（M10）

**A1 — 输入端治理升级**：
1. quality gate v2 拦截 "schema version 10"（`version_snapshot`）和 "961/961 pass"（`test_count`），`user_explicit` 不受影响
2. `rules_enabled.version_snapshot=false` 时该规则不拦截
3. transcript_cleaner extra_rules：合法 pattern 正确剥离；非法/ReDoS pattern 静默跳过
4. summarize prompt 包含"跨会话测试"指令

**A2 — 整合端提质**：
5. `helpful_count=0 AND unhelpful_count=3 AND age > half_life×2` → `candidate_expire`（缺口 1 修复验证）
6. `candidate_expire` 状态 31d 后 → `archived`（黑洞修复验证）
7. dedup touch 后 `last_touched_at` 不变、`updated_at` 更新
8. `adjustTrust` helpful_implicit 后 `last_touched_at` 更新
9. consolidated（depth≤1, helpful_count=0, age>60d）→ `candidate_expire`

**B1 — 检索可观测性**：
10. `recent_injections.scores` JSON 含每条注入 mem 的 fts/jac/cos/fused 评分
11. `/ccmem:show m42` 显示 "Recent injections" 段（含评分明细）
12. `/ccmem:list --never-injected` 列出 30d 内从未被注入的 active 记忆
13. `/ccmem:admin diagnose --injections` 输出 5 段（Volume/Score/Top10/Low-quality/Never）
14. `/ccmem:stats` 在 never_injected > 15% 时显示 Injection 提示行

**B2 — 预防性扩展**：
15. metrics.jsonl prompt_submit 行含 `retrieval_embed_ms` / `retrieval_db_ms` / `retrieval_cosine_ms` / `retrieval_pool`
16. `diagnose --injections` 性能段显示 embed/db/cosine p50/p95

**C1 — 跨项目知识自动发现**：
17. `cross_project_patterns` 在周日 04:47 触发；`task_runs` lease 防重复
18. 2 个 project 各有 cosine ≥ 0.80 的相似 mem → `promote_candidates` 新增 1 行（聚类去重后）
19. global 已有覆盖 → 跳过候选 + audit `cross_project_already_global`
20. `/ccmem:resurrect --promote-candidates` 的 p/d/s 三分支全通 + dangerous_command 安全检查
21. embedding 关闭时 C1 整体跳过 + audit `cross_project_skipped`

**通用**：
22. v0.8 测试套全量回归 100% 通过（961/961）
23. embedding 关闭时所有 hook 输出与 v0.8 字符级一致

---

## 二、架构（v0.9 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart (v0.9 零变化)                                           │
│  UserPromptSubmit (v0.9 微增):                                        │
│    retrieveMemories (算法不变)                                        │
│      → timing 采集 (B2: embed_ms, db_ms, cosine_ms, pool)           │
│    writeRecentInjection (+scores JSON) (B1)                          │
│    L1/L2.5 反馈: adjustTrust +last_touched_at (A2.4)                │
│  Stop (v0.9 零变化)                                                   │
├──────────────────────────────────────────────────────────────────────┤
│  summarize_pending (v0.9 A1 增量):                                    │
│    transcript_cleaner (+extra_rules 用户自定义)                       │
│    callClaudeP (prompt 加分级提取指令)                                 │
│    quality gate v2 (4 条新规则 + rules_enabled)                      │
│    insertMemory (不变)                                                │
├──────────────────────────────────────────────────────────────────────┤
│  Tier 2.5 dedup (v0.9 A2.3 行为修正):                                │
│    dedupCheck 命中: UPDATE updated_at (不再更新 last_touched_at)      │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.9 增量):                                                  │
│    daily_maintenance                                                  │
│      step 1 修改: candidate_expire 条件删除 AND unhelpful_count=0 (A2.1)│
│      +step 20: candidate_expire 30d → archived (A2.2)               │
│      +step 21: consolidated 60d 快速过期 (A2.5)                      │
│      +step 22: promote_candidates 60d 清理 (C1.6)                   │
│    cross_project_patterns (C1, 新增 cron, 周日 04:47)                │
│    其它 cron 零变化                                                   │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (v0.9 增量):                                                  │
│    recent_injections (+scores TEXT)                                    │
│    promote_candidates (新表, C1)                                      │
│    metrics_daily_rollup (+4 个 injection 统计字段)                     │
│    memories (零字段变更)                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 新增 / 修改模块清单

```
scripts/
├── daemon/
│   ├── loop.mjs                         # 【改】scheduleCronTasks + cross_project_patterns
│   │                                    #        dispatch 加 cross_project_patterns
│   └── tasks/
│       ├── daily-maintenance.mjs        # 【改】step 1 条件修改 + steps 20-22
│       ├── summarize-pending.mjs        # 【改】quality gate v2 + prompt 分级提取
│       └── cross-project-patterns.mjs   # 【新增】cosine 预筛 + 聚类 + 全局覆盖检查
├── handlers/
│   └── prompt-submit.mjs               # 【改】writeRecentInjection +scores; recordMetric +timing
├── lib/
│   ├── quality-gate.mjs                 # 【改】+4 条新规则 + rules_enabled
│   ├── transcript-cleaner.mjs           # 【改】+extra_rules 加载 + pattern 编译
│   ├── dedup.mjs                        # 【改】命中路径改 updated_at
│   ├── trust.mjs                        # 【改】adjustTrust helpful +last_touched_at
│   ├── recent-injections.mjs            # 【改】writeRecentInjection +scores 参数
│   ├── retrieval.mjs                    # 【改】返回 timing 对象
│   ├── metrics-rollup.mjs              # 【改】+injection 统计字段
│   ├── cmd/
│   │   ├── show.mjs                     # 【改】+Recent injections 段
│   │   ├── list.mjs                     # 【改】+--never-injected flag
│   │   ├── stats.mjs                    # 【改】+Injection 提示行 +Promote 提示行
│   │   └── resurrect.mjs               # 【改】+--promote-candidates 分支
│   └── admin/
│       ├── cron.mjs                     # 【改】白名单加 cross_project_patterns
│       └── diagnose.mjs                 # 【改】+--injections flag (+性能段)
├── config.default.json                  # 【改】version 0.9 + 新配置段
└── migrations/
    └── 011_v09.sql                      # 【新增】v0.9 schema
```

---

## 三、Schema 迁移（v0.8 → v0.9）

### 3.1 迁移文件 `migrations/011_v09.sql`

v0.8 已实现 `ensureSchema → runMigration` 始终调用 + 失败 hard-exit + 自动备份 +
单次 backup + 跨进程去重。v0.9 只需新增 011 文件。

```sql
-- ============================================================
-- migrations/011_v09.sql — v0.9 schema (adaptive pipeline)
-- ============================================================

-- ---- 1. recent_injections: 注入评分明细 (B1) ----
ALTER TABLE recent_injections ADD COLUMN scores TEXT;
-- scores: [{"id":42,"fts":0.82,"jac":0.45,"cos":0.91,"f":0.79}, ...]

-- ---- 2. metrics_daily_rollup: 注入统计字段 (B1) ----
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_empty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_avg_fused REAL;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_never_30d INTEGER NOT NULL DEFAULT 0;

-- ---- 3. promote_candidates (C1) ----
CREATE TABLE promote_candidates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  mem_id               INTEGER NOT NULL,
  project_key          TEXT NOT NULL,
  similar_in           TEXT NOT NULL,            -- JSON: [{project_key, mem_id, cosine}]
  trigger              TEXT NOT NULL,            -- 'cosine_cross_project'
  detected_at          INTEGER NOT NULL,
  acknowledged_at      INTEGER,
  acknowledged_action  TEXT,
  CHECK (acknowledged_action IS NULL
      OR acknowledged_action IN ('promote', 'dismiss'))
);
CREATE INDEX idx_promote_pending ON promote_candidates(detected_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX idx_promote_mem ON promote_candidates(mem_id);

-- ---- 4. schema 版本推进 ----
UPDATE schema_meta SET version = 11, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (10, 11, 'v0.9: injection scores + promote_candidates + injection rollup',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值（无 schema 变更）

| action | 写入时机 | mem_id | details JSON 关键字段 |
|---|---|---|---|
| `cross_project_run` | `runCrossProjectPatterns` 跑完 | null | `{projects_scanned, pairs_checked, candidates_found, clusters_formed, skipped_global_covered, duration_ms}` |
| `cross_project_detected` | 新增 promote_candidate | 代表 mem id | `{candidate_id, similar_in: [...], trigger}` |
| `cross_project_acknowledged` | 用户 resurrect 裁决 | mem id | `{candidate_id, action: 'promote'\|'dismiss'}` |
| `cross_project_already_global` | 全局覆盖检查跳过 | 候选 mem id | `{global_mem_id, cosine}` |
| `cross_project_skipped` | embedding 关闭或 < 2 projects | null | `{reason: 'no_embedding'\|'single_project'}` |

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.8 `recent_injections` 老行 `scores=NULL` | ALTER 默认 NULL，不动老数据；新写入开始有 scores |
| v0.8 `metrics_daily_rollup` 老行 | ALTER ADD COLUMN 默认 0/NULL，不动老数据 |
| v0.8 daemon（in-memory schema=10）看到 DB schema=11 | v0.5 self-restart 自动处理 |
| v0.1-v0.8 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002-011 |
| `promote_candidates` 空表 | `--promote-candidates` 友好提示 `no cross-project patterns detected` |

---

## 四、Hooks（v0.9 微增）

### 4.1 SessionStart（零变化）

不动。v0.9 回归断言：注入文本与 v0.8 字符级一致。

### 4.2 UserPromptSubmit（微增：scores 写入 + timing 采集）

v0.8 已实现三路检索 + L1 正向/否定 + recent_injections 写入。v0.9 两处微增：

1. **`writeRecentInjection` 追加 scores**（B1.1）：在已有的 `mem_ids` 之外同步写入每条被注入
   记忆的三路评分
2. **retrieval timing 采集**（B2.1）：`retrieveMemories` 返回 `timing` 对象，handler 写入
   `metrics.jsonl`

```javascript
// scripts/handlers/prompt-submit.mjs (v0.9 增量)

// retrieveMemories 返回值扩展
const { rows, queryVec, cosineContribution, timing } = await retrieveMemories(db, ...);

// B1: scores 写入
if (mode !== 'shadow') {
  writeRecentInjection(db, sessionId, promptIdx, 'user_prompt_submit',
    rows.map(r => r.id),
    rows.map(r => ({
      id: r.id,
      fts: round3(r.ftsScore ?? 0),
      jac: round3(r.jaccardScore ?? 0),
      cos: round3(r.cosineScore ?? 0),
      f: round3(r.fused ?? 0),
    }))
  );
}

// B2: timing 写入
await recordMetric({
  hook: 'prompt_submit',
  // ... 已有字段不变 ...
  retrieval_embed_ms: timing?.embedMs,
  retrieval_db_ms: timing?.dbReadMs,
  retrieval_cosine_ms: timing?.cosineMs,
  retrieval_pool: timing?.candidatePool,
});
```

**性能影响**：JSON.stringify scores ~0.1ms + 4 个额外 metric 字段 ~0ms，可忽略。

### 4.3 Stop（零变化）

不动。L2/L2.5 反馈推断路径：`adjustTrust` 内部行为改变（A2.4），但 handler 代码不改。

---

## 五、写入闸门（v0.9 零变化 + dedup 行为修正）

`insertMemory` 的 Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine pipeline **不动**。

**Tier 2.5 dedup 行为修正（A2.3）**：`dedupCheck` 命中路径将 `UPDATE last_touched_at` 改为
`UPDATE updated_at`。接口不变，仅内部行为——调用方无感知。

回归测试断言：v0.8 Tier 1/2/2.5/3 真值表全套通过。

---

## 六、v0.9 核心改动

### 6.1 A1 — 输入端治理升级

#### 6.1.1 quality gate v2（`lib/quality-gate.mjs` 增量）

在 v0.8 已有的 3 条规则基础上新增 4 条：

| # | 规则名 | 检测逻辑 | 示例命中 |
|---|--------|---------|---------|
| 4 | `version_snapshot` | `/\b(?:v?\d+\.\d+\|version\s*[=:]\s*\d+\|schema\s*(?:version)?\s*\d+)/i` 且 content < 60 字符 | "schema version 10", "v0.8 shipped" |
| 5 | `test_count` | `/\b\d+\s*\/\s*\d+\s*(?:pass\|tests?\|fail)/i` 或 `/\b(?:UT\|IT\|E2E)\s*\d+\s*pass/i` | "961/961 pass", "UT 12 pass IT 5 pass" |
| 6 | `timestamp_dominant` | ISO 日期/时间占 content > 30%（`/\d{4}-\d{2}-\d{2}/g` 匹配字符数 / 总字符数） | "2026-06-05 committed fix for parser bug" |
| 7 | `path_list` | content 中 ≥ 3 个文件路径（`/[\w.-]+\/[\w.-]+/g` 命中 ≥ 3 次）且无动词/形容词（纯路径罗列） | "scripts/lib/audit.mjs scripts/daemon/loop.mjs scripts/lib/trust.mjs" |

```javascript
// scripts/lib/quality-gate.mjs (v0.9 增量)
const VERSION_SNAPSHOT = /\b(?:v?\d+\.\d+|version\s*[=:]\s*\d+|schema\s*(?:version)?\s*\d+)/i;
const TEST_COUNT = /\b\d+\s*\/\s*\d+\s*(?:pass|tests?|fail)/i;
const TEST_COUNT_NAMED = /\b(?:UT|IT|E2E)\s*\d+\s*pass/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const FILE_PATH = /[\w.-]+\/[\w.-]+/g;

export function checkQuality(content, cfgOverride) {
  const cfg = cfgOverride ?? {};
  const enabled = cfg.rules_enabled ?? {};

  // v0.8 已有 3 条 (不变)
  if (enabled.too_short !== false && content.length < (cfg.min_chars ?? 15))
    return { pass: false, reason: 'too_short' };
  if (enabled.commit_format !== false && COMMIT_FORMAT.test(content.trim()))
    return { pass: false, reason: 'commit_format' };
  if (enabled.too_specific !== false) {
    const pathMatches = content.match(FILE_PATH_HEAVY) || [];
    if (pathMatches.join('').length > content.length * 0.5)
      return { pass: false, reason: 'too_specific' };
  }

  // v0.9 新增 4 条
  if (enabled.version_snapshot !== false
      && VERSION_SNAPSHOT.test(content) && content.length < 60)
    return { pass: false, reason: 'version_snapshot' };
  if (enabled.test_count !== false
      && (TEST_COUNT.test(content) || TEST_COUNT_NAMED.test(content)))
    return { pass: false, reason: 'test_count' };
  if (enabled.timestamp_dominant !== false) {
    const dateMatches = content.match(ISO_DATE) || [];
    if (dateMatches.join('').length > content.length * 0.3)
      return { pass: false, reason: 'timestamp_dominant' };
  }
  if (enabled.path_list !== false) {
    const paths = content.match(FILE_PATH) || [];
    if (paths.length >= 3 && !/\b(?:use|add|create|remove|change|update|prefer|avoid)\b/i.test(content))
      return { pass: false, reason: 'path_list' };
  }

  return { pass: true, reason: null };
}
```

**关键约束**：所有规则仅对 `source='auto_inferred'` 生效（`checkQuality` 仅在 `summarize-pending.mjs`
内部调用，`user_explicit` 不经过此路径，沿用 v0.8 设计）。

#### 6.1.2 summarize prompt 分级提取

在现有 prompt 的 "Tasks" 段前插入跨会话测试指令：

```text
Before extracting each candidate, apply this cross-session test:
  "Would a FRESH Claude Code session (no prior context) benefit from knowing this?"
  - YES → extract: user preferences, project conventions, recurring patterns,
           architectural decisions, tool chain choices, workflow rules
  - NO  → skip: one-time commands, debugging steps that led to a fix,
           test run results, version/schema numbers, commit messages,
           file edit sequences, build output summaries

Additional DO NOT extract rules:
  - Test pass/fail counts (e.g., "961/961 pass") — ephemeral state
  - Schema/version numbers — derivable from code
  - Commit hashes or PR numbers — derivable from git
  - "Fixed bug X by doing Y" — the fix is in the code; only extract
    if Y reveals a non-obvious convention worth remembering
```

不改 JSON output 格式。

#### 6.1.3 transcript_cleaner 用户自定义规则（v0.8 deferred）

v0.8 遗留：`DEFAULT_RULES` 含 RegExp 无法 JSON 序列化。v0.9 加字符串 pattern → RegExp 编译层。

```javascript
// scripts/lib/transcript-cleaner.mjs (v0.9 增量)
import { compileSafePattern } from './pattern-safety.mjs';

function loadRules(cfg) {
  const base = DEFAULT_RULES;
  const extra = (cfg?.extra_rules || []).map(r => {
    const start = compileSafePattern(r.start_pattern);   // 字符串→RegExp, fuzz+50ms 超时
    const end = compileSafePattern(r.end_pattern);
    if (!start || !end) return null;                      // 非法/ReDoS pattern 静默跳过
    return { name: r.name, start, end };
  }).filter(Boolean);
  return [...base, ...extra];
}
```

`compileSafePattern` 复用 v0.1 `pattern-safety.mjs`（re2 优先 + 50ms 超时 + SyntaxError 拦截）。

---

### 6.2 A2 — 整合端提质（三缺口修补 + 两个配套）

#### 6.2.1 缺口 1：candidate_expire 条件放宽

**现状**：`helpful_count=0 AND unhelpful_count=0`（零反馈）触发。有 unhelpful 但无 helpful 的记忆卡在死角。

**修复**：删除 `AND unhelpful_count=0`。

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs step 1 (v0.9 修订)
db.prepare(`UPDATE memories SET decay_status='candidate_expire'
  WHERE decay_status='active' AND pinned=0
    AND helpful_count=0                    -- v0.9: 删除 AND unhelpful_count=0
    AND julianday('now') - julianday(last_touched_at/1000,'unixepoch')
        > half_life_days * 2`).run();
```

**语义变化**：零反馈 + 超龄 → 零**正**信号 + 超龄。有 `helpful_count > 0` 的记忆不受影响。

#### 6.2.2 缺口 1 配套：candidate_expire → archived 30d 转换

**现状**：`candidate_expire` 状态的记忆不被注入（`decay_status IN ('active','probation')` 查询排除），
也不被已有的 trust/灰区 archive 规则覆盖——黑洞。

**修复**：新增 daily_maintenance step。

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.9 新增 step 20)
const archiveDays = loadConfig().adaptive_decay?.candidate_expire_archive_days ?? 30;
db.prepare(`UPDATE memories SET decay_status='archived', updated_at=?
  WHERE decay_status='candidate_expire'
    AND julianday('now') - julianday(updated_at/1000,'unixepoch') > ?`)
  .run(Date.now(), archiveDays);
```

30d 宽限期内用户可通过 `/ccmem:show <id>` 发现并 `/ccmem:pin` 挽救。

#### 6.2.3 缺口 2：dedup touch 不再刷新衰减时钟

> **⚠ 原子约束**：A2.3 和 A2.4 必须在**同一 commit** 落地。否则 A2.3 先上线时
> `last_touched_at` 几乎永远不被更新，导致所有老记忆一次性 candidate_expire。

**现状**：`dedupCheck` 命中时 `UPDATE last_touched_at = now`。反复 dedup touch 导致记忆永不过期。

**修复**：改为 `UPDATE updated_at`。

```javascript
// scripts/lib/dedup.mjs dedupCheck 命中路径 (v0.9 修订)
db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`)  // 改: last_touched_at → updated_at
  .run(Date.now(), bestCandidate.id);
```

**影响**：
- priority 公式用 `last_touched_at` 计算 recency → dedup touch 不再人为抬高排名（正确）
- candidate_expire 用 `last_touched_at` 判超龄 → dedup touch 不再阻止过期（正确）
- dedup audit `summarize_skip_duplicate` 不受影响

#### 6.2.4 缺口 2 配套：adjustTrust helpful 刷新 last_touched_at

**现状**：`adjustTrust` 对 helpful/helpful_implicit 只更新 `updated_at`，不更新 `last_touched_at`。
移除 dedup 刷新后，`last_touched_at` 几乎只等于 `created_at`。

**修复**：正信号同时刷新 `last_touched_at`。

```javascript
// scripts/lib/trust.mjs adjustTrust (v0.9 修订)
// helpful / helpful_implicit 路径:
db.prepare(`UPDATE memories SET
  trust_score = MIN(1.0, trust_score + ?),
  helpful_count = helpful_count + 1,
  updated_at = ?,
  last_touched_at = ?          -- v0.9 新增: 正信号刷新衰减时钟
  WHERE id = ?`)
  .run(reward, Date.now(), Date.now(), memId);
```

**`last_touched_at` 语义变为"最后一次被证明有用的时刻"**：
- 正信号（L1正向/L2.5/L4 helpful）→ 刷新 ✓
- dedup touch → 不刷新 ✓（v0.9 修复）
- 负信号（unhelpful）→ 不刷新 ✓
- resurrect keep → 刷新 ✓（已有行为）

#### 6.2.5 缺口 3：consolidated 60d 快速过期

**现状**：consolidated `half_life_days=90`，通用 candidate_expire 在 180d 触发。太慢。

**修复**：新增 consolidated 专用快速过期路径（独立于通用 half_life × 2）。

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.9 新增 step 21)
const fastExpireDays = loadConfig().adaptive_decay?.consolidated_fast_expire_days ?? 60;
const maxDepth = loadConfig().adaptive_decay?.consolidated_max_depth_for_expire ?? 1;

db.prepare(`UPDATE memories SET decay_status='candidate_expire', updated_at=?
  WHERE type='consolidated' AND decay_status='active' AND pinned=0
    AND helpful_count=0
    AND consolidation_depth <= ?
    AND julianday('now') - julianday(created_at/1000,'unixepoch') > ?`)
  .run(Date.now(), maxDepth, fastExpireDays);
```

**为什么用 `created_at` 而非 `last_touched_at`**：consolidated 不参与 dedup（仅 auto_inferred
触发 dedup），且 `helpful_count=0` 时 `last_touched_at` 未被正信号刷新，两者等价。`created_at` 语义
更明确——从产出到验证的固定窗口。

**为什么 depth ≤ 1**：深层 meta-consolidated 是稀有的高阶知识（月度元整合产物），应保留更久。

#### 6.2.6 synthesis prompt 上下文去重强化

`buildSynthesisPromptV2` 的 `<<EXISTING CONSOLIDATED>>` 段加强指令：

```text
<<EXISTING CONSOLIDATED (for context)>>
${existingJson}

CRITICAL: Before producing any synthesis, check against the existing list above.
If your proposed output is essentially restating something already captured
(same topic + same conclusion, even in different words), DO NOT output it.
Only synthesize genuinely NEW patterns not yet covered.
```

代码层 cosine 去重（v0.8，threshold 0.90）仍作为安全网。

---

### 6.3 B1 — 检索可观测性

#### 6.3.1 注入评分明细（`recent_injections.scores`）

```javascript
// scripts/lib/recent-injections.mjs (v0.9 增量)
export function writeRecentInjection(db, sessionId, promptIdx, injectSource, memIds, scores) {
  db.prepare(`INSERT INTO recent_injections
    (session_id, prompt_idx, inject_source, mem_ids, scores, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, prompt_idx) DO UPDATE SET
      mem_ids=excluded.mem_ids, scores=excluded.scores, created_at=excluded.created_at`)
    .run(sessionId, promptIdx, injectSource,
         JSON.stringify(memIds),
         scores ? JSON.stringify(scores) : null,     // v0.9: scores 可选
         Date.now());
}
```

`SessionStart` 调用不传 scores（injection_cache 无三路评分），scores=NULL。
`UserPromptSubmit` 调用传 scores（retrieveMemories 返回的评分）。

#### 6.3.2 "从未被注入"检测

UNION 两张表覆盖 30d 窗口：

```sql
-- recent_injections 覆盖近 14d (含 SessionStart + UserPromptSubmit)
-- memory_feedback 补充 14-30d (仅 UserPromptSubmit)
SELECT m.id, m.type, m.scope, m.content, m.trust_score, m.created_at
FROM memories m
WHERE m.decay_status IN ('active','probation') AND m.status='active'
  AND NOT EXISTS (
    SELECT 1 FROM recent_injections ri, json_each(ri.mem_ids) je
    WHERE je.value = m.id AND ri.created_at > ?
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_feedback f, json_each(f.injected_ids) je
    WHERE je.value = m.id AND f.recorded_at > ?
  )
ORDER BY m.created_at ASC
```

两个 `?` 参数均为 `Date.now() - 30 * 86400000`。

暴露为 `/ccmem:list --never-injected [--days 30]`。

#### 6.3.3 `/ccmem:show <id>` 注入历史段

```javascript
// scripts/lib/cmd/show.mjs (v0.9 增量, 输出末尾追加)
const injections = db.prepare(`
  SELECT ri.created_at, ri.scores
  FROM recent_injections ri, json_each(ri.mem_ids) je
  WHERE je.value = ? AND ri.scores IS NOT NULL
  ORDER BY ri.created_at DESC LIMIT 10
`).all(memId);

if (injections.length > 0) {
  lines.push('');
  lines.push('  Recent injections (last 14d):');
  for (const inj of injections) {
    const scores = JSON.parse(inj.scores);
    const s = scores.find(x => x.id === memId);
    if (s) {
      lines.push(`    ${daysAgo(inj.created_at)}  fts=${s.fts} jac=${s.jac} cos=${s.cos} fused=${s.f}`);
    }
  }
  lines.push(`    (${injections.length} times in 14d)`);
}
```

#### 6.3.4 metrics_daily_rollup 注入统计

`writeMetricsDailyRollup` 追加 4 个字段的聚合逻辑：

```javascript
// scripts/lib/metrics-rollup.mjs (v0.9 增量)

// inj_total: 当日 recent_injections 行数
const injTotal = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections
  WHERE created_at >= ? AND created_at < ?`).get(dayStartMs, dayEndMs).n;

// inj_empty: 当日空注入
const injEmpty = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections
  WHERE created_at >= ? AND created_at < ? AND mem_ids = '[]'`).get(dayStartMs, dayEndMs).n;

// inj_avg_fused: 当日所有 scores 中 f 值的均值
const allScores = db.prepare(`SELECT scores FROM recent_injections
  WHERE created_at >= ? AND created_at < ? AND scores IS NOT NULL`).all(dayStartMs, dayEndMs);
let fusedSum = 0, fusedCount = 0;
for (const row of allScores) {
  for (const s of JSON.parse(row.scores)) { fusedSum += s.f; fusedCount++; }
}
const injAvgFused = fusedCount > 0 ? fusedSum / fusedCount : null;

// inj_never_30d: 30d 内从未注入的 active 记忆数 (daily 快照)
const injNever30d = db.prepare(`SELECT COUNT(*) AS n FROM memories m
  WHERE m.decay_status IN ('active','probation') AND m.status='active'
    AND NOT EXISTS (SELECT 1 FROM recent_injections ri, json_each(ri.mem_ids) je
        WHERE je.value = m.id AND ri.created_at > ?)
    AND NOT EXISTS (SELECT 1 FROM memory_feedback f, json_each(f.injected_ids) je
        WHERE je.value = m.id AND f.recorded_at > ?)`)
  .get(Date.now() - 30 * 86400000, Date.now() - 30 * 86400000).n;

// ⚠ 实施注意: writeMetricsDailyRollup 的 INSERT OR REPLACE 显式枚举全部列。
// v0.9 新增 4 列 (inj_total/inj_empty/inj_avg_fused/inj_never_30d) 必须同步
// 追加到该 INSERT 语句的列列表和 VALUES 参数中，否则 INSERT OR REPLACE 会先
// DELETE 再 INSERT，遗漏的列回退到 DEFAULT 0/NULL。
```

#### 6.3.5 `/ccmem:admin diagnose --injections [--days N]`

```javascript
// scripts/lib/admin/diagnose.mjs (v0.9 增量)
export function cmdDiagnoseInjections(db, { days = 14 }) {
  try { maybeRunTier15(db); } catch {}

  const cutoff = Date.now() - days * 86400000;

  // Volume
  const total = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections
    WHERE created_at > ?`).get(cutoff).n;
  const empty = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections
    WHERE created_at > ? AND mem_ids = '[]'`).get(cutoff).n;
  const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM memories
    WHERE decay_status IN ('active','probation') AND status='active'`).get().n;
  const distinctMems = countDistinctInjected(db, cutoff);

  // Score distribution
  const fusedValues = collectFusedValues(db, cutoff);
  const p50 = percentile(fusedValues, 0.5);
  const p95 = percentile(fusedValues, 0.95);

  // Top 10 most injected
  const top10 = topInjected(db, cutoff, 10);

  // Low-quality injections (fused < threshold)
  const lowThreshold = loadConfig().injection_observability?.low_quality_threshold ?? 0.30;
  const lowQuality = topInjected(db, cutoff, 10, { maxFused: lowThreshold });

  // Never injected (30d)
  const neverCount = countNeverInjected(db);

  // Retrieval performance (B2)
  const perfStats = aggregateRetrievalTiming(days);

  // 渲染输出
  const lines = [
    `Injection overview (last ${days} days)`,
    '',
    '  Volume',
    `    injections:    ${total} (avg ${(total / days).toFixed(1)}/day)`,
    `    empty:         ${empty} (${total > 0 ? (empty/total*100).toFixed(1) : 0}%)`,
    `    distinct mems: ${distinctMems} / ${activeCount} active (${activeCount > 0 ? (distinctMems/activeCount*100).toFixed(1) : 0}%)`,
  ];
  if (fusedValues.length > 0) {
    lines.push('');
    lines.push('  Score distribution (fused, p50 / p95)');
    lines.push(`    ${p50.toFixed(2)} / ${p95.toFixed(2)}`);
  }
  if (top10.length > 0) {
    lines.push('');
    lines.push('  Top 10 most injected');
    for (const t of top10) {
      lines.push(`    m${t.id}  ${t.type}|${t.scope}  ${t.count}x  avg=${t.avgFused.toFixed(2)}  ${t.content.slice(0, 50)}`);
    }
  }
  if (lowQuality.length > 0) {
    lines.push('');
    lines.push(`  Low-quality injections (fused < ${lowThreshold})`);
    for (const l of lowQuality) {
      lines.push(`    m${l.id}  ${l.type}|${l.scope}  ${l.count}x  avg=${l.avgFused.toFixed(2)}  ${l.content.slice(0, 50)}`);
    }
    lines.push('    Run /ccmem:forget mNNN to remove, or wait for adaptive decay.');
  }
  lines.push('');
  lines.push(`  Never injected (30d, active): ${neverCount} memories`);
  if (neverCount > 0) lines.push('    Run /ccmem:list --never-injected to see them.');

  // B2: 性能段
  if (perfStats) {
    lines.push('');
    lines.push('  Retrieval performance (embedding ON)');
    lines.push(`    embed:     p50=${perfStats.embed.p50}ms  p95=${perfStats.embed.p95}ms`);
    lines.push(`    db read:   p50=${perfStats.db.p50}ms  p95=${perfStats.db.p95}ms  pool=${perfStats.avgPool} mems`);
    lines.push(`    cosine:    p50=${perfStats.cosine.p50}ms  p95=${perfStats.cosine.p95}ms`);
    const totalP95 = perfStats.embed.p95 + perfStats.db.p95 + perfStats.cosine.p95;
    const status = totalP95 > 100 ? 'WARN' : 'OK';
    lines.push(`    total:     p95=${totalP95}ms  budget=350ms  ${status}`);
    if (status === 'WARN') {
      lines.push(`    hint: consider reducing active memory count or enabling retrieval.prefilter (v0.10+)`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}
```

#### 6.3.6 `/ccmem:stats` 提示行

```javascript
// scripts/lib/cmd/stats.mjs (v0.9 增量)
const neverRatio = activeCount > 0 ? neverCount / activeCount : 0;
const alertRatio = loadConfig().injection_observability?.never_injected_alert_ratio ?? 0.15;
if (neverRatio > alertRatio) {
  lines.push(`Injection: ${neverCount} memories never injected in 30d (${(neverRatio*100).toFixed(0)}%) — run /ccmem:admin diagnose --injections`);
}
```

---

### 6.4 B2 — 预防性扩展（纯监控）

#### 6.4.1 retrieval timing 采集

```javascript
// scripts/lib/retrieval.mjs (v0.9 增量)
export async function retrieveMemories(db, prompt, projectKey, config) {
  // ... 现有代码 ...

  if (!useEmbedding) {
    return { rows: ftsRows.slice(0, limit), queryVec: null, timing: null };
  }

  const t0 = Date.now();
  const [queryVec] = await provider.embed([prompt.slice(0, 2000)]);
  const embedMs = Date.now() - t0;

  const t1 = Date.now();
  const allVecs = db.prepare(`SELECT id, embedding FROM memories ...`).all(projectKey);
  const dbReadMs = Date.now() - t1;

  const t2 = Date.now();
  for (const row of allVecs) { cosineScores.set(row.id, cosineSimilarity(...)); }
  const cosineMs = Date.now() - t2;

  // ... 融合评分 + 排序 (不变) ...

  return {
    rows: scored.slice(0, limit),
    queryVec,
    cosineContribution: avgCosineContribution,
    timing: { embedMs, dbReadMs, cosineMs, candidatePool: allVecs.length },
  };
}
```

`diagnose --injections` 的性能段读取 `metrics.jsonl` 中的 `retrieval_*` 字段聚合 p50/p95。

---

### 6.5 C1 — 跨项目知识自动发现

#### 6.5.1 调度

```javascript
// scripts/daemon/loop.mjs scheduleCronTasks (v0.9 增量)
// 周日 04:47, 错峰 contradiction_audit 04:17 后 30min
const cp = loadConfig().cross_project?.audit;
if (cp?.enabled !== false
    && now.getDay() === (cp?.schedule_weekday ?? 0)
    && isTimeAfter(now, cp?.schedule_hour ?? 4, cp?.schedule_minute ?? 47)) {
  if (tryClaimLease(db, {
    type: 'cross_project_patterns',
    date_key: weekKey(now),
    ran_by: RAN_BY.DAEMON,
  })) {
    enqueue(db, 'cross_project_patterns');
  }
}
```

dispatch 增加：`case 'cross_project_patterns': return runCrossProjectPatterns(db, task);`

#### 6.5.2 主流程

```javascript
// scripts/daemon/tasks/cross-project-patterns.mjs
import { cosineSimilarity, blobToVec } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';

export function runCrossProjectPatterns(db, _task) {
  const t0 = Date.now();
  const cfg = loadConfig().cross_project?.audit ?? {};
  const cosineThreshold = cfg.cosine_threshold ?? 0.85;    // 0.85: 2 项目时需要更严格的门槛
  const minProjects = cfg.min_projects ?? 2;
  const minTrust = cfg.min_trust ?? 0.5;                   // 排除低 trust 噪音记忆
  const maxCandidatesPerRun = cfg.max_candidates_per_run ?? 5;  // 每次最多 N 个推荐
  const dedupWindowMs = (cfg.dedup_window_days ?? 30) * 86400000;
  const maxPairs = cfg.max_pairs ?? 500000;   // 安全上限, 防 20 项目 ×1000 mem 场景

  // 前置检查
  const provider = getProvider(loadConfig());
  if (!provider?.isLoaded()) {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'no_embedding' });
    return;
  }

  const projectKeys = db.prepare(`SELECT DISTINCT project_key FROM memories
    WHERE scope='project' AND status='active' AND decay_status IN ('active','probation')
      AND embedding IS NOT NULL`)
    .all().map(r => r.project_key);

  if (projectKeys.length < minProjects) {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'single_project' });
    return;
  }

  // Step 1: 加载各 project 的 embedding
  const projectMems = new Map();
  for (const pk of projectKeys) {
    projectMems.set(pk, db.prepare(`SELECT id, content, trust_score, embedding
      FROM memories WHERE project_key=? AND status='active'
        AND decay_status IN ('active','probation') AND embedding IS NOT NULL
        AND trust_score >= ?`)                          // trust 下限过滤
      .all(pk, minTrust));
  }

  // 加载 global memories (Step 2.5 用)
  const globalMems = db.prepare(`SELECT id, embedding FROM memories
    WHERE scope='global' AND status='active' AND decay_status IN ('active','probation')
      AND embedding IS NOT NULL`).all();

  // Step 2: 跨 project pair-wise cosine
  // matches: Map<memId, Set<projectKey>> — 记录每条 mem 在哪些其它 project 有匹配
  const matches = new Map();    // memId → [{project_key, mem_id, cosine}]

  const pkList = [...projectMems.keys()];
  let pairsChecked = 0;

  for (let i = 0; i < pkList.length; i++) {
    for (let j = i + 1; j < pkList.length; j++) {
      const memsA = projectMems.get(pkList[i]);
      const memsB = projectMems.get(pkList[j]);

      for (const ma of memsA) {
        if (pairsChecked >= maxPairs) break;   // 安全上限
        const vecA = blobToVec(ma.embedding);
        for (const mb of memsB) {
          if (pairsChecked >= maxPairs) break;
          pairsChecked++;
          const sim = cosineSimilarity(vecA, blobToVec(mb.embedding));
          if (sim >= cosineThreshold) {
            // 记录 A 在 B 中有匹配
            if (!matches.has(ma.id)) matches.set(ma.id, []);
            matches.get(ma.id).push({ project_key: pkList[j], mem_id: mb.id, cosine: Math.round(sim * 1000) / 1000 });
            // 记录 B 在 A 中有匹配
            if (!matches.has(mb.id)) matches.set(mb.id, []);
            matches.get(mb.id).push({ project_key: pkList[i], mem_id: ma.id, cosine: Math.round(sim * 1000) / 1000 });
          }
        }
      }
    }
  }

  // Step 3: 聚合 — 有多少 distinct project 有匹配
  const candidates = [];
  for (const [memId, similarList] of matches) {
    const distinctProjects = new Set(similarList.map(s => s.project_key));
    // similarList 只含"其它"项目的匹配，mem 自身所在项目不在列表中。
    // 因此 "出现在 ≥ minProjects 个项目" = distinctProjects.size ≥ minProjects - 1
    if (distinctProjects.size >= minProjects - 1) {
      const mem = findMem(projectMems, memId);
      if (mem) candidates.push({ id: memId, trust: mem.trust_score, embedding: mem.embedding, similarList });
    }
  }

  // Step 2.5: 全局覆盖检查
  let skippedGlobal = 0;
  const filtered = candidates.filter(c => {
    const vec = blobToVec(c.embedding);
    for (const gm of globalMems) {
      if (cosineSimilarity(vec, blobToVec(gm.embedding)) >= cosineThreshold) {
        writeAudit(db, 'cross_project_already_global', c.id, { global_mem_id: gm.id, cosine: cosineThreshold });
        skippedGlobal++;
        return false;
      }
    }
    return true;
  });

  // Step 3.5: 候选聚类去重 — 互相相似的候选归 1 cluster, 取最高 trust 为代表
  const clusters = clusterCandidates(filtered, cosineThreshold);

  // Step 4: 30d 去重 + max candidates 截断
  let candidatesFound = 0;
  for (const cluster of clusters) {
    if (candidatesFound >= maxCandidatesPerRun) break;   // 每次最多 N 个推荐
    const representative = cluster.reduce((best, c) => c.trust > best.trust ? c : best, cluster[0]);
    const dup = db.prepare(`SELECT 1 FROM promote_candidates
      WHERE mem_id=? AND detected_at > ? LIMIT 1`)
      .get(representative.id, Date.now() - dedupWindowMs);
    if (dup) continue;

    // Step 5: 写入
    const allSimilar = cluster.flatMap(c =>
      c.id === representative.id ? c.similarList : [{ project_key: findProjectKey(projectMems, c.id), mem_id: c.id, cosine: 1.0 }, ...c.similarList]
    );
    const uniqueSimilar = deduplicateSimilarList(allSimilar, representative.id);

    const candidateId = db.prepare(`INSERT INTO promote_candidates
      (mem_id, project_key, similar_in, trigger, detected_at)
      VALUES (?, ?, ?, 'cosine_cross_project', ?)`)
      .run(representative.id, findProjectKey(projectMems, representative.id),
           JSON.stringify(uniqueSimilar), Date.now())
      .lastInsertRowid;

    writeAudit(db, 'cross_project_detected', representative.id, {
      candidate_id: Number(candidateId), similar_in: uniqueSimilar, trigger: 'cosine_cross_project',
    });
    candidatesFound++;
  }

  writeAudit(db, 'cross_project_run', null, {
    projects_scanned: projectKeys.length,
    pairs_checked: pairsChecked,
    candidates_found: candidatesFound,
    clusters_formed: clusters.length,
    skipped_global_covered: skippedGlobal,
    duration_ms: Date.now() - t0,
  });
}

function clusterCandidates(candidates, threshold) {
  if (candidates.length === 0) return [];
  const clusterOf = new Map();
  const clusters = [];
  for (let i = 0; i < candidates.length; i++) {
    clusterOf.set(candidates[i].id, i);
    clusters.push([candidates[i]]);
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const ci = clusterOf.get(candidates[i].id);
      const cj = clusterOf.get(candidates[j].id);
      if (ci === cj) continue;
      const sim = cosineSimilarity(blobToVec(candidates[i].embedding), blobToVec(candidates[j].embedding));
      if (sim >= threshold) {
        for (const m of clusters[cj]) { clusters[ci].push(m); clusterOf.set(m.id, ci); }
        clusters[cj] = [];
      }
    }
  }
  return clusters.filter(c => c.length > 0);
}

function findMem(projectMems, memId) {
  for (const mems of projectMems.values()) {
    const m = mems.find(x => x.id === memId);
    if (m) return m;
  }
  return null;
}

function findProjectKey(projectMems, memId) {
  for (const [pk, mems] of projectMems) {
    if (mems.some(m => m.id === memId)) return pk;
  }
  return null;
}
```

#### 6.5.3 `/ccmem:resurrect --promote-candidates`

```javascript
// scripts/lib/cmd/resurrect.mjs (v0.9 增量)
export function cmdResurrectPromoteCandidates(db, { limit = 10 }) {
  try { maybeRunTier15(db); } catch {}
  const projectKey = resolveProjectKey(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const rows = db.prepare(`
    SELECT pc.id AS candidate_id, pc.mem_id, pc.project_key, pc.similar_in,
           pc.trigger, pc.detected_at,
           m.content, m.type, m.trust_score, m.tags
    FROM promote_candidates pc
    JOIN memories m ON m.id = pc.mem_id
    WHERE pc.acknowledged_at IS NULL
      AND (pc.project_key = ? OR EXISTS (
        SELECT 1 FROM json_each(pc.similar_in) je
        WHERE json_extract(je.value, '$.project_key') = ?))
    ORDER BY pc.detected_at DESC LIMIT ?
  `).all(projectKey, projectKey, limit);

  if (rows.length === 0) {
    process.stdout.write(`ccmem: no cross-project patterns detected\n`);
    return;
  }

  for (const r of rows) {
    const similar = JSON.parse(r.similar_in);
    process.stdout.write(
      `[candidate#${r.candidate_id}] detected ${daysAgo(r.detected_at)}\n` +
      `  [m${r.mem_id}] ${r.type}|project:${r.project_key}  trust=${r.trust_score.toFixed(2)}\n` +
      `    ${r.content.slice(0, 100)}\n` +
      `  Similar in ${similar.length} other project(s):\n`
    );
    for (const s of similar.slice(0, 5)) {
      const sMem = db.prepare(`SELECT content FROM memories WHERE id=?`).get(s.mem_id);
      process.stdout.write(
        `    project:${s.project_key}  [m${s.mem_id}] cosine=${s.cosine}  "${(sMem?.content || '?').slice(0, 60)}"\n`
      );
    }
    process.stdout.write(`  [p]romote to global / [d]ismiss / [s]kip: `);

    const choice = readLineSync().trim().toLowerCase();
    switch (choice) {
      case 'p': {
        // 安全检查: dangerous_command / contains_secret 不可提升 global
        const tags = JSON.parse(r.tags || '[]');
        if (tags.includes('dangerous_command') || tags.includes('contains_secret')) {
          process.stdout.write(`  BLOCKED: cannot promote dangerous/secret memory to global\n`);
          break;
        }
        db.prepare(`UPDATE memories SET scope='global', project_key=NULL, type='rule', updated_at=?
          WHERE id=?`).run(Date.now(), r.mem_id);
        db.prepare(`UPDATE promote_candidates SET acknowledged_at=?, acknowledged_action='promote'
          WHERE id=?`).run(Date.now(), r.candidate_id);
        regenerateInjectionCache('global', db);
        writeAudit(db, 'cross_project_acknowledged', r.mem_id, {
          candidate_id: r.candidate_id, action: 'promote',
        });
        process.stdout.write(`  promoted m${r.mem_id} to global rule\n`);
        break;
      }
      case 'd': {
        db.prepare(`UPDATE promote_candidates SET acknowledged_at=?, acknowledged_action='dismiss'
          WHERE id=?`).run(Date.now(), r.candidate_id);
        writeAudit(db, 'cross_project_acknowledged', r.mem_id, {
          candidate_id: r.candidate_id, action: 'dismiss',
        });
        break;
      }
      default: break; // skip
    }
  }
}
```

#### 6.5.4 daily_maintenance 清理

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.9 新增 step 22)
const retDays = loadConfig().cross_project?.alert_retention_days ?? 60;
db.prepare(`DELETE FROM promote_candidates WHERE detected_at < ?`)
  .run(Date.now() - retDays * 86400000);
```

#### 6.5.5 `/ccmem:stats` 提示行

```javascript
// scripts/lib/cmd/stats.mjs (v0.9 增量)
const promotePending = db.prepare(
  `SELECT COUNT(*) AS n FROM promote_candidates WHERE acknowledged_at IS NULL`).get().n;
if (promotePending > 0) {
  lines.push(`Promote  : ${promotePending} cross-project patterns detected — run /ccmem:resurrect --promote-candidates`);
}
```

---

## 七、命令延伸

所有命令遵守 v0.1 R-4 原则。命令 prelude 调 `maybeRunTier15`。

### 7.1 命令矩阵（v0.9 新增 / 扩展）

| Slash | CLI | 实现 | 类型 |
|---|---|---|---|
| `/ccmem:list --never-injected [--days N]` | 同 | `lib/cmd/list.mjs` 增 flag | 扩展 |
| `/ccmem:show <id>` | 同 | `lib/cmd/show.mjs` 加 injection history | 扩展 |
| `/ccmem:resurrect --promote-candidates [--limit N]` | 同 | `lib/cmd/resurrect.mjs` 增分支 | 扩展 |
| `/ccmem:admin diagnose --injections [--days N]` | 同 | `lib/admin/diagnose.mjs` 新 flag | 新增 |
| `/ccmem:admin cron run cross_project_patterns` | 同 | `lib/admin/cron.mjs` 白名单加 | 扩展 |
| `/ccmem:stats` | 同 | `lib/cmd/stats.mjs` 加 Injection + Promote 行 | 扩展 |

### 7.2 命令 prelude 调用

| 命令 | prelude 调用 | 理由 |
|---|---|---|
| `/ccmem:list --never-injected` | `maybeRunTier15(db)` | 与 list 已有行为一致 |
| `/ccmem:show <id>` | 已有（不新增） | — |
| `/ccmem:resurrect --promote-candidates` | `maybeRunTier15(db)` | 列前先跑 lazy |
| `/ccmem:admin diagnose --injections` | `maybeRunTier15(db)` | 与 --tuning/--metrics 一致 |

### 7.3 输出契约（R-4 LLM-safe）

- resurrect --promote-candidates 交互走 **stdin**（p/d/s 单字符）
- promote 安全检查（dangerous_command/contains_secret）→ HARD-BLOCK + 提示原因
- 元解释走 `audit_log`

---

## 八、配置（v0.9 增量）

`config.default.json` 升到 `"version": "0.9"`。新增 / 修改如下：

```jsonc
{
  "version": "0.9",

  // A1: 输入端治理
  "summarize": {
    // v0.8 已有: min_transcript_after_clean
    "transcript_cleaner": {
      "enabled": true,
      "extra_rules": []              // v0.9: [{name, start_pattern, end_pattern}]
    },
    "quality_gate": {
      "enabled": true,
      "min_chars": 15,
      "rules_enabled": {             // v0.9: 按规则名开关
        "too_short": true,
        "commit_format": true,
        "too_specific": true,
        "version_snapshot": true,
        "test_count": true,
        "timestamp_dominant": true,
        "path_list": true
      }
    }
  },

  // A2: 整合端提质
  "adaptive_decay": {
    "consolidated_fast_expire_days": 60,
    "consolidated_max_depth_for_expire": 1,
    "candidate_expire_archive_days": 30
  },

  // B1: 检索可观测性
  "injection_observability": {
    "never_injected_alert_ratio": 0.15,
    "low_quality_threshold": 0.30
  },

  // C1: 跨项目知识自动发现
  "cross_project": {
    "audit": {
      "enabled": true,
      "schedule_weekday": 0,
      "schedule_hour": 4,
      "schedule_minute": 47,
      "cosine_threshold": 0.85,           // 0.85: 2 项目时需更严格门槛; 3+ 项目时可放宽到 0.80
      "min_projects": 2,
      "min_trust": 0.5,                  // 排除低 trust 噪音记忆
      "max_candidates_per_run": 5,       // 每次 cron 最多推荐数; 避免淹没用户
      "dedup_window_days": 30,
      "max_pairs": 500000              // 安全上限, 超出截断 + audit 告警
    },
    "alert_retention_days": 60
  }
}
```

4 层合并（default < user < project < env）沿用。**`cross_project.audit.*` 不接受项目级覆盖**——
避免单项目关全局跨项目检测。`injection_observability.*` **允许**项目级覆盖。

---

## 九、测试策略

| 类别 | 覆盖对象 | 关键断言 |
|------|---------|---------|
| **Schema migration** | `011_v09.sql` 幂等；v0.8 DB(version=10) 升 11 | `recent_injections.scores` 列存在；`promote_candidates` 表+索引建成；4 个 rollup 列默认 0/NULL |
| **Unit: quality gate v2** | 4 条新规则独立 + rules_enabled | `version_snapshot` 命中 "schema version 10"；`test_count` 命中 "961/961 pass"；`timestamp_dominant` 命中日期占>30%；`path_list` 命中纯路径列表；user_explicit 全部绕过；`rules_enabled.version_snapshot=false` 不拦截 |
| **Unit: transcript_cleaner extra_rules** | 用户自定义规则 | 合法 pattern 正确剥离；非法 pattern 静默跳过；ReDoS pattern 50ms 超时拒绝 |
| **Unit: A2.1 candidate_expire 条件** | 删除 `AND unhelpful_count=0` | unhelpful_count=3+helpful_count=0+超龄→candidate_expire；helpful_count=1→不触发 |
| **Unit: A2.2 candidate_expire→archived** | 30d 宽限 | candidate_expire 31d→archived；29d→不动 |
| **Unit: A2.3 dedup touch** | 不更新 last_touched_at | dedup 命中后 last_touched_at 不变；updated_at 更新 |
| **Unit: A2.4 adjustTrust last_touched_at** | helpful 刷新衰减时钟 | helpful_implicit→last_touched_at 更新；unhelpful→last_touched_at 不变 |
| **Unit: A2.5 consolidated 快速过期** | 60d+depth≤1+helpful_count=0 | 满足全部条件→candidate_expire；depth=2→不触发；helpful_count=1→不触发；用 created_at 不受 dedup touch 影响 |
| **Unit: B1 scores 写入** | recent_injections.scores | 注入 3 条 mem→scores JSON 含 3 条记录各有 fts/jac/cos/f 字段；SessionStart 注入 scores=NULL |
| **Unit: B1 never-injected** | UNION 两表查询 | 30d 内从未在 recent_injections 或 memory_feedback 中出现→命中；出现过→不命中；json_each 精确匹配（S-5：不误命中 id=1→id=10） |
| **Unit: B1 show injection history** | `/ccmem:show <id>` | 有注入记录→显示 Recent injections 段含评分；无记录→不显示段 |
| **Unit: B1 diagnose --injections** | 有/无数据 | 有 14d 数据→5 段输出；无数据→友好提示；Low-quality 段仅当有 fused<threshold 时显示 |
| **Unit: B1 stats Injection 行** | 阈值显示 | never_injected_ratio>0.15→显示；≤0.15→不显示 |
| **Unit: B2 retrieval timing** | metrics.jsonl 字段 | prompt_submit 行含 retrieval_embed_ms/db_ms/cosine_ms/pool；embedding OFF 时 timing=null |
| **Unit: C1 算法** | 跨项目 cosine 检测 | 2 项目各有相似 mem(cosine≥0.80)→candidate 产生；cosine<threshold→不产生；单项目→跳过+audit |
| **Unit: C1 聚类去重** | 3 条互相相似候选→1 candidate | 最高 trust 为代表；similar_in 含其余 |
| **Unit: C1 全局覆盖** | global 已有相似 mem→跳过 | audit `cross_project_already_global` 写入 |
| **Unit: C1 30d 去重** | 同 mem_id 30d 内→跳过 | promote_candidates 不重复写入 |
| **Unit: C1 resurrect** | p/d/s 三分支 | p→scope='global'+project_key=NULL+ack；d→ack；s→不动 |
| **Unit: C1 resurrect 安全检查** | dangerous_command tag | p→HARD-BLOCK+显示原因+不 ack |
| **Unit: C1 embedding 关闭** | 全流程跳过 | audit `cross_project_skipped` reason='no_embedding' |
| **Integration: A2 退场端到端** | 插入 auto_inferred fact+mock 超龄 | helpful_count=0→candidate_expire→30d→archived→14d→硬删 |
| **Integration: A2 dedup+trust 配套** | dedup 不延命 + helpful 延命 | dedup touch 后 candidate_expire 仍按 created_at 触发；helpful_implicit 后 last_touched_at 刷新阻止 candidate_expire |
| **Integration: B1 端到端** | save→prompt→diagnose --injections | scores 写入→Top10 显示→never-injected 计数 |
| **Integration: C1 端到端** | 插入 2 个 project 各有相似 mem→cron→resurrect | promote_candidate 产生→p promote→global；全局覆盖→跳过 |
| **Integration: daily_maintenance 新 steps** | steps 20-22 | candidate_expire→archived + consolidated 快速过期 + promote_candidates 60d 清理 |
| **回归: v0.8 全套** | 961/961 | hooks 输出 / Tier 1-3 / embedding / 反馈 / 整合全 PASS |
| **回归: embedding 关闭** | 全流程 | hook 输出=v0.8；C1 跳过+audit；B1 scores 中 cos=0 |
| **Mode 矩阵: shadow** | shadow 下 C1 / B1 / A2 | daemon 内 cron 不受 mode 影响；命令 prelude 的 Tier 1.5 在 shadow 下仍跑 |

**强制门禁**：
- schema migration + quality gate v2 unit + A2 五项 unit 通过
- C1 端到端（mock embedding）通过
- B1 diagnose --injections 有数据/无数据通过
- embedding 关闭回归 100% 通过
- v0.8 全量回归 100% 通过（961/961）

---

## 十、实施顺序（4 周 / M10）

### P1 Week 1-1.5 — 输入+整合管线升级 (A1+A2)

1. `migrations/011_v09.sql` + migration 测试
2. `quality-gate.mjs` v2（4 新规则 + `rules_enabled` config）+ unit
3. `summarize-pending.mjs` prompt 分级提取（prompt 文本修改）
4. `transcript-cleaner.mjs` extra_rules（pattern→RegExp 编译 + safety）+ unit
5. A2.1 `daily-maintenance.mjs` step 1 条件修改 + unit
6. A2.2 `daily-maintenance.mjs` step 20 candidate_expire→archived 30d + unit
7. A2.3 + A2.4（同 commit）`dedup.mjs` 命中路径改 `updated_at` + `trust.mjs` adjustTrust helpful 刷新 `last_touched_at` + unit
9. A2.5 `daily-maintenance.mjs` step 21 consolidated 60d 快速过期 + unit
10. A2.6 `weekly-synthesis.mjs` synthesis prompt 去重强化

### P2 Week 1.5-3 — 检索可观测性 (B1+B2)

11. `recent-injections.mjs` writeRecentInjection +scores 参数 + unit
12. `prompt-submit.mjs` 传 scores + recordMetric +timing
13. never-injected 查询（UNION 两表 + json_each）+ `/ccmem:list --never-injected` + unit
14. `/ccmem:show <id>` injection history 段 + unit
15. `metrics-rollup.mjs` 注入统计 + writeMetricsDailyRollup 扩展
16. `/ccmem:admin diagnose --injections`（5 段 + 性能段）+ unit
17. `/ccmem:stats` Injection 提示行
18. `retrieval.mjs` timing 采集（B2）

### P3 Week 3-4 — 跨项目发现 + 集成 (C1 + 验收)

19. `cross-project-patterns.mjs`（算法 + 聚类去重 + 全局覆盖检查）+ unit
20. `daemon/loop.mjs` scheduleCronTasks + dispatch
21. `/ccmem:resurrect --promote-candidates`（p/d/s + 安全检查）+ unit
22. `/ccmem:stats` Promote 提示行
23. `daily-maintenance.mjs` step 22 promote_candidates 60d 清理
24. `lib/admin/cron.mjs` 白名单加 `cross_project_patterns`
25. `config.default.json` bump 0.9 + 新配置段
26. v0.8 全量回归（961 tests）+ embedding 关闭回归
27. mode 矩阵（shadow/off）
28. **M10 验收**（§1.3 完成判据 23 条）

### 依赖关系

```
011 schema ──→ A1 quality gate v2 + prompt ──→ A2.1-A2.5 (三缺口+两配套)
                                                    ↓
              B1 scores/never-injected ──→ B1 show/list/diagnose/stats
                                                    ↓
              B2 timing (独立, 可并行) ────→ diagnose 性能段
                                                    ↓
              C1 算法 ──→ cron + dispatch ──→ resurrect + stats + cleanup
                                                    ↓
                                                回归 + 验收
```

---

## 附录 A：v0.9 不变量 checklist（CI grep）

沿用 v0.8 附录 A 全部 75 条，新增 v0.9 专属：

76. `checkQuality` 仅在 `summarize-pending.mjs` 内调用（不在 `save.mjs`）
    （`grep -rn 'checkQuality' scripts/lib/cmd/save.mjs` 应为空）
77. `quality_gate` 新规则 v0.9 4 条全部受 `enabled.` 守卫（`enabled = cfg.rules_enabled`）
    （`grep -cn 'enabled\.' scripts/lib/quality-gate.mjs` ≥ 7，含 v0.8 3 条 + v0.9 4 条）
78. `dedupCheck` 命中路径不更新 `last_touched_at`
    （`grep -n 'last_touched_at' scripts/lib/dedup.mjs` 应为空）
79. `adjustTrust` helpful/helpful_implicit 路径更新 `last_touched_at`
    （`grep -n 'last_touched_at' scripts/lib/trust.mjs` ≥ 1）
80. `adjustTrust` unhelpful 路径不更新 `last_touched_at`
    （code review 验证：unhelpful UPDATE 语句无 `last_touched_at`）
81. `candidate_expire` 条件不含 `unhelpful_count=0`
    （`grep -n 'unhelpful_count.*=.*0' scripts/daemon/tasks/daily-maintenance.mjs` 中 step 1 应为空）
82. `candidate_expire→archived` 转换存在
    （`grep -n "candidate_expire.*archived" scripts/daemon/tasks/daily-maintenance.mjs` ≥ 1）
83. consolidated 快速过期使用 `created_at` 而非 `last_touched_at`
    （`grep -n 'created_at' scripts/daemon/tasks/daily-maintenance.mjs` 在 step 21 命中）
84. `writeRecentInjection` 接受 scores 参数
    （`grep -n 'scores' scripts/lib/recent-injections.mjs` ≥ 1）
85. never-injected 查询使用 `json_each` 精确匹配（S-5）
    （`grep -n 'json_each' scripts/lib/cmd/list.mjs` ≥ 1）
86. `runCrossProjectPatterns` 前置检查 embedding + min_projects
    （`grep -n 'cross_project_skipped' scripts/daemon/tasks/cross-project-patterns.mjs` ≥ 2）
87. `clusterCandidates` 存在（聚类去重）
    （`grep -n 'clusterCandidates' scripts/daemon/tasks/cross-project-patterns.mjs` ≥ 1）
88. 全局覆盖检查在候选写入前
    （`grep -n 'cross_project_already_global' scripts/daemon/tasks/cross-project-patterns.mjs` ≥ 1）
89. resurrect --promote-candidates 安全检查 dangerous_command/contains_secret
    （`grep -n 'dangerous_command\|contains_secret' scripts/lib/cmd/resurrect.mjs` ≥ 1）
90. v0.9 新增文件 100% 用 `writeAudit`，禁止 `logAudit`
    （`grep -rn 'logAudit(' scripts/daemon/tasks/cross-project-patterns.mjs` 应为空）

---

## 附录 B：从 v0.8 spec 引用的关键约定速查

| 约定 | 出处 | v0.9 沿用 |
|---|---|---|
| 同步 DatabaseSync API | v0.2 §0.2 | ✓ |
| `await callClaudeP` 不持锁 | v0.2 §7.4 | ✓（v0.9 无新 LLM 任务） |
| LLM 输出走 parseLlmJson + JSON schema | v0.2 §8.5 | ✓（无新 schema） |
| stdout/stderr 都进 LLM 上下文 | v0.1 R-4 / v0.2 §5.0.2 | ✓ |
| writeAudit helper | v0.1 §5.6.2 / v0.4 §6.5 统一 | ✓ |
| daemon 防递归 | v0.2 §4.0 / §7.4 | ✓ |
| task_runs lease 防重复 | v0.2 §八 | ✓ |
| Tier 1.5 lazy maintenance | v0.2 §8.4 | ✓（v0.9 不动） |
| daemon-optional 三档定位 | motivation §三 / v0.2 §1.2 | ✓ |
| migration 失败 hard-exit + 自动备份 | v0.2 §3.3 / v0.5 A5 | ✓ |
| Tier 3 quarantine | v0.3 §五 | ✓（v0.9 不动） |
| security_audit cron | v0.3 §6 | ✓ |
| revalidation_audit | v0.4 §6.1 | ✓ |
| metrics_daily_rollup | v0.4 §6.4 | ✓（v0.9 加 4 个 injection 字段） |
| platform 抽象层 | v0.4 §6.6 | ✓ |
| daemon self-restart | v0.5 §6.0-6.5 | ✓（schema 10→11 自动触发） |
| container fallback | v0.5 §6.12-6.19 | ✓ |
| EmbeddingProvider + 三路检索 | v0.6 §6.1-6.4 | ✓（v0.9 不动算法） |
| L1 正向反馈 | v0.6 §6.6 | ✓ |
| audit_log.ts 毫秒 | v0.6 §6.7 | ✓ |
| CJK tokenize | v0.7 §6.1 | ✓ |
| 语义 dedup 双路 | v0.7 §6.2 | ✓（A2.3 修正 dedup touch 行为） |
| per-session dedup | v0.7 §6.3 | ✓ |
| contradiction_audit | v0.7 §6.6 | ✓ |
| monthly_meta_synthesis | v0.7 §6.9 | ✓ |
| 多后端 embedding | v0.8 §6.1 | ✓ |
| transcript cleaner + quality gate | v0.8 §6.2 | ✓（v0.9 扩展规则集） |
| clusterBatchV2 两阶段聚类 | v0.8 §6.3 | ✓ |
| contradiction merge | v0.8 §6.4 | ✓ |
| synthesis 可观测性 | v0.8 §6.5 | ✓ |

---

## 附录 C：未在 v0.9 实现但已埋设的钩子（for v0.10+）

| 钩子 | 已在 v0.9 准备 | v0.10+ 用途 |
|---|---|---|
| `promote_candidates` 表 | ✓ | v0.10 冷启动继承：新项目从 global + promote history 初始化 |
| `injection_observability.low_quality_threshold` config | ✓ | v0.10 `--tuning` 加 injection 质量建议规则 |
| `retrieval_*_ms` metrics.jsonl 字段 | ✓ | v0.10 数据驱动决定是否启用检索预过滤 |
| `quality_gate.rules_enabled` 按名开关 | ✓ | v0.10 用户自定义 quality gate 规则 |
| `adaptive_decay.*` config | ✓ | v0.10 `--tuning` 加衰减阈值建议 |
| `candidate_expire→archived` 转换 | ✓ | v0.10 回顾：30d 宽限期是否合适 |
| `cross_project.audit.cosine_threshold` | ✓ | v0.10 `--tuning` 加跨项目检测阈值建议 |

---

## 附录 D：daemon 缺席降级表（v0.9 更新）

| daemon 状态 | quality gate v2 | A2 退场机制 | B1 scores 写入 | B1 diagnose | B2 timing | C1 跨项目 |
|---|---|---|---|---|---|---|
| ✅ 跑 | ✓（summarize 内部） | ✓（daily steps 20-22） | ✓（hook 内同步） | ✓（读 rollup） | ✓（hook 内同步） | ✓（周跑） |
| ❌ 不跑 | ✗（summarize 不跑） | 部分（step 1 条件改动在 daily 内；Tier 1.5 不含新 steps） | ✓ | ✓（读历史 rollup） | ✓ | ✗ 跳过 |

quality gate v2 和 A2 的 consolidated 快速过期 + candidate_expire→archived 在 daemon daily
内执行——daemon 不跑时不执行。但 A2.1 的 candidate_expire 条件改动（删除 `AND unhelpful_count=0`）
是 daily step 1 的行内修改，daemon 不跑时也不执行。A2.3（dedup touch）和 A2.4（adjustTrust
last_touched_at）在 hook/save 内同步执行，daemon-optional。

---

## 附录 E：dogfood 记录（待 dogfood 期填）

> 真实使用过程中发现的行为偏差、阈值不合理、误判等记录在这里。

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| TBD | (待 dogfood 期填) | | |

---

**End of v0.9 spec.**
