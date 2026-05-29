# ccmem v0.1 实施 spec

> 这是 v0.1 的**实施 spec**（"现在要 build 什么"），不是 [`ccmem-design.md`](./ccmem-design.md)（"ccmem 长期能成为什么"）。
>
> **核心原则**：v0.1 验证一个假设——「自动加载的项目/用户上下文能减少 LLM 重复解释」。在这个假设被验证之前，**任何不直接服务于此目标的功能都不进 v0.1**。
>
> ship 出 v0.1 自己用 1-2 周，根据 metrics.jsonl 和体感决定 v0.2 方向。如果假设被证伪（注入了但 LLM 不用 / 用户更想自己控制），v0.1 比 v3 spec 容易调整。

---

## 一、范围与时间预算

- **代码量目标**：< 2000 行 Node.js（含测试）
- **实施时间**：2-3 周（单人）
- **假设验证窗口**：v0.1 ship 后自用 1-2 周再决定 v0.2

### 1.1 v0.1 做什么

| 能力 | 说明 |
|---|---|
| SessionStart 注入 | 进入会话时把 pinned + 项目相关 + 全局相关记忆拼成 markdown 注入 |
| UserPromptSubmit 检索 | 每次用户提问 FTS5 检索 top 6 相关记忆注入 |
| 用户写入 | `/ccmem:save "<content>"` 主动写入；走 Tier 1 闸门 |
| 用户管理 | list / show / forget / pin / mode 五个命令 |
| 双入口 | Slash 命令 + 独立 CLI 共享底层 |
| 模式开关 | active / shadow / off |
| 写入闸门 | Tier 1 prompt-injection 模式 + secret-in-global 拦截 |
| 性能预算 | **分层指标**:业务逻辑 p95 < 50ms / 100ms;端到端(含 Node 冷启动)p95 < 300ms,详见 §4.1 / §4.2 |
| 失败兜底 | 任何错误 → stderr warn + 空注入 + exit 0，绝不阻塞主会话 |

### 1.2 v0.1 不做什么（明确推迟到 v0.2+）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| Daemon | v0.2 | 验证假设阶段不需要后台 |
| Cron 任务（任何 LLM 调用）| v0.2 | 同上 |
| `claude -p` 任何调用 | v0.2 | 同上 |
| Trust 数值系统 | v0.2 | v0.1 所有记忆 trust = 1.0，无衰减 |
| 反馈推断（L1-L4）| v0.2 | 无 trust 系统则无处反馈 |
| `consolidation_depth` 功能逻辑 | v0.2 | schema 预留字段，v0.1 一直 = 0 |
| `type='consolidated'` | v0.2 | 由 weekly_synthesis 生成 |
| Embedding / 向量检索 | v0.5+ | FTS5 已足够验证假设 |
| Import / Export 命令 | v0.3+ | 用 `ccmem list --json` + `sqlite3` CLI 替代 |
| Cerebrum 自动同步 | v0.2+ | 用户可手动 `/ccmem:save` 复制关键内容 |
| 状态降级（degraded/safe/bypass）| 永不 | 用 try/catch 兜底替代 |
| `quarantine` 写入路径 | v0.2（Tier 2 evaluateTier2 生效后引入） | v0.1 不实现 Tier 2 闸门；Tier 1 直接拒绝即可 |
| 项目级 config 文件(完整 schema)| 永不 | v0.1 即读 `<project>/.ccmem/config.json`,但**仅认 `project_key` / `project_key_remote_priority`**(B5);完整配置永远只在用户级 |
| Path-escape realpath 检测 | 永不 | 文档化"不要写带路径的全局规则" |
| Confirm token 表 / content hash / 冷却期 | 永不 | 改为 4 档分级(L0/L1/L2/L3)。L3 用短词 verbatim(如 `PURGE ALL`),无 token、无 hash、无 cooldown。详见 ccmem-design.md §16.4 |
| AskUserQuestion 多选交互 | 永不 | Claude Code 硬限制 ≤ 4 选项;v0.1 所有命令的人机确认走 stdin(y/N) 或 verbatim 短词,不依赖 LLM 多选 UI |

---

## 二、架构

```
┌──────────────────────────────────────────────────────────────┐
│                      Claude Code 会话                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SessionStart            UserPromptSubmit                    │
│  ┌─────────────┐         ┌──────────────┐                    │
│  │ 1 SELECT    │         │ FTS5 + 注入  │                    │
│  │ injection_  │         │ + 反馈表占位 │                    │
│  │ cache       │         │ (写值不生效) │                    │
│  └──────┬──────┘         └──────┬───────┘                    │
│         │                       │                             │
│         └──────────┬────────────┘                             │
│                    ▼                                          │
│            stdout JSON additionalContext                      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Slash 命令              CLI (ccmem)                        │
│   /ccmem:list             ccmem list --json                  │
│   /ccmem:save             ccmem save                         │
│   /ccmem:show             ccmem show                         │
│   /ccmem:forget           ccmem forget                       │
│   /ccmem:pin              ccmem pin                          │
│   /ccmem:mode             ccmem mode                         │
│         │                       │                            │
│         └──────────┬────────────┘                            │
│                    ▼                                          │
│            scripts/lib/cmd/*.mjs                              │
│            (共享底层实现)                                      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   写入路径 → Tier 1 闸门 → injection_cache 同步重生           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│         SQLite (~/.claude/ccmem/global.db)                    │
│         + 项目级 (<project>/.ccmem/project.db, 可选)         │
│         WAL mode + busy_timeout 5s                            │
│                                                              │
│  memories | memories_fts | injection_cache | audit_log       │
│  config_kv | tasks (空表,v0.2 预留)                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**关键设计点**：

1. **无 daemon**。所有逻辑在 hook 进程或 CLI 进程内同步完成。
2. **预渲染 injection_cache**。任何写入操作（save/forget/pin/edit）后同步重生 cache；hook 内只读 cache，1 SELECT。
3. **Slash 与 CLI 共享底层**。`scripts/lib/cmd/*.mjs` 是真实实现，slash handler 与 CLI 都是 5 行薄壳。
4. **失败永远兜底**。任何 throw 都被 hook 入口的 try/catch 接住，输出空注入 + exit 0。

---

## 三、数据模型

### 3.1 SQLite schema

```sql
-- ============================================================
-- v0.1 schema (migrations/001_initial.sql)
-- ============================================================

-- B5: 当前 schema 版本(**单 row, UPDATE in-place**)
-- 代码标准查询:SELECT version FROM schema_meta LIMIT 1
-- 多行迁移历史在 schema_migrations(下方),两表互补:schema_meta = "now",
-- schema_migrations = "ever"。MAX(version) 在单 row 上等价于 LIMIT 1,但 LIMIT 1
-- 是 canonical,新代码统一用 LIMIT 1。
CREATE TABLE schema_meta (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
INSERT INTO schema_meta VALUES (1, strftime('%s', 'now') * 1000);

-- R-5: schema 迁移历史(每次 ALTER / CHECK enum 扩展都记一行)
-- v0.1 即建表,即便初期只有 1 条 v0→v1 row;v0.2 起每次 migration 入历史
-- 用途:用户 /ccmem:admin diagnose --migrations 查"做过哪些迁移";
--      debug 数据问题时定位"是哪次迁移引入的字段";
--      v0.3+ 实施 rollback 命令时读 rollback_sql 字段
CREATE TABLE schema_migrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version    INTEGER NOT NULL,
  to_version      INTEGER NOT NULL,
  description     TEXT NOT NULL,           -- 'Q-4: extend task_runs.ran_by enum (add recovery_script)'
  applied_at      INTEGER NOT NULL,
  applied_by      TEXT NOT NULL,           -- 'ccmem-cli' / 'manual' / 'upgrade-script'
  rollback_sql    TEXT,                     -- 反向迁移 SQL(可选,v0.3+ rollback 命令用)
  CHECK (applied_by IN ('ccmem-cli', 'manual', 'upgrade-script'))
);
CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at);
INSERT INTO schema_migrations
  (from_version, to_version, description, applied_at, applied_by)
  VALUES (0, 1, 'v0.1 initial schema', strftime('%s', 'now') * 1000, 'ccmem-cli');

-- 主表
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scope         TEXT NOT NULL,              -- 'global' | 'project'
  project_key   TEXT,                        -- NULL when scope='global'
  type          TEXT NOT NULL,              -- 'rule' | 'fact' | 'episode'
  content       TEXT NOT NULL,
  pinned        INTEGER DEFAULT 0,          -- 0 | 1
  source        TEXT NOT NULL,              -- 'user_explicit' (v0.1 only writes this; C-5: 'system' removed)

  -- v0.2+ reserved 字段(T-1 / T-6 — 保留理由见 revisions §五 T-1)
  -- v0.1 hooks/commands 严禁 UPDATE 这些列(见 §4.6 白名单),
  -- 例外:SessionStart 召回时允许 UPDATE last_touched_at(K-1 lazy maintenance 需要)
  trust_score          REAL    NOT NULL DEFAULT 1.0,      -- v0.1: reserved, no writes (排序 IGNORE,见 §3.3);v0.2+ 上限统一 1.0(U-5)
  consolidation_depth  INTEGER NOT NULL DEFAULT 0,        -- v0.1: reserved, no writes (无 consolidated 类型)
  status               TEXT    NOT NULL DEFAULT 'active', -- v0.1: reserved;v0.2 'active'|'superseded'|'archived'(整合产物生命期)
  decay_status         TEXT    NOT NULL DEFAULT 'active', -- v0.1: reserved;v0.2 'active'|'probation'|'archived'|'candidate_expire'|'quarantine'
  half_life_days       INTEGER,                            -- v0.1: reserved;v0.2 默认由 type 填(rule=60/fact=30/episode=7/consolidated=90)
  helpful_count        INTEGER NOT NULL DEFAULT 0,        -- v0.1: reserved;v0.2 L1/L4/L2.5 反馈累加
  unhelpful_count      INTEGER NOT NULL DEFAULT 0,        -- v0.1: reserved;v0.2 同上
  parent_ids           TEXT,                               -- v0.1: reserved;v0.2 consolidated 的 source 链(JSON array, NULL for non-consolidated)
  trust_summary        TEXT,                               -- v0.1: reserved; v0.2+ JSON summary {total_helpful, total_unhelpful, last_delta, last_reason, last_adjusted_at} — 详细明细走 audit_log

  last_touched_at INTEGER NOT NULL,                        -- v0.1: 写入时 = created_at;v0.2+ 允许 SessionStart 召回时 UPDATE
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  tags            TEXT,                                    -- JSON array, e.g. ["dangerous_command_discussed"]

  CHECK (scope IN ('global', 'project')),
  CHECK (type IN ('rule', 'fact', 'episode', 'consolidated')),  -- 'consolidated' 预留
  -- CHECK 一开始就允许 v0.2 全部 source,避免 v0.2 加新 source 时需要 schema migration
  -- C-5: 已删除 'system' — 该值无明确用途且无 §4.3 trust 参数定义,v0.1 仅 'user_explicit' 写入
  CHECK (source IN ('user_explicit', 'tool_output',
                    'auto_inferred', 'cron_consolidated',
                    'cerebrum_import', 'external')),
  -- T-6 reserved enum CHECK:v0.1 永远是 'active',v0.2+ 状态机激活后才有非默认值
  CHECK (status IN ('active', 'superseded', 'archived')),
  CHECK (decay_status IN ('active', 'probation', 'archived', 'candidate_expire', 'quarantine')),
  -- parent_ids 只允许在 consolidated 上出现(v0.1 永远 NULL,因为 v0.1 不写 consolidated)
  CHECK ((type = 'consolidated' AND parent_ids IS NOT NULL)
      OR (type <> 'consolidated' AND parent_ids IS NULL)),
  CHECK ((scope = 'global' AND project_key IS NULL)
      OR (scope = 'project' AND project_key IS NOT NULL))
);

CREATE INDEX idx_mem_scope        ON memories(scope);
CREATE INDEX idx_mem_project      ON memories(project_key) WHERE project_key IS NOT NULL;
CREATE INDEX idx_mem_pinned       ON memories(pinned)      WHERE pinned = 1;
CREATE INDEX idx_mem_type         ON memories(type);
CREATE INDEX idx_mem_touched      ON memories(last_touched_at);
CREATE INDEX idx_mem_decay        ON memories(decay_status) WHERE decay_status <> 'active';
CREATE INDEX idx_mem_status       ON memories(status)       WHERE status <> 'active';

-- FTS5 全文索引
-- tokenize='trigram' 是为了支持中文(porter+unicode61 不分词 CJK 连续段,
-- "API 路由统一" 整段会成为单一 token,搜"路由"无法命中)。
-- trigram 的代价:索引大小 ~2-3x;查询 token 必须 ≥3 字符才有意义。
-- v0.1 sanitizer 据此过滤短 token;CJK 用户的 1-2 字查询(如"路由")
-- 在 v0.1 接受召回率下降,v0.2 可加 LIKE fallback。
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tokenize = 'trigram'
);

-- FTS 同步触发器(content 变更时自动维护索引)
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN
  UPDATE memories_fts SET content = new.content WHERE rowid = new.id;
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
END;

-- 注入预渲染缓存
CREATE TABLE injection_cache (
  scope         TEXT PRIMARY KEY,            -- 'global' | 'project:<key>'
  rendered_text TEXT NOT NULL,
  member_ids    TEXT NOT NULL,                -- JSON array of memories.id
  rendered_at   INTEGER NOT NULL
);

-- 审计日志(v0.1 用于 debug;v0.2 加入 cron 后会更频繁写)
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  action        TEXT NOT NULL,
  affected_ids  TEXT,                         -- JSON array(语义保留;mem_id 查走 audit_log_targets)
  details       TEXT                           -- JSON blob
);
CREATE INDEX idx_audit_ts ON audit_log(ts);

-- C6: audit_log_targets join 表(按 mem_id 查 audit 的索引路径)
-- "我误删了 m1234, 谁干的" → 不再走 affected_ids LIKE '%1234%'(全表 + 假阳性),
-- 改走 JOIN audit_log_targets WHERE mem_id = 1234,idx_audit_targets_mem 直接命中。
-- 写者每次写 audit 同时插 N 行(N = affected memories 数,常见 N=1)。
-- ON DELETE CASCADE:audit_log 行被 daemon 滚动归档时自动清理 target 行,无残留。
CREATE TABLE audit_log_targets (
  audit_id  INTEGER NOT NULL REFERENCES audit_log(id) ON DELETE CASCADE,
  mem_id    INTEGER NOT NULL,
  PRIMARY KEY (audit_id, mem_id)
);
CREATE INDEX idx_audit_targets_mem ON audit_log_targets(mem_id);

-- 配置 kv(只存运行时状态,如 mode;静态 config 走 ~/.claude/ccmem/config.json)
CREATE TABLE config_kv (
  key      TEXT PRIMARY KEY,
  value    TEXT NOT NULL,
  set_at   INTEGER NOT NULL
);

-- v0.2 预留(空表) — cron 队列
CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,              -- 'summarize_pending' | 'daily_maintenance' | 'weekly_synthesis' | 'vec_backfill'
  payload         TEXT,
  scheduled_for   INTEGER NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER DEFAULT 0,
  error_excerpt   TEXT,
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'superseded'))
);
CREATE INDEX idx_tasks_dispatch ON tasks(status, scheduled_for);

-- v0.1+v0.2 共用 — first-wins lease(O-1)
--
-- 用途:K-1 lazy SQL catch-up 在 SessionStart 触发 daily_maintenance SQL 部分,
-- 多窗口并发开启时所有 SessionStart hook 都会 try 跑;UNIQUE(type, date_key)
-- 保证同一天同一类型只跑一次,后续 INSERT 失败即 skip,避免 SQLite WRITE 冲突
-- 与重复 trust_archive。design.md §7.7 / §O-1 详细描述。
--
-- v0.1 即建表(K-1 lazy SQL 需要);v0.2 daemon 起来后承担主要写入。
CREATE TABLE task_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,              -- 'daily_maintenance' | 'weekly_synthesis' | ...
  date_key        TEXT NOT NULL,              -- 'YYYY-MM-DD' (daily) / 'YYYY-Www' (weekly)
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT NOT NULL DEFAULT 'running',
  ran_by          TEXT,                       -- Q-4: enum 见下方 CHECK
  CHECK (status IN ('running', 'completed', 'failed')),
  -- Q-4 + M-3-D: ran_by enum 防漂移(实施者常见错误:'cron' / 'lazy_hook' / 'auto')
  --      允许 NULL 以便迁移期遗留 row 不破坏约束;新代码必须用 RAN_BY 常量
  --      扩展该 enum 需走 docs/migrations.md 的 "CHECK enum 扩展 recipe"
  --      (SQLite 不支持 ALTER TABLE ADD CONSTRAINT,需 rename → recreate → copy)
  --      M-3-D(2026-05-28): 'opportunistic' 已 rename 为 'opportunistic'
  --      — Tier 1.5 + SessionStart mini-prelude 都不是 hook 也不是 lazy,
  --        准确语义是"机会式触发(用户动作搭便车)"
  CHECK (ran_by IS NULL OR ran_by IN ('daemon', 'opportunistic', 'manual')),
  UNIQUE(type, date_key)                      -- 第二个并发 INSERT 失败 → skip
);
CREATE INDEX idx_task_runs_type_date ON task_runs(type, date_key);
```

**配套代码常量**(scripts/lib/task-runs.mjs):

```javascript
// Q-4 + M-3-D: 所有 INSERT INTO task_runs 必须用 RAN_BY.XXX,不允许字面量。
// CHECK 约束是 DB-level 兜底;代码 const 是 IDE-level 提示。
// M-3-D(2026-05-28): RAN_BY 三档按"触发源"语义命名 — 定时 / 机会 / 显式
export const RAN_BY = Object.freeze({
  DAEMON:        'daemon',         // Tier 2 daemon 主循环按 cron schedule 跑
  OPPORTUNISTIC: 'opportunistic',  // 机会式触发(Tier 1.5 命令 prelude + SessionStart mini-prelude)
                                   // — 用户做正经事时 ccmem 顺手做维护(原 HOOK_LAZY,M-3-D rename)
  MANUAL:        'manual',         // 用户显式触发(/ccmem:admin cron run <task>)
});
```

**扩展 enum 的 migration recipe**(适用于 `task_runs.ran_by` /
`recent_injections.inject_source` 等所有 CHECK 约束 enum 列):

```sql
-- 例:给 task_runs.ran_by 加 'recovery_script' 值
BEGIN TRANSACTION;
ALTER TABLE task_runs RENAME TO task_runs_old;
CREATE TABLE task_runs (
  -- ... 完整 schema,CHECK 改为新 enum 集合 ...
  CHECK (ran_by IS NULL OR ran_by IN ('daemon', 'opportunistic', 'manual', 'recovery_script')),
  UNIQUE(type, date_key)
);
INSERT INTO task_runs SELECT * FROM task_runs_old;
DROP TABLE task_runs_old;
CREATE INDEX idx_task_runs_type_date ON task_runs(type, date_key);
-- 更新 RAN_BY 常量:RECOVERY_SCRIPT: 'recovery_script'
COMMIT;
```

成本 ~50ms / 1K rows,可放在 ccmem 升级时一次性跑。新值出现频率应当极低
(每 6+ 月 1 个),否则就该考虑迁移到字典表 + FK 方案。

### 3.2 数据库位置（v0.1 决策：单库）

```
~/.claude/ccmem/global.db    # 全部记忆,scope + project_key 区分
```

**v0.1 不使用** `<project>/.ccmem/project.db`。所有 scope='global' 与 scope='project' 的记忆都在同一个 SQLite 文件里，靠 `scope` 与 `project_key` 列过滤。

理由：
- 跨 scope 检索一次 SQL 搞定（无需 ATTACH DATABASE）
- FTS5 一份索引覆盖全部
- 实现复杂度降低 ~30%

**项目级 `<project>/.ccmem/` 目录** v0.1 仅存放可选的 `project_key` 单行覆盖文件，不放 DB。

**v0.3 拆分预案**：当多设备同步需求出现时，写一次性迁移工具把 scope='project' 的行批量导出到对应 `<project>/.ccmem/project.db`，并保留 global.db。

### 3.3 类型说明

| type | v0.1 含义 | base_priority(v0.1 不实现) | 注入优先级（v0.1 用 pinned + recency 替代）|
|---|---|---|---|
| `rule` | 用户偏好 / 项目规则 | — | pinned > rule > fact > episode (硬编码) |
| `fact` | 事实信息（路径、技术栈、配置） | — | 同上 |
| `episode` | 一次性情景 | — | 同上 |
| `consolidated` | v0.2 才出现，v0.1 schema 预留但永不写入 | — | — |

**N-2 v0.1 排序简化声明**:

v0.1 的"优先级"**只按 `pinned > type 硬序 > last_touched_at DESC`** 三段排序。
设计上**不参与排序的字段**(schema 里写入,排名时 IGNORE):

- `trust_score`:v0.1 全部记忆 source=`user_explicit`,trust 初始 1.0 全部相等,排序无意义。
  v0.2 多 source(`cron_consolidated` / `tool_output` / `external` 等)介入后才有差异。
- `recall_count` / `usage`:v0.1 不写 usage 表(`UserPromptSubmit` 不更新计数),
  频率项恒为 0,加入公式只会让所有记忆 priority 相等。
- `consolidation_depth`:v0.1 无 consolidated 记忆,字段恒为 0。
- `probation_boost`:v0.1 无 probation 状态机,恒为 1.0。

**为什么不让 v0.1 直接跑完整公式**:v0.1 没有反馈信号源(L1-L4 全部 v0.2 才实现),
`trust_score` 是"死字段"——既不会上调也不会下调,加入排序等于按 source 类型给初始值
排个固定顺序,不增加任何信息。v0.2 反馈机制上线后,这些字段才有"动起来"的意义,
那时再把排序公式升级到完整版,**hot path 用户感知零变化**(rule 仍排第一,只是
trust 差异让同 type 内的位次有了微调)。详见 [ccmem-design.md §5.1](./ccmem-design.md#51-优先级公式)。

### 3.4 Source

v0.1 只有 1 种 source(C-5):
- `user_explicit` — 用户通过 `/ccmem:save` 写入

v0.2 加入 `tool_output / auto_inferred / cron_consolidated / cerebrum_import / external`。

> **C-5 决议(2026-05-28)**:原设计 schema 中保留 `'system'` 值,但 §4.3 trust 分级表
> 从未给出对应的初始 trust / 观察期参数,且全文无 code path 实际写入此 source。
> 已从 schema CHECK 中删除。如未来需要"系统生成的种子记忆",改用 `auto_inferred`
> + tag(如 `system_seed`)区分,可复用现有 trust=0.5 + 14 天观察期的语义。

---

## 四、Hooks

### 4.1 SessionStart

**输入**：`hookData = { hook_event_name, source, session_id, transcript_path, cwd }`

**职责**：从 injection_cache 读两段文本（global + 当前项目），拼接后输出。

**性能预算**(**分层**,U-PERF):

| 指标 | 含义 | p50 | p95 | hard timeout |
|---|---|---|---|---|
| `ms_business` | 业务逻辑(DB open / SQL / render / stdout write) | < 20ms | **< 50ms** | — |
| `ms_total` | hook.mjs entry → stdout write 完成(我们能测的最大范围) | < 150ms | **< 300ms** | 1000ms |

- 业务预算约束代码质量;端到端预算反映用户感知
- Node 自身冷启动(fork → main entry)不可测,经验值 50-100ms,**不计入 ms_total**——但 Claude Code timeout 1s 已涵盖
- metrics.jsonl 同时记两个数,诊断时区分"Node 慢"vs"SQL 慢"

```javascript
// scripts/handlers/session-start.mjs
import { withHookSafety } from '../lib/hook-safety.mjs';
import { openDb } from '../lib/db.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';

export async function handleSessionStart(hookData) {
  return withHookSafety('session_start', 200, async () => {
    const config = loadConfig();
    const mode = await getMode();

    if (mode === 'off') return { additionalContext: '' };

    // U-6 strict shadow: read-only diagnostic — 读 injection_cache,不写任何表(error 除外),
    // metrics.jsonl 仍写(诊断的本意用途)。提示文案明确"read-only diagnostic"而非"recording".
    if (mode === 'shadow') {
      process.stderr.write('ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n');
    }

    const db = openDb();
    const projectKey = resolveProjectKey(hookData.cwd);

    // U-1 + T-5 daemon-optional: SessionStart hook 不跑 Tier 1.5 maintenance(避免污染 hook 预算)。
    // Tier 1.5(trust 兜底 / 14d archive / decay_status 状态机)在用户主动命令 prelude 里跑,
    // 通过 task_runs.UNIQUE(type='tier1_5_maintenance', date_key=today) lease 保证一天一次。
    // Tier 2(LLM 任务)daemon 缺席时直接不做。
    // 用户可通过 `/ccmem:stats` 顶部条目感知三档状态(v0.2 加入)。

    const rows = await db.all(`
      SELECT rendered_text FROM injection_cache
      WHERE scope = 'global' OR scope = ?
      ORDER BY (scope = 'global') DESC
    `, [`project:${projectKey}`]);

    const text = rows.map(r => r.rendered_text).filter(Boolean).join('\n\n');
    const trimmed = trimToCharLimit(text, config.inject.max_chars);

    // U-6: metrics 仍写(诊断本意),inject 文本 shadow 下置空
    return {
      additionalContext: mode === 'shadow' ? '' : trimmed,
      _shadow_would_inject_chars: mode === 'shadow' ? trimmed.length : 0,
    };
  });
}

// T-5 daemon-optional 决策后,tryLazyDailyMaintenance 已删除。
// 原 K-1 lazy SQL maintenance 路径不再使用 —— 所有 maintenance(trust 兜底 /
// 14d archive / decay_status 状态机)归类为 Tier 2,daemon 缺席时直接不做。
// 此注释保留作为决策痕迹,v0.2 实施 daemon 时由 daemon 内的 daily_maintenance
// cron 任务承担全部职责(详见 design.md §7.6)。
```

**K-1 daemon-not-running 提示**(v0.2+ 才需要,v0.1 无 daemon 故不显示):
v0.2 起 `/ccmem:stats` 顶部检查 daemon 心跳与 LLM 队列长度;daemon down 时
红条提示用户(详见 design.md §7.7 / §K-1)。v0.1 阶段无 LLM 队列,无需提示。

**hook-safety.mjs**：

```javascript
// scripts/lib/hook-safety.mjs
// U-PERF: 双指标 ms_business / ms_total — 见 §4.1 / §4.2
//
// 时间轴:
//   ENTRY ──[ms_node_unmeasured]── hook.mjs main ──[ms_pre]── withHookSafety()
//     ↑ Claude Code spawn                                          ↑ t_entry
//     │                                                            │
//     │  ms_business = t_business_end - t_business_start (代码可控)
//     │  ms_total    = t_stdout_done  - t_entry          (我们能测的最大范围)
//
// hook.mjs 顶部必须立刻记录 t_entry,传给 withHookSafety:
//
//   // scripts/hook.mjs
//   const T_ENTRY = process.hrtime.bigint();
//   import('./handlers/...').then(m => m.handle(hookData, T_ENTRY));

import { recordMetric } from './metrics.mjs';

export async function withHookSafety(hookName, timeoutMs, fn, tEntry) {
  const tBusinessStart = process.hrtime.bigint();
  let result;
  try {
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new TimeoutError()), timeoutMs)
    );
    result = await Promise.race([fn(), timer]);
  } catch (e) {
    process.stderr.write(`ccmem: ${hookName} failed (${e.message})\n`);
    result = { additionalContext: '', _error: e.message };
  }

  const tBusinessEnd = process.hrtime.bigint();
  const msBusiness = Number(tBusinessEnd - tBusinessStart) / 1e6;

  // stdout JSON output (ECC pattern: wrap in Promise + handle EPIPE)
  // hookEventName 必须与 Claude Code 生命周期事件名精确匹配,不能靠 pascalCase 推导
  // (prompt_submit → PromptSubmit ≠ UserPromptSubmit)。用显式映射表。
  const HOOK_EVENT_NAMES = {
    session_start: 'SessionStart', prompt_submit: 'UserPromptSubmit',
    stop: 'Stop', session_end: 'SessionEnd',
  };
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAMES[hookName] || pascalCase(hookName),
      additionalContext: result.additionalContext || '',
    },
  });
  await new Promise((resolve) => {
    process.stdout.once('error', () => resolve());        // 容忍 EPIPE
    process.stdout.write(payload, () => resolve());
  });

  // metrics 在 stdout 之后写,确保不影响响应时长
  const tStdoutDone = process.hrtime.bigint();
  const msTotal = tEntry ? Number(tStdoutDone - tEntry) / 1e6 : null;

  await recordMetric({
    hook: hookName,
    ms_business: Math.round(msBusiness * 10) / 10,
    ms_total: msTotal !== null ? Math.round(msTotal * 10) / 10 : null,
    error: result._error,
  });

  process.exit(0);
}
```

### 4.2 UserPromptSubmit

**输入**：`hookData = { hook_event_name, prompt, session_id, transcript_path, cwd }`

**职责**：用 prompt 做 FTS5 检索，过滤 + top 6 注入。

**性能预算**(**分层**,U-PERF):

| 指标 | 含义 | p50 | p95 | hard timeout |
|---|---|---|---|---|
| `ms_business` | 业务逻辑(FTS5 query / LIKE fallback / render / stdout write) | < 50ms | **< 100ms** | — |
| `ms_total` | hook.mjs entry → stdout write 完成 | < 200ms | **< 300ms** | 1000ms |

业务预算与端到端预算的拆分原理同 §4.1。`ms_business` 是代码层 SLO,`ms_total` 是用户感知 SLO。

```javascript
// scripts/handlers/prompt-submit.mjs
import { withHookSafety } from '../lib/hook-safety.mjs';
import { openDb } from '../lib/db.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { renderRetrievedBlock } from '../lib/render.mjs';

export async function handlePromptSubmit(hookData) {
  return withHookSafety('prompt_submit', 500, async () => {
    const config = loadConfig();
    const mode = await getMode();
    if (mode === 'off') return { additionalContext: '' };

    const db = openDb();
    const projectKey = resolveProjectKey(hookData.cwd);
    const prompt = (hookData.prompt || '').trim();
    if (!prompt) return { additionalContext: '' };

    // ECC-R2: 防止超长 prompt(用户粘贴大段代码)打爆 FTS5 query 或 LIKE 扫描
    // 只取前 2000 字符用于检索 — 记忆匹配只需 prompt 的语义前缀,不需要全文
    const MAX_PROMPT_FOR_RETRIEVAL = 2000;
    const searchPrompt = prompt.length > MAX_PROMPT_FOR_RETRIEVAL
      ? prompt.slice(0, MAX_PROMPT_FOR_RETRIEVAL)
      : prompt;

    // FTS5 检索(U-4: + LIKE fallback for short CJK queries)
    const ftsQuery = sanitizeFtsQuery(searchPrompt);
    const limit = config.inject.max_per_prompt;

    let rows = [];
    if (ftsQuery !== null) {
      rows = await db.all(`
        SELECT m.id, m.type, m.content, m.scope, m.pinned, bm25(memories_fts) AS rank,
               'fts' AS lane
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ?
          AND (m.scope = 'global' OR m.project_key = ?)
        ORDER BY m.pinned DESC, rank ASC
        LIMIT ?
      `, [ftsQuery, projectKey, limit]);
    }

    // U-4 + I-4: LIKE fallback for short tokens (trigram requires ≥3 chars).
    //   U-4: 覆盖 CJK 1-2 字 query("路由"/"组件")
    //   I-4: 扩展到 ASCII 2-3 字符缩写("QA"/"DB"/"API")— 防英文用户在 dogfood 期撞到此盲区
    // 仅在 FTS5 召回不足时启用,避免污染高质量 FTS5 匹配
    if (rows.length < (config.retrieval?.like_fallback?.trigger_when_fts_below ?? 3)) {
      const shortTerms = extractShortTokens(searchPrompt);
      if (shortTerms.length > 0) {
        const likeRows = await likeSearch(db, shortTerms, projectKey, limit - rows.length);
        rows = dedupeMerge(rows, likeRows);  // FTS5 优先,LIKE 补充
      }
    }

    if (rows.length === 0) {
      await recordMetric({ hook: 'prompt_submit', matched: 0, empty: true });
      return { additionalContext: '' };
    }

    await recordMetric({
      hook: 'prompt_submit',
      matched: rows.length,
      fts_count: rows.filter(r => r.lane === 'fts').length,
      like_count: rows.filter(r => r.lane === 'like').length,
    });

    const block = renderRetrievedBlock(rows, prompt);

    return {
      additionalContext: mode === 'shadow' ? '' : block,
      _matched_count: rows.length,
    };
  });
}

// U-4 + I-4: 抽短 token(CJK 2-3 字 + ASCII 2-3 字符缩写),去重,上限 5
//   - CJK 段: /[一-龥]{2,3}/(已有 U-4)
//   - ASCII 段(I-4 新增): /\b[A-Za-z][A-Za-z0-9]{1,2}\b/ — 词边界 \b 防止抽出 substring
//   - stop word 过滤防止"is/be/on/it"等高频小词污染召回
const ASCII_STOP_WORDS = new Set([
  'is', 'be', 'on', 'in', 'it', 'am', 'or', 'to', 'of', 'an', 'as',
  'at', 'by', 'do', 'go', 'me', 'my', 'no', 'so', 'up', 'us', 'we',
  'i', 'a',  // 单字母兜底
]);

function extractShortTokens(prompt) {
  const cjk = (prompt.match(/[一-龥]{2,3}/g) || []);
  const asciiRaw = (prompt.match(/\b[A-Za-z][A-Za-z0-9]{1,2}\b/g) || []);
  const ascii = asciiRaw.filter(t => !ASCII_STOP_WORDS.has(t.toLowerCase()));
  return [...new Set([...cjk, ...ascii])]
    .filter(t => t.length >= 2)
    .slice(0, config?.retrieval?.like_fallback?.max_terms ??
              config?.retrieval?.like_fallback?.max_cjk_terms ?? 5);
  // 配置项命名(I-4): max_terms 是新名;max_cjk_terms 保留作 alias,向后兼容
}

// U-4 + I-4: LIKE 查询 — 对 CJK 与 ASCII 短词都做。
//   ASCII 必须用空格 boundary(`%' || term || ' %'` / `term || ' %'` / `'% ' || term`)
//   防止 "QA" 误命中 "QAR" / "QAD" 等无关 substring。
//   CJK 用普通 `%term%`(中文不分词,substring 即可)。
async function likeSearch(db, terms, projectKey, limit) {
  if (limit <= 0) return [];
  // 防 SQL injection: terms 已通过 extractShortTokens 过滤(CJK Unicode 或 ASCII \b\w+\b),
  // 不含 % _ \ 等 LIKE 元字符
  const isCjk = (t) => /^[一-龥]+$/.test(t);
  const clauses = [];
  const params = [];
  for (const t of terms) {
    if (isCjk(t)) {
      clauses.push('content LIKE ?');
      params.push(`%${t}%`);
    } else {
      // ASCII: 词边界 — 三种情况:头/中/尾
      clauses.push('(content LIKE ? OR content LIKE ? OR content LIKE ? OR content = ?)');
      params.push(`% ${t} %`, `${t} %`, `% ${t}`, t);
    }
  }
  return await db.all(`
    SELECT id, type, content, scope, pinned, 0 AS rank, 'like' AS lane
    FROM memories
    WHERE (${clauses.join(' OR ')})
      AND (scope = 'global' OR project_key = ?)
    ORDER BY pinned DESC, last_touched_at DESC
    LIMIT ?
  `, [...params, projectKey, limit]);
}

// dedupe by id,FTS5 结果保留在前(已按 BM25 排序),LIKE 结果追加(无 rank,按 last_touched_at)
function dedupeMerge(ftsRows, likeRows) {
  const seen = new Set(ftsRows.map(r => r.id));
  const merged = [...ftsRows];
  for (const r of likeRows) {
    if (!seen.has(r.id)) { merged.push(r); seen.add(r.id); }
  }
  return merged;
}

// FTS5 query sanitizer (适配 trigram tokenizer):
//   - trigram 要求 token 长度 ≥ 3 才有意义(< 3 不生成 trigram)
//   - 去除 FTS5 语法字符防止注入: " : ( ) { } [ ]
//   - 用 OR 连接多个 token(任一命中即可,而非 AND 全命中)
function sanitizeFtsQuery(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  const tokens = prompt
    .replace(/["':(){}[\]]/g, ' ')         // 剥离 FTS5 语法字符
    .split(/[\s,。、!?;:!?,;]+/)            // 切分(中英文标点都作为分隔符)
    .filter(t => t.length >= 3 || /^[a-zA-Z0-9]{2,}$/.test(t))
    //         ↑ ≥3 字符通用      ↑ 或 2+ 位英数(覆盖 CI/UI/QA 等缩写)
    .slice(0, 20);                          // 上限 20 token,防超长 query

  if (tokens.length === 0) return null;     // 调用方据此跳过 FTS5 检索
  return tokens.map(t => `"${t}"`).join(' OR ');
}

// 用法约束:调用方必须处理 null 返回值。U-4 后即使 ftsQuery=null
// 也可能通过 LIKE fallback 召回(短 CJK query 场景)。
```

**U-4 + I-4 LIKE fallback 设计要点**:

| 决策 | 取值 | 理由 |
|---|---|---|
| 何时启用 | FTS5 返回 < 3 条时 | 避免污染高质量 FTS5 匹配;3 条是合理"召回不足"阈值 |
| 匹配什么 | CJK 2-3 字连续段 + ASCII 2-3 字符缩写(I-4 扩展) | CJK 2 字与 ASCII 2-3 字符都是 trigram tokenizer 盲区("路由"/"QA"/"DB") |
| 上限 | 5 个 short term(CJK + ASCII 合计) | hook 预算 < 30ms(< 2000 行记忆下实测) |
| ASCII boundary | 空格词边界(头 / 中 / 尾 三种位置) | 防 `LIKE '%QA%'` 误命中 "QAR" / "QAD" 等无关 substring |
| ASCII stop word | 过滤 is/be/on/in 等高频 2 字符词 | 防小词污染召回 |
| 排序 | last_touched_at DESC | LIKE 无 BM25 概念,只能按时间新鲜度 |
| 与 FTS5 合并 | FTS5 优先(按 BM25),LIKE 追加(去重) | 用户主要期望 FTS5 精准,LIKE 是兜底 |
| 配置项 | `retrieval.like_fallback.{enabled,trigger_when_fts_below,max_terms}` | 用户可关闭;`max_cjk_terms` 保留作 alias 向后兼容 |

**为什么 v0.1 就实现**:
- **U-4**:trigram tokenizer 对中文 1-2 字 query 召回 0 — 中文用户在 dogfood 期撞到这个会直接证伪假设
- **I-4**:同理,英文用户的高频缩写(QA / DB / API / UI / CI)同样是 < 3 字符 trigram 盲区,不修就 break 英文用户首周体验
- 30 行代码 + 30 行单测的投入,值得放进 v0.1 而非推迟到 v0.2

**default 配置**(§7.1):
```jsonc
"retrieval": {
  "like_fallback": {
    "enabled": true,
    "trigger_when_fts_below": 3,
    "max_terms": 5             // I-4: 重命名自 max_cjk_terms (alias 保留向后兼容)
  }
}
```

**known-limitations.md SQ-05 应对策略已更新**:trigram 中英文短词盲区(< 3 字符)
已通过 LIKE fallback 缓解(U-4 + I-4)。

### 4.3 hooks/hooks.json 注册

**本地开发加载**：使用 `claude --plugin-dir <plugin-root>` 加载插件，hooks 和 commands
均自动发现。开发中修改代码后在会话内运行 `/reload-plugins` 热加载。

**命令文件命名约定**：`commands/` 下的 `.md` 文件名会被 Claude Code 自动加上插件
命名空间前缀 `/ccmem:<filename>`。因此文件名**不含** `ccmem-` 前缀（例如 `list.md`
→ `/ccmem:list`，而非 `ccmem-list.md` → `/ccmem:ccmem-list`）。

Claude Code v2.1+ **自动加载** plugin 根目录的 `hooks/hooks.json`(不在 `plugin.json` 中声明,
详见 §11.0 V-2)。此文件遵循 `settings.json` 的 hooks schema。

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
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

**v0.1 不注册** Stop / SessionEnd hooks（这些在 v0.2 daemon 上线后启用）。**PreCompact 永不实现**（设计明确不使用,详见 design.md §3 / §6 / motivation §核心理念 6）。

**V-1:为什么用 `${CLAUDE_PLUGIN_ROOT}` 而不是 hardcode 路径**(2026-05-27 决议):

Claude Code 不把所有 plugin 都装到 `~/.claude/plugins/<slug>/`。实际路径取决于安装方式:`~/.claude/plugins/ccmem/`(直接 clone)、`~/.claude/plugins/ccmem@ccmem/`(marketplace 旧 layout)、`~/.claude/plugins/marketplaces/ccmem/`(marketplace 新 layout)、`~/.claude/plugins/cache/ccmem/<org>/<version>/`(versioned cache,marketplace 最常见)。

Claude Code 会注入 `CLAUDE_PLUGIN_ROOT` env 给 hook 进程,值为该插件的实际根目录。任何 plugin 必须读它,绝不能 hardcode 路径——否则 marketplace install 直接挂。**双引号是必须的**:env 展开值可能含空格(`~/My Documents/`),不加双引号会被 shell word-split。

**ccmem 强制要求** Claude Code v2.1+ (注入 `CLAUDE_PLUGIN_ROOT` 的版本)。安装脚本检测到老版本应拒绝安装并提示升级。

**Fallback 处理**(`scripts/hook.mjs` 顶部):

```javascript
// scripts/hook.mjs
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!PLUGIN_ROOT) {
  process.stderr.write('ccmem: CLAUDE_PLUGIN_ROOT not set, skipping hook\n');
  process.exit(0);  // 绝不阻塞主会话
}
```

**为什么 hook command 带 `--experimental-sqlite`**：v0.1 用 Node 内置 `node:sqlite`（零原生构建依赖），Node 22.x 系列下该模块需启动 flag 才能 `import`，否则 hook 进程会以 `ERR_UNKNOWN_BUILTIN_MODULE` 立即 exit 1。Node ≥ 24 该 flag 默认开启，可移除。**ccmem 安装脚本必须 detect Node 版本**：< 22.5 → 拒绝安装并提示升级；22.5 ≤ ver < 24 → 自动注入 flag；≥ 24 → 不注入。

**为什么不抄 ECC 的 5 级 fallback**:ECC 兼容老版本 Claude Code(2.0 前不注入 env)+ 6 种历史 layout,因此专门写了 50 行 `resolvePluginRoot()` 做路径探测(`reference/ECC/scripts/hooks/session-start-bootstrap.js:73-116`)。ccmem 是新项目,**强制要求 v2.1+**,packaging 才能简单。文档化最低支持版本是更干净的工程取舍。

**`!` 字符的 inline JS 坑**(参考 ECC):若 hook command 写 inline `node -e "...!..."`,部分 shell 环境会触发 bash history expansion 启动报错。ccmem 的 command 字段零 inline JS、零 `!` 字符,天然安全。详见 `reference/ECC/scripts/hooks/session-start-bootstrap.js:11-15` 注释。

### 4.4 注入文本格式

**SessionStart 注入**（来自 injection_cache.rendered_text）：

```
=== ccmem: stable context ===

[GLOBAL]
- 用户偏好简洁直接的回答风格
- 用户偏好 TypeScript 严格模式
- (pinned) 提交前必须跑 pnpm typecheck && pnpm test

[PROJECT github.com/me/myapp]
- Next.js 14 App Router + Tailwind CSS
- API 路由统一放在 /app/api/
- 部署目标 AWS cn-north-1

* Note: 这些是 ccmem 注入的项目背景,如有过时,用户会通过 /ccmem:forget 处理
```

**UserPromptSubmit 注入**：

```
=== ccmem: retrieved for current prompt ===

[m42] rule | global    用户偏好简洁直接的回答风格
[m78] fact | project   API 路由统一放在 /app/api/
[m91] rule | project   提交前必须跑 pnpm typecheck && pnpm test
```

**ID 格式 `m<integer>`**(U-2 决议):底层仍是 `INTEGER PRIMARY KEY`,渲染时加 `m` 前缀。
理由:
1. 纯数字 `[42]` 在 LLM 响应/用户 prompt 里说 "42" 可能命中任何聊天数字 → 无法用作"显式引用"信号(v0.2 L1 反馈推断会因此误归因)
2. `m` 前缀让 `/\bm\d+\b/` regex 几乎不可能误命中(类似 issue tracker 的 `PROJ-123` 心智)
3. 不引入新字段(`short_id` 列已删除),只是渲染换皮 → 与 revisions §1.3 "INTEGER PK"决议兼容
4. 命令端 `/ccmem:show m42` 与 `/ccmem:show 42` 都接受(parser 剥 `m` 前缀)

### 4.5 lib/render.mjs 实现

```javascript
// scripts/lib/render.mjs

const TYPE_ABBREV = { rule: 'rule', fact: 'fact', episode: 'epis', consolidated: 'cons' };

/**
 * 渲染 UserPromptSubmit 检索到的记忆为紧凑注入块
 */
export function renderRetrievedBlock(rows, prompt) {
  if (rows.length === 0) return '';
  const lines = ['=== ccmem: retrieved for current prompt ===', ''];
  for (const r of rows) {
    const typeStr = (TYPE_ABBREV[r.type] || r.type).padEnd(4);
    const scopeStr = r.scope === 'global' ? 'global ' : 'project';
    const pinFlag = r.pinned ? '★' : ' ';
    // U-2: m 前缀让 ID 在 LLM 响应中可被显式引用而不与聊天数字混淆
    lines.push(`[m${r.id}] ${typeStr} | ${scopeStr} ${pinFlag} ${r.content}`);
  }
  return lines.join('\n');
}
```

### 4.6 v0.1 Hook 行为白名单(N-1)

明确**每个 hook 在 v0.1 阶段做什么 / 不做什么**,防止实现时把 v0.2+ 的行为
提前漏进 v0.1。schema 里写入的 trust / recall / lineage 字段(§3.1 注释已标
`reserved, no writes`)在以下白名单里 **绝对不出现在 UPDATE 子句**;若 PR
里出现就直接 reject。

| Hook | v0.1 做 | v0.1 不做 |
|---|---|---|
| `SessionStart` | 读 `injection_cache.rendered_text`(2 行 SELECT)。**v0.1 不跑** K-1 lazy maintenance(T-5 daemon-optional 决策:Tier 2 任务 daemon 缺席时直接不做,不 lazy 降级) | **不读** trust_score;**不写** recall_count / last_touched_at / trust_summary / decay_status;**不**调 LLM;**不** spawn 子进程;**不**做任何 maintenance |
| `UserPromptSubmit` | FTS5 + Jaccard 检索(§6);renderRetrievedBlock 输出注入文本 | **不写**任何表(无 recall_count 更新、无 last_touched_at touch、无 usage 表写入) — N-2 已声明;**不**调 LLM |
| `Stop` | (v0.1 不注册) | — |
| `SessionEnd` | (v0.1 不注册) | **不**入 `pending_summarize` 队列(v0.2 才做);**不**调 LLM 总结 |

**审查 checklist**(实施时按行核对):

1. `grep -rn 'UPDATE memories' scripts/handlers/` —— v0.1 应为空(T-5 后 SessionStart 不再
   写 decay_status;UserPromptSubmit 永远不写);`pinned` UPDATE 来自 /ccmem:pin 命令路径,
   不在 hook 内;**不允许**出现 `SET trust_score`、`SET recall_count`、`SET last_touched_at`、
   `SET trust_summary`、`SET decay_status`、`SET helpful_count`、`SET unhelpful_count`。
2. `grep -rn 'spawn\|exec\|claude -p\|fetch\|http' scripts/handlers/` —— 应为空。
3. `grep -rn 'INSERT INTO tasks\|INSERT INTO task_runs' scripts/handlers/` —— v0.1 hook
   **应为空**(T-5 daemon-optional 后,K-1 lazy SQL maintenance 也移除,SessionStart 不再
   try-claim lease)。v0.2+ daemon 起来后由 daemon 写。

违反任何一条都意味着 v0.1 边界被打破,要么把改动推到 v0.2,要么把字段从
schema 注释里去掉"reserved"标记后再独立评审。

**与 design.md 的对应**:此节是 design.md §6 hook 设计在 v0.1 阶段的**严格子集
快照**,任何 design.md 后续修改 hook 行为时必须同步检查此表;新增 hook 行为如果
要落到 v0.1,必须先把字段从 reserved 名单移出。

**v0.2+ 演进注脚**(Q-1):此 hook 白名单是 **v0.1 快照**,不是永久契约。已确认的
v0.2 放开项:

| Hook | v0.2 起允许 | 理由 |
|---|---|---|
| `SessionStart` | 写 `recent_injections`(inject_source='session_start',Q-1)。**不再** try-claim `task_runs` lease — T-5 daemon-optional 决策后,所有 maintenance 走 daemon | 支撑 `/ccmem:forget --last` 跨 source 引用 |
| `UserPromptSubmit` | 写 `recent_injections`(inject_source='user_prompt_submit',J-1)与 `memories.helpful_count` / `unhelpful_count` / `last_touched_at`(L1 反馈) | 支撑反馈推断 + 自然语言引用 |
| `Stop` | 写 `pending_summarize` 队列、`memory_feedback` 表(L1/L2 反馈推断);**T-3 新增** L2.5 transcript 引用扫描 → `helpful_count++`/`+0.025 trust`(daemon-required,缺席时跳过) | v0.2 daemon 上线后才有意义;L2.5 是 trust 正反馈的主要可靠源 |
| `SessionEnd` | 写 `pending_summarize` 收尾任务 | 同上 |

新增 hook 写入许可必须**同时**:
1. 在 design.md §6 对应章节给出实现细节(写哪个表、什么时机、什么字段);
2. 在 v0.1-spec.md §4.6 此表追加一行(或在演进注脚补一行);
3. schema 注释从 `-- v0.x: reserved, no writes` 改为 `-- written by <hook> since v0.x`;
4. 更新对应版本的 grep checklist。

这是对**版本边界三重防漏(N-1)**的延伸——白名单本身也要随 spec 演进而显式
修订,不是默认禁止后任由 PR 静默打破。

---

## 五、命令（Slash + CLI 共享）

### 5.0 Flag 可用性版本门控规范(P-4)

ccmem 的命令在 v0.1 / v0.2 / v0.5+ 各阶段会逐步开放新 flag(如 `/ccmem:forget --last`
v0.2 起;`/ccmem:admin semantic on` v0.5+ 起)。**所有"当前版本未实现的 flag"必须
通过同一个 `FeatureNotAvailableError` 类报错**,不允许各命令各自硬编码错误信息——
否则用户体验割裂,且 CI/脚本无法可靠捕捉。

**统一错误格式**:

```
ccmem: --last requires ccmem >= 0.2 (currently 0.1.3)
       This flag/feature is not yet available in your version.
       Workaround: use `/ccmem:list --limit 10` to see recent saves,
                   then `/ccmem:forget <id>` to delete by id.
       Planned: 0.2.0 (see docs/ccmem-design.md §12.1.1)

Exit code: 78
```

**实现**(scripts/lib/version-gate.mjs):

```javascript
// scripts/lib/version-gate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG_PATH = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
const CURRENT_VERSION = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version;

export class FeatureNotAvailableError extends Error {
  constructor({ flag, minVersion, workaround, planned }) {
    super(`${flag} requires ccmem >= ${minVersion} (currently ${CURRENT_VERSION})`);
    this.code = 'FEATURE_NOT_AVAILABLE';
    this.flag = flag;
    this.minVersion = minVersion;
    this.workaround = workaround;
    this.planned = planned;
  }

  // R-4 修订:不直接输出 workaround/planned 字符串,改写 audit_log,stderr 只留指针
  toAuditDetails() {
    return {
      message: this.message,
      flag: this.flag,
      min_version: this.minVersion,
      current_version: CURRENT_VERSION,
      workaround: this.workaround ?? null,
      planned: this.planned ?? null,
      exit_code: 78,
    };
  }
}

// 调用点示例:requireMinVersion({ flag: '--last', minVersion: '0.2.0', ... })
export function requireMinVersion({ flag, minVersion, workaround, planned }) {
  if (semverLt(CURRENT_VERSION, minVersion)) {
    const err = new FeatureNotAvailableError({ flag, minVersion, workaround, planned });
    const auditId = writeAudit('feature_not_available', null, err.toAuditDetails());
    process.stderr.write(
      `ccmem: ${err.message}\n` +
      `       see → ccmem audit show ${auditId}\n`
    );
    process.exit(78);
  }
}

// 简易 semver 比较(v0.1 阶段不引入 semver 包)
function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}
```

### 5.0.2 命令输出原则(R-4,基于 PoC 修订)

**PoC 结论(详见 §附录 D)**:Claude Code 的 `!bash` slash command 把
**stdout 与 stderr 都注入 LLM 上下文**——这与传统 Unix pipe 直觉相反,但
Claude Code 把两个流合并展示给 LLM。原 v0.1 草稿假设的"stderr 只给终端"
**不成立**,本节是修订后的设计。

**核心原则**(R-4 修订):

1. **所有 LLM 可见的输出必须 LLM-safe**——不能携带可被模型模仿的"推断模式"
   或"指令结构",否则会产生 hallucinated rule(见 §5.2 H-3 关键约束)。
2. **冗长元解释一律写 SQLite `audit_log.details` JSON blob**,不打印到 LLM
   可见的任何流。用户想看完整元解释 → `/ccmem:audit show <id>`(§5.6.1)。
3. **stdout 输出"结果事实"** — 短句、机器可解析格式
   (`saved memory #N (scope type)`)。LLM 据此判断操作完成与否。
4. **stderr 输出"指针 + 可执行提示",硬上限两行**——所有内容必须 LLM-safe:
   不写推断细节、不写 prompt template、不写完整 trash 文件名。
5. **错误路径(exit ≠ 0)** 走 stderr 一行人类可读消息 + machine-readable exit code
   (§5.0.1)。错误描述也必须 LLM-safe(不模仿系统提示词的结构)。

**通道使用对照表**:

| 通道 | LLM 可见? | 内容硬约束 |
|---|---|---|
| **stdout** | ✅ | 操作结果事实,一行,机器格式(`<verb> memory #<id> (<scope> <type>)`) |
| **stderr** | ✅ | ≤ 2 行;LLM-safe 提示与指针(`meta logged → ccmem audit show N`、`Override with --type fact`) |
| **audit_log.details** | ❌ | 任意冗长元数据(推断层级、关键词、完整路径、format 解释、score breakdown) |
| **exit code** | LLM 隐含可见(`!bash` 的退出码会影响下一轮上下文标记) | §5.0.1 定义的语义 |

**实例对比(修订后)**:

```bash
$ /ccmem:save "用 4 空格缩进"
# stdout (LLM sees):
ccmem: saved memory #142 (project rule)
# stderr (LLM also sees — 1 行指针,LLM-safe):
ccmem: meta logged → ccmem audit show 142

# 用户想看完整元解释(只在终端执行,不在 slash command):
$ ccmem audit show 142
{
  "type_inference": {
    "result": "rule",
    "layer": "zh_sentence_initial",
    "matched_keyword": "用",
    "confidence": 0.85
  },
  "override_hint": "ccmem save \"...\" --type fact",
  "source": "user_explicit",
  "ts": 1716800000
}

$ /ccmem:forget 143
# stdout:
ccmem: forgot memory #143 (project fact)
# stderr (1 行 LLM-safe 指针,不带完整路径):
ccmem: backup saved → ccmem audit show 143 (restore command included)
```

**所有命令的输出约定**(R-4 修订):

| 命令 | stdout(结果事实) | stderr(指针 + 提示,≤ 2 行) | audit_log.details(详细元数据) |
|---|---|---|---|
| `/ccmem:save` | `saved memory #N (scope type)` | `meta logged → ccmem audit show N` | H-3 推断层 / 关键词 / override 命令 |
| `/ccmem:forget` | `forgot memory #N (scope type)` | `backup saved → ccmem audit show N (restore command included)` | trash 完整路径 / restore shell snippet |
| `/ccmem:pin` | `pinned memory #N` | (无) | (无 — 操作无元数据) |
| `/ccmem:pin --remove` | `unpinned memory #N` | (无) | (无) |
| `/ccmem:mode shadow` | `mode set to shadow` | `Hooks run but injections stay empty.` | mode 切换前后值 |
| `/ccmem:list` | 表格(用户主动查询,允许富格式) | (无) | (无 — 只读命令) |
| `/ccmem:show <id>` | 单条 detail(用户主动查询) | (无) | (无) |
| `/ccmem:show --last all` | compact 列表(Q-5) | `(use /ccmem:show <id> for full detail)` | (无) |
| `/ccmem:list <query>` | 检索结果 + 可选 score breakdown(C-6) | (无) | (无 — 只读命令) |
| `/ccmem:audit show <id>` | audit_log.details JSON pretty-print | (无) | (无 — 自己就是元数据查询) |

**为什么把元数据移到 audit_log 而不是哨兵字符串**:

| 方案 | 优点 | 劣势 | 结论 |
|---|---|---|---|
| A. stderr 加 `<!--terminal-only-->` 哨兵让 LLM 忽略 | 保留原分流意图 | 依赖 LLM 服从指令;不同模型/版本行为漂移;HTML 注释仍占 token 预算 | 否决 |
| B. **元数据写 audit_log + stderr 一行指针** | LLM 看到的永远是"中性事实",彻底消除推断模式泄露;SQLite 查询有索引可追溯;不占用 LLM token 预算 | 用户多敲一条 `audit show N` 才看得到全文 | **采纳** |
| C. stderr 全部改写为 LLM-safe 中性措辞 | 实现最简单 | 牺牲元解释丰富度;后续添加任何"为什么"提示都得重写 | 否决 |
| D. `--verbose` flag 才输出元数据 | 默认零污染 | 仍有"默认 vs verbose"两条代码路径;verbose 时仍走 LLM 可见的 stdout/stderr | 否决 |

**LLM-safe 措辞规则**(stderr/stdout 撰写时务必遵守):

- ❌ 不写`type auto-inferred from keyword "X" via Y_layer`(模型会模仿推断模板)
- ❌ 不写完整 shell 命令模板带占位符(模型会以为是工作流脚本)
- ❌ 不写"如果发生 X 那么 Y"(模型会以为是用户偏好规则)
- ✅ 写`meta logged → ccmem audit show 142`(中性指针)
- ✅ 写`Override with --type fact`(单一命令片段,无模板,无变量插值结构)
- ✅ 写`mode set to shadow`(陈述事实)

**实现约束**:

- 任何"为什么这么做"的元解释必须用 helper `writeAudit(action, mem_id, details)`
  写入 `audit_log`,**禁止** `process.stderr.write` 元解释字符串。
- stderr 行数 > 2 在单元测试里 fail(`assert.ok(stderrLines.length <= 2)`)。
- code review checklist 加一条:"stderr 是否 ≤ 2 行?stderr/stdout 文本是否含
  '推断模板' 或 '可执行脚本模板'(LLM 可能模仿)?元解释是否走 audit_log?"
- 单元测试用 `exec` 捕获 stdout / stderr 两个流,并断言两流加起来不超过约定字数
  (默认 stdout ≤ 200 字符,stderr ≤ 200 字符,以控制 LLM token 预算)。

### 5.0.1 Exit code 约定(P-4)

ccmem 所有 CLI / Slash 命令通过 stdout 之外的渠道(exit code)表达机器可读的
失败类别。脚本与 CI 可据此分流处理(例如 v0.x 不可用的 flag 不必视为 hard
failure,exit 78 静默 skip)。

| Exit code | 含义 | 例子 |
|---|---|---|
| 0 | 成功 | `/ccmem:save "x"` 写入成功 |
| 1 | 通用错误(DB 不可用 / IO 错误) | SQLite locked > 5s busy_timeout |
| 2 | 参数类型/格式错误 | `/ccmem:show abc`(id 不是数字) |
| 64 | 命令使用错误(缺必填参数 / 必填 flag 缺失) | `/ccmem:save`(content 缺失);`/ccmem:save "..."` 在非 git 目录下未带 `--scope`(U-9) |
| 70 | 内部一致性错误 | trash file 写失败、injection_cache 校验失败 |
| 78 | feature/flag 不可用(版本/配置门控) | `/ccmem:forget --last` on v0.1.x |

**约定原则**:
- exit 78 **不写 audit_log**(用户错误而非系统错误,日志噪音)
- exit 70 **必须**写 audit_log(内部一致性问题,需要 dev review)
- exit 1 走 `withHookSafety` 的兜底路径,sliently degrade 不阻塞 hook
- 新增命令 / flag 时,实施 PR 必须在描述里说明用到了哪些 exit code

### 5.1 命令矩阵(C-6 合并 list / search)

| Slash | CLI | 共享实现 |
|---|---|---|
| `/ccmem:list [<query>] [--type X] [--scope Y] [--limit N] [--score]` | `ccmem list [<query>] [...] [--json]` | `lib/cmd/list.mjs` |
| `/ccmem:show <id>` | `ccmem show <id> [--json]` | `lib/cmd/show.mjs` |
| `/ccmem:save "<content>"` | `ccmem save "<content>"` | `lib/cmd/save.mjs` |
| `/ccmem:forget <id>` | `ccmem forget <id>` | `lib/cmd/forget.mjs` |
| `/ccmem:pin <id> [--remove]` | `ccmem pin <id> [--remove]` | `lib/cmd/pin.mjs` |
| `/ccmem:mode [active\|shadow\|off]` | `ccmem mode [...]` | `lib/cmd/mode.mjs` |
| `/ccmem:audit show <id>` | `ccmem audit show <id> [--json]` | `lib/cmd/audit.mjs` |

**C-6 决议(2026-05-28)**:原 `/ccmem:search` 已合入 `/ccmem:list`——
`list` 接受可选位置参数 `<query>`:

- 不带 query:走原本的枚举(`last_touched_at DESC + pinned 优先`)
- 带 query:走 FTS5 trigram + LIKE fallback + Jaccard 融合检索(§6),按 BM25 排序
- `--score` flag(仅 query 模式有效):输出 BM25 / Jaccard / fused score breakdown,
  用于 debug "为什么我那条记忆没被注入"
- `--type` / `--scope` 与 query 正交,可叠加过滤

实现层只有 `lib/cmd/list.mjs`,不再有 `lib/cmd/search.mjs`。
**只读、不更新 trust/usage**(N-2)。

**Slash 与 CLI 的差异**：
- Slash 默认人类可读输出（表格 / 段落）
- CLI 默认人类可读，加 `--json` 输出 JSON
- Slash 不支持 `--json`（输出会污染 LLM 上下文，无意义）

**人机交互约束**(Claude Code AskUserQuestion 硬上限 4 个选项):

- v0.1 所有命令**不通过 LLM AskUserQuestion 收集用户输入**。需要确认或多选时,改走 stdin(`y/N`)、子命令(`/ccmem:mode active|shadow|off`)、或 verbatim 短词(留给 v0.2+ 的 L3 销毁类命令)。
- 命令的输入永远是命令行参数,不是 LLM 多轮对话。这避免了"用户提交 prompt → LLM 生成 AskUserQuestion → 用户再选项" 这种多 round-trip 的尴尬流程,也不会撞 4 选项硬上限。
- 若未来 v0.2+ 引入需要"列出 N 条候选让用户挑"的命令,必须先在 stderr 打印编号列表,再让用户用 stdin 输入编号(如 `选择要 promote 的记忆 [1-7]:`),不走 AskUserQuestion。

### 5.2 `/ccmem:save` 详细规范

**输入**：用户提供一段文本，最长 300 字符（config.save.max_chars_per_memory）。

**自动判定**：
- `scope`：v0.1 默认 `project`(git 项目内),由用户加 `--global` 改为 `global`。
  - **U-9:非 git 目录强制要求 `--scope`**:当 `resolveProjectKey()` 返回 `path:` 前缀时(即非 git 项目),**`/ccmem:save` 不再自动 default scope**,而是 reject 并要求用户显式指定。
    - 旧设计("默认改为 global")被 U-9 否决。理由:非 git 目录 + H-3 推断为 rule + `user_explicit` trust=0.9 三个 default 叠加 → "在 /tmp/scratch/ 随手 `/ccmem:save '必须用 4 空格'`" 会污染所有项目的全局 rule。
    - reject 强制用户停 5 秒思考"我要存到当前临时目录(`--scope project`,path-hash key 几乎没人重访),还是真要存到全局(`--scope global`)"。
    - exit code 64(EX_USAGE),实现见 §5.0.1。
- `type`：用户可加 `--type rule|fact|episode` 显式指定。**H-1 白名单**:`--type consolidated` 一律拒绝并报错(`consolidated` 是 v0.2 cron `weekly_synthesis` 的产物,有严格 source citation / 抽象度约束;用户手填会污染 lineage chain 并误得最高 base_priority,即便 v0.1 schema 预留了 `consolidated` 也只允许"读不允许写")。
  - **H-3 默认 type 推断**:未显式指定时,先跑关键词启发式(规则词 → `rule`,否则 fallback `fact`)。**episode 不自动判定**(需要用户显式 `--type episode`,因为情景化记忆通常只对当下会话有意义,误判会导致 base_priority 偏低、半衰期偏短)。详见下方"H-3 类型推断"小节。
- `source`：始终 `user_explicit`。

**H-3 类型推断**(纯字符串扫描,零 LLM 依赖,三层匹配防中文单字误判):

```javascript
// scripts/lib/type-heuristic.mjs
//
// 三层匹配设计(P-5):
//   Layer 1 — EN 多词短语(最高优先级):'must use' / 'always use'
//   Layer 2 — ZH 多字短语:'必须' / '一律用' / '统一' 等(几乎不误判)
//   Layer 3 — EN 单词(带词尾空格做 word boundary):'use ' / 'must '
//   Layer 4 — ZH 句首单字/双字(正则锚定标点或起始位置):
//             仅在"。;!?\n,、:"之后或字符串起始才认为是"用 X 做 Y"的 rule
//             用以避免 "项目使用 / 用户数 / 费用" 等复合词误命中

const RULE_TRIGGERS_ZH_PHRASES = [
  // 多字明确指令(几乎不误判)
  '必须', '务必', '严禁', '禁止', '不要', '不准', '一律', '请勿',
  '总是', '永远', '从不', '优先', '避免', '应当', '需要', '推荐',
  '强制', '硬性', '默认', '统一',
  // 2-3 字组合(精度高于单字)
  '必须用', '一律用', '统一用', '优先用', '永远用', '只用', '请用',
  '不要用', '不准用', '禁止用', '避免用',
];

const RULE_TRIGGERS_ZH_SENTENCE_INITIAL = [
  // 仅在"句首/标点后"匹配的单字/双字 — 防 "使用/作用/费用" 误判
  '用', '使用', '调用',
];

const RULE_TRIGGERS_EN = [
  // word boundary 由 trigger 字符串末尾的空格保证
  'must ', 'always ', 'never ', 'should ', 'shall ',
  'use ', 'prefer ', 'avoid ', "don't ", 'do not ', 'forbid',
];

const RULE_TRIGGERS_EN_PHRASES = [
  'must use', 'always use', 'never use', 'prefer to use',
];

export function inferType(content) {
  const lower = content.toLowerCase();

  // 1. EN 多词短语(最高优先级,精度最高)
  for (const trigger of RULE_TRIGGERS_EN_PHRASES) {
    if (lower.includes(trigger))
      return { type: 'rule', triggered_by: trigger, layer: 'en_phrase' };
  }

  // 2. ZH 多字短语
  for (const trigger of RULE_TRIGGERS_ZH_PHRASES) {
    if (content.includes(trigger))
      return { type: 'rule', triggered_by: trigger, layer: 'zh_phrase' };
  }

  // 3. EN 单词(带 word boundary)
  for (const trigger of RULE_TRIGGERS_EN) {
    if (lower.includes(trigger))
      return { type: 'rule', triggered_by: trigger.trim(), layer: 'en_word' };
  }

  // 4. ZH 句首单字/双字(正则锚定标点或起始位置)
  const sentenceStartZh = new RegExp(
    `(?:^|[。;!?\\n,、:])\\s*(${RULE_TRIGGERS_ZH_SENTENCE_INITIAL.join('|')})(?=\\s|[\\u4e00-\\u9fa5])`,
  );
  const m = sentenceStartZh.exec(content);
  if (m) return { type: 'rule', triggered_by: m[1], layer: 'zh_sentence_initial' };

  return { type: 'fact', triggered_by: null, layer: null };
}
```

**新行为示例**(P-5 关键回归):

| 输入 | 旧推断 | 新推断 | 原因 |
|---|---|---|---|
| "用 4 空格缩进" | rule(命中 `'用'`) | rule(zh_sentence_initial) | 句首"用" |
| "项目使用 Vite 5.2" | rule(误命中 `'用'`) | **fact** | 句首是"项",不命中 |
| "用户数 5000" | rule(误命中 `'用'`) | **fact** | "用户"不在短语表 |
| "费用核算 ¥3000" | rule(误命中 `'用'`) | **fact** | 同上 |
| "必须用 TypeScript" | rule(`'必须'`) | rule(zh_phrase `'必须用'`) | 命中更精确 |
| "提交前必须跑测试" | rule(`'必须'`) | rule(zh_phrase `'必须'`) | 命中 |
| "API 路由统一放在 /app/api/" | fact | rule(zh_phrase `'统一'`) | 确实是 rule 性质 |
| "Next.js 14 + Tailwind" | fact | fact | 无触发 |

**Unit test 必加**(test/type-heuristic.test.mjs):

```javascript
import { inferType } from '../scripts/lib/type-heuristic.mjs';
import assert from 'node:assert';

const cases = [
  ['用 4 空格缩进', 'rule', 'zh_sentence_initial'],
  ['项目使用 Vite 5.2', 'fact', null],            // 回归 P-5
  ['用户数 5000', 'fact', null],                   // 回归 P-5
  ['费用核算 ¥3000', 'fact', null],                // 回归 P-5
  ['通用配置在 .env', 'fact', null],               // 回归 P-5
  ['必须用 TypeScript', 'rule', 'zh_phrase'],
  ['一律用 pnpm 替代 npm', 'rule', 'zh_phrase'],
  ['统一放在 /app/api/', 'rule', 'zh_phrase'],
  ['Always use TypeScript strict mode', 'rule', 'en_phrase'],
  ['Avoid mocking database', 'rule', 'en_word'],
  ['Next.js 14 + Tailwind', 'fact', null],
];

for (const [content, expectedType, expectedLayer] of cases) {
  const result = inferType(content);
  assert.equal(result.type, expectedType, `type mismatch for "${content}"`);
  if (expectedLayer)
    assert.equal(result.layer, expectedLayer, `layer mismatch for "${content}"`);
}
```

输出示例(R-4 修订;详见 §5.0.2):

```
$ /ccmem:save "用 4 空格缩进"
# stdout (LLM sees):
ccmem: saved memory #142 (project rule)
# stderr (LLM also sees — LLM-safe 指针 + override 提示):
ccmem: meta logged → ccmem audit show 142
       Override with --type fact

$ /ccmem:save "项目使用 Vite 5.2"
# stdout:
ccmem: saved memory #143 (project fact)
# stderr:
ccmem: meta logged → ccmem audit show 143
       Override with --type rule

$ /ccmem:save "必须用 TypeScript 严格模式"
# stdout:
ccmem: saved memory #144 (project rule)
# stderr:
ccmem: meta logged → ccmem audit show 144
       Override with --type fact

# 用户主动查看完整推断细节(只在终端,不在 slash command):
$ ccmem audit show 142
{
  "type_inference": {
    "result": "rule",
    "matched_keyword": "用",
    "layer": "zh_sentence_initial",
    "confidence": 0.85
  },
  "source": "user_explicit",
  "scope": "project",
  "ts": 1716800000
}
```

**关键约束(R-4 修订)**:H-3 推断的**层级名 / 关键词 / 置信度**等"推断模板"
信息**必须**写入 `audit_log.details` JSON blob,**禁止**出现在 stdout/stderr
任一可被 LLM 看到的输出里。原因:Claude Code 的 `!bash` 把两个流都注入 LLM 上下文
(§附录 D PoC 证实),若 LLM 反复看到"auto-inferred from keyword X via Y layer"
这种推断模板,会在后续 prompt 里模仿产生 hallucinated rule。stderr 只保留
两类内容:**中性指针**(`meta logged → ccmem audit show 142`)与**单一可执行
override 片段**(`Override with --type fact`)。详见 §5.0.2 LLM-safe 措辞规则。

**U-9 非 git 目录强制 `--scope` 实现**:

```javascript
// scripts/lib/cmd/save.mjs 入口前置检查
import { resolveProjectKey } from '../project-key.mjs';

export async function cmdSave({ content, scope, type, tags, cwd }) {
  const projectKey = resolveProjectKey(cwd);
  const isNonGit = projectKey.startsWith('path:');

  if (isNonGit && !scope) {
    // R-4 修订:stderr 也进 LLM 上下文,这里 ≤ 2 行 LLM-safe 错误 + 完整解释走 audit_log
    const auditId = writeAudit('save_rejected_non_git', null, {
      reason: 'non_git_directory_requires_explicit_scope',
      cwd,
      options: {
        global: 'save user-wide preferences (visible in every session)',
        project: 'save here (path-hash key, isolated to this dir)',
      },
    });
    process.stderr.write(
      `ccmem: --scope required in non-git directory\n` +
      `       see → ccmem audit show ${auditId}\n`
    );
    process.exit(64);  // EX_USAGE
  }

  // git 目录:scope 缺省 → 'project'(原行为不变)
  const finalScope = scope ?? 'project';
  // ... 原有 Tier 1 闸门 / type 推断 / INSERT 流程 ...
}
```

**git 目录行为不变**:`scope` 缺省默认 `project`,H-3 推断 rule/fact,trust 0.9 — 都是原 default。
U-9 只在 `path:` 前缀(非 git)时触发,git 项目下用户体验零变化。

**示例**:

```
$ cd /tmp/scratch
$ /ccmem:save "用 4 空格缩进"
# stdout: (empty)
# stderr (LLM-safe,≤ 2 行;完整原因走 audit_log):
ccmem: --scope required in non-git directory
       see → ccmem audit show 87
# exit code: 64

# 用户在终端追看完整解释:
$ ccmem audit show 87
{
  "action": "save_rejected_non_git",
  "reason": "non_git_directory_requires_explicit_scope",
  "cwd": "/tmp/scratch",
  "options": {
    "global": "save user-wide preferences (visible in every session)",
    "project": "save here (path-hash key, isolated to this dir)"
  }
}

$ /ccmem:save "用 4 空格缩进" --scope global
# stdout:
ccmem: saved memory #m145 (global rule)
# stderr:
ccmem: meta logged → ccmem audit show 88
       Override with --type fact
# exit code: 0
```

**为什么不是 warning 而是 hard reject**:
- warning + auto-default 仍然产生污染,只是用户事后发现 — pinned 在 trust=0.9 的全局 rule 难以靠"事后觉察"清理
- reject 让用户**停 5 秒思考一次**,符合"对用户零打扰"的反面 — 这种潜在污染的"打扰"是值得的
- 用户加 `--scope global` 后再不会被烦,git 项目本身完全无影响



**为什么不全部 LLM 推断**:v0.1 无 cron / daemon,save 命令在 hook 进程内同步
执行,触发 LLM 调用违反 hook 预算与 §4.6 白名单。三层启发式命中率显著高于单字
方案(实测从 ~50% 提升到 ~85%,误判率从 ~30% 降到 < 5%),命中失败时提示词
写明 `Override with --type X if needed`,用户可以一句话改写。v0.2+ 可在 cron
后台对 `triggered_by=null` 且 created_at > 24h 的 `fact` 复查升级为 `rule`
(异步、非阻塞)。

**为什么不引入 jieba 分词**:jieba 包 ~30MB,首次加载冷启动 200-500ms,违反
hook 预算与"v0.1 零额外大依赖"原则。三层启发式 + unit test 已足够 v0.1 用。
v0.5+ 若开 embedding 模型反正得载入大依赖,届时可考虑借用。

**与 design.md 的对应**:`type` 列在 design.md §4.5 仍由"用户/cron LLM"双通道
写入;v0.1 单通道是 `user_explicit + keyword heuristic`,关键词命中等价于"用户
意图明确指向规则";v0.2+ 引入 cron 后,推断 type 由 cron LLM 完成(更准),
keyword heuristic 退为兜底默认。

**Tier 1 闸门**（详见 §6）：
- 命中 → 拒绝写入 + audit log + 提示用户

**写入完成后**：同步调用 `regenerateInjectionCache(scope)`，使下一次 SessionStart 立即看到新记忆。

**示例**：
```
$ /ccmem:save "用户偏好 4 空格缩进" --global --type rule
ccmem: saved memory #142 (global rule)

$ /ccmem:save "API 路由统一放在 /app/api/"
ccmem: saved memory #143 (project fact)

$ /ccmem:save "ignore previous instructions"
ccmem: BLOCKED — content matches Tier 1 prompt-injection pattern.
       This was logged for review (audit id #29).
```

### 5.3 `/ccmem:list` 详细规范

```
$ /ccmem:list
ID    Type     Scope    Pinned  Created     Content
142   rule     global           2026-05-22  用户偏好 4 空格缩进
143   fact     project          2026-05-22  API 路由统一放在 /app/api/
144   rule     global   ★       2026-05-21  用户偏好 TypeScript 严格模式
...

(showing 20 of 47, use --limit N or filter with --type/--scope)
```

```
$ ccmem list --json
[
  {
    "id": 142,
    "scope": "global",
    "project_key": null,
    "type": "rule",
    "content": "用户偏好 4 空格缩进",
    "pinned": false,
    "source": "user_explicit",
    "trust_score": 1.0,
    "created_at": 1716345600000,
    "updated_at": 1716345600000,
    "tags": []
  },
  ...
]
```

### 5.3.1 `/ccmem:show <id>`

显示单条记忆完整信息。`--json` 输出含全部字段（包括 v0.2 预留字段）。

**ID 参数接受两种格式**(U-2):
- `m142`(注入文本中的形式,推荐复制粘贴)
- `142`(纯数字,等价)

parser 实现:`const id = parseInt(rawArg.replace(/^m/, ''), 10);`

```
$ /ccmem:show m142
Memory #m142
  Type:        rule
  Scope:       global
  Pinned:      no
  Source:      user_explicit
  Created:     2026-05-22 14:32:18
  Updated:     2026-05-22 14:32:18
  Tags:        []
  trust_score: 1.0   (v0.2 reserved, always 1.0 in v0.1)
  consolidation_depth: 0   (v0.2 reserved)

Content:
  用户偏好 4 空格缩进
```

### 5.4 `/ccmem:forget`

```
$ /ccmem:forget 143
# stdout (LLM sees):
ccmem: forgot memory #143 (project fact)
# stderr (LLM-safe 1 行指针;完整 trash 路径与 restore 命令走 audit_log):
ccmem: backup saved → ccmem audit show 89 (restore command included)

# 用户在终端追看 backup 路径与 restore 命令:
$ ccmem audit show 89
{
  "action": "forget",
  "mem_id": 143,
  "scope": "project",
  "type": "fact",
  "trash_path": "~/.claude/ccmem/trash/143.md",
  "restore_command": "ccmem save \"$(sed -n '7,$p' ~/.claude/ccmem/trash/143.md)\""
}
```

**实现**：DELETE 之前先把记忆完整内容写到 `~/.claude/ccmem/trash/<id>.md`,
然后从 DB 中删除,**再**用 `writeAudit('forget', mem_id, { trash_path, restore_command })`
落入 audit_log。**v0.1 不提供 `/ccmem:undo` 命令**,用户从 audit_log 取出 restore
命令在终端执行,或手动从 trash/ 文件复制后用 `ccmem save` 重写。

**R-4 关键**:stderr 不能直接打印 restore 命令模板(含 `sed -n`、`$(...)` 等 shell 结构),
LLM 可能模仿这种"运行 shell substitution 复原数据"的模式产生 hallucinated 工作流。
完整 restore shell 命令必须只在 `audit_log.details` JSON 里,用户主动 `ccmem audit show`
才看得到。

trash 文件格式：

```markdown
# Forgotten memory 143
Forgotten at: 2026-05-23T14:32:18.842Z
Type: fact
Scope: project (git:github.com/me/myapp)
Source: user_explicit
Original created_at: 2026-05-15T09:11:04.123Z
Tags: []

API 路由统一放在 /app/api/
```

trash/ 不自动清理（用户可定期 `rm -rf ~/.claude/ccmem/trash/` 整体清空）。

**v0.1 不做级联**（也无 lineage — v0.2 lineage 用 `memories.parent_ids` JSON 直接表达,不建独立表,详见 design.md §4.2.1）。

**v0.1 不支持 `--last` / `--match` flag**(J-1 在 v0.2 实现)。误用时通过 §5.0
`requireMinVersion()` 抛 `FeatureNotAvailableError`,exit 78,format:

```
ccmem: --last requires ccmem >= 0.2 (currently 0.1.x)
       This flag/feature is not yet available in your version.
       Workaround: use `/ccmem:list --limit 10` to see recent saves,
                   then `/ccmem:forget <id>` to delete by id.
       Planned: 0.2.0 (see docs/ccmem-design.md §12.1.1)

Exit code: 78
```

实现:
```javascript
// scripts/lib/cmd/forget.mjs 顶部
import { requireMinVersion } from '../version-gate.mjs';

export async function cmdForget(args) {
  if (args.last !== undefined) {
    requireMinVersion({
      flag: '--last',
      minVersion: '0.2.0',
      workaround: 'use `/ccmem:list --limit 10`, then `/ccmem:forget <id>`',
      planned: '0.2.0 (see docs/ccmem-design.md §12.1.1)',
    });
  }
  if (args.match !== undefined) {
    requireMinVersion({
      flag: '--match',
      minVersion: '0.2.0',
      workaround: 'use `/ccmem:list`, grep manually, then `/ccmem:forget <id>`',
      planned: '0.2.0',
    });
  }
  // ... 原有 cmdForget(id) 逻辑
}
```

**确认分档**(对齐 ccmem-design.md §16.4):v0.1 `/ccmem:forget` 走 **L0 直接执行**(无 y/N 提示)。理由:trash 备份是完全可逆的(用户可直接 `ccmem save` 回灌内容),不需要打断终端体验。design.md 中把 forget 列为 L1 是面向 v0.2+ —— 那时引入 `/ccmem:purge`、`/ccmem:promote-global`、级联删除等更高风险操作,届时 forget 才需要 y/N 与之拉齐分档,**不会回头改 v0.1 的行为**。

**实现示例**：

```javascript
// scripts/lib/cmd/forget.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db.mjs';
import { getDataRoot } from '../config.mjs';
import { regenerateInjectionCache } from '../injection-cache.mjs';
import { logAudit } from '../audit.mjs';

export async function cmdForget(id) {
  const db = openDb();
  const mem = await db.get(`SELECT * FROM memories WHERE id = ?`, [id]);
  if (!mem) throw new Error(`Memory ${id} not found`);

  // 1. 写 trash 文件(ECC-R3: atomic write — tmp+rename 防止进程中断导致半写文件)
  const trashDir = path.join(getDataRoot(), 'trash');
  await fs.promises.mkdir(trashDir, { recursive: true });
  const trashPath = path.join(trashDir, `${id}.md`);
  const trashContent = [
    `# Forgotten memory ${id}`,
    `Forgotten at: ${new Date().toISOString()}`,
    `Type: ${mem.type}`,
    `Scope: ${mem.scope}${mem.project_key ? ` (${mem.project_key})` : ''}`,
    `Source: ${mem.source}`,
    `Tags: ${mem.tags || '[]'}`,
    ``,
    mem.content,
  ].join('\n');
  const tmpPath = `${trashPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, trashContent);
  await fs.promises.rename(tmpPath, trashPath);

  // 2. 删除 DB 行(FTS5 触发器自动同步索引)
  await db.run(`DELETE FROM memories WHERE id = ?`, [id]);

  // 3. 重生 injection_cache
  const cacheScope = mem.scope === 'global' ? 'global' : `project:${mem.project_key}`;
  await regenerateInjectionCache(cacheScope);

  // 4. Audit
  await logAudit({
    action: 'forget',
    affected_ids: [id],
    details: { trashed_to: trashPath, content_excerpt: mem.content.slice(0, 80) },
  });

  return { id, trashPath };
}
```

### 5.5 `/ccmem:pin`

```
$ /ccmem:pin m142
ccmem: pinned memory #m142

$ /ccmem:pin m142 --remove
ccmem: unpinned memory #m142
```

ID 参数接受 `m142` 或 `142` 两种形式(U-2 一致)。

约束：每 scope 最多 20 条 pinned（避免占满注入预算）。

**pin 不影响 trust_score**(U-5):pin 是"注入保证"独立轴,与 trust 正交。
v0.1 无 trust 系统(全部 trust=1.0),pin 仅 set memories.pinned=1。
v0.2+ pin 仍只动 pinned 列,不再像旧设计中 trust→0.95。

### 5.6 `/ccmem:mode`

```
$ /ccmem:mode
Mode: active (set 3h ago)
  reads & writes — full memory system (default)

$ /ccmem:mode shadow
ccmem: mode set to shadow
  read-only diagnostic — retrieves but never writes (no inject, no recent_injections,
  no audit non-error, no trust adjustment). metrics.jsonl still written for diagnosis.

$ /ccmem:mode off
ccmem: mode set to off
  completely disabled — hooks early-exit, no reads, no writes
  Run /ccmem:mode active to re-enable.
```

**U-6 三档清晰边界**:

| 维度 | active | shadow | off |
|---|---|---|---|
| FTS5 检索 / injection_cache 读 | ✅ | ✅ | ❌ early-exit |
| additionalContext 输出 | ✅ | ❌ | ❌ |
| recent_injections 写入(v0.2+) | ✅ | ❌ | ❌ |
| audit_log 写入(error 除外) | ✅ | ❌ | ❌ |
| metrics.jsonl(诊断) | ✅ | ✅ | ✅ |
| L1/L2/L2.5/L4 反馈推断(v0.2+) | ✅ | ❌ | ❌ |

mode 存在 `config_kv` 表，key=`mode`，value=`active|shadow|off`。

### 5.6.1 `/ccmem:audit show <id>`(R-4 修订引入)

**用途**:展示 `audit_log` 中某条记录的完整 `details` JSON。slash command 与
CLI 共用同一实现,**纯只读**。这是 §5.0.2 "元数据走 audit_log + stderr 只留
指针" 设计的查询端——用户在终端从 stderr 看到 `see → ccmem audit show N` 后,
通过这条命令查完整元数据(H-3 推断细节、trash 路径、restore 命令、feature gate
信息等)。

**实现**:

```javascript
// scripts/lib/cmd/audit.mjs
import { openDb } from '../db.mjs';

export async function cmdAuditShow({ id, json }) {
  const db = openDb();
  const row = db
    .prepare(`SELECT id, ts, action, details FROM audit_log WHERE id = ?`)
    .get(Number(id));

  if (!row) {
    process.stderr.write(`ccmem: audit #${id} not found\n`);
    process.exit(2);
  }

  const details = row.details ? JSON.parse(row.details) : {};
  const payload = {
    id: row.id,
    ts: new Date(row.ts * 1000).toISOString(),
    action: row.action,
    ...details,
  };

  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    // 人类可读 pretty-print(slash command 与 CLI default)
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}
```

**输出示例**:

```
$ /ccmem:audit show 142
{
  "id": 142,
  "ts": "2026-05-27T08:13:32.000Z",
  "action": "save",
  "type_inference": {
    "result": "rule",
    "matched_keyword": "用",
    "layer": "zh_sentence_initial",
    "confidence": 0.85
  },
  "scope": "project",
  "source": "user_explicit"
}
```

**关键约束**:`/ccmem:audit show` 自己的输出**也**会进入 LLM 上下文(slash command
通道一致)。但其内容是用户**主动**查询的元数据,LLM 看到无害(类比 `/ccmem:show`
查记忆 detail)。**不在** §5.0.2 LLM-safe 措辞硬约束范围内——这里 JSON 输出
含 `matched_keyword`、`layer` 等推断模板信息是 OK 的,因为用户已经主动触发了
查询,LLM 不会"误以为"那是给它的指令。

### 5.6.2 `writeAudit()` helper 规范

**所有把元解释写入 audit_log 的代码路径必须用 `writeAudit` helper**,
**禁止**裸 `INSERT INTO audit_log`(防止字段漏填、防止 affected_ids
与 audit_log_targets 不同步)。

```javascript
// scripts/lib/audit.mjs
import { openDb } from './db.mjs';

/**
 * 把一次操作的元数据写入 audit_log,并同步 audit_log_targets。
 * 返回 audit_log.id(供 stderr 指针使用)。
 *
 * @param {string}        action      'save' | 'forget' | 'pin' | 'mode_change' |
 *                                    'save_rejected_non_git' | 'feature_not_available' | ...
 * @param {number|null}   mem_id      受影响的 memory id;无则 null(如 mode 切换、reject)
 * @param {object}        details     任意 JSON-serializable 元数据 blob
 * @returns {number}                  写入的 audit_log.id
 */
export function writeAudit(action, mem_id, details) {
  const db = openDb();
  const ts = Math.floor(Date.now() / 1000);
  const affectedIds = mem_id == null ? null : JSON.stringify([mem_id]);
  const result = db
    .prepare(
      `INSERT INTO audit_log (ts, action, affected_ids, details)
       VALUES (?, ?, ?, ?)`
    )
    .run(ts, action, affectedIds, JSON.stringify(details));
  const audit_id = result.lastInsertRowid;

  if (mem_id != null) {
    db.prepare(
      `INSERT INTO audit_log_targets (audit_id, mem_id) VALUES (?, ?)`
    ).run(audit_id, mem_id);
  }
  return Number(audit_id);
}
```

**调用约定**:

| 命令 | action | mem_id | details 关键字段 |
|---|---|---|---|
| `/ccmem:save` | `save` | 新写 id | `type_inference`(layer/keyword/confidence)、`scope`、`source` |
| `/ccmem:save` 拒绝 | `save_rejected_non_git` | null | `reason`、`cwd`、`options`(global/project 解释) |
| `/ccmem:forget` | `forget` | 删除 id | `scope`、`type`、`trash_path`、`restore_command` |
| `/ccmem:pin` | `pin` / `unpin` | 操作 id | (空,无需元数据;**可选**写入仅是为了 pin/unpin 时间线追溯) |
| `/ccmem:mode` | `mode_change` | null | `from`、`to` |
| feature gate 拒绝 | `feature_not_available` | null | `flag`、`min_version`、`current_version`、`workaround`、`planned` |
| migration 失败 | (**不**走 audit_log,DB 可能不可用,改落地到 `migration-fail-*.log` 文件,见 §schema migration) | — | — |

**幂等性**:`writeAudit` 是普通 INSERT,失败回退由调用方处理(hook 路径走
`withHookSafety`;slash command 路径走 try/catch)。**audit_log 写失败不阻塞
主操作完成**——已经 `INSERT INTO memories` 成功的 `/ccmem:save` 不能因为
audit_log 写失败而 rollback,否则用户记忆丢失。这条原则在调用模板:

```javascript
const memId = db.prepare(`INSERT INTO memories ...`).run(...).lastInsertRowid;
let auditId = null;
try {
  auditId = writeAudit('save', Number(memId), { type_inference, scope, source });
} catch (e) {
  // audit 写失败,记忆已经保存,只是没有元数据指针 — stderr 用 "(audit unavailable)" 兜底
}
process.stdout.write(`ccmem: saved memory #${memId} (${scope} ${type})\n`);
process.stderr.write(
  auditId != null
    ? `ccmem: meta logged → ccmem audit show ${auditId}\n       Override with --type ${altType}\n`
    : `ccmem: (audit unavailable)\n       Override with --type ${altType}\n`
);
```

### 5.7 文件结构

`<plugin-root>/` 是 plugin 部署位置的占位(实际路径见 §4.3 V-1 + §11.0)。

```
<plugin-root>/                         # 路径由 Claude Code 决定;代码侧走 ${CLAUDE_PLUGIN_ROOT}
├── .claude-plugin/
│   └── plugin.json                    # V-2 manifest(见 §11.0)
├── package.json
├── config.default.json
├── bin/
│   └── ccmem                          # #!/usr/bin/env -S node --experimental-sqlite CLI 入口
├── scripts/
│   ├── hook.mjs                       # Hook 单入口分发
│   ├── handlers/
│   │   ├── session-start.mjs
│   │   └── prompt-submit.mjs
│   ├── lib/
│   │   ├── db.mjs                     # SQLite 打开、迁移
│   │   ├── hook-safety.mjs            # withHookSafety + Promise.race
│   │   ├── project-key.mjs            # 简化版 git remote 解析
│   │   ├── config.mjs                 # 单层 config + env override
│   │   ├── mode.mjs                   # active/shadow/off
│   │   ├── threat-scan.mjs            # Tier 1 + secret patterns + 运行时硬超时(B3=C)
│   │   ├── pattern-safety.mjs         # isPatternSafe 加载时 fuzz test(B3=C)
│   │   ├── injection-cache.mjs        # 重生 cache 的同步函数
│   │   ├── render.mjs                 # 注入文本渲染
│   │   ├── metrics.mjs                # JSONL append
│   │   ├── audit.mjs                  # writeAudit helper(§5.6.2)
│   │   └── cmd/
│   │       ├── list.mjs
│   │       ├── show.mjs
│   │       ├── save.mjs
│   │       ├── forget.mjs
│   │       ├── pin.mjs
│   │       ├── mode.mjs
│   │       └── audit.mjs              # /ccmem:audit show <id>(§5.6.1)
│   └── migrations/
│       └── 001_initial.sql
├── commands/                          # Slash command 定义(C-6: 已删除 search.md)
│   ├── list.md                  # 接受可选 <query> 位置参数,合并原 search 能力
│   ├── show.md
│   ├── save.md
│   ├── forget.md
│   ├── pin.md
│   ├── mode.md
│   └── audit.md
└── tests/
    ├── unit/
    │   ├── threat-scan.test.mjs
    │   ├── project-key.test.mjs
    │   ├── render.test.mjs
    │   └── injection-cache.test.mjs
    └── integration/
        ├── session-start.test.mjs
        ├── prompt-submit.test.mjs
        └── e2e-save-list-forget.test.mjs
```

---

## 六、写入闸门

v0.1 只做 **Tier 1 + secret detection**。Tier 2 / quarantine / 语义矛盾全部不做。

### 6.1 Tier 1 patterns

```javascript
// scripts/lib/threat-scan.mjs
const TIER1_PATTERNS = [
  // Prompt injection
  /ignore\s+(previous|prior|above|all)\s+(instructions|prompts|context)/i,
  /forget\s+(everything|all)\s+you\s+(know|learned|remember)/i,
  /(?:you\s+are\s+now|从现在(?:开始|起))\s+(?:a|an|the|一个|一名)/i,

  // System prompt impersonation
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>/,
  /system\s*:\s*you\s+are\s+now/i,
  /<!--\s*(?:system|admin|prompt|hidden|inject)/i,

  // Zero-width / invisible chars
  /[​‌‍﻿]/,

  // Encoded payloads
  /(?:base64|atob)\s*[(:]/i,
];

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,                              // AWS access key
  /\bsk-[a-zA-Z0-9]{32,}\b/,                            // OpenAI / Anthropic key
  /\bghp_[a-zA-Z0-9]{36}\b/,                            // GitHub PAT
  /\bxox[abps]-[0-9a-zA-Z-]{10,}\b/,                    // Slack token
  /-----BEGIN\s+(RSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/, // Private keys
];

export function tier1Scan(content) {
  for (const re of TIER1_PATTERNS) {
    if (re.test(content)) return { matched: true, pattern: re.source };
  }
  return { matched: false };
}

export function secretScan(content) {
  const hits = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) hits.push(re.source);
  }
  return hits;
}
```

**v0.1 用户自定义 patterns**(B3=C 修正，与 design.md §10.2.1 对齐):

`config.security.tier1_patterns_extra` / `tier2_patterns_extra` / `secret_patterns_extra` 在 v0.1 即可用,通过 `pattern-safety.mjs::isPatternSafe()` 加载时 fuzz test 拒绝 ReDoS/非法 regex,运行时单条 50ms / 总扫描 200ms 硬超时。**不引入 re2 native 依赖**——零依赖即可覆盖 99% 实际威胁。详见 design.md §10.2.1。

```javascript
// 加载时(scripts/lib/threat-scan.mjs)
const userTier1 = await loadUserPatterns(config.security?.tier1_patterns_extra ?? []);
const TIER1_ALL = [...TIER1_PATTERNS.map(s => ({ regex: s, source: s.source })), ...userTier1];
// scanContent 走运行时硬超时(见 design.md §10.2.1 代码示例)
```

### 6.2 写入流程（save.mjs）

```javascript
// scripts/lib/cmd/save.mjs
import { tier1Scan, secretScan } from '../threat-scan.mjs';
import { openDb } from '../db.mjs';
import { logAudit } from '../audit.mjs';
import { regenerateInjectionCache } from '../injection-cache.mjs';

export async function cmdSave({ content, scope, type, projectKey }) {
  // 1. Tier 1 always-block (with bypass escape hatch for legitimate edge cases)
  //
  // Bypass: 用户合法需要保存讨论 prompt injection 攻击的内容(例如安全研究笔记)
  //   会被 Tier 1 误拦。v0.1 提供 env CCMEM_BYPASS_TIER1=1 仅当前进程有效。
  //   v0.2 加入 /ccmem:audit --allow <id> 命令做更细粒度的审计放行。
  const t1 = tier1Scan(content);
  if (t1.matched && process.env.CCMEM_BYPASS_TIER1 !== '1') {
    await logAudit({
      action: 'tier1_blocked',
      details: { pattern: t1.pattern, content_excerpt: content.slice(0, 200) },
    });
    throw new TierOneBlockedError(t1.pattern);
  }
  if (t1.matched) {
    // bypass used — audit and tag the memory
    await logAudit({
      action: 'tier1_bypassed',
      details: { pattern: t1.pattern, content_excerpt: content.slice(0, 200) },
    });
  }

  // 2. Secret in global → block
  const secrets = secretScan(content);
  if (secrets.length > 0 && scope === 'global') {
    await logAudit({
      action: 'secret_in_global_blocked',
      details: { patterns: secrets },
    });
    throw new SecretInGlobalError(secrets);
  }

  // 3. Length check
  if (content.length > 300) {
    throw new Error(`Content exceeds 300 chars (got ${content.length})`);
  }

  // 4. Insert — last_touched_at = created_at = now (T-6 reserved 字段;NOT NULL)
  const db = openDb();
  const now = Date.now();
  const result = await db.run(`
    INSERT INTO memories
      (scope, project_key, type, content, source,
       created_at, updated_at, last_touched_at, tags)
    VALUES (?, ?, ?, ?, 'user_explicit', ?, ?, ?, ?)
  `, [
    scope, scope === 'project' ? projectKey : null, type, content,
    now, now, now, JSON.stringify([]),
  ]);

  // 5. 同步重生 injection_cache (只重生当前 scope 段)
  const cacheScope = scope === 'global' ? 'global' : `project:${projectKey}`;
  await regenerateInjectionCache(cacheScope);

  // 6. Audit
  await logAudit({
    action: 'save',
    affected_ids: [result.lastID],
    details: { scope, type, content_len: content.length },
  });

  return { id: result.lastID, scope, type, content };
}
```

### 6.3 injection_cache 重生

```javascript
// scripts/lib/injection-cache.mjs
export async function regenerateInjectionCache(cacheScope) {
  const db = openDb();
  const config = loadConfig();

  // Determine query criteria
  const isGlobal = cacheScope === 'global';
  const projectKey = isGlobal ? null : cacheScope.replace(/^project:/, '');

  // Pull recent + pinned memories under this scope
  // 注入策略 v0.1:pinned 放最前,然后 rule > fact > episode,各自按 created_at DESC
  const rows = await db.all(`
    SELECT id, type, content, pinned FROM memories
    WHERE scope = ?
      ${isGlobal ? '' : 'AND project_key = ?'}
    ORDER BY pinned DESC,
             CASE type WHEN 'rule' THEN 1 WHEN 'fact' THEN 2 ELSE 3 END,
             created_at DESC
    LIMIT 100
  `, isGlobal ? ['global'] : ['project', projectKey]);

  // Render
  const lines = [`[${isGlobal ? 'GLOBAL' : 'PROJECT ' + projectKey}]`];
  let totalChars = lines[0].length;
  const includedIds = [];
  const cap = isGlobal ? config.inject.global_chars : config.inject.project_chars;

  for (const r of rows) {
    const prefix = r.pinned ? '- (pinned) ' : '- ';
    const line = prefix + r.content;
    if (totalChars + line.length + 1 > cap) break;
    lines.push(line);
    totalChars += line.length + 1;
    includedIds.push(r.id);
  }

  const renderedText = lines.join('\n');

  await db.run(`
    INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      rendered_text = excluded.rendered_text,
      member_ids = excluded.member_ids,
      rendered_at = excluded.rendered_at
  `, [cacheScope, renderedText, JSON.stringify(includedIds), Date.now()]);
}
```

---

## 七、配置

### 7.1 配置文件

`~/.claude/ccmem/config.json`（**单层**，不存在项目级）：

```jsonc
{
  "mode": "active",                       // active | shadow | off (与 config_kv 表的 mode 同步,文件优先级高)
  "inject": {
    "max_chars": 3000,                    // SessionStart 总注入上限
    "global_chars": 1500,                 // global 段子上限
    "project_chars": 1500,                // project 段子上限
    "max_per_prompt": 6                   // UserPromptSubmit 检索 top-N
  },
  "save": {
    "max_chars_per_memory": 300,
    "max_pinned_per_scope": 20
  },
  "retrieval": {
    // I-1: 各路融合权重,缺通道按 0,全零回退 fts=1.0
    // v0.1 只有 lexical(FTS5 + Jaccard),v0.5+ 才有 hybrid(+ vec)
    //
    // I-2: lexical 默认 {fts:0.7, jaccard:0.3} — FTS5 (BM25) 是主力,Jaccard
    //   减权保留只在"短 query + 路径字符串(如 /app/api/auth)"等 FTS trigram 命中差
    //   的场景作补充。Jaccard 与 FTS5-trigram 在 token 层信号重叠约 60%,平权(0.5/0.5)
    //   等于把 FTS 的精准度稀释;0.7/0.3 是经验估算,实测后可在 config 调整。
    //   v0.5+ 三路融合时 Jaccard 进一步降权 → hybrid {fts:0.5, jaccard:0.2, vec:0.3}。
    "weights": {
      "lexical": { "fts": 0.7, "jaccard": 0.3 }
    },
    "candidatesPerLane": 30,              // 每路 top-K 候选,融合后再切 top-N
    // U-4 + I-4: LIKE fallback for short queries (trigram tokenizer 盲区)
    //   - U-4: CJK 1-2 字 query("路由"、"组件")
    //   - I-4: ASCII 2-3 字符缩写("QA"、"DB"、"API"、"UI"、"CI")
    //   FTS5 召回不足时启用,词边界限制(空格 boundary)防 `LIKE '%QA%'` 误命中 substring
    "like_fallback": {
      "enabled": true,
      "trigger_when_fts_below": 3,        // FTS5 返回 < N 条时启用
      "max_terms": 5                       // 每次最多取 N 个 short term(I-4: 重命名自 max_cjk_terms)
      // "max_cjk_terms": 5                // alias 仍接受(向后兼容),代码内 fallback 读取
    }
  }
}
```

**为什么 v0.1 就开放 `weights` 配置**:虽然 v0.1 只跑 lexical 一路,但权重比例
直接影响"FTS 精准命中"与"Jaccard 模糊覆盖"的取舍。预留 config 字段比硬编码后再升级
更省力——用户/调试人员发现 FTS 召回过多噪音时可直接调到 `{ fts: 0.85, jaccard: 0.15 }`,
不用改代码。v0.5+ 开启 vec 通道时只需追加 `hybrid` 块,`lexical` 配置原样不变。

**默认值在代码中硬编码**（`lib/config.mjs` 的 `DEFAULTS`）。配置文件不存在或某 key 缺失时回退到默认。

**项目级 config 白名单**(B5,与 design.md §14.1.0 对齐):`<project>/.ccmem/config.json` **仅读取 `project_key` / `project_key_remote_priority` 两个 key,其它 key 一律忽略 + stderr warn**。理由:registry / URL 归一是跨项目一致的"全局规则",retrieval / inject / save 是用户偏好,均不适合项目级覆盖;§8.1.4 描述的 `project_key` 手动 override 仍按原逻辑工作。

### 7.2 环境变量覆盖

| 环境变量 | 覆盖路径 | 类型 |
|---|---|---|
| `CCMEM_MODE` | `mode` | string |
| `CCMEM_INJECT_MAX_CHARS` | `inject.max_chars` | number |
| `CCMEM_INJECT_MAX_PER_PROMPT` | `inject.max_per_prompt` | number |
| `CCMEM_DATA_ROOT` | (路径覆盖,不在 config.json) | string |

### 7.3 实现

```javascript
// scripts/lib/config.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  mode: 'active',
  inject: {
    max_chars: 3000,
    global_chars: 1500,
    project_chars: 1500,
    max_per_prompt: 6,
  },
  save: {
    max_chars_per_memory: 300,
    max_pinned_per_scope: 20,
  },
  // U-4: LIKE fallback (中文 1-2 字 query 兜底)
  retrieval: {
    like_fallback: {
      enabled: true,
      trigger_when_fts_below: 3,
      max_cjk_terms: 5,
    },
  },
};

const ENV_OVERRIDES = {
  CCMEM_MODE: ['mode', String],
  CCMEM_INJECT_MAX_CHARS: ['inject.max_chars', Number],
  CCMEM_INJECT_MAX_PER_PROMPT: ['inject.max_per_prompt', Number],
};

let cached = null;
let cachedMtime = 0;

export function loadConfig() {
  const configPath = path.join(getDataRoot(), 'config.json');
  let mtime = 0;
  try { mtime = fs.statSync(configPath).mtimeMs; } catch { /* missing */ }

  if (cached && cachedMtime === mtime) return cached;

  let userConfig = {};
  try {
    if (mtime > 0) userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`ccmem: config parse failed (${e.message}), using defaults\n`);
  }

  const merged = shallowMergeTwoLevel(DEFAULTS, userConfig);

  for (const [envVar, [pathStr, parser]] of Object.entries(ENV_OVERRIDES)) {
    if (process.env[envVar] !== undefined) {
      try { setByPath(merged, pathStr, parser(process.env[envVar])); }
      catch { /* ignore parse errors */ }
    }
  }

  cached = merged;
  cachedMtime = mtime;
  return merged;
}

export function getDataRoot() {
  // E3-γ: 测试模式优先,数据走 ${TMPDIR}/ccmem-test-${pid}/,与生产 DB 完全隔离.
  // 测试 setup/teardown 自负责清理.
  if (process.env.CCMEM_TEST_MODE === '1') {
    const tmp = process.env.TMPDIR || '/tmp';
    return path.join(tmp, `ccmem-test-${process.pid}`);
  }
  return process.env.CCMEM_DATA_ROOT || path.join(os.homedir(), '.claude/ccmem');
}

// 简单两层合并:对象类型递归合并,其它整体替换
function shallowMergeTwoLevel(a, b) {
  const result = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
        && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      result[k] = { ...a[k], ...v };
    } else {
      result[k] = v;
    }
  }
  return result;
}

function setByPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
```

### 7.4 schema 迁移 helper(R-5)

所有 schema 变更(加列 / 加表 / 扩 CHECK enum / 加 index)都必须走 `runMigration()`,
**禁止裸写 ALTER TABLE / CREATE TABLE**。helper 保证:
1. forward SQL 与 `schema_meta` + `schema_migrations` 写入在同一事务
2. 失败自动 rollback,DB 一致性不受损
3. 每次 migration 入历史 log,`/ccmem:admin diagnose --migrations` 可见

```javascript
// scripts/lib/schema-migrate.mjs
import { openDb } from './db.mjs';

export async function runMigration({ description, sqlForward, sqlRollback = null }) {
  const db = openDb();
  const meta = await db.get(`SELECT version FROM schema_meta LIMIT 1`);
  const fromVersion = meta?.version ?? 0;
  const toVersion = fromVersion + 1;

  await db.transaction(async (tx) => {
    // 1. 跑 forward SQL(支持多语句)
    for (const stmt of splitSql(sqlForward)) {
      if (stmt.trim()) await tx.exec(stmt);
    }
    // 2. 更新当前 schema 版本
    await tx.run(`UPDATE schema_meta SET version = ?, applied_at = ?`,
                 [toVersion, Date.now()]);
    // 3. 记录 migration 历史
    await tx.run(`INSERT INTO schema_migrations
                  (from_version, to_version, description, applied_at, applied_by, rollback_sql)
                  VALUES (?, ?, ?, ?, ?, ?)`,
                 [fromVersion, toVersion, description, Date.now(),
                  'ccmem-cli', sqlRollback]);
  });

  process.stderr.write(
    `ccmem: migration applied (v${fromVersion} → v${toVersion}): ${description}\n`,
  );
}

// 简单按分号分句(string literal 内的 ; 需要 caller 避免)
function splitSql(sql) {
  return sql.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(Boolean);
}
```

**migration 文件组织约定**(`scripts/migrations/`):

```
scripts/migrations/
├── 001_initial.sql              # v0 → v1: 初始 schema(随 ccmem 安装直接 exec)
├── 002_v02_add_daemon.mjs       # v1 → v2: v0.2 加 daemon_lock / memory_feedback (调 runMigration)
├── 003_p3_exposure_queue.mjs    # v2 → v3: P-3 加 exposure_queue (调 runMigration)
└── 004_q4_extend_ran_by_enum.mjs   # v3 → v4: Q-4 扩 task_runs.ran_by enum (调 runMigration)
```

每个 `.mjs` 文件 default export 一个对象给 ccmem upgrade 流程调用:
```javascript
// scripts/migrations/004_q4_extend_ran_by_enum.mjs
import { runMigration } from '../lib/schema-migrate.mjs';

export default async function migrate() {
  await runMigration({
    description: 'Q-4: extend task_runs.ran_by enum (add recovery_script)',
    sqlForward: `
      BEGIN;
      ALTER TABLE task_runs RENAME TO task_runs_old;
      CREATE TABLE task_runs (
        -- ... 完整 schema,CHECK 改为 ('daemon', 'opportunistic', 'manual', 'recovery_script') ...
      );
      INSERT INTO task_runs SELECT * FROM task_runs_old;
      DROP TABLE task_runs_old;
      CREATE INDEX idx_task_runs_type_date ON task_runs(type, date_key);
      COMMIT;
    `,
    sqlRollback: `
      BEGIN;
      ALTER TABLE task_runs RENAME TO task_runs_new;
      CREATE TABLE task_runs (
        -- ... 旧 CHECK ('daemon', 'opportunistic', 'manual') ...
      );
      INSERT INTO task_runs SELECT * FROM task_runs_new
        WHERE ran_by IS NULL OR ran_by IN ('daemon', 'opportunistic', 'manual');
      DROP TABLE task_runs_new;
      CREATE INDEX idx_task_runs_type_date ON task_runs(type, date_key);
      COMMIT;
    `,
  });
}
```

**ccmem 启动时的 migration 检测**:
```javascript
// 在 openDb() 之后立即跑(早于任何业务代码)
async function checkAndApplyMigrations() {
  const meta = await db.get(`SELECT version FROM schema_meta LIMIT 1`);
  const currentVersion = meta?.version ?? 0;
  const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir).sort();    // 001_, 002_, ...

  for (const file of files) {
    const version = parseInt(file.match(/^(\d+)_/)?.[1] ?? '0', 10);
    if (version <= currentVersion) continue;
    if (file.endsWith('.sql')) {
      // 初始 schema 直接 exec(不走 runMigration,因为还没 schema_meta 行)
      continue;
    }
    const { default: migrate } = await import(path.join(migrationsDir, file));
    await migrate();
  }
}
```

**v0.3+ rollback 命令面**:`schema_migrations.rollback_sql` 字段已建好,但命令面
(`/ccmem:admin migrate schema rollback v3` 还是 `/ccmem:admin schema-rollback v3`?)
留到 v0.3+ 根据真实 migration 经验决定。v0.1 阶段只需要保证**基础设施齐全**,
未来加命令面零成本。

### 7.4.1 migration 启动失败语义(S-3)

ccmem 启动时检测 `schema_meta.version < migrations 目录最新版本` → 跑 migration。
失败处理采用**hard exit + 详细 recovery hints + emergency bypass + migration 前
自动备份**四层保护。这是对 §九 "没有 degraded / safe / bypass" 原则的延伸——
schema 不一致比 hook 失败严重得多,数据安全优先于用户便利。

**完整实现**(scripts/lib/migration-runner.mjs):

```javascript
import { runMigration } from './schema-migrate.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getDataRoot } from './db.mjs';

export async function checkAndApplyMigrations() {
  // S-3: emergency bypass(用户明确知道风险)
  if (process.env.CCMEM_SKIP_MIGRATIONS === '1') {
    process.stderr.write(
      'ccmem: WARNING — migrations skipped via CCMEM_SKIP_MIGRATIONS=1\n' +
      '       ccmem may behave incorrectly if schema is out of date.\n',
    );
    return;
  }

  const pending = await detectPendingMigrations();
  if (pending.length === 0) return;

  process.stderr.write(`ccmem: applying ${pending.length} pending migration(s)...\n`);

  // S-3: migration 前自动备份(cheap insurance)
  const backupPath = await backupDb();
  process.stderr.write(`ccmem: DB backed up to ${backupPath}\n`);

  for (const m of pending) {
    try {
      await m.migrate();
    } catch (e) {
      process.stderr.write(formatMigrationFailureMessage(e, m, backupPath));
      process.exit(1);
    }
  }
}

async function detectPendingMigrations() {
  const db = openDb();
  const meta = await db.get(`SELECT version FROM schema_meta LIMIT 1`);
  const currentVersion = meta?.version ?? 0;
  const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir).sort();    // 001_, 002_, ...
  const pending = [];
  for (const file of files) {
    const version = parseInt(file.match(/^(\d+)_/)?.[1] ?? '0', 10);
    if (version <= currentVersion) continue;
    if (file.endsWith('.sql')) continue;        // initial schema 直接 exec,不走 runMigration
    const { default: migrate } = await import(path.join(migrationsDir, file));
    pending.push({ version, file, migrate, description: file });
  }
  return pending;
}

async function backupDb() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dbPath = path.join(getDataRoot(), 'global.db');
  const backupPath = `${dbPath}.bak.${ts}`;
  await fs.promises.copyFile(dbPath, backupPath);
  return backupPath;
}

// R-4 修订:migration 失败时 DB 可能不可写,audit_log 不可用 — 落盘到独立文件,
// stderr 只留 ≤ 2 行 LLM-safe 指针。完整 recovery 步骤(含 shell 命令模板)在文件里,
// 用户用 `cat` 查看。
function formatMigrationFailureMessage(error, migration, backupPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = `${getDataRoot()}/migration-fail-${ts}.log`;
  const fullReport = [
    `ccmem migration failure report`,
    `==============================`,
    `Time:       ${new Date().toISOString()}`,
    `Migration:  ${migration.description}`,
    `Error:      ${error.message}`,
    `Backup:     ${backupPath}`,
    ``,
    `Recovery options:`,
    `  1. Fix the underlying issue (e.g., free disk space, kill long-running query)`,
    `     and restart ccmem to retry migration.`,
    `  2. Restore from backup:`,
    `       cp ${backupPath} ~/.claude/ccmem/global.db`,
    `     then downgrade ccmem to the previous version.`,
    `  3. EMERGENCY BYPASS (USE AT YOUR OWN RISK):`,
    `       CCMEM_SKIP_MIGRATIONS=1 <whatever you were running>`,
    `     ccmem will run with mismatched schema and may misbehave.`,
    ``,
  ].join('\n');
  fs.writeFileSync(logPath, fullReport, 'utf8');
  // 返回 ≤ 2 行 stderr — LLM-safe(不含 shell 模板)
  return (
    `ccmem: migration failed (${migration.description})\n` +
    `       see → cat ${logPath}\n`
  );
}
```

**失败模式分析与对策**:

| 失败类型 | 事务影响 | DB 状态 | hard exit 后用户行动 |
|---|---|---|---|
| Forward SQL 语法错 | rollback | 完整(老 schema) | 找 ccmem maintainer + 用 backup 回滚 |
| ALTER 磁盘满 / 锁定 | rollback | 完整 | 清理磁盘 / kill 锁源,重启 |
| 中途 crash(SIGKILL) | WAL 自动 recover | 大概率完整 | 重启自动重跑 |
| INSERT INTO schema_migrations 失败 | 部分 commit | 不一致 ⚠ | 用 backup 回滚 + 报 issue |

**备份保留策略**(daily_maintenance §7.6 加一步):

```sql
-- 保留最近 5 个 .bak 备份(按 mtime 排序删最旧)
-- (实际实现要 ls + sort + delete,不能纯 SQL)
```

> 由于 backup 是文件操作,daily_maintenance 不能用 SQL 直接清。改为
> `scripts/lib/backup-cleanup.mjs` 在 daemon 启动时跑一次 + daily_maintenance 调用。

**为什么不 safe mode**:v0.1-spec.md §九 已明确"没有 degraded / safe / bypass",
schema 不一致下让代码继续跑会出现"字段不存在 / CHECK 约束违反"等运行时错误,
比启动失败更难诊断。Hard exit + 详细 recovery hints + emergency bypass(CCMEM_SKIP_MIGRATIONS)
是更安全的选择。

**为什么 emergency bypass 必要**:罕见但可能——用户在重要时刻发现 migration 失败,
需要先用旧代码救急(例如 v0.3 升级失败但 v0.2 数据仍可用)。bypass 是 escape hatch,
配 stderr WARNING + 文档化"USE AT YOUR OWN RISK"。

---

## 八、Metrics

### 8.1 文件位置与格式

`~/.claude/ccmem/metrics.jsonl`，每行一个事件：

```jsonl
{"ts":1716345600000,"hook":"session_start","ms_business":18.4,"ms_total":172.1,"chars":1843,"members":12}
{"ts":1716345603000,"hook":"prompt_submit","ms_business":42.7,"ms_total":198.3,"chars":612,"matched":4,"empty":false}
{"ts":1716345610000,"hook":"prompt_submit","ms_business":38.2,"ms_total":189.0,"chars":0,"matched":0,"empty":true}
{"ts":1716345700000,"action":"save","scope":"project","type":"fact"}
{"ts":1716345800000,"action":"forget","id":143}
```

**U-PERF 字段说明**:
- `ms_business`:withHookSafety 内部业务逻辑耗时(代码可控,见 §4.1 / §4.2 SLO)
- `ms_total`:hook.mjs entry → stdout write 完成(端到端,含 import/SQL 打开等)
- 两个数同时记,便于诊断"代码慢"vs"启动慢"

文件 > 10MB 时 rotate（`metrics.<ts>.jsonl.gz`，保留最近 5 个）。

### 8.2 写入

```javascript
// scripts/lib/metrics.mjs
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from './config.mjs';

const METRICS_PATH = path.join(getDataRoot(), 'metrics.jsonl');

export async function recordMetric(event) {
  const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
  try {
    // ECC-R3: metrics 用 appendFile — 对于 append-only JSONL,appendFile 在 POSIX 上
    // 对 < PIPE_BUF (4096 bytes) 的写入是原子的;单条 metric JSON 远小于此阈值。
    // 不需要 tmp+rename(rename 会覆盖整个文件,不适合 append 场景)。
    await fs.promises.appendFile(METRICS_PATH, line);
  } catch {
    // metrics 写失败不致命,silently drop
  }
}
```

### 8.3 `/ccmem:stats`（v0.1 不实现，但 metrics.jsonl 已可用）

v0.1 用户用 jq / awk 直接查：

```bash
# 业务 p95（代码可控部分 — 用于判断是否需要优化 SQL/render）
jq -s 'map(select(.hook == "session_start")) | sort_by(.ms_business) |
       .[length * 0.95 | floor].ms_business' \
  ~/.claude/ccmem/metrics.jsonl

# 端到端 p95（含 Node 启动 — 用于判断是否触发用户感知卡顿）
jq -s 'map(select(.hook == "session_start")) | sort_by(.ms_total) |
       .[length * 0.95 | floor].ms_total' \
  ~/.claude/ccmem/metrics.jsonl

# Empty match rate (last 100 prompt_submit)
jq -s 'map(select(.hook == "prompt_submit")) | .[length-100:length] |
       map(.empty | tostring) | group_by(.) | map({key: .[0], count: length})' \
  ~/.claude/ccmem/metrics.jsonl
```

**为什么分两个查询**：`ms_business` 是 ccmem 代码能优化的部分（SQL/render/stdout），超 SLO 说明 ccmem 自身需要调优；`ms_total` 是用户实际感知的延迟（含 Node 启动 ~100-150ms 固定成本），超 SLO 说明用户已经感觉到卡顿。两个指标独立报警，避免把 Node cold start 算到 ccmem 头上误导优化方向（U-PERF）。

`/ccmem:stats` 命令在 v0.2 实现（按需聚合 jsonl）。

---

## 九、模式

```
active  - 正常运行
shadow  - hook 正常运行 + 写入 DB,但 additionalContext = ""
off     - hook 立即 exit 0
```

切换：`/ccmem:mode <X>` 或 env `CCMEM_MODE=X`。env 优先于 config_kv 表。

**没有** degraded / safe / bypass。任何 DB 错误都被 `withHookSafety` 接住，hook 输出空注入并 exit 0，stderr 提示用户。

---

## 十、Project key 解析

**M-4-A 决议(2026-05-29)**:`project_key` 解析与 URL 归一算法的**权威定义**在
[design.md §8.1.1](./ccmem-design.md#811-解析优先级) 与 [§8.1.3](./ccmem-design.md#813-url-同形归一v01-4-步简化)。
v0.1-spec 不再复制实现代码,避免两份文档同步漂移。

**v0.1 实现要求**:
1. `resolveProjectKey()`:实现 design.md §8.1.1 的 4 步优先级链
   - 手动 override(`<project>/.ccmem/config.json` 中 `project_key`,B5 白名单)
   - 环境变量 `CCMEM_PROJECT_KEY`
   - `git remote get-url origin` + `normalizeGitUrlSimple()` 归一
   - fallback:`path:` + sha256(absPath).slice(0, 16)
2. `normalizeGitUrlSimple()`:实现 design.md §8.1.3 的 4 步简化归一(SSH→HTTPS / 剥协议 / 剥凭据 + 默认端口 / 剥 `.git` + 尾 `/`)。**完整代码见 design.md,本文件不再 inline**。

**v0.1 故意不做的**(由 design.md §8.1 列举):
- 多 remote 选择 registry(v0.3+)
- Azure DevOps `_git/` host-path 重写(v0.3+)
- 大小写敏感 host 白名单(v0.3+)
- worktree 检测(永不,改靠 git remote 稳定性)

不做这些的代价:少数用户在切换 SSH/HTTPS 协议或多 remote 项目时 `project_key`
可能漂移。**v0.1 接受这个代价**,等用户实际遇到再补。设计层面的"漂移检测"
能力在 `project_key_alias` 表(v0.2+,design.md §8.1.5)上线后才有。

**为什么 v0.1-spec 不内嵌实现代码**(M-4-A):
- design.md 是设计 SSOT,v0.1-spec 是"v0.1 阶段做什么"的实施切片
- 两份文档独立维护同一段代码 → 修改时一份改、一份漏 = 高发漂移源
- v0.1-spec 用 ALGORITHM 引用 + 不做清单的方式呈现 v0.1 阶段决策即可,
  实现细节由读者跳转 design.md 看
- 这种"实施 spec 引用设计 SSOT"的模式适用于所有 v0.x-spec 与 design 的关系

---

## 十一、安装与卸载

### 11.0 Plugin Packaging(V-2,2026-05-27 决议)

ccmem 作为 Claude Code plugin 分发,`.claude-plugin/plugin.json` manifest 必须遵守 Claude Code validator 的隐性硬约束。**违反任何一条都会让 marketplace install 失败,validator 输出无线索的 `Invalid input` 错误**。约束来源:`reference/ECC/.claude-plugin/PLUGIN_SCHEMA_NOTES.md`(ECC 在长期迭代中踩遍所有未文档化约束的沉淀)。

#### 5 条硬约束(MUST)

| 字段 | 规则 | 违反后果 |
|---|---|---|
| `version` | 必填,semver 字符串 | marketplace install / `claude plugin validate` 失败 |
| `commands` / `skills` | **必须 array**,即便只有 1 个 entry | 字符串值报 `Invalid input` |
| `agents` | **绝不能出现**(任何形式) | `agents: Invalid input`。agents 走 `agents/*.md` 目录约定自动发现 |
| `hooks` | **绝不能出现** | Claude Code v2.1+ 自动加载 `hooks/hooks.json`,声明会触发 `Duplicate hooks file detected` |
| `mcpServers` | **显式 `{}` 空对象保留**(即便不用 MCP) | 否则 root `.mcp.json` 被自动 bundle,长插件名让 OpenAI 兼容 gateway 拒绝 MCP tool name(>64 字符) |

#### ccmem v0.1 minimal `plugin.json`

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

**字段释义**:
- 没有 `hooks` 字段:`hooks/hooks.json` 由 Claude Code 自动加载(约定优于声明)
- 没有 `agents` 字段:ccmem v0.1 无 agents(future 加 agents 也只放 `agents/*.md`,不在 manifest 声明)
- `commands` 是 array,装 1 个目录路径(commands/*.md 自动注册为 `/ccmem:<filename>`)
- `skills` v0.1 暂无,空 array(`[]`)
- `mcpServers: {}` 是**主动 opt-out**,不是"忘填"

#### Regression test 要求

ship 前必须有 `tests/unit/plugin-manifest.test.mjs` 防止上述约束在 PR 迭代中被无意打破:

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

**为什么 v0.1 就要 regression test**:这些 schema 约束是 validator 隐性 enforce 的,人眼很难发现——ECC 撞了 4 次 fix/revert cycle 才稳定下来。ccmem 第一次 ship 就走 marketplace install,所有用户都暴露在风险下;regression test 写 30 行,ship 后用户装不上的 issue 排查可能要几天。

#### Plugin 文件结构

```
<plugin-root>/                       # 实际路径由 Claude Code 决定(见 V-1 / §4.3)
├── .claude-plugin/
│   └── plugin.json                  # V-2 约束的 manifest
├── commands/                        # commands/*.md → /ccmem:<filename>
│   ├── list.md
│   ├── save.md
│   └── ...
├── hooks/
│   └── hooks.json                   # Claude Code v2.1+ 自动加载,不在 manifest 声明
├── scripts/
│   ├── hook.mjs                     # hooks.json 的 command 入口(走 ${CLAUDE_PLUGIN_ROOT})
│   ├── handlers/
│   └── lib/
├── bin/
│   └── ccmem                        # CLI 入口
├── tests/
│   └── unit/
│       └── plugin-manifest.test.mjs # V-2 regression test
├── config.default.json
├── package.json
└── README.md
```

### 11.1 安装

ccmem 作为 Claude Code plugin 通过 marketplace 或手动方式安装。**`ccmem install` 本身不负责 plugin 文件分发**——Claude Code 的 plugin 安装机制决定实际部署路径(见 §4.3 V-1)。

```bash
# 方式 1:marketplace install(推荐,实际部署到 ~/.claude/plugins/cache/ccmem/<org>/<version>/)
claude plugin install ccmem

# 方式 2:手动 clone(部署到 ~/.claude/plugins/ccmem/)
git clone https://github.com/<author>/ccmem ~/.claude/plugins/ccmem

# 必要:创建 CLI 软链(slash command 通过 PATH 找 ccmem,见附录 B V-1 路径解析说明)
ln -sf "$(claude plugin path ccmem)/bin/ccmem" ~/.local/bin/ccmem
# 确认 ~/.local/bin 在 PATH 中(macOS / Linux 默认通常已包含,Windows 需手动配置)
```

首次运行任何命令时自动 init:
- 创建 `~/.claude/ccmem/` 目录(用户数据,独立于 plugin 部署路径)
- 创建子目录 `~/.claude/ccmem/trash/`(forget 时备份用)
- 创建 `~/.claude/ccmem/global.db` + 跑 migrations/001_initial.sql
- 检测 `~/.claude/settings.json` 是否已注册 SessionStart / UserPromptSubmit hooks——若否,提示用户允许写入
- **检测 `ccmem` CLI 是否在 PATH 中**——若否,提示用户手动 `ln -sf <plugin-root>/bin/ccmem ~/.local/bin/ccmem` 并把 `~/.local/bin` 加入 PATH。slash command 通过 PATH 调 ccmem(V-1),不在 PATH 里所有 `/ccmem:*` 命令都会失败

**v0.1 用户数据目录布局**(与 plugin 代码目录完全分离):

```
~/.claude/ccmem/             # 用户数据,不跟版本走
├── config.json              # 用户配置(可选,缺失即用 defaults)
├── global.db                # SQLite,所有记忆 + audit_log + config_kv + tasks(空)
├── metrics.jsonl            # 每行一个事件(hook + 命令操作),> 10MB 自动 rotate
└── trash/                   # forget 时的 markdown 备份
    ├── 142.md
    └── 143.md
```

### 11.2 卸载

```bash
# 推荐:marketplace 安装的用户通过官方命令卸载(自动处理 cache 路径)
claude plugin remove ccmem

# 手动 clone 安装的用户:删插件目录
rm -rf ~/.claude/plugins/ccmem

# (可选)删数据
rm -rf ~/.claude/ccmem
```

**不要 `rm -rf ~/.claude/plugins/ccmem` 一刀切**——marketplace install 时 plugin 实际在 `~/.claude/plugins/cache/ccmem/<org>/<version>/`,直接 rm 删错位置反而留下残留。`claude plugin remove` 会同时清理 cache 与 `~/.claude/settings.json` 的 hooks 注册。

无 daemon 需要停止(v0.1 无 daemon;v0.2+ 卸载流程见 design.md §15.1)。

---

## 十二、实施路线（2-3 周）

### Week 1：基础设施 + Hook

**Day 1-2**：
- 项目结构 + package.json + bin/ccmem
- DB 打开 + migrations/001 跑通
- `lib/config.mjs` + 默认值
- `lib/project-key.mjs` 三档 fallback + 单元测试

**Day 3-4**：
- `lib/threat-scan.mjs` Tier 1 + secret 模式 + 单元测试
- `lib/injection-cache.mjs` 渲染逻辑 + 单元测试
- `lib/audit.mjs` + `lib/metrics.mjs`

**Day 5**：
- `handlers/session-start.mjs` + `handlers/prompt-submit.mjs`
- `lib/hook-safety.mjs` Promise.race timeout
- 集成测试：hook 调用从 stdin → stdout 端到端

### Week 2：命令实现

**Day 6-7**：
- `lib/cmd/save.mjs`（含 Tier 1 闸门）+ 集成测试
- `lib/cmd/list.mjs` 含 `--json` 模式 + 集成测试
- `lib/cmd/show.mjs`

**Day 8**：
- `lib/cmd/forget.mjs` + trash/ 备份
- `lib/cmd/pin.mjs` + 容量校验

**Day 9**：
- `lib/cmd/mode.mjs`
- Slash command markdown 文件（commands/）
- CLI argv 解析（用 `node:util.parseArgs`，无外部依赖）

**Day 10**：
- e2e 测试：save → list → forget(检查 trash/<id>.md 已写入) → save 复原
- hook + cmd 联动测试：save 后 SessionStart 能立即看到

### Week 3：dogfood + 微调

**Day 11-12**：
- 自用，逐步填 ~30 条 memory（项目偏好 + 用户偏好）
- 观察 metrics.jsonl，看 hook p95 是否符合预算

**Day 13-14**：
- 修 bug，根据自用感受调注入文本格式 / FTS query 策略
- README + AGENTS.md（如何安装、命令清单、debug 方法）

**Day 15（buffer）**：
- 准备 v0.1 → v0.2 决策报告

### 12.1 测试覆盖目标

| 范畴 | 目标 |
|---|---|
| `lib/threat-scan.mjs` | 100% line coverage + Tier 1 模式真值表（每个模式至少 1 个 positive + 1 个 negative case）|
| `lib/project-key.mjs` | 至少覆盖：HTTPS / SSH / 无 git / 多 remote / 环境变量 override |
| `lib/injection-cache.mjs` | 至少覆盖：空表 / 仅 pinned / 超 budget 截断 / 全部 type 排序 |
| `lib/cmd/*` | 每个命令 happy path + 至少 2 个错误路径 |
| Hook 集成 | Tier 1 throw → hook 仍 exit 0 + 空注入 |
| Schema migration | 001 重复运行幂等 |
| FTS5 sanitizer | 对抗输入：emoji / 引号 / 控制字符 / 超长 prompt |
| Shadow 模式可见性 | SessionStart hook 在 `mode=shadow` 下 stderr 有一行 `ccmem: mode=shadow` 输出,`mode=off` 与 `mode=active` 均不输出 |

### 12.2 测试隔离(CCMEM_TEST_MODE)

所有 e2e / 集成测试必须设 `CCMEM_TEST_MODE=1`,这会让 `getDataRoot()` 返回
`${TMPDIR}/ccmem-test-${pid}/`,与生产 `~/.claude/ccmem/` 完全隔离。

```javascript
// tests/setup.mjs
import fs from 'node:fs';
import path from 'node:path';

beforeEach(() => {
  process.env.CCMEM_TEST_MODE = '1';
  // getDataRoot() 现在会返回临时目录
});

afterEach(() => {
  const tmp = process.env.TMPDIR || '/tmp';
  const root = path.join(tmp, `ccmem-test-${process.pid}`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
```

**注意**：
- 测试模式不影响控制流,只重定向 I/O 目标(DB / config / metrics / trash)
- v0.1 没有 daemon / cron,所以测试模式仅影响 DB 与 metrics 路径
- v0.2+ 会扩展：cron 任务不注册到真实 launchd/systemd-user;daemon 不真启;`claude -p` mock

---

## 十三、v0.1 → v0.2 决策点

ship v0.1 后自用 1-2 周，根据以下数据决定 v0.2 投入方向：

### 13.1 验收指标（必看）

读 metrics.jsonl 看：

| 指标 | 健康基线 | 异常含义 |
|---|---|---|
| `session_start.ms_business` p95 | < 50ms | DB / render 慢 → 优化 SQL 或 stable_top 数量 |
| `session_start.ms_total` p95 | < 300ms | 用户实际感知卡顿 → 检查 Node 启动 + 业务总和 |
| `prompt_submit.ms_business` p95 | < 100ms | FTS query 太重或 memories 表过大 |
| `prompt_submit.ms_total` p95 | < 400ms | 用户感知 prompt 延迟 → 优化检索或降级注入数量 |
| `prompt_submit.empty=true` 比例 | < 30% | 记忆稀疏 / 关键词不对 → 触发 v0.2 加 LLM 提取的需求 |
| `inject.session_start.chars` | 200-2500 | 太少=记忆稀疏；爆 cap=过载需要 cron 整合 |
| 用户自用 7 天后 saves count | > 20 | 用户实际在用；< 5 = 假设可能错误 |
| Hook timeout 触发率(`ms_total > 1000`) | < 1% | > 1% 说明 timeout 边界有问题或机器过载 |

**优化方向判断（U-PERF）**：
- 只有 `ms_business` 超 SLO、`ms_total` 也超 → 优化 ccmem 代码（SQL / render / FTS）
- `ms_business` 正常但 `ms_total` 超 → Node 启动慢，ccmem 无能为力（v0.2 可考虑常驻 daemon 走 IPC）
- 两者都超 → 先修业务，再看是否还需 daemon

### 13.2 假设验证（主观）

每天用结束问自己：
- 今天 LLM **复述/采用**了多少条 ccmem 注入的记忆？
- 是否减少了"我之前不是说过 X"的重复解释？
- 是否有"明明 ccmem 里有但 LLM 没用上"的失望？
- 是否有"ccmem 注入了但完全无关"的污染？

### 13.3 v0.2 候选方向（视 v0.1 数据决定）

| 数据信号 | v0.2 优先做 |
|---|---|
| `empty=true` 比例 > 30% | 加 LLM 自动提取（summarize_pending），让记忆更密集 |
| Hook p95 接近预算 | 优化 + 引入 daemon 异步预渲染 |
| 用户手写 saves 比例高（每周 > 20）| 自动化提取价值大，daemon + cron 优先 |
| 用户手写 saves 比例低（< 5）| 假设可能错误，先调研为什么用户不存 |
| `prompt_submit.matched` 平均 < 2 | 检索差，加 embedding（v0.5 提前到 v0.2）|
| Inject 内容污染严重 | 加 trust 系统 + 反馈推断 |

### 13.4 失败回退路径

如果 v0.1 跑完发现：
- **假设错误**（注入但 LLM 不用 / 用户更想自己 grep）→ 不进 v0.2，重新设计
- **假设部分对**（pinned 有用，自动注入无用）→ v0.2 改方向，按需召唤而非自动注入
- **假设完全对**（自动注入显著减少重复）→ 按 §13.3 选 v0.2 方向

**绝不**因为"已经写了这么多"就硬上 v0.2 daemon。v0.1 的代码量小（< 2000 行），重写成本可控。

### 13.5 Schema migration 准备(T-7)

> v0.1 ship 时即固化 v0.2 migration 流程,提供脚本骨架与通用 helper。
> v0.2 实施者只需 fill in 实际 SQL,不需要从头设计迁移机制。

#### 13.5.1 `runMigration()` helper(v0.1 即写,v0→v1 已用)

```javascript
// scripts/lib/migrations.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

/**
 * 把数据库升级到 targetVersion(不传则升级到最新)。
 * 调用方:CLI `ccmem migrate` 命令、首次 hook 启动、v0.2 daemon 启动。
 *
 * 安全约束:
 * - 整个 migration 在单事务里;失败 ROLLBACK,数据不残留
 * - migration 前自动写 backup: ~/.claude/ccmem/backups/pre-migration-<from>-<to>-<ts>.db
 * - schema_migrations 表每次成功 INSERT 一行(R-5)
 * - 失败时 stderr WARNING + exit 1,daemon/hook 必须能感知
 */
export async function runMigration(db, targetVersion = null) {
  const current = await getCurrentVersion(db);
  const files = listMigrationFiles().filter(f => f.toVersion > current);
  const target = targetVersion ?? Math.max(...files.map(f => f.toVersion), current);

  if (current === target) return { skipped: true, current };

  // 1. Backup before any DDL
  const backupPath = await backupDb(current, target);

  for (const file of files) {
    if (file.toVersion > target) break;
    await db.transaction(async (tx) => {
      const sql = readFileSync(file.path, 'utf8');
      tx.exec(sql);
      tx.run(`
        INSERT INTO schema_migrations
          (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, ?, ?, ?, ?)
      `, [file.fromVersion, file.toVersion, file.description, Date.now(), 'ccmem-cli']);
    });
  }

  return { migrated: true, from: current, to: target, backup: backupPath };
}

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .map(name => {
      const m = name.match(/^(\d{3})_v(\d+)_to_v(\d+)/);
      return m && {
        path: join(MIGRATIONS_DIR, name),
        fromVersion: Number(m[2]),
        toVersion: Number(m[3]),
        description: name,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.toVersion - b.toVersion);
}

async function getCurrentVersion(db) {
  // B5: schema_meta 单 row,canonical 查询 LIMIT 1(等价于 MAX(version),但更直接)
  const row = await db.get(`SELECT version FROM schema_meta LIMIT 1`);
  return row?.version ?? 0;
}

async function backupDb(from, to) {
  const ts = Date.now();
  const target = join(getDataRoot(), 'backups', `pre-migration-${from}-${to}-${ts}.db`);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.copyFile(getGlobalDbPath(), target);
  return target;
}
```

#### 13.5.2 `scripts/migrations/002_v0_1_to_v0_2.sql` 骨架

> v0.1 ship 即包含此文件,**body 是 stub 注释**;v0.2 实施者按下方 checklist 填充。

```sql
-- ============================================================
-- 002_v0_1_to_v0_2.sql — v0.1 → v0.2 schema migration
-- ============================================================
-- Generated by T-7 decision (revisions §五 T-7).
-- v0.1 ship 时 body 为空(注释 stub);v0.2 实施者按 checklist 填充。
--
-- SQLite 限制重要提醒:
-- - 不支持 ALTER TABLE ADD CHECK / ALTER TABLE DROP COLUMN(老 SQLite < 3.35)
-- - 改 NOT NULL / 改 DEFAULT 必须走 rename → recreate → copy → drop pattern
-- - 跨表 FK / TRIGGER 必须临时 PRAGMA foreign_keys=OFF
--
-- 一次 BEGIN/COMMIT 包裹整个 migration(由 runMigration() 提供事务)。

-- [v0.2 实施 checklist — 按顺序 fill in]:
--
-- A. 新建表(无 schema 冲突,直接 CREATE):
--   - memory_feedback(L1/L2/L4 反馈推断)
--   - daemon_lock(单实例锁)
--   - recent_injections(J-1 + Q-1,/ccmem:forget --last 支撑)
--   - cross_scope_alerts(L-2,跨 scope 投毒告警)
--   - project_key_alias(漂移检测)
--   - ccmem_blacklisted_sessions(防递归)
--   - 见 design.md §4.1 v0.2 增量段落
--
-- B. memories 表加字段(reserved 字段已在 v0.1 schema,本批新增):
--   - migration_origin TEXT             -- F-1: 标记 v0.1 → v0.2 升级来源
--   - requires_revalidation INTEGER     -- C-1: Tier 2 危险模式标记(§10.5 cron 用)
--   - last_revalidated_at INTEGER       -- C-1: revalidation_audit 上次复核时间
--   - last_scanned_patterns_version TEXT -- C-1: §10.6 retroactive scan 用
-- (C-1 决议: updated_at 已在 v0.1 schema,promote/audit 时刷新该列;
--  "谁改的"信息走 audit_log.details.set_by,不在 memories 表加 modified_by 列)
--
-- C. 扩展 CHECK 约束(不支持 ALTER ADD CHECK,需 rename→recreate):
--   - 例:tasks 表 status enum 扩展、ran_by 扩展 — 见 v0.1-spec §3.1 enum 扩展 recipe
--
-- D. 初始化 v0.2 默认值:
--   - UPDATE memories SET half_life_days = CASE type
--       WHEN 'rule' THEN 60 WHEN 'fact' THEN 30
--       WHEN 'episode' THEN 7 WHEN 'consolidated' THEN 90 END
--     WHERE half_life_days IS NULL;
--   - UPDATE memories SET migration_origin = 'v0.1_user_explicit'
--     WHERE migration_origin IS NULL;
--
-- E. 创建 v0.2 索引(若 v0.1 没建过):
--   - idx_mem_decay_status / idx_mem_helpful / idx_mem_unhelpful
--   - 各新表的索引见 design.md §4.1
--
-- F. 验证 invariants(每张表都跑一个 SELECT 检查):
--   - SELECT COUNT(*) FROM memories WHERE last_touched_at IS NULL — 必须为 0
--   - SELECT COUNT(*) FROM memories WHERE decay_status NOT IN (...) — 必须为 0
--
-- 此 stub 在 v0.1 ship 时**永远不执行**(runMigration 看 file.toVersion=2 > target=1,skip)。
-- v0.2 ship 时 ccmem 启动检测 schema_meta.version=1 < 2,自动跑此 SQL。
```

#### 13.5.3 测试要求(v0.1 即写)

1. **runMigration 跑 0→1 单测**:空 DB → 应用 001_initial.sql → 验证 schema_meta=1
2. **runMigration backup 单测**:任何 migration 前 backups/ 必出现文件
3. **runMigration 事务回滚单测**:故意往 001 中加非法 SQL → 应 ROLLBACK + schema_meta 不变
4. **idempotent 单测**:连跑 runMigration 两次,第二次必须 skipped=true(因为 schema_meta 已达 target)

v0.2 ship 时这 4 个测试自动覆盖 002 migration 的最小正确性,只需要再加 v0.2 业务相关的断言。

---

## 十四、约定与禁止

### 14.1 编码约定

- ESM only（`.mjs`）
- **零运行时依赖**：用 Node ≥ 22.5 内置 [`node:sqlite`](https://nodejs.org/api/sqlite.html)（替代 `better-sqlite3`，避免 node-gyp 编译失败这一常见装机痛点）
- `node --version` 要求 **≥ 22.5**（`node:sqlite` 在 22.5 引入，22.x 系列下需启动 flag `--experimental-sqlite`；Node ≥ 24 该 flag 默认开启）
- hook 调用必须显式带 flag,路径走 `${CLAUDE_PLUGIN_ROOT}`(V-1):`node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs" ...`
- DB API 是 **sync** 的（`DatabaseSync` / `StatementSync`），hook 短生命周期下天然适配；`db.mjs` wrapper 内部把 `.run()` / `.get()` / `.all()` / `.transaction(fn)` 用 sync API 封装，文档中其它伪代码 `await db.xxx()` **不字面要求 Promise**，落地时可以是 sync return
- 所有 SQL 用 prepared statement，禁止字符串拼接
- 所有 fs 操作用 `node:fs/promises`（fs 是真正异步的，与 sync SQL 不冲突）
- DB 错误必须被 `withHookSafety` 或 cmd 入口 try/catch 接住

### 14.2 v0.1 禁止事项

- ❌ `claude -p` 调用（v0.2）
- ❌ daemon 进程（v0.2）
- ❌ `setInterval` / 后台计时器（hook 进程是短生命周期）
- ❌ embedding / ONNX / transformers（v0.5+）
- ❌ 长事务（任何事务必须在 50ms 内提交）
- ❌ 任何 stderr 写超过 2 行（PoC §附录 D 证实 stderr 也进 LLM 上下文；冗长元解释必须走 `audit_log.details`，详见 §5.0.2 R-4 修订）
- ❌ stderr/stdout 任一通道出现「推断模板」「shell 命令模板带占位符」「if-then 规则结构」（LLM 会模仿，产生 hallucinated rule；LLM-safe 措辞规则见 §5.0.2）
- ❌ hook 脚本 stdout 写非 JSON 内容（hook 输出契约；slash command 不在此约束内）
- ❌ 阻塞性 I/O 在 hook 路径（不要读大文件、不要 spawn）
- ❌ 删除 v0.2 预留 schema（tasks 表、trust_score / consolidation_depth 字段）

---

## 附录 A：v0.1 完整 schema 一次性建表脚本

见 `scripts/migrations/001_initial.sql`，与 §3.1 一致。

## 附录 B：v0.1 命令的 markdown 定义示例

`commands/save.md`：

```markdown
---
description: Save a memory to ccmem (project scope by default)
command: true
disable-model-invocation: true
argument-hint: "<content> [--global] [--type rule|fact|episode]"
---

ccmem save -- $ARGUMENTS
```

**ECC-R1 命令范式选型**:ccmem 所有 slash command 采用 **Archetype C: CLI-delegating**
(`command: true` + `disable-model-invocation: true`)。此范式下 Claude Code **直接执行**
命令体中的 shell 命令,**不经过 LLM 解释**(省去一次 LLM round-trip + Bash tool call)。

适用条件(ccmem 全部命令均满足):
- 命令是纯 CLI 操作,不需要 LLM 推理
- 输出结果直接进入 LLM 上下文供后续对话使用
- 错误处理在 CLI 内部完成

**Frontmatter 字段说明**:

| 字段 | 值 | 含义 |
|---|---|---|
| `description` | 一行说明 | 命令列表中展示 |
| `command: true` | — | 标记为直接执行(非 LLM prompt) |
| `disable-model-invocation: true` | — | 阻止 LLM 被调用,命令体即是 shell 命令 |
| `argument-hint` | 参数格式提示 | 用户输入时的 UI 提示 |

**V-1 路径解析说明**:slash command 在 user shell 中执行,**不继承** `${CLAUDE_PLUGIN_ROOT}` env(附录 E PoC 已证实)。因此 slash command 调用 PATH 上的 `ccmem` CLI,不用绝对路径。§11.1 install 时把 `<plugin-root>/bin/ccmem` 软链到 `~/.local/bin/ccmem`——`ccmem install` 强制完成此步(失败时 stderr 显式告知,但不阻塞 hook 注册)。

**`--` 是参数隔离符**(防止 `$ARGUMENTS` 内的 `-x` flag 被 ccmem CLI 误解析为自身 flag)。Claude Code 把用户 verbatim 参数透传到 `$ARGUMENTS`(PoC §附录 D),`ccmem save -- "<content>" --type rule` 是正确形式;CLI argparse 负责在 `--` 之后识别已知 flag(`--type`/`--global`)和 positional content。

**其它命令的 `.md` 模板**(全部统一格式):

```markdown
# commands/list.md
---
description: List or search saved memories (C-6: list/search merged)
command: true
disable-model-invocation: true
argument-hint: "[<query>] [--type rule|fact|episode] [--scope global|project] [--limit N] [--score]"
---

ccmem list -- $ARGUMENTS
```

```markdown
# commands/show.md
---
description: Show a single memory in detail
command: true
disable-model-invocation: true
argument-hint: "<id>"
---

ccmem show -- $ARGUMENTS
```

```markdown
# commands/forget.md
---
description: Delete a memory (backed up to trash)
command: true
disable-model-invocation: true
argument-hint: "<id>"
---

ccmem forget -- $ARGUMENTS
```

```markdown
# commands/pin.md
---
description: Pin/unpin a memory for guaranteed injection
command: true
disable-model-invocation: true
argument-hint: "<id> [--remove]"
---

ccmem pin -- $ARGUMENTS
```

```markdown
# commands/mode.md
---
description: Get or set ccmem mode (active|shadow|off)
command: true
disable-model-invocation: true
argument-hint: "[active|shadow|off]"
---

ccmem mode -- $ARGUMENTS
```

```markdown
# commands/audit.md
---
description: Show audit log entry details
command: true
disable-model-invocation: true
argument-hint: "show <id>"
---

ccmem audit -- $ARGUMENTS
```

---

## 附录 C：与 ccmem-design.md 的对应关系

v0.1 spec 是 ccmem-design.md 的**最小可行子集**。下表标注每个 v0.1 元素对应 design.md 的章节：

| v0.1 章节 | design.md 章节 | 状态 |
|---|---|---|
| §3 schema | §4.1 SQLite Schema | 大幅简化，删除 ~15 张表 |
| §4 Hooks | §6 Hook 设计 | 只保留 SessionStart + UserPromptSubmit |
| §5 命令 | §12 用户命令 | 19 → 6 |
| §6 写入闸门 | §10 安全防护 | 只保留 Tier 1 + secret |
| §7 配置 | §14 配置文件 | 4 层 → 1 层 |
| §8 Metrics | §13 评估指标 | daily_metrics 表 → metrics.jsonl |
| §9 模式 | §16.3 数据库故障容错 | 4 模式 → 3 模式 |
| §10 project key | §8.1 project_key 解析 | 8 步归一 → 简化 4 行函数 |

**完整删/改/留清单见**：[`docs/ccmem-design-revisions.md`](./ccmem-design-revisions.md)

---

## 附录 D：`!bash` slash command 路由 PoC 记录(R-4 修订依据)

**目的**:在投入 §5.2-§5.6 任何 CLI 实现之前,验证 Claude Code `!bash` 机制
对 `ccmem-v0.1-spec` 假设的三个关键行为是否成立。

**PoC 文件**(实现验证后已删除,见末尾):
- `poc/bin/poc-cli` — 一个把 `POC_STDOUT_MARK` 写 stdout、`POC_STDERR_MARK`
  写 stderr 的 bash 脚本,同时 echo `args_seen=$*` 与 `args_count=$#`。
- `.claude/commands/ccmem-poc.md` — slash command markdown,通过
  `!/Users/biran/code/skills/ccmem/poc/bin/poc-cli $ARGUMENTS` 调用脚本,
  并要求 LLM 按固定格式自报"是否看到 stdout/stderr 标记 + args 值"。
- `poc/README.md` — 验证矩阵(4 种 LLM 自报结果 → spec 行动)。

**执行**(2026-05-27):

用户在 Claude Code 内输入:
```
/ccmem-poc hello world 中文 "with spaces"
```

**LLM 自报结果**:

| 维度 | 结果 |
|---|---|
| `[stdout visible?]` | **yes** — LLM 在上下文中看到 `POC_STDOUT_MARK` |
| `[stderr visible?]` | **yes** — LLM 在上下文中也看到 `POC_STDERR_MARK` ⚠️ |
| `[args_seen value]` | `hello world 中文 with spaces`(args_count=4) |
| `[anomalies]` | 双流都可见;字面引号被 shell 消费(预期);CJK UTF-8 透传完好 |

**三个假设的验证状态**:

1. **stdout 注入 LLM 上下文**:✅ 成立 — slash command 的 `!bash` 命令 stdout 确实进入下一轮 LLM context。
2. **stderr 不进 LLM 上下文**:❌ **不成立** — stderr 同样进入 LLM context,与传统 Unix pipe 直觉相反。
3. **`$ARGUMENTS` 透传**:✅ 成立(带一个已知限制) — 用户原 prompt 中的引号会被 shell 消费(`"with spaces"` → 单个 arg `with spaces`),但 token 边界与 UTF-8 字符均完整保留。**结论**:slash command 的 args 适合放短/简单字符串,长/含特殊字符的输入应该走 stdin 或 file path。

**对 spec 的影响**:

| 受影响章节 | 修改方向 |
|---|---|
| §5.0.2 命令输出原则(R-4) | **整节重写** — 从"stdout vs stderr 分流"改为"双流都 LLM 可见 → 元数据走 SQLite audit_log + stderr 只留指针"(详见本表后方案对比) |
| §5.2 `/ccmem:save` 输出示例 | 删除 stderr 写"auto-inferred from keyword X via Y layer"等推断模板,改为 `meta logged → ccmem audit show N` 一行指针 |
| §5.2 U-9 非 git 拒绝示例 | 删除 stderr 5 行用法说明,改为 ≤ 2 行 + audit_log 详情 |
| §5.4 `/ccmem:forget` | 删除 stdout 多行 restore shell 命令模板(防止 LLM 模仿),改为 stderr `backup saved → ccmem audit show N` 指针 |
| §5.6.1 `/ccmem:audit show` | **新增命令** — 查询 audit_log.details JSON pretty-print |
| §5.6.2 `writeAudit()` helper | **新增规范** — 所有元解释写 audit_log 的统一入口 |
| §5.0(`FeatureNotAvailableError.formatForUser`) | 改为返回 `toAuditDetails()`,stderr 只 ≤ 2 行 |
| schema migration `formatMigrationFailureMessage` | DB 不可用时退回写文件 `migration-fail-*.log`,stderr 只 ≤ 2 行指针 |
| §14.2 禁止事项 | "stderr 写超过 2 行" 的理由从"避免污染终端"改为"PoC 证实 stderr 也进 LLM";新增"任一通道含推断模板/shell 命令模板/if-then 规则结构"禁止项 |

**方案选型(用户 2026-05-27 决策)**:

| 候选方案 | 优劣 | 结论 |
|---|---|---|
| A. stderr 加 `<!--terminal-only-->` 哨兵 | 依赖 LLM 服从指令;不同模型行为漂移;HTML 注释仍占 token | 否决 |
| **B. 元数据 → audit_log + stderr 一行指针** | **LLM 看到的永远是"中性事实",消除推断模式泄露;查询路径 indexed;不付出 LLM token 预算** | **采纳(本附录及 §5.0.2 R-4 修订实现)** |
| C. stderr 改写中性措辞,接受双通道可见 | 实现简单但牺牲元解释丰富度 | 否决 |
| D. `--verbose` flag 才输出元数据 | 仍有双码路径;verbose 时仍 LLM 可见 | 否决 |

**LLM-safe 措辞规则**(后续命令开发的硬约束,详见 §5.0.2):

- ❌ 不写 `auto-inferred from keyword "X" via Y_layer`(LLM 会模仿推断模板)
- ❌ 不写完整 shell 命令模板带占位符(LLM 会以为是工作流脚本)
- ❌ 不写 "如果发生 X 那么 Y"(LLM 会以为是用户偏好规则)
- ✅ 写 `meta logged → ccmem audit show 142`(中性指针)
- ✅ 写 `Override with --type fact`(单一片段,无模板)
- ✅ 写 `mode set to shadow`(陈述事实)

**事后清理**:`poc/` 目录与 `.claude/commands/ccmem-poc.md` 在 v0.1 实现
工作开始前由用户手动 `rm -rf` 删除,不作为 ccmem 发布物的一部分。本附录 D
是 PoC 结论的唯一长期记录。

---

## 附录 E：V-1 env 继承 PoC 记录(2026-05-27)

**目的**:验证 slash command 的 `!bash` 是否继承 `CLAUDE_PLUGIN_ROOT` env——
spec §4.3 V-1 与附录 B 的论断"不保证继承"是否真实。

**PoC 文件**(验证后待删除):
- `.claude/commands/ccmem-poc-env.md` — 用 `bash -c '...'` 打印全部 `CLAUDE_*` +
  `ANTHROPIC_*` env 变量 + 基线 env(HOME/PWD/USER/SHELL/PATH)。

**执行**(2026-05-27,当前会话内直接调用 `/ccmem-poc-env`):

**结果**:

| 问题 | 结果 | 意义 |
|---|---|---|
| **Q1: `CLAUDE_PLUGIN_ROOT`** | **`<empty>`** | **V-1 论断成立**:slash command `!bash` 不继承此 env |
| Q2: `CLAUDE_PROJECT_DIR` | `<empty>` | 也不可用 |
| Q3: 可见 `CLAUDE_*` | `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_EXECPATH` / `CLAUDE_EFFORT` | Claude Code 注入部分自身 env,但**不含 plugin root** |
| Q4: 基线 env | HOME / PWD / USER / SHELL / PATH 全正常 | user shell env 整体可用 |
| Q5: `$ARGUMENTS` | 空(本次未传参) | 与附录 D U-CMD-PoC 一致 |

**决议**:

1. **spec §4.3 V-1 + 附录 B 当前设计完全正确**,无需修改:
   - Slash command 走 PATH 上的 `ccmem` CLI(拿不到 `CLAUDE_PLUGIN_ROOT`)
   - Hook 进程走 `${CLAUDE_PLUGIN_ROOT}`(由 hooks.json 机制注入)
   - `ccmem install` 强制 CLI 软链到 PATH(§11.1)

2. **bonus 发现**:`CLAUDE_CODE_SESSION_ID` 在 `!bash` 中可用。v0.2 实现时 ccmem
   CLI 可以直接读 `process.env.CLAUDE_CODE_SESSION_ID` 关联 `recent_injections`
   表的 `session_id` 列,而不需要从 stdin hookData 传递——这简化了 slash command
   与 hook 两条路径的 session 归因逻辑。

3. **ECC 的 inline 路径解析的真相**:ECC hooks.json 里每条 hook 的 2000 字符
   inline `node -e` 会先尝试读 `process.env.CLAUDE_PLUGIN_ROOT`,如有则用;如无
   则走 5 级 fallback 自行 resolve 后**手动设入 env**(`process.env.CLAUDE_PLUGIN_ROOT = r`)
   再 spawnSync 子进程。这说明 Claude Code 对 hook 进程也**不保证**注入此 env——
   ECC 的 resolve + 手动设 env 是防御式编程。**ccmem 选择强制要求 v2.1+ 并加
   fallback exit 0 是更简洁的取舍**(不兼容老版本,但 packaging 干净)。

**事后清理**:`.claude/commands/ccmem-poc-env.md` 在 v0.1 实现工作开始前由用户
手动 `rm -rf .claude/commands/ccmem-poc-env.md` 删除。本附录 E 是 PoC 结论的
唯一长期记录。
