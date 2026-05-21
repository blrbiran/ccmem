# Claude Code 记忆插件设计方案 v3.0

> 基于 SQLite + 嵌入式向量检索,为 Claude Code 实现持久化记忆系统。
> 利用 Hook 多阶段生命周期实现「热记忆直注 + 按问题检索 + 异步整合」,用 Cron 实现周期性深度反思。
>
> **v3.0 是 greenfield 重写**,放弃了 v2.1 的所有妥协设计,以"当前最优"为唯一原则。
> 实现尚未开始,本文档作为 Phase 0 之后所有实现的唯一依据。

---

## v3.0 相对 v2.1 的关键变更

按影响排序,引用 v2.1 章节便于追溯:

| # | 变更 | v2.1 出处 | 原因 |
|---|------|-----------|------|
| 1 | **hot_memory 表降级为 injection_cache(预渲染缓存)**;`pinned` 改为 `memories.pinned` 字段;每条 hot 行带隐式 `<!--mXXX-->` 注释,反馈机制天然可追溯 | §4.1 / §6.1 / §11.1 | 旧设计中段级注入断了反馈闭环,近半注入内容不参与 trust 调整 |
| 2 | **`/ccmem:forget` 改为同步级联**,立即降级所有引用此 id 的 consolidated + 失效 hot 段 | §7.5 / §10.4 / §12 | 旧设计的级联在周级 security_audit 才生效,用户体验失败 |
| 3 | **frequency_factor 改为 sigmoid + floor 0.1**,惩罚系数 1.5→2.0,允许负反馈占主导 | §5.1 | 旧公式在负向场景可输出负数 priority,数学上不可解释 |
| 4 | **写入闸门 `insertMemory()` 统一所有写入路径**(用户/cron/summarize_pending) | §10.1 缺失 | 旧设计中 LLM 抽取路径绕过模式扫描,投毒防御有缺口 |
| 5 | **三层意图判别取代单一模式黑白名单**:Tier 1 always-block / Tier 2 context-gated / Tier 3 semantic-review;在代码块/引号内、有解释性后续的危险词不阻止 | §10.1 / §10.2 | 用户讨论 unix 命令时大量假阳性 |
| 6 | **危险命令强制降级**:Tier 2 命中时 `type` 被强制为 `episode`、`scope` 强制为 `project`、`trust` 上限 0.6;`/ccmem:promote` 提供逐字声明覆盖路径 | 新增 | 防止时效性内容被错误升级为通用规则 |
| 7 | **daemon 自动拉起 + 心跳 + 单实例锁**;hook 探测 daemon 不健康则 `spawn detached` 接管 | §17 known unknown | 旧设计下 daemon 静默死亡无人监控 |
| 8 | **文件触发器 daemon.wake 跨平台唤醒**,放弃 SIGUSR1 Unix-only 方案 | §6.4 / §7.6 | 跨平台双实现成本高,文件触发器够用 |
| 9 | **嵌入向量改为多 vec_index 表 + BLOB 原始存储 + 5 层唯一性防御**(validate→hash 后缀→UNIQUE 约束→运行时活检→repair 命令) | §4.1 维度硬编码 | 模型切换无成本,防 HuggingFace 命名碰撞 |
| 10 | **RetrievalProvider 接口从 Day 1 抽象**(LexicalProvider / HybridProvider / DaemonIpcProvider),Phase 1 用 lexical,Phase 5 评估升级 | §5.2 | 解耦检索策略与 hook 逻辑 |
| 11 | **/ccmem:mode 统一启停**(`active` / `shadow` / `off`),取消 `enable`/`disable` 双义命令 | §12 | 命令语义清晰 |
| 12 | **`/ccmem:purge-*` 走特批高危删除**(强确认 + 显示删除总大小 + 审计) | §12 | 防误删用户数据 |
| 13 | **safe-fs 模块封装所有删除**:绝对路径 + realpath + 白名单根目录 + 类型检查 + 文件名 pattern;**永不使用 `rm -rf`** | 缺失 | 防符号链接逃逸、路径误解析 |
| 14 | **Schema 加 `schema_meta` 版本表**;`cron_task_state` 加锁字段(`lock_holder` / `lock_acquired_at`);`memories` 加 `generation` / `pinned` / `last_revalidated_at` 字段 | §4.1 / §7.6 | 支持平滑迁移、并发去重、防止二级整合 |
| 15 | **反馈推断 L1 加 code-block / quote / imperative 信号判别**,降低代码引用造成的假阳性 | §6.6 L1 | 中英开发者频繁在 prompt 中粘代码 |
| 16 | **性能预算硬约束**(SessionStart p95 ≤ 300ms,UserPromptSubmit p95 ≤ 500ms,Stop/PreCompact p95 ≤ 80ms);`/ccmem:bench` 命令测量 | 缺失 | 防 hook 链阻塞用户感知 |
| 17 | **统一注入格式规范**:type 单字母 + trust + age + 状态后缀(`!p`/`!c`/`!ctx`);verbose / compact / raw 三档,默认 compact | §11.2 不一致 | LLM 解读一致性 |
| 18 | **`cache_hit_rate` 字段移除**;`memory_audit_log` 表加入 schema | §13 / §10.1 | 不可观测的指标删除,审计是一等公民 |
| 19 | **目录结构按"代码/用户数据/项目数据"三分**;插件目录卸载不丢用户数据 | §15 不一致 | 升级与清理路径清晰 |
| 20 | **OpenWolf cerebrum.md 段落映射规则明确**(User Preferences→global rule, Key Learnings→project fact, Do-Not-Repeat→project rule + tag) | §9.1 模糊 | 双系统数据流可追溯 |

---

## 一、设计目标

在不修改 LLM 权重的前提下,通过应用层机制为 Claude Code 提供:

1. **跨会话记忆持久化**:会话结束后记忆不丢失
2. **多阶段记忆触达**:启动注入背景 + 按 prompt 检索细节 + 压缩前抢救 + 结束沉淀
3. **可追溯的反馈闭环**:每条注入的记忆都能精确回写 trust
4. **自动衰减与整合**:旧记忆按 half-life 自然淡出,cron 做深度整合
5. **双层作用域**:全局通用记忆 + 项目专属记忆
6. **强投毒防御**:三层意图判别 + 强制降级 + 周期复核
7. **可观测、可控制**:用户可查可改可禁用,系统有反馈指标
8. **跨平台运行**:macOS / Linux / Windows 同等行为

---

## 二、技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 嵌入式向量索引 | **sqlite-vec** (按需 opt-in) | 纯进程内,无需常驻服务 |
| 全文检索 | **SQLite FTS5** | 与向量同库,支持三路融合,内置 |
| 词重叠检索 | **FTS5 候选 + 内存 Jaccard 计算** | < 2k 记忆下延迟 < 50ms,无额外依赖 |
| Embedding 模型(opt-in) | 本地 `Xenova/bge-small-zh-v1.5` / `Xenova/all-MiniLM-L6-v2` 通过 `@xenova/transformers` | 完全本地,无隐私问题 |
| Hook 语言 | Node.js ESM | 与 OpenWolf hooks 一致,Claude Code 内置 |
| LLM 整合调用 | `claude -p` 子进程 | 仅在 cron 异步任务里调用,不在 hook 里同步等待 |
| Cron 实现 | **检测到 OpenWolf 时复用 cron-engine**(插件模式)/ 否则 `node-cron` 自托管(独立模式) | 复用 retry/backoff/dead-letter,跨平台 |
| 项目根目录定位 | `CLAUDE_PROJECT_DIR` 环境变量 | 比 cwd 更稳,worktree 切换不会乱 |
| 用户数据存储路径 | `~/.claude/ccmem/global.db` + `<project>/.ccmem/project.db` | 物理分离,便于迁移/清理 |
| Daemon 跨平台唤醒 | 文件触发器 `daemon.wake` + `fs.watch` + 轮询降级 | 替代 SIGUSR1,跨平台一致 |

---

## 三、架构总览

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Claude Code 会话                                │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  SessionStart           UserPromptSubmit      PreCompact      Stop     │
│  ┌────────────────┐    ┌────────────────┐   ┌──────────┐  ┌────────┐  │
│  │ 读 injection_  │    │ Provider.retrieve│  │ 估算~70%*│  │ 入队列 │  │
│  │ cache + pinned │    │ 写 feedback     │   │ 入队列   │  │ 写 wake│  │
│  │ + fresh,注入   │    │ stdout JSON     │   │ 不注入   │  │ 不阻塞 │  │
│  │ 写 feedback    │    │                 │   │          │  │ exit 0 │  │
│  └────────┬───────┘    └────────┬───────┘   └────┬─────┘  └───┬────┘  │
│           │                     │                │            │       │
│           ▼                     ▼                ▼            ▼       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              SQLite (global.db / project.db)                      │  │
│  │  ┌───────────┐ ┌──────────────┐ ┌───────────────┐                │  │
│  │  │ memories  │ │ memories_fts │ │ vec_<model>   │                │  │
│  │  │           │ │ (FTS5)       │ │ (opt-in)      │                │  │
│  │  └───────────┘ └──────────────┘ └───────────────┘                │  │
│  │  ┌───────────┐ ┌──────────────┐ ┌───────────────┐                │  │
│  │  │injection_ │ │ pending_     │ │ memory_       │                │  │
│  │  │cache      │ │ summarize    │ │ feedback      │                │  │
│  │  └───────────┘ └──────────────┘ └───────────────┘                │  │
│  │  ┌───────────────┐ ┌──────────────┐ ┌────────────────┐           │  │
│  │  │ consolidated_ │ │ cron_task_   │ │ memory_audit_  │           │  │
│  │  │ lineage       │ │ state        │ │ log            │           │  │
│  │  └───────────────┘ └──────────────┘ └────────────────┘           │  │
│  │  ┌─────────────────┐ ┌──────────────────────┐                    │  │
│  │  │ embedding_      │ │ schema_meta          │                    │  │
│  │  │ model_registry  │ │                      │                    │  │
│  │  └─────────────────┘ └──────────────────────┘                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                ▲                                       │
│                                │ daemon.wake 文件触发                  │
│                                │                                       │
├────────────────────────────────────────────────────────────────────────┤
│                       Daemon (独立或 OpenWolf cron-engine)             │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ summarize_pending  自适应轮询(1-30s 活跃 / 5min 空闲)            │  │
│  │ daily_consolidation     每日 02:17,catch-up 24h                  │  │
│  │ weekly_reflection       每周日 03:17,catch-up 7d (C8)            │  │
│  │ security_audit          每周一 04:17,catch-up 72h                │  │
│  │ revalidation_audit      每周三 04:17,catch-up 72h(C2 复核)      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

时间用 `:17` 等非整点,避开 cron 调度峰值。

---

## 四、数据模型

### 4.1 SQLite Schema

```sql
-- Schema version (migration support)
CREATE TABLE schema_meta (
  version    INTEGER PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL,
  notes      TEXT
);
INSERT INTO schema_meta VALUES (1, datetime('now'), 'initial schema v3.0');

-- Main table
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,            -- mem_<8hex>_<rand>
  scope           TEXT NOT NULL,               -- 'global' | 'project'
  project_key     TEXT,                        -- project identifier (see section 8)

  -- Type and source
  type            TEXT NOT NULL,               -- 'rule'|'fact'|'skill'|'episode'|'consolidated'
  source          TEXT NOT NULL,               -- 'user_explicit'|'tool_output'|'auto_inferred'|'cron_consolidated'|'external'|'cerebrum_import'
  content         TEXT NOT NULL,               -- recommended <= 200 chars

  -- Trust and decay
  trust_score          REAL DEFAULT 0.5,
  base_priority        REAL DEFAULT 1.0,
  half_life_days       REAL NOT NULL,
  decay_status         TEXT DEFAULT 'active',  -- 'active'|'probation'|'quarantine'|'candidate_expire'|'archived'

  -- Behavior flags
  pinned               INTEGER DEFAULT 0,      -- 0|1, user pinned
  generation           INTEGER DEFAULT 0,      -- 0=raw, 1=first consolidation, >=2 forbidden
  last_revalidated_at  TIMESTAMP,              -- periodic revalidation timestamp
  revalidation_count   INTEGER DEFAULT 0,
  requires_revalidation INTEGER DEFAULT 0,     -- 0|1, derived from tags (C12.1 index optimization)

  -- Frequency and time
  recall_count    INTEGER DEFAULT 0,
  helpful_count   INTEGER DEFAULT 0,
  unhelpful_count INTEGER DEFAULT 0,
  last_touched_at TIMESTAMP NOT NULL,
  created_at      TIMESTAMP NOT NULL,
  probation_until TIMESTAMP,

  -- Context
  session_id      TEXT,
  modified_by     TEXT DEFAULT 'system',       -- 'user'|'system'|'cron' (used by M10)
  modified_at     TIMESTAMP,
  tags            TEXT                          -- JSON array
);

CREATE INDEX idx_mem_scope_status ON memories(scope, decay_status);
CREATE INDEX idx_mem_project ON memories(project_key) WHERE project_key IS NOT NULL;
CREATE INDEX idx_mem_touched ON memories(last_touched_at);
CREATE INDEX idx_mem_pinned ON memories(pinned) WHERE pinned = 1;
-- Revalidation index: use boolean field instead of LIKE for performance (C12.1)
CREATE INDEX idx_mem_revalidation ON memories(last_revalidated_at) 
  WHERE requires_revalidation = 1;

-- Trigger to keep requires_revalidation in sync with tags (C12.1.1)
CREATE TRIGGER sync_requires_revalidation_on_update 
AFTER UPDATE OF tags ON memories
BEGIN
  UPDATE memories SET requires_revalidation = 
    CASE WHEN NEW.tags LIKE '%require_periodic_revalidation%' THEN 1 ELSE 0 END
  WHERE id = NEW.id;
END;

-- FTS5 full-text index
CREATE VIRTUAL TABLE memories_fts USING fts5(
  id UNINDEXED,
  content,
  tags,
  tokenize = 'porter unicode61'
);

-- consolidated source lineage
CREATE TABLE consolidated_lineage (
  consolidated_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (consolidated_id, source_memory_id)
);
CREATE INDEX idx_lineage_source ON consolidated_lineage(source_memory_id);

-- Pre-rendered cache (SessionStart performance optimization)
CREATE TABLE injection_cache (
  scope         TEXT NOT NULL,               -- 'global' | 'project:<project_key>'
  segment       TEXT NOT NULL,               -- 'consolidated' | 'pinned' | 'fresh'
  rendered_text TEXT NOT NULL,               -- rendered text with <!--m1234--> markers
  member_ids    TEXT NOT NULL,               -- JSON array of memories.id
  rendered_at   TIMESTAMP NOT NULL,
  ttl_seconds   INTEGER,                      -- consolidated=604800, fresh=86400, pinned=NULL
  version       INTEGER DEFAULT 1,           -- monotonic version for race condition prevention (C4.1)
  PRIMARY KEY (scope, segment)
);

-- Cron task state + concurrency lock
CREATE TABLE cron_task_state (
  task_id                  TEXT PRIMARY KEY,
  schedule                 TEXT NOT NULL,
  last_success_at          INTEGER,
  last_attempt_at          INTEGER,
  last_error               TEXT,
  next_due_at              INTEGER NOT NULL,
  max_catch_up_window_sec  INTEGER NOT NULL,

  -- Concurrency lock (M2)
  lock_holder              TEXT,              -- 'daemon'|'hook'|pid identifier
  lock_acquired_at         INTEGER,
  lock_ttl_sec             INTEGER DEFAULT 600
);

-- Pending summarization queue
CREATE TABLE pending_summarize (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT,
  project_key  TEXT,
  priority     INTEGER DEFAULT 0,             -- 0=normal, 10=high (Stop-triggered)
  trigger      TEXT NOT NULL,                 -- 'pre_compact' | 'session_end' | 'manual'
  raw_payload  TEXT NOT NULL,
  enqueued_at  TIMESTAMP NOT NULL,
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX idx_pending_priority ON pending_summarize(priority DESC, enqueued_at ASC);

-- Feedback and evaluation
CREATE TABLE memory_feedback (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT,
  injected_ids       TEXT NOT NULL,           -- JSON array
  injection_source   TEXT NOT NULL,           -- 'session_start'|'user_prompt_submit'
  prompt_excerpt     TEXT,                    -- char-count truncated to 100
  outcome            TEXT,                    -- 'helpful'|'unhelpful'|'helpful_implicit'|'unknown'
  outcome_locked     INTEGER DEFAULT 0,       -- 1 = L4 LLM review has locked this
  evidence           TEXT,
  recorded_at        TIMESTAMP NOT NULL
);
CREATE INDEX idx_feedback_session_outcome ON memory_feedback(session_id, outcome);

-- Audit log
CREATE TABLE memory_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TIMESTAMP NOT NULL,
  action          TEXT NOT NULL,              -- 'insert_blocked'|'cascade_archive'|'mode_change'|'promote_to_rule'|...
  reason          TEXT,
  source          TEXT,
  session_id      TEXT,
  affected_ids    TEXT,                       -- JSON array
  details         TEXT                        -- JSON blob
);
CREATE INDEX idx_audit_ts ON memory_audit_log(ts);
CREATE INDEX idx_audit_action ON memory_audit_log(action);

-- Embedding model registry (H2)
CREATE TABLE embedding_model_registry (
  model_id        TEXT PRIMARY KEY,
  vec_table_name  TEXT NOT NULL UNIQUE,
  dim             INTEGER NOT NULL,
  registered_at   TIMESTAMP NOT NULL,
  status          TEXT NOT NULL,              -- 'downloading'|'ready'|'failed'|'deprecated'

  CHECK (model_id GLOB '[a-z0-9]*'),
  CHECK (vec_table_name GLOB 'vec_*')
);

-- Embedding raw data (arbitrary dim; model switch needs no schema change)
CREATE TABLE memory_embedding (
  memory_id    TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL REFERENCES embedding_model_registry(model_id),
  embedding    BLOB NOT NULL,                 -- Float32Array as bytes
  created_at   TIMESTAMP NOT NULL,
  PRIMARY KEY (memory_id, model_id)
);
CREATE INDEX idx_emb_model ON memory_embedding(model_id);

-- Active embedding model (single-row table)
CREATE TABLE embedding_active (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  active_model    TEXT NOT NULL REFERENCES embedding_model_registry(model_id),
  enabled_at      TIMESTAMP NOT NULL
);

-- Session context tracking (for PreCompact strategy 2)
CREATE TABLE session_context (
  session_id       TEXT PRIMARY KEY,
  project_key      TEXT,
  important_facts  TEXT,                -- JSON array of key facts discovered
  recent_decisions TEXT,                -- JSON array of decisions made
  tool_call_count  INTEGER DEFAULT 0,
  message_count    INTEGER DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL
);
CREATE INDEX idx_session_context_project ON session_context(project_key);

-- Daily metrics (M6, replaces metrics.json file)
CREATE TABLE daily_metrics (
  date         TEXT PRIMARY KEY,              -- YYYY-MM-DD
  metrics_json TEXT NOT NULL,
  updated_at   TIMESTAMP NOT NULL
);

-- Mode state (S4)
CREATE TABLE mode_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  mode        TEXT NOT NULL,                  -- 'active'|'shadow'|'off'
  set_at      TIMESTAMP NOT NULL,
  set_by      TEXT NOT NULL                    -- 'user_command'|'install_default'|...
);
-- Initialize default mode on schema creation
INSERT INTO mode_state (id, mode, set_at, set_by) 
VALUES (1, 'active', datetime('now'), 'install_default');

-- Daemon singleton lock (cross-platform, C3)
CREATE TABLE daemon_lock (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  holder_pid      INTEGER NOT NULL,
  holder_hostname TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,           -- Unix timestamp ms
  heartbeat_at    INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1  -- optimistic lock
);
```

### 4.2 记忆类型

| type | 含义 | base_priority | half_life_days | 默认 trust 上限 |
|------|------|---------------|----------------|----------------|
| `rule` | 用户偏好 / 项目规则 | 1.2 | 90 | 0.95 |
| `fact` | 事实(技术栈、配置、路径) | 1.0 | 60 | 0.9 |
| `skill` | 可复用操作方法论 | 1.3 | 90 | 0.9 |
| `episode` | 一次性情景片段 | 0.7 | 14 | 0.7 |
| `consolidated` | cron 整合产出的高阶规则 | 1.5 | 180 | 0.95 |

### 4.3 来源分级 trust

| source | 初始 trust | 观察期天数 | 注入前最低 trust |
|--------|-----------|-----------|------------------|
| `user_explicit` | 0.9 | 0 | — |
| `cron_consolidated` | 0.85 | 0 | — |
| `tool_output` | 0.7 | 7 | 0.5 |
| `auto_inferred` | 0.5 | 14 | 0.5 |
| `external`(MCP 等) | 0.3 | 14 | 0.6 |
| `cerebrum_import`(从 OpenWolf cerebrum.md 同步) | 0.8 | 7 | 0.5 |

观察期内 trust 上限锁为 0.6,被显式否定 → 直接删除,被肯定 → 提前结束观察期。

**`cron_consolidated` 不进入观察期**:其输入均来自已通过观察期的高 trust 记忆,但仍受 `security_audit` 级联降级保护。

### 4.4 trust 不对称调整

```
被肯定一次(显式): trust += 0.05  (上限 = source 类别上限)
被肯定一次(隐式): trust += 0.025 (helpful_implicit,沉默通过)
被否定一次:       trust -= 0.10  (下限 0.0,< 0.2 转 archived)
被纠正一次:       trust -= 0.15
被整合保留:       trust += 0.03
被整合淘汰:       trust = 0
级联降级(部分):  trust -= 0.10
级联降级(过半):  trust -= 0.30
```

惩罚 > 奖励:让错误记忆退场更快。

**Trust 阈值自动归档**: 当 `trust_score < 0.2` 时,记忆自动转为 `archived` 状态。
此逻辑在以下位置执行:
1. `applyOutcome()` 中 trust 调整后立即检查
2. `daily_consolidation` 兜底扫描

> **C7 注**: 上述系数 (0.05/0.10 等) 为初始经验值,缺乏 A/B 测试支撑。
> 1. 已通过 `config.trust.rewardOnHelpful` 等配置项支持调整
> 2. `daily_metrics` 追踪 trust 分布变化,便于后续调优
> 3. Phase 5 评估后可能调整默认值
>
> **Trust 分布监控指标**(daily_metrics.memory_health):
> - `trust_histogram`: 按 0.1 分桶的 trust 分布
> - `trust_drift_7d`: 7 天内平均 trust 变化(检测通胀/紧缩)
> - `low_trust_surge`: trust < 0.4 的记忆数突增告警阈值

### 4.5 SOURCE_MAX_TRUST 常量(H8)

```javascript
// lib/trust-constants.mjs
export const SOURCE_MAX_TRUST = {
  user_explicit:     0.95,
  cron_consolidated: 0.95,
  tool_output:       0.90,
  auto_inferred:     0.80,
  external:          0.70,
  cerebrum_import:   0.85,
};
```

### 4.6 Embedding Model Identity 模块(5 层唯一性防御)

为防止 HuggingFace 模型命名碰撞、用户手动编辑 registry 导致不一致等问题,统一通过 `model-identity.mjs` 模块管理模型注册。

#### 5 层防御链

| 层 | 名称 | 防御目标 | 实现 |
|----|------|---------|------|
| 1 | 格式校验 | 非法字符/保留前缀 | `validateModelId()` 正则 + 黑名单 |
| 2 | 命名空间 | 不同来源同名模型碰撞 | `hf_xenova_bge_small` 前缀区分 |
| 3 | 配置哈希 | 同名但配置不同的模型 | `vec_<model>_<sha256(dim+vocab+type)[:8]>` |
| 4 | DB 约束 | 重复注册 | `UNIQUE(vec_table_name)` |
| 5 | 运行时活检 | 物理表/registry 漂移 | `verifyModelIntegrity()` 检查 dim/count |

#### 核心函数

```javascript
// lib/model-identity.mjs

const MODEL_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const RESERVED_PREFIXES = ['vec_', 'ccmem_', 'test_'];

// Layer 1: 格式校验
export function validateModelId(rawId) {
  const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new InvalidModelIdError(`Invalid model ID format: ${rawId}`);
  }
  if (RESERVED_PREFIXES.some(p => id.startsWith(p))) {
    throw new InvalidModelIdError(`Reserved prefix: ${rawId}`);
  }
  return id;
}

// Layer 2: 命名空间(防 HuggingFace org 碰撞)
export function namespacedModelId(source, modelName) {
  // source: 'hf' | 'local' | 'custom'
  // Example: hf/Xenova/bge-small-zh-v1.5 → hf_xenova_bge_small_zh_v1_5
  const normalized = `${source}_${modelName}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48);
  return validateModelId(normalized);
}

// Layer 3: 配置哈希(同名不同配置 → 不同表)
export function vecTableName(modelId, configHash) {
  const suffix = configHash.slice(0, 8);
  const tableName = `vec_${modelId}_${suffix}`;
  
  // C11.1: Extra SQL safety validation for dynamic table names
  // Defense-in-depth even though modelId is already validated
  if (!/^vec_[a-z0-9_]{1,50}_[a-f0-9]{8}$/.test(tableName)) {
    throw new Error(`Invalid table name format: ${tableName}`);
  }
  
  return tableName;
}

// Layer 5: 运行时活检
export async function verifyModelIntegrity(db, modelId) {
  const registry = await db.get(`
    SELECT * FROM embedding_model_registry WHERE model_id = ?
  `, [modelId]);
  if (!registry) return { ok: false, error: 'not_in_registry' };

  // 检查物理表存在
  const table = await db.get(`
    SELECT name FROM sqlite_master WHERE type='table' AND name = ?
  `, [registry.vec_table_name]);
  if (!table) return { ok: false, error: 'table_missing' };

  // 检查维度一致性
  const tableInfo = await db.all(`PRAGMA table_info(${registry.vec_table_name})`);
  const embCol = tableInfo.find(c => c.name === 'embedding');
  const dimMatch = embCol?.type.match(/FLOAT\[(\d+)\]/);
  const actualDim = dimMatch ? parseInt(dimMatch[1]) : null;
  if (actualDim !== registry.dim) {
    return { ok: false, error: 'dim_mismatch', expected: registry.dim, actual: actualDim };
  }

  return { ok: true };
}
```

#### 注册流程

```javascript
export async function registerModel(db, modelConfig) {
  const modelId = namespacedModelId(modelConfig.source, modelConfig.name);
  const configHash = sha256(`${modelConfig.dim}:${modelConfig.vocab_size}:${modelConfig.type}`);
  const tableName = vecTableName(modelId, configHash);

  await db.transaction(async (tx) => {
    const existing = await tx.get(`
      SELECT * FROM embedding_model_registry WHERE model_id = ?
    `, [modelId]);

    if (existing && existing.vec_table_name !== tableName) {
      throw new ModelCollisionError(
        `Model ${modelId} already registered with different config`
      );
    }

    if (!existing) {
      await tx.run(`
        INSERT INTO embedding_model_registry 
        (model_id, vec_table_name, dim, registered_at, status)
        VALUES (?, ?, ?, ?, 'downloading')
      `, [modelId, tableName, modelConfig.dim, now()]);

      await tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
        USING vec0(embedding FLOAT[${modelConfig.dim}])
      `);
    }
  });

  return { modelId, tableName };
}
```

---

## 五、优先级与检索

### 5.1 优先级公式(C4 修正版)

```javascript
priority = base_priority
         × recency_factor      // natural half-life decay
         × frequency_factor    // sigmoid + floor, modulated by trust
         × trust_score         // poisoning defense core
```

各因子:

```javascript
// Half-life decay
function recencyFactor(daysSinceTouched, halfLifeDays) {
  return Math.pow(0.5, daysSinceTouched / halfLifeDays);
}

// Frequency factor: sigmoid decay with floor
function frequencyFactor(helpfulCount, unhelpfulCount, trustScore) {
  const signal = helpfulCount - 2.0 * unhelpfulCount;  // penalty coefficient = 2.0

  if (signal >= 0) {
    // Positive: higher trust amplifies boost
    return Math.min(1 + 0.08 * signal * trustScore, 1.8);
  } else {
    // Negative: trust-independent sigmoid decay, floor 0.1
    const x = Math.abs(signal);
    return Math.max(0.1, 1 / (1 + 0.15 * x));
  }
}
```

注入门槛:
- `trust_score >= source 对应最低值`(见 §4.3)
- `decay_status IN ('active', 'probation')`(不含 `quarantine`)
- 观察期记忆额外打 ×0.5 注入权重

### 5.2 RetrievalProvider 抽象(H3)

```javascript
// lib/retrieve.mjs
export class LexicalProvider {
  async retrieve(query, scope, topK) {
    const [ftsHits, jaccardHits] = await Promise.all([
      ftsSearch(query, scope, /*candidates=*/30),
      jaccardSearch(query, scope, /*candidates=*/30),
    ]);
    return fuseScores({
      fts:     { hits: ftsHits, weight: 0.6 },
      jaccard: { hits: jaccardHits, weight: 0.4 },
    }).slice(0, topK);
  }
  async warmup() { /* no-op */ }
}

export class HybridProvider {
  async retrieve(query, scope, topK) {
    const [ftsHits, jaccardHits, vecHits] = await Promise.all([
      ftsSearch(query, scope, 30),
      jaccardSearch(query, scope, 30),
      vectorSearch(query, scope, 30),
    ]);
    return fuseScores({
      fts:     { hits: ftsHits,     weight: 0.4 },
      jaccard: { hits: jaccardHits, weight: 0.3 },
      vec:     { hits: vecHits,     weight: 0.3 },
    }).slice(0, topK);
  }
  async warmup() { return ensureVecIndexLoaded(); }
}

export class DaemonIpcProvider {
  // Phase 5 option A: route through daemon-exposed unix socket
  constructor(socketPath) { this.socketPath = socketPath; }
  async retrieve(query, scope, topK) {
    return await ipcCall(this.socketPath, '/retrieve',
                          { query, scope, topK }, { timeoutMs: 500 });
  }
  async warmup() { return ipcCall(this.socketPath, '/health'); }
}

export class PrefetchProvider {
  // Phase 5 option B: Stop hook pre-warms the likely next-turn query
  async retrieve(query, scope, topK) {
    const cached = await readPrefetchCache(query, scope);
    if (cached) return cached;
    return await fallbackProvider.retrieve(query, scope, topK);
  }
}

export function getRetrievalProvider(config) {
  switch (config.retrieval.mode) {
    case 'lexical':  return new LexicalProvider();
    case 'hybrid':   return new HybridProvider();
    case 'daemon':   return new DaemonIpcProvider(config.retrieval.daemon_socket);
    case 'prefetch': return new PrefetchProvider();
    default: throw new Error(`Unknown retrieval mode: ${config.retrieval.mode}`);
  }
}
```

**Phase 1 默认 lexical;Phase 5 评估升级。**

### 5.3 Jaccard 实现(H1)

复用 FTS5 倒排索引降低成本:

```javascript
async function jaccardSearch(query, scope, candidates) {
  // 1. Use FTS5 to pull candidates (already tokenized).
  //    Pull candidates*3 to leave headroom after filtering.
  const ftsCandidates = await db.all(`
    SELECT m.id, m.content
    FROM memories_fts f
    JOIN memories m ON m.id = f.id
    WHERE memories_fts MATCH ? AND m.decay_status IN ('active', 'probation')
      AND (m.scope = 'global' OR m.project_key = ?)
    LIMIT ?
  `, [query, scope, candidates * 3]);

  // 2. Compute Jaccard in memory, only over the FTS5-returned candidates (<100 rows)
  const queryTokens = tokenize(query);
  return ftsCandidates
    .map(m => ({ id: m.id, score: jaccard(queryTokens, tokenize(m.content)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidates);
}
```

延迟实测预期:< 2k 记忆下 < 50ms。

### 5.4 召回反馈机制

注入后:
- `recall_count++`,`last_touched_at = now`
- 写入 `memory_feedback`(`outcome='unknown'`)
- 下一个 UserPromptSubmit / Stop 时回填 outcome(详见 §6.6)

---

## 六、Hook 设计(四阶段)

### 6.1 SessionStart

> **VERIFIED (2026-05-21)**: SessionStart hook 实际输入 schema:
> ```typescript
> { hook_event_name: 'SessionStart', source: 'startup'|'resume'|'clear'|'compact',
>   agent_type?: string, model?: string, session_id, transcript_path, cwd }
> ```

```javascript
async function handleSessionStart(hookData) {
  const { run, mode } = await shouldHookRun();
  if (!run) { process.exit(0); }

  const projectKey = resolveProjectKey(process.env.CLAUDE_PROJECT_DIR || hookData.cwd);

  // 1. Pull the four pre-rendered segments
  const [consolidatedGlobal, consolidatedProject, pinned, fresh] = await Promise.all([
    getInjectionCache('global', 'consolidated'),
    getInjectionCache(`project:${projectKey}`, 'consolidated'),
    renderPinned(projectKey),                       // live-rendered, max 20 lines
    renderFresh(projectKey, /*windowHours=*/24),    // live-rendered episodes from last 24h
  ]);

  // 2. Trim and concatenate according to budget (with overflow handling)
  const block = composeInjectionBlock({
    segments: [consolidatedGlobal, consolidatedProject, pinned, fresh],
    budget: config.injection.budget,                // see section 14
  });

  // composeInjectionBlock 裁剪逻辑 (C13.1 实现):
  // 1. 每个 segment 先按自身 budget 裁剪
  // 2. 若总量仍超 total_cap,按 overflow_trim_order 顺序继续裁剪
  //    默认: fresh → consolidated_project → consolidated_global → pinned
  // 3. pinned 最后裁剪(用户明确 pin 的内容优先保留)
  // 4. 若 pinned 单独超过 total_cap,截断并记录 audit

  // 3. Record feedback (C1 critical)
  const allMembers = uniqueIds([
    ...consolidatedGlobal.member_ids,
    ...consolidatedProject.member_ids,
    ...pinned.member_ids,
    ...fresh.member_ids,
  ]);
  await recordFeedback({
    session_id: hookData.session_id,
    injected_ids: JSON.stringify(allMembers),
    injection_source: 'session_start',
    outcome: 'unknown',
  });

  // 4. Bump recall counters (batched)
  if (allMembers.length > 0) {
    await db.run(`
      UPDATE memories SET recall_count = recall_count + 1, last_touched_at = ?
      WHERE id IN (${allMembers.map(() => '?').join(',')})
    `, [now(), ...allMembers]);
  }

  // 5. Lazy catch-up (<50ms, SQL-only + enqueue)
  if (config.cron.lazy_catch_up_on_hook) {
    await lazyCatchUpScan();
  }

  // 6. Output (shadow mode does not actually inject)
  const additionalContext = (mode === 'shadow') ? '' : block;
  if (mode === 'shadow') {
    process.stderr.write(`ccmem [shadow]: would inject ${block.length} chars\n`);
  } else {
    process.stderr.write(`ccmem: loaded ${allMembers.length} memories\n`);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));

  process.exit(0);
}
```

#### 6.1.1 composeInjectionBlock 实现 (C13.1)

```javascript
// lib/injection-cache.mjs

/**
 * Compose injection block with budget-aware trimming
 * @param {Object} opts
 * @param {Array<{name: string, text: string, member_ids: string[]}>} opts.segments
 * @param {Object} opts.budget - from config.injection.budget
 * @returns {string} Composed injection text
 */
export function composeInjectionBlock({ segments, budget }) {
  const segmentBudgets = {
    consolidated_global:  budget.consolidated_global  || 1000,
    consolidated_project: budget.consolidated_project || 1000,
    pinned:               budget.pinned               || 1000,
    fresh:                budget.fresh                || 500,
  };
  const totalCap = budget.total_cap || 4000;
  const trimOrder = budget.overflow_trim_order || 
    ['fresh', 'consolidated_project', 'consolidated_global', 'pinned'];

  // 1. Per-segment budget trim (preserve whole entries where possible)
  for (const seg of segments) {
    const segBudget = segmentBudgets[seg.name] || 500;
    if (seg.text.length > segBudget) {
      seg.text = trimToCharLimit(seg.text, segBudget, { preserveWholeEntries: true });
      seg.trimmed = true;
    }
  }

  // 2. Total overflow handling
  let total = segments.reduce((sum, seg) => sum + seg.text.length, 0);
  
  for (const segName of trimOrder) {
    if (total <= totalCap) break;
    
    const seg = segments.find(s => s.name === segName);
    if (!seg || seg.text.length === 0) continue;
    
    const excess = total - totalCap;
    const newLen = Math.max(0, seg.text.length - excess);
    seg.text = trimToCharLimit(seg.text, newLen, { preserveWholeEntries: true });
    seg.overflowTrimmed = true;
    
    total = segments.reduce((sum, s) => sum + s.text.length, 0);
  }

  // 3. Last resort: if pinned alone exceeds total_cap, hard truncate
  if (total > totalCap) {
    const pinned = segments.find(s => s.name === 'pinned');
    if (pinned && pinned.text.length > 0) {
      const pinnedCap = totalCap - segments
        .filter(s => s.name !== 'pinned')
        .reduce((sum, s) => sum + s.text.length, 0);
      
      if (pinnedCap > 0) {
        pinned.text = pinned.text.slice(0, pinnedCap);
      } else {
        pinned.text = '';
      }
      pinned.hardTruncated = true;
      
      // Log audit for pinned truncation (unusual, indicates misconfiguration)
      logAudit({
        action: 'injection_pinned_truncated',
        details: JSON.stringify({
          original_total: total,
          total_cap: totalCap,
          pinned_truncated_to: pinned.text.length,
        }),
      });
    }
  }

  // 4. Compose final text
  return segments
    .filter(seg => seg.text.length > 0)
    .map(seg => seg.text)
    .join('\n\n');
}

/**
 * Trim text to character limit, preserving whole entries (lines) where possible
 */
function trimToCharLimit(text, limit, opts = {}) {
  if (text.length <= limit) return text;
  
  if (!opts.preserveWholeEntries) {
    return text.slice(0, limit);
  }
  
  // Try to preserve whole lines (entries separated by newlines)
  const lines = text.split('\n');
  let result = '';
  
  for (const line of lines) {
    const candidate = result ? result + '\n' + line : line;
    if (candidate.length > limit) break;
    result = candidate;
  }
  
  // If even first line exceeds limit, hard truncate
  if (result.length === 0 && lines[0]) {
    return lines[0].slice(0, limit);
  }
  
  return result;
}
```

### 6.2 UserPromptSubmit

> **VERIFIED (2026-05-21)**: UserPromptSubmit hook 实际输入 schema:
> ```typescript
> { hook_event_name: 'UserPromptSubmit', prompt: string,
>   session_id, transcript_path, cwd }
> ```

```javascript
async function handleUserPromptSubmit(hookData) {
  const { run, mode } = await shouldHookRun();
  if (!run) { process.exit(0); }

  // 0. Backfill previous-turn outcome first (section 6.6 L1)
  await inferPrevTurnOutcome(hookData.session_id, hookData.prompt || '');

  const userPrompt = hookData.prompt || '';
  const projectKey = resolveProjectKey();

  // 1. Three-lane retrieval (provider selected by config)
  const provider = getRetrievalProvider(config);
  const candidates = await provider.retrieve(userPrompt, projectKey, /*topK=*/12);

  // 2. Filter: trust threshold + dedupe against injection_cache
  const cachedIds = await getCachedMemberIds(projectKey);
  const filtered = candidates
    .filter(c => c.trust_score >= sourceMinTrust(c.source))
    .filter(c => !cachedIds.has(c.id));

  const final = filtered.slice(0, 6);

  // 3. Record feedback
  await recordFeedback({
    session_id: hookData.session_id,
    injected_ids: JSON.stringify(final.map(f => f.id)),
    injection_source: 'user_prompt_submit',
    prompt_excerpt: safeTrimChars(userPrompt, 100),
    outcome: 'unknown',
  });

  // 4. Bump recall counters
  if (final.length > 0) {
    await db.run(`
      UPDATE memories SET recall_count = recall_count + 1, last_touched_at = ?
      WHERE id IN (${final.map(() => '?').join(',')})
    `, [now(), ...final.map(f => f.id)]);
  }

  // 5. Inject
  const block = formatRetrievedBlock(final, config.injection.format);  // see section 11
  const additionalContext = (mode === 'shadow') ? '' : block;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
  process.exit(0);
}
```

### 6.3 PreCompact(H6 修正)

> **VERIFIED (2026-05-21)**: PreCompact hook 实际输入 schema:
> ```typescript
> { hook_event_name: 'PreCompact', trigger: 'manual'|'auto', 
>   custom_instructions: string|null, session_id, transcript_path, cwd }
> ```
> **不包含 messages 数组**。需通过 transcript_path 读取历史。

```javascript
async function handlePreCompact(hookData) {
  const { run } = await shouldHookRun();
  if (!run) { process.exit(0); }

  // PreCompact 不提供 messages，需从 transcript 读取
  // 或依赖 Stop hook 已持续追踪的重要内容
  const transcriptPath = hookData.transcript_path;
  
  // 策略1: 从 transcript 提取即将被压缩的内容
  // CAVEAT (U9): 70% 是启发式估算，Claude Code 实际压缩是 LLM 驱动，非固定比例。
  //              此策略作为"补救"，主要依赖应是 Stop hook 持续追踪 (策略2)。
  let messagesSnapshot = null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const transcript = await parseTranscript(transcriptPath);
      const estimatedRatio = config.preCompact?.estimatedCompactRatio ?? 0.7;
      const boundaryIdx = Math.floor(transcript.length * estimatedRatio);
      messagesSnapshot = transcript.slice(0, boundaryIdx);
    } catch (e) {
      logWarn('PreCompact: failed to parse transcript', e);
    }
  }

  // 策略2 (主策略): 从 session_context 表读取 Stop hook 已追踪的重要内容
  const trackedContext = await db.get(`
    SELECT important_facts, recent_decisions FROM session_context
    WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1
  `, [hookData.session_id]);

  await db.run(`
    INSERT INTO pending_summarize
      (session_id, project_key, priority, trigger, raw_payload, enqueued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    hookData.session_id,
    resolveProjectKey(),
    5,                                   // mid priority
    'pre_compact',
    JSON.stringify({
      trigger: hookData.trigger,         // 'manual' | 'auto'
      custom_instructions: hookData.custom_instructions,
      transcript_path: transcriptPath,
      messages_snapshot: messagesSnapshot,
      tracked_context: trackedContext,
    }),
    now(),
  ]);

  await wakeDaemon();   // see section 7.6
  process.exit(0);
}
```

### 6.4 Stop / SessionEnd

> **VERIFIED (2026-05-21)**: Stop hook 实际输入 schema:
> ```typescript
> { hook_event_name: 'Stop', stop_hook_active: boolean,
>   last_assistant_message?: string, session_id, transcript_path, cwd }
> ```
> **不包含** tool_call_count, message_count, duration_ms。需自行从 transcript 统计。

```javascript
async function handleStop(hookData) {
  const { run } = await shouldHookRun();
  if (!run) { process.exit(0); }

  // 0. L2 inference: assistant self-correction in transcript
  if (hookData.transcript_path) {
    await inferFromTranscript(hookData.session_id, hookData.transcript_path);
  }

  // 从 transcript 统计会话规模（hookData 不提供这些字段）
  let sessionStats = { toolCalls: 0, messageCount: 0, durationMs: 0 };
  if (hookData.transcript_path && fs.existsSync(hookData.transcript_path)) {
    try {
      sessionStats = await computeSessionStats(hookData.transcript_path);
    } catch (e) {
      logWarn('Stop: failed to compute session stats', e);
    }
  }

  const wasSignificant = sessionStats.toolCalls > 3
                      || sessionStats.messageCount > 6;

  if (!wasSignificant) { process.exit(0); }

  await db.run(`
    INSERT INTO pending_summarize
      (session_id, project_key, priority, trigger, raw_payload, enqueued_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    hookData.session_id,
    resolveProjectKey(),
    10,                                  // high priority
    'session_end',
    JSON.stringify({
      last_assistant_message: hookData.last_assistant_message,
      stop_hook_active: hookData.stop_hook_active,
      tool_calls: sessionStats.toolCalls,
      duration_ms: sessionStats.durationMs,
      transcript_path: hookData.transcript_path,
    }),
    now(),
  ]);

  await wakeDaemon();
  process.exit(0);
}
```

### 6.5 settings.json 注册

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command",
                  "command": "node ~/.claude/plugins/ccmem/scripts/hook.mjs session-start",
                  "timeout": 1 }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command",
                  "command": "node ~/.claude/plugins/ccmem/scripts/hook.mjs prompt-submit",
                  "timeout": 2 }]
    }],
    "PreCompact": [{
      "hooks": [{ "type": "command",
                  "command": "node ~/.claude/plugins/ccmem/scripts/hook.mjs pre-compact",
                  "timeout": 1 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command",
                  "command": "node ~/.claude/plugins/ccmem/scripts/hook.mjs stop",
                  "timeout": 1 }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command",
                  "command": "node ~/.claude/plugins/ccmem/scripts/hook.mjs session-end",
                  "timeout": 1 }]
    }]
  }
}
```

> **C12.2 注**: timeout 值与 §6.7 性能预算表对齐,略大于兜底 timeout 以留出系统调度 buffer。

> **VERIFIED (U7)**: Claude Code 对同一 event 的多个 hooks **并行执行** (`Promise.all`)。
> ccmem 每个 event 只注册一个 hook，无顺序依赖问题。若未来扩展为多 hook，
> 需注意它们会同时执行，不能假设顺序。

### 6.6 反馈推断机制(B3)

四层推断架构:

| 层 | 时机 | 成本 | 置信度 | 主要信号 |
|---|------|------|--------|----------|
| L1 显式否定 | UserPromptSubmit 入口 | 零(关键词) | 高 | 用户 prompt 含否定/纠正词 |
| L2 assistant 自纠 | Stop(读 transcript) | 零(关键词) | 中 | assistant 在响应里自我修正 |
| L3 沉默通过 | `summarize_pending` cron 兜底 | 零(计数) | 低 | 连续 N 轮未否定 → helpful_implicit |
| L4 LLM 复核 | `weekly_reflection` cron | LLM 调用 | 高 | 抽样复核 unknown/helpful_implicit |

#### L1 关键词扫描 + 上下文判别(S5 鲁棒性)

```javascript
async function inferPrevTurnOutcome(sessionId, currentPrompt) {
  // C6: Add time window to prevent cross-session feedback conflicts
  //     when multiple Claude Code sessions run concurrently
  const lastInjection = await db.get(`
    SELECT id, injected_ids FROM memory_feedback
    WHERE session_id = ? AND outcome = 'unknown' AND outcome_locked = 0
      AND recorded_at > datetime('now', '-5 minutes')
    ORDER BY recorded_at DESC LIMIT 1
  `, [sessionId]);
  if (!lastInjection) return;

  const NEG = /不对|重做|错了|撤销|这不是|不是我要|不要这样|wrong|redo|not what i (want|asked)|that's (incorrect|wrong)|undo|revert/i;
  const COR = /应该是|改成|换成|不,是|实际上是|should be|actually|i meant|let me clarify/i;

  for (const pattern of [NEG, COR]) {
    const m = currentPrompt.match(pattern);
    if (!m) continue;

    // Context guards (reduce false positives)
    if (isInCodeBlock(currentPrompt, m.index)) continue;        // inside code block -> quoted
    if (isInQuotes(currentPrompt, m.index)) continue;           // inside quotes -> quoted
    if (isLikelyAboutCode(currentPrompt, m.index)) continue;    // adjacent to filename/class -> talking about code

    const reason = pattern === NEG ? 'neg_keyword' : 'correction_keyword';
    await applyOutcome(lastInjection.id, 'unhelpful', `${reason}:${m[0]}`);
    return;
  }
}

function isInCodeBlock(text, index) {
  const before = text.slice(0, index);
  const fencedOpens = (before.match(/^```/gm) || []).length;
  if (fencedOpens % 2 === 1) return true;
  const inlineTicks = countUnescapedTicks(before);
  if (inlineTicks % 2 === 1) return true;
  const codeOpens = (before.match(/<code\b[^>]*>/gi) || []).length;
  const codeCloses = (before.match(/<\/code>/gi) || []).length;
  if (codeOpens > codeCloses) return true;
  const preOpens = (before.match(/<pre\b[^>]*>/gi) || []).length;
  const preCloses = (before.match(/<\/pre>/gi) || []).length;
  if (preOpens > preCloses) return true;
  return false;
}

function isInQuotes(text, index) {
  const before = text.slice(0, index);
  // English double/single quotes, Chinese corner brackets, smart quotes
  return /["'「『](?:[^"'」』]*)$/.test(before.replace(/\\["']/g, ''));
}

function isLikelyAboutCode(text, index) {
  const context = text.slice(Math.max(0, index - 30), index + 30);
  return /\b(\w+\.(ts|js|py|tsx|jsx|mjs|go|rs)|src\/\S+|class\s+\w+|function\s+\w+)\b/.test(context);
}
```

#### L2 transcript assistant 自纠

```javascript
async function inferFromTranscript(sessionId, transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const entries = readTranscriptJsonl(transcriptPath);
  const lastAssistant = [...entries].reverse().find(e => e.type === 'assistant');
  if (!lastAssistant) return;
  const text = extractAssistantText(lastAssistant);

  const SELF_CORRECT = /(actually|on second thought|wait|let me reconsider|i was wrong|你说的对.*我之前|我之前.*错了|其实|应该是|更准确地说)/i;
  if (SELF_CORRECT.test(text)) {
    const lastUnknown = await db.get(`
      SELECT id FROM memory_feedback
      WHERE session_id = ? AND outcome = 'unknown' AND outcome_locked = 0
      ORDER BY recorded_at DESC LIMIT 1
    `, [sessionId]);
    if (lastUnknown) {
      await applyOutcome(lastUnknown.id, 'unhelpful', 'assistant_self_correction');
    }
  }
}
```

#### L3 沉默通过

```sql
UPDATE memory_feedback
SET outcome = 'helpful_implicit', evidence = 'silence_passthrough'
WHERE outcome = 'unknown' AND outcome_locked = 0
  AND (SELECT COUNT(*) FROM memory_feedback mf2
       WHERE mf2.session_id = memory_feedback.session_id
         AND mf2.recorded_at > memory_feedback.recorded_at) >= ?
```

#### L4 LLM 复核

`weekly_reflection` 抽样 `unknown` / `helpful_implicit` 让 LLM 看 transcript 上下文判别,结果写回并设 `outcome_locked = 1`,防止 L1-L3 后续覆写。

#### trust 调整统一收口

```javascript
async function applyOutcome(feedbackId, outcome, evidence) {
  // Check if locked by prior L4 review (M8)
  const fb = await db.get(`
    SELECT outcome_locked, injected_ids FROM memory_feedback WHERE id = ?
  `, [feedbackId]);
  if (!fb) return;
  if (fb.outcome_locked) return;

  await db.run(`UPDATE memory_feedback SET outcome=?, evidence=? WHERE id=?`,
               [outcome, evidence, feedbackId]);

  const ids = JSON.parse(fb.injected_ids);
  for (const memId of ids) {
    const maxTrust = await getSourceMaxTrust(memId);
    if (outcome === 'unhelpful') {
      await db.run(`UPDATE memories SET
        trust_score = MAX(0, trust_score - 0.10),
        unhelpful_count = unhelpful_count + 1
        WHERE id = ?`, [memId]);
    } else if (outcome === 'helpful') {
      await db.run(`UPDATE memories SET
        trust_score = MIN(?, trust_score + 0.05),
        helpful_count = helpful_count + 1
        WHERE id = ?`, [maxTrust, memId]);
    } else if (outcome === 'helpful_implicit') {
      await db.run(`UPDATE memories SET
        trust_score = MIN(?, trust_score + 0.025),
        helpful_count = helpful_count + 1
        WHERE id = ?`, [maxTrust, memId]);
    }

    // Auto-archive when trust drops below threshold (§4.4)
    await db.run(`
      UPDATE memories SET decay_status = 'archived', modified_at = ?
      WHERE id = ? AND trust_score < 0.2 AND decay_status != 'archived'
    `, [now(), memId]);
  }
}
```

### 6.7 性能预算(H5)

| Hook | p50 预算 | p95 预算 | 兜底 timeout(降级) | settings.json timeout |
|------|---------|---------|---------------------|----------------------|
| SessionStart | 150ms | 300ms | 1s(降级:只注入 pinned 段) | 1s |
| UserPromptSubmit | 200ms | 500ms | 1.5s(降级:FTS5 only) | 2s (含 buffer) |
| PreCompact | 30ms | 80ms | 500ms | 1s |
| Stop / SessionEnd | 30ms | 80ms | 500ms | 1s |

> **C12.2 注**: settings.json timeout 应略大于兜底 timeout,留出系统调度 buffer。

#### Timeout 行为规范 (C8.1)

| 场景 | 行为 | 理由 |
|------|------|------|
| Hook 正常完成 | exit 0 + stdout JSON | 正常路径 |
| Hook 内部 timeout | exit 0 + empty additionalContext | 优雅降级,不阻塞用户 |
| Hook 被 Claude Code kill | 无控制 | 事务会被 SQLite 回滚 |
| DB 操作失败 | exit 0 + empty additionalContext + stderr 警告 | 优雅降级 |

**实现要点**:
1. 所有 DB 写操作必须在事务内,确保原子性
2. 使用 `Promise.race` 实现内部 timeout,在 settings.json timeout 之前主动降级
3. Timeout 时输出 empty `additionalContext`(不注入),但仍写 audit 日志
4. Claude Code 不会重试失败的 hook(fire-once 语义)
5. 部分完成的状态由 SQLite 事务回滚保证一致性

```javascript
// 内部 timeout 包装示例
async function withTimeout(fn, ms, fallback) {
  const timer = new Promise((_, reject) => 
    setTimeout(() => reject(new TimeoutError()), ms)
  );
  try {
    return await Promise.race([fn(), timer]);
  } catch (e) {
    if (e instanceof TimeoutError) {
      await logAudit({ action: 'hook_timeout', details: JSON.stringify({ ms }) });
      return fallback;
    }
    throw e;
  }
}
```

`/ccmem:bench` 命令测量并写入 `daily_metrics`,p95 持续超标时 stderr 提示用户。

### 6.8 Transcript 辅助函数 (U8)

> **VERIFIED (U8)**: Claude Code transcript 是复杂 JSONL 格式，包含 messages Map、
> summaries、leafUuids 等。不能简单按行解析，需使用 `buildConversationChain` 逻辑。

```javascript
import * as readline from 'readline';
import * as fs from 'fs';

/**
 * 解析 Claude Code transcript JSONL 文件
 * 参考: reference/claudecode/src/utils/sessionStorage.ts:loadTranscriptFile
 * 
 * C12.1: Improved error handling - distinguish partial vs complete failure
 */
async function parseTranscript(transcriptPath) {
  const messages = new Map();      // uuid -> message
  const leafUuids = new Set();     // 叶子消息 UUID
  let parseErrors = 0;             // C12.1: track parse errors
  let totalLines = 0;
  
  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalLines++;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'message' && entry.message) {
        messages.set(entry.message.uuid, entry.message);
      } else if (entry.type === 'leaf') {
        leafUuids.add(entry.uuid);
      }
    } catch (e) {
      parseErrors++;
    }
  }

  // C12.1: Distinguish partial failure from complete failure
  if (messages.size === 0) {
    if (parseErrors > 0 && totalLines > 0) {
      // Complete parse failure - likely corrupted file
      throw new TranscriptCorruptError(
        `Failed to parse any messages from transcript ` +
        `(${parseErrors}/${totalLines} lines failed)`
      );
    }
    // Empty file - legitimate empty session
    return [];
  }
  
  // Log partial failures for debugging (but don't fail)
  if (parseErrors > 0) {
    await logAudit({
      action: 'transcript_partial_parse_failure',
      details: JSON.stringify({ 
        path: transcriptPath, 
        parseErrors, 
        totalLines, 
        messagesRecovered: messages.size 
      }),
    });
  }

  // 找到最新的叶子消息
  let leafMessage = null;
  let latestTs = 0;
  for (const uuid of leafUuids) {
    const msg = messages.get(uuid);
    if (msg) {
      const ts = new Date(msg.timestamp).getTime();
      if (ts > latestTs) {
        latestTs = ts;
        leafMessage = msg;
      }
    }
  }

  if (!leafMessage) {
    // Fallback: 使用最后一条消息
    leafMessage = [...messages.values()].pop();
  }

  // 从叶子节点反向构建对话链
  return buildConversationChain(messages, leafMessage);
}

function buildConversationChain(messages, leafMessage) {
  const chain = [];
  let current = leafMessage;
  
  while (current) {
    chain.unshift(current);
    const parentUuid = current.parentUuid || current.parent_uuid;
    current = parentUuid ? messages.get(parentUuid) : null;
  }
  
  return chain;
}

/**
 * 从 transcript 计算会话统计 (用于 Stop hook)
 */
async function computeSessionStats(transcriptPath) {
  const messages = await parseTranscript(transcriptPath);
  
  let toolCalls = 0;
  let firstTs = null;
  let lastTs = null;

  for (const msg of messages) {
    const ts = new Date(msg.timestamp).getTime();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    // 统计 tool calls (assistant 消息中的 tool_use)
    if (msg.type === 'assistant' && msg.content) {
      const content = Array.isArray(msg.content) ? msg.content : [msg.content];
      toolCalls += content.filter(c => c.type === 'tool_use').length;
    }
  }

  return {
    toolCalls,
    messageCount: messages.length,
    durationMs: (lastTs && firstTs) ? (lastTs - firstTs) : 0,
  };
}

/**
 * 读取 transcript 并提取最后一条 assistant 消息文本
 */
function readTranscriptJsonl(transcriptPath) {
  // 同步版本用于简单场景，返回消息数组
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const entries = [];
  
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'message' && entry.message) {
        entries.push(entry.message);
      }
    } catch (e) { /* skip */ }
  }
  
  return entries;
}

function extractAssistantText(message) {
  if (!message || message.type !== 'assistant') return '';
  
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .join('\n');
}
```

---

## 七、Cron 任务设计

### 7.1 与 OpenWolf 协作

**优先策略**:检测到 `.wolf/cron-manifest.json` 时,注册为 OpenWolf cron-engine 的 ai_task,复用其 retry/backoff/dead-letter/heartbeat。

**独立策略**:无 OpenWolf 时,自托管 `node-cron` daemon(详见 §7.6)。

### 7.2 任务清单

| 任务 | 触发 | catch-up 窗口 | 操作 |
|------|------|--------------|------|
| `summarize_pending` | daemon 自适应轮询 + Stop 触发 wake file | 1h | 消费 `pending_summarize` → claude -p 提取 → 写入 `memories` |
| `daily_consolidation` | 每日 02:17 | 24h | half-life 衰减更新 / 相似度 > 0.92 合并 / 标记 candidate_expire / 删除已 archived 超 14 天 |
| `weekly_reflection` | 每周日 03:17 | 7d (C8) | LLM 跨记忆深度反思 / consolidated 提炼 / 重生 injection_cache / L4 反馈复核 |
| `security_audit` | 每周一 04:17 | 72h | trust < 0.4 簇审查 / 投毒模式回扫 / consolidated 级联降级兜底 |
| `revalidation_audit` | 每周三 04:17 | 72h | C2 时效性复核:扫 `requires_revalidation=1` 且 trust ≥ 0.5 的记忆 |

### 7.3 `summarize_pending` prompt 模板(英文输出)

```text
You are a memory extraction assistant. Analyze the following Claude Code
session fragment and extract information worth remembering across sessions.

Session data: {payload}

Tasks:
1. Identify user preferences and rules (type=rule).
   Scope decision: universal across all user's projects → global;
                   specific to current project only → project.
2. Identify factual information (type=fact, e.g. tech stack, API, paths, config).
3. Identify reusable operational methodologies (type=skill).
4. Record episodes (type=episode) only if they have standalone value.

Hard constraints (highest priority):
- When content involves dangerous operations: rm -rf, del /s, format,
  curl|sh, wget|sh, DROP TABLE, TRUNCATE, chmod 777, iptables -F:
  * MUST extract as type='episode' (never type='rule')
  * MUST set scope='project' (never 'global')
  * MUST preserve causal context ("because X happened, used Y")
  * MUST include time/project anchor (e.g. "2026-05 in myapp project")
  * MUST add tags: ["dangerous_command", "time_bound"]
  * MUST set confidence <= 0.6
- When content includes secrets, credentials, tokens, API keys:
  * MUST set scope='project' (never 'global')
  * Recommend redaction or reject if directly identifiable

Output requirements:
- Each entry <= 200 characters, standalone-understandable
- Mark confidence 0.5-0.95 based on evidence strength
- Mark source: user_explicit / tool_output / auto_inferred
- Return empty array if fragment not worth remembering

Output JSON:
[
  {
    "content": "...",
    "type": "...",
    "scope": "...",
    "source": "...",
    "confidence": 0.8,
    "tags": ["..."]
  }
]
```

### 7.4 `weekly_reflection` prompt 模板(英文输出)

```text
You are a memory consolidation expert. Analyze {n_recent} newly added +
{n_frequent} frequently-recalled memories from the past week.

Recent memories: {recent_json}
Frequent memories: {frequent_json}

Tasks:
1. Merge semantic duplicates into consolidated rules.
   Reference source_ids; do not invent new content.
2. Resolve contradictions: identify pairs, decide which to keep based on
   trust + recency.
3. Discover co-occurrence patterns: memories frequently invoked in the
   same session are candidate relationships.
4. Regenerate injection_cache.consolidated segments:
   - one for global scope (~1000 chars max)
   - one for current project_key (~1000 chars max)
   Use ONLY the existing memory IDs you've reviewed; do NOT generate new
   content not backed by source memories.

Hard constraints:
- consolidated.generation must be derived from source.generation + 1
- Never produce generation >= 2 outputs
- Source memories with tag 'dangerous_command' cannot be used in
  consolidated rules (they remain project-scoped episodes)

Output JSON:
{
  "consolidated_rules": [
    { "content": "...", "source_ids": ["m1","m2"], "scope": "project", "trust": 0.85 }
  ],
  "contradictions": [{ "pair": [id1, id2], "keep": id, "reason": "..." }],
  "patterns": [...],
  "injection_cache_consolidated_global": "rendered text with <!--mXXX--> markers",
  "injection_cache_consolidated_project": "..."
}
```

### 7.4.1 LLM 响应解析与错误处理(C10)

```javascript
// scripts/lib/llm-parse.mjs
async function parseMemoriesFromLlm(llmResponse, expectedShape = 'array') {
  try {
    // Handle common LLM output quirks
    let cleaned = llmResponse.trim();
    // Strip markdown code fences if present
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

    const parsed = JSON.parse(cleaned);

    if (expectedShape === 'array' && !Array.isArray(parsed)) {
      throw new Error(`Expected array, got ${typeof parsed}`);
    }
    if (expectedShape === 'object' && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`Expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }

    // Validate individual items have required fields
    const validated = expectedShape === 'array'
      ? parsed.filter(item => validateMemoryShape(item))
      : parsed;

    return { success: true, data: validated, droppedCount: parsed.length - validated.length };
  } catch (e) {
    await logAudit({
      action: 'llm_parse_failed',
      details: JSON.stringify({
        error: e.message,
        response_excerpt: llmResponse.slice(0, 500),
        response_length: llmResponse.length,
      }),
    });
    return { success: false, error: e.message, raw: llmResponse };
  }
}

function validateMemoryShape(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.content !== 'string' || item.content.length === 0) return false;
  if (!['rule', 'fact', 'skill', 'episode'].includes(item.type)) return false;
  if (!['global', 'project'].includes(item.scope)) return false;
  return true;
}
```

在 `summarize_pending` 和 `weekly_reflection` cron 任务中使用:

```javascript
const llmResult = await callClaudeP(prompt);
const parsed = await parseMemoriesFromLlm(llmResult, 'array');

if (!parsed.success) {
  // Retry with backoff, or skip this batch
  await db.run(`
    UPDATE pending_summarize SET attempts = attempts + 1, last_error = ?
    WHERE id = ?
  `, [parsed.error, batchId]);
  continue;
}

for (const mem of parsed.data) {
  await insertMemory(mem);  // goes through full gate (§10.1)
}
```

### 7.4.2 consolidated 写入事务模型

LLM 返回 K 条 `consolidated_rules` 后,**每条独立一个 SQLite transaction**,失败不影响其他条目。三步操作的依赖:

```
Step 1: INSERT INTO memories         (新 consolidated 行)
Step 2: INSERT INTO consolidated_lineage (N 条 source 映射)
Step 3: INSERT OR REPLACE injection_cache (异步幂等再生)
```

**事务边界**:Step 1 + Step 2 同一事务(强一致);Step 3 在事务提交后异步入队(最终一致)。

#### 失败场景

| 场景 | 处理 |
|------|------|
| Step 1 失败 | 整条 rule 跳过,记入 `results.failed`,下次 cron 重试 |
| Step 1 成功 / Step 2 中途失败 | 事务 rollback,无孤儿 consolidated;下次 cron 重试 |
| Step 1+2 成功 / Step 3 失败 | 事务已提交,injection_cache 缺新段,下次 SessionStart 触发再生(可接受) |
| daemon crash 在 Step 3 入队前 | 同上;daily_consolidation 末尾会兜底触发再生 |

#### 实现

```javascript
// scripts/cron/weekly-reflection.mjs
async function writeConsolidatedRules(consolidatedRules) {
  const results = { succeeded: 0, failed: [], inserted_ids: [] };

  for (const rule of consolidatedRules) {
    try {
      const memId = generateMemoryId();

      await db.transaction(async (tx) => {
        // Combined source validation: generation, decay_status, and tags (C7.1)
        const sources = await tx.all(`
          SELECT id, generation, decay_status, tags FROM memories
          WHERE id IN (${rule.source_ids.map(() => '?').join(',')})
        `, rule.source_ids);

        // Check all source IDs exist
        if (sources.length !== rule.source_ids.length) {
          const foundIds = new Set(sources.map(s => s.id));
          const missing = rule.source_ids.filter(id => !foundIds.has(id));
          throw new Error(`Source memories not found: ${missing.join(', ')}`);
        }

        for (const src of sources) {
          // Generation constraint (M9): max source generation must be < 1
          if (src.generation >= 1) {
            throw new GenerationLimitError(
              `Cannot consolidate from source ${src.id} at generation >= 1 (got ${src.generation})`
            );
          }

          // Decay status constraint (C7.1): only active sources can be consolidated
          if (src.decay_status !== 'active') {
            throw new Error(
              `Cannot consolidate from source ${src.id} with status '${src.decay_status}' (must be 'active')`
            );
          }

          // Tag constraint: dangerous_command must not enter consolidated
          const tags = JSON.parse(src.tags || '[]');
          if (tags.includes('dangerous_command')) {
            throw new Error(
              `Source memory ${src.id} with dangerous_command tag cannot be consolidated`
            );
          }
        }

        const maxSrcGen = Math.max(0, ...sources.map(s => s.generation));

        // Step 1: insert consolidated
        await tx.run(`
          INSERT INTO memories (
            id, scope, project_key, type, source, content,
            trust_score, base_priority, half_life_days, decay_status,
            generation, recall_count, helpful_count, unhelpful_count,
            last_touched_at, created_at, modified_by, modified_at, tags
          ) VALUES (?, ?, ?, 'consolidated', 'cron_consolidated', ?,
                    ?, 1.5, 180, 'active',
                    ?, 0, 0, 0, ?, ?, 'cron', ?, ?)
        `, [
          memId, rule.scope,
          rule.scope === 'project' ? rule.project_key : null,
          rule.content, rule.trust, maxSrcGen + 1,
          now(), now(), now(), JSON.stringify(rule.tags || []),
        ]);

        // Step 2: insert lineage (batched in same transaction)
        const stmt = await tx.prepare(`
          INSERT INTO consolidated_lineage (consolidated_id, source_memory_id)
          VALUES (?, ?)
        `);
        try {
          for (const srcId of rule.source_ids) {
            await stmt.run([memId, srcId]);
          }
        } finally {
          await stmt.finalize();
        }
        // Commit at transaction end
      });

      results.succeeded++;
      results.inserted_ids.push(memId);
    } catch (err) {
      results.failed.push({
        rule_excerpt: rule.content.slice(0, 80),
        error: err.message,
        source_ids: rule.source_ids,
      });
      await logAudit({
        action: 'consolidated_write_failed',
        details: JSON.stringify({ rule_excerpt: rule.content.slice(0, 200), error: err.message }),
      });
      // Do not throw; keep processing the next rule
    }
  }

  // Step 3: async idempotent regen (fired once after all consolidated rules processed)
  if (results.succeeded > 0) {
    await enqueueRegenerateInjectionCache({
      reason: 'weekly_reflection_consolidated',
      affected_scopes: uniqueScopes(consolidatedRules),
    });
  }

  return results;
}

// Idempotent regen with version-based race prevention (C4.1)
async function regenerateInjectionCache(scope) {
  // 1. Read current version before regeneration
  const current = await db.get(`
    SELECT version FROM injection_cache WHERE scope = ? AND segment = 'consolidated'
  `, [scope]);
  const versionBefore = current?.version || 0;

  // 2. Check for recent forget events that should exclude memories
  const recentForgets = await db.all(`
    SELECT json_each.value as mem_id FROM memory_audit_log, json_each(affected_ids)
    WHERE action = 'user_forget' AND ts > datetime('now', '-5 minutes')
  `);
  const excludeIds = new Set(recentForgets.map(r => r.mem_id));

  // 3. Fetch consolidated memories, excluding recently forgotten
  const consolidated = await db.all(`
    SELECT id, content FROM memories
    WHERE scope = ? AND type = 'consolidated' AND decay_status = 'active'
    ORDER BY trust_score DESC, last_touched_at DESC
    LIMIT 50
  `, [scope]);

  const filtered = consolidated.filter(m => !excludeIds.has(m.id));
  const { selected, memberIds } = selectByBudget(
    filtered, config.injection.budget.consolidated_global
  );

  const renderedText = selected
    .map(m => `- ${m.content} <!--${shortId(m.id)}-->`)
    .join('\n');

  // 4. Conditional update: only if version hasn't changed (no concurrent forget)
  const result = await db.run(`
    INSERT INTO injection_cache
      (scope, segment, rendered_text, member_ids, rendered_at, ttl_seconds, version)
    VALUES (?, 'consolidated', ?, ?, ?, ?, ?)
    ON CONFLICT(scope, segment) DO UPDATE SET
      rendered_text = excluded.rendered_text,
      member_ids = excluded.member_ids,
      rendered_at = excluded.rendered_at,
      ttl_seconds = excluded.ttl_seconds
    WHERE version = ?
  `, [scope, renderedText, JSON.stringify(memberIds), now(), 604800, versionBefore + 1, versionBefore]);

  if (result.changes === 0 && versionBefore > 0) {
    // Version changed during regeneration (concurrent forget happened)
    // Re-queue for another attempt
    await enqueueTask('regenerate_injection_cache', { scope, retry: true });
  }
}
```

#### 锁交互(M2)

`weekly_reflection` 整个 cron 任务持 `cron_task_state.lock_holder` (§7.7
`acquireTaskLock`);单条 consolidated 的事务在此锁内串行,无需额外锁。
`enqueueRegenerateInjectionCache` 入队后由 daemon 消费,消费时再获一次
task lock 避免与下次 `weekly_reflection` 重叠。

### 7.5 `daily_consolidation` 伪代码

```javascript
async function dailyConsolidation() {
  const isoNow = new Date().toISOString();

  // 1. Half-life: move to candidate_expire
  await db.run(`
    UPDATE memories SET decay_status = 'candidate_expire'
    WHERE decay_status='active' AND pinned = 0
      AND recall_count = 0
      AND julianday(?) - julianday(last_touched_at) > half_life_days * 2
  `, [isoNow]);

  // 2. Probation expiry handling
  await db.run(`
    UPDATE memories SET decay_status='active'
    WHERE decay_status='probation' AND probation_until <= ? AND helpful_count > 0
  `, [isoNow]);
  await db.run(`
    UPDATE memories SET decay_status='archived'
    WHERE decay_status='probation' AND probation_until <= ? AND helpful_count = 0
  `, [isoNow]);

  // 3. Similarity dedup (enabled only in hybrid mode)
  if (config.retrieval.mode === 'hybrid') {
    const duplicates = await findNearDuplicates(0.92);
    for (const [keep, drop] of duplicates) {
      await mergeMemories(keep.id, drop.id);
    }
  }

  // 4. Trust threshold backstop: archive low-trust memories (§4.4)
  await db.run(`
    UPDATE memories SET decay_status = 'archived', modified_at = ?
    WHERE trust_score < 0.2 AND decay_status IN ('active', 'probation')
  `, [isoNow]);

  // 5. Archived rows older than 14 days -> hard delete
  await db.run(`
    DELETE FROM memories WHERE decay_status='archived'
      AND julianday(?) - julianday(last_touched_at) > 14
  `, [isoNow]);

  await logAudit({ action: 'daily_consolidation_complete', details: { ts: isoNow } });
}

// Wrapper to ensure metrics collection runs even if consolidation fails (C10.1)
async function dailyConsolidationWithMetrics() {
  let consolidationError = null;
  try {
    await dailyConsolidation();
  } catch (e) {
    consolidationError = e;
    await logAudit({ 
      action: 'daily_consolidation_failed', 
      details: JSON.stringify({ error: e.message }) 
    });
  } finally {
    // Metrics collection should succeed independently
    try {
      await computeDailyMetrics();
    } catch (metricsError) {
      await logAudit({
        action: 'daily_metrics_failed',
        details: JSON.stringify({ error: metricsError.message }),
      });
    }
  }
  if (consolidationError) throw consolidationError;
}
```

### 7.6 补打与幂等(三层防御)

**Layer 1: Lazy Catch-up**(必做)

所有 cron 任务在 `cron_task_state` 维护 `last_success_at` / `next_due_at`,三个入口检查:

1. Daemon 启动时:扫所有 task,补跑过期的
2. 任意 hook 启动时(尤其 SessionStart):8s 内做轻检查,过期任务**写入异步队列**(不阻塞 hook)
3. 正常 cron tick:无错过时走原路径

```javascript
async function lazyCatchUpScan() {
  const now = Date.now();
  const overdue = await db.all(`
    SELECT task_id, next_due_at, max_catch_up_window_sec
    FROM cron_task_state
    WHERE next_due_at < ?
      AND (lock_holder IS NULL OR lock_acquired_at + lock_ttl_sec * 1000 < ?)
  `, [now, now]);

  if (overdue.length === 0) return;

  for (const t of overdue) {
    const overdueSec = (now - t.next_due_at) / 1000;
    const truncate = overdueSec > t.max_catch_up_window_sec;
    await enqueueCatchUp(t.task_id, { catch_up: true, truncate });
  }

  // Standalone mode: probe daemon health; fire-and-forget spawn if missing (C3)
  if (config.cron.mode !== 'openwolf') {
    const healthy = await checkDaemonHealth();
    if (!healthy) startDaemonDetached();
  }
}
```

**Layer 2: platform 模板**(可选优化)

- macOS launchd plist 加 `WakeFromSleep` LaunchEvents
- Linux systemd timer 加 `Persistent=true`
- Windows scheduled task 勾选 `Run task as soon as possible after a scheduled start is missed`

**Layer 3: 任务幂等约定**(强制契约)

1. 所有任务必须幂等(用水位线游标,而非"自上次以来 N 天")
2. 处理量上界:补打不能无限放大工作量,`truncate=true` 时只处理"最近 max_catch_up_window 内"
3. 可中断恢复:每完成一批写一次 `last_success_at`,挂掉重启不会重做或丢工作

### 7.7 Daemon 主循环(自适应轮询 + 文件触发 + SQLite 锁)

```javascript
// scripts/daemon.mjs
const WAKE_FILE = path.join(getDataRoot(), 'daemon.wake');
let wakeUpEarly = false;
let lastWakeProcessedTs = 0;
let shouldStop = false;
let consecutiveIdleTicks = 0;

// C3: SQLite-based singleton lock (cross-platform)
const LOCK_STALE_MS = 60_000;       // 60s without heartbeat = stale
const LOCK_SOFT_STALE_MS = 20_000;  // 20s: try PID probe on same machine
const HEARTBEAT_INTERVAL_MS = 15_000;

async function main() {
  try {
    await acquireDaemonLock();
  } catch (e) {
    if (e instanceof DaemonAlreadyRunningError) {
      console.error(e.message);
      process.exit(0);
    }
    throw e;
  }

  // SQLite-based heartbeat
  const heartbeatInterval = setInterval(refreshHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();

  process.on('SIGTERM', () => { shouldStop = true; });
  process.on('SIGINT', () => { shouldStop = true; });

  await initWakeWatcher();
  try {
    await mainLoop();
  } finally {
    clearInterval(heartbeatInterval);
    await releaseDaemonLock();
  }
}

async function acquireDaemonLock() {
  const now = Date.now();
  const hostname = os.hostname();
  const pid = process.pid;

  const existing = await db.get(`SELECT * FROM daemon_lock WHERE id = 1`);

  if (existing) {
    const age = now - existing.heartbeat_at;

    // Case 1: Same process re-entry (allow)
    if (existing.holder_pid === pid && existing.holder_hostname === hostname) {
      await db.run(`UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1`, [now]);
      return { acquired: true, reentry: true };
    }

    // Case 2: Hard timeout (60s no heartbeat → force acquire)
    if (age >= LOCK_STALE_MS) {
      return await forceAcquireLock(now, pid, hostname, 'hard_timeout');
    }

    // Case 3: Soft timeout + same machine + PID dead (20s, probe)
    if (age >= LOCK_SOFT_STALE_MS && existing.holder_hostname === hostname) {
      if (!isPidAlive(existing.holder_pid)) {
        return await forceAcquireLock(now, pid, hostname, 'pid_dead');
      }
    }

    // Case 4: Lock still valid
    throw new DaemonAlreadyRunningError(
      `Daemon already running: pid=${existing.holder_pid} on ${existing.holder_hostname} ` +
      `(heartbeat ${Math.round(age / 1000)}s ago)`
    );
  }

  // Case 5: No lock, acquire fresh
  await db.run(`
    INSERT INTO daemon_lock (id, holder_pid, holder_hostname, acquired_at, heartbeat_at, version)
    VALUES (1, ?, ?, ?, ?, 1)
  `, [pid, hostname, now, now]);

  return { acquired: true, fresh: true };
}

async function forceAcquireLock(now, pid, hostname, reason) {
  await db.run(`
    UPDATE daemon_lock
    SET holder_pid = ?, holder_hostname = ?, acquired_at = ?, heartbeat_at = ?, version = version + 1
    WHERE id = 1
  `, [pid, hostname, now, now]);

  await logAudit({
    action: 'daemon_lock_force_acquire',
    reason,
    details: JSON.stringify({ pid, hostname }),
  });

  return { acquired: true, forced: true, reason };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = process not found, EPERM = process exists but no permission
    return e.code === 'EPERM';
  }
}

async function refreshHeartbeat() {
  await db.run(`
    UPDATE daemon_lock SET heartbeat_at = ?
    WHERE id = 1 AND holder_pid = ? AND holder_hostname = ?
  `, [Date.now(), process.pid, os.hostname()]).catch(() => {});
}

async function releaseDaemonLock() {
  await db.run(`
    DELETE FROM daemon_lock
    WHERE id = 1 AND holder_pid = ? AND holder_hostname = ?
  `, [process.pid, os.hostname()]);
}

async function isDaemonHealthy() {
  const lock = await db.get(`SELECT * FROM daemon_lock WHERE id = 1`);
  if (!lock) return false;
  return (Date.now() - lock.heartbeat_at) < LOCK_STALE_MS;
}

async function initWakeWatcher() {
  // Clean any leftover wake file on startup
  try {
    const content = await fs.promises.readFile(WAKE_FILE, 'utf8');
    const { ts } = JSON.parse(content);
    if (Date.now() - ts < 300_000) wakeUpEarly = true;
    await fs.promises.unlink(WAKE_FILE).catch(() => {});
  } catch { /* not present */ }

  try {
    const watcher = fs.watch(getDataRoot(), { persistent: false }, (event, filename) => {
      if (filename === 'daemon.wake' && (event === 'change' || event === 'rename')) {
        handleWakeEvent();
      }
    });
    watcher.on('error', () => {
      logger.warn('fs.watch failed, falling back to polling');
      watcher.close();
      startWakeFilePoller();
    });
  } catch {
    logger.info('fs.watch unavailable, using polling');
    startWakeFilePoller();
  }
}

async function handleWakeEvent() {
  try {
    const content = await fs.promises.readFile(WAKE_FILE, 'utf8');
    const { ts, reason } = JSON.parse(content);
    if (ts <= lastWakeProcessedTs) return;
    lastWakeProcessedTs = ts;
    wakeUpEarly = true;
    logger.debug(`woken by ${reason} at ${new Date(ts).toISOString()}`);
    await fs.promises.unlink(WAKE_FILE).catch(() => {});
  } catch { /* concurrent delete, ignore */ }
}

function startWakeFilePoller() {
  // C12.3: Adaptive polling - fast initially, slow down if no activity
  let pollInterval = 1000;  // Start at 1s
  let consecutiveEmpty = 0;

  const poll = async () => {
    try {
      await fs.promises.access(WAKE_FILE);
      await handleWakeEvent();
      consecutiveEmpty = 0;
      pollInterval = 1000;  // Reset to fast
    } catch {
      consecutiveEmpty++;
      // Slow down after 10 empty polls (10s of no activity)
      if (consecutiveEmpty > 10) {
        pollInterval = Math.min(pollInterval * 1.5, 5000);  // Max 5s
      }
    }
    setTimeout(poll, pollInterval);
  };

  poll();
}

async function sleep(ms) {
  const start = Date.now();
  while (Date.now() - start < ms && !wakeUpEarly && !shouldStop) {
    await new Promise(r => setTimeout(r, Math.min(200, ms - (Date.now() - start))));
  }
  wakeUpEarly = false;
}

async function mainLoop() {
  while (!shouldStop) {
    const { mode } = await getCurrentMode();
    if (mode === 'off') {
      await sleep(60_000);
      continue;
    }

    const hasPending = await db.get(`SELECT 1 FROM pending_summarize LIMIT 1`);
    const dueCron = await db.all(`
      SELECT task_id FROM cron_task_state
      WHERE next_due_at < ?
        AND (lock_holder IS NULL OR lock_acquired_at + lock_ttl_sec * 1000 < ?)
    `, [Date.now(), Date.now()]);

    let didWork = false;
    if (hasPending) {
      await processOneBatch('summarize_pending', { batch_size: 5 });
      didWork = true;
    }
    for (const t of dueCron) {
      if (await acquireTaskLock(t.task_id)) {
        try { await runCronTask(t.task_id); }
        finally { await releaseTaskLock(t.task_id); }
        didWork = true;
      }
    }

    consecutiveIdleTicks = didWork ? 0 : consecutiveIdleTicks + 1;

    const sleepMs = consecutiveIdleTicks === 0 ? 1000
                  : consecutiveIdleTicks < 5  ? 30_000
                  :                              300_000;
    await sleep(sleepMs);
  }
}

// Hook side: trigger wake
async function wakeDaemon() {
  try {
    await fs.promises.writeFile(WAKE_FILE, JSON.stringify({
      ts: Date.now(),
      reason: 'hook_trigger',
      pid: process.pid,
    }));
  } catch { /* non-fatal */ }
}

// Task lock (M2)
async function acquireTaskLock(taskId) {
  const result = await db.run(`
    UPDATE cron_task_state
    SET lock_holder = ?, lock_acquired_at = ?
    WHERE task_id = ?
      AND (lock_holder IS NULL OR lock_acquired_at + lock_ttl_sec * 1000 < ?)
  `, ['daemon:' + process.pid, Date.now(), taskId, Date.now()]);
  return result.changes > 0;
}

async function releaseTaskLock(taskId) {
  await db.run(`
    UPDATE cron_task_state SET lock_holder = NULL, lock_acquired_at = NULL
    WHERE task_id = ? AND lock_holder = ?
  `, [taskId, 'daemon:' + process.pid]);
}
```

### 7.8 cron_task_state 初始默认

| task_id | schedule | max_catch_up_window_sec |
|---------|----------|-------------------------|
| `daily_consolidation` | `17 2 * * *` | 86400 |
| `weekly_reflection` | `17 3 * * 0` | 604800 (C8: 7 天) |
| `security_audit` | `17 4 * * 1` | 259200 |
| `revalidation_audit` | `17 4 * * 3` | 259200 |
| `summarize_pending` | (daemon 自适应) | 3600 |

---

## 八、双层作用域

### 8.1 project_key 解析(H4)

```javascript
function resolveProjectKey(projectDir) {
  try {
    const origin = execSync(
      `git -C "${projectDir}" config --get remote.origin.url`
    ).toString().trim();
    if (origin) return 'git:' + normalizeGitUrl(origin);
  } catch {}

  try {
    const remotes = execSync(`git -C "${projectDir}" remote`)
      .toString().trim().split('\n').filter(Boolean).sort();
    if (remotes.length > 0) {
      const url = execSync(
        `git -C "${projectDir}" config --get remote.${remotes[0]}.url`
      ).toString().trim();
      process.stderr.write(`ccmem: no 'origin' remote, using '${remotes[0]}'\n`);
      return 'git:' + normalizeGitUrl(url);
    }
  } catch {}

  return 'path:' + sha256(projectDir).slice(0, 16);
}

function normalizeGitUrl(url) {
  let s = url.trim()
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'ssh://$1/')
    .replace(/^(https?|ssh|git):\/\/[^@\/]+@/, '$1://');

  const m = s.match(/^(?:https?|ssh|git):\/\/([^\/]+)\/(.+?)(\.git)?\/?$/);
  if (!m) throw new Error(`Invalid git URL: ${url}`);

  const [, host, path] = m;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}
```

诊断命令 `/ccmem:show-key` 显示当前解析结果。

### 8.2 scope 判断(由 summarize_pending LLM 决定)

| 信息 | 例 | scope |
|------|-----|-------|
| 用户通用偏好 | "偏好简洁回答" | global |
| 编辑器/语言习惯 | "TypeScript 严格模式" | global |
| 项目技术栈 | "本项目 Next.js 14 + App Router" | project |
| 项目约定 | "API 路由在 /app/api/" | project |
| 含 dangerous_command tag | 任何 | **强制 project** |
| 含 secret 模式 | 任何 | **强制 project** + 拒绝 global |

### 8.3 检索时合并

```sql
-- Retrieval scope filter used by UserPromptSubmit
WHERE (scope = 'global' OR (scope = 'project' AND project_key = ?))
```

---

## 九、与 OpenWolf 协同

### 9.1 共存原则

| 维度 | OpenWolf | ccmem |
|------|----------|-------|
| 文件导航 / anatomy | ✅ 独占 | — |
| Token 审计 | ✅ 独占 | — |
| Session 内行为追踪 | ✅ `memory.md` | — |
| 文本型学习提醒 | ✅ `cerebrum.md` | — |
| 跨 session 语义记忆 | — | ✅ SQLite |
| Cron 调度 | ✅ cron-engine | 复用 / 注册 |

### 9.2 cerebrum.md 段落映射(S3 精确化)

`daily_consolidation` 增加 cerebrum sync 子步骤:

| cerebrum 段 | ccmem 写入 | 备注 |
|-------------|------------|------|
| `## User Preferences` | scope=global, type=rule, source=cerebrum_import, trust=0.85 | probation 7 天 |
| `## Key Learnings` | scope=project, type=fact, source=cerebrum_import, trust=0.80 | probation 7 天 |
| `## Do-Not-Repeat` | scope=project, type=rule, source=cerebrum_import, trust=0.90, tag=['dnr'] | 无 probation(高 trust) |
| `## Decision Log` | **不读** | 过度具体,价值低 |

写入走 §10 写入闸门(投毒扫描照样过)。同步是单向的:**ccmem 只读 cerebrum,不写**。除非用户开启 `ccmem.write_cerebrum: true`(Phase 5+)。

#### 三阶段去重(防止重复导入)

用户手动编辑 cerebrum.md 时可能添加 ccmem 已有的内容,需在导入前去重:

| 阶段 | 方法 | 成本 | 匹配策略 |
|------|------|------|---------|
| Stage 1 | 精确匹配 | O(1) 查询 | `content = ?` 完全相同 |
| Stage 2 | 归一化匹配 | O(n) 候选 | 忽略空白/标点/大小写后相同 |
| Stage 3 | 语义相似 | 需 embedding | cosine > 0.85 |

```javascript
// lib/cerebrum-sync.mjs
export async function syncCerebrumEntry(db, entry, projectKey) {
  const { content, section, lineNumber } = entry;

  // Stage 1: 精确匹配 → 跳过,只更新 tag
  const exact = await db.get(`
    SELECT * FROM memories WHERE content = ? 
    AND (scope = 'global' OR project_key = ?) LIMIT 1
  `, [content, projectKey]);
  if (exact) {
    await db.run(`UPDATE memories SET tags = json_insert(
      COALESCE(tags, '[]'), '$[#]', ?
    ) WHERE id = ?`, [`cerebrum_synced:${section}:L${lineNumber}`, exact.id]);
    return { action: 'exact_match', existingId: exact.id, inserted: false };
  }

  // Stage 2: 归一化匹配 → 跳过,合并引用
  const normalized = normalizeForComparison(content);
  const candidates = await db.all(`
    SELECT * FROM memories WHERE decay_status = 'active'
      AND (scope = 'global' OR project_key = ?)
      AND ABS(LENGTH(content) - ?) < 50 LIMIT 20
  `, [projectKey, content.length]);

  for (const c of candidates) {
    if (normalizeForComparison(c.content) === normalized) {
      await db.run(`UPDATE memories SET tags = json_insert(
        COALESCE(tags, '[]'), '$[#]', ?
      ) WHERE id = ?`, [`cerebrum_normalized:${section}:L${lineNumber}`, c.id]);
      return { action: 'normalized_match', existingId: c.id, inserted: false };
    }
  }

  // Stage 3: 语义相似(仅当 embedding 启用) → 创建并链接
  if (await isEmbeddingEnabled(db)) {
    const similar = await findSimilarByEmbedding(db, content, projectKey, 0.85);
    if (similar) {
      // 保留两者,但降低新条目优先级并建立双向链接
      const newId = await insertNewFromCerebrum(db, entry, projectKey, {
        trust_score: Math.min(similar.trust_score, 0.7),
        tags: ['semantic_duplicate_of:' + similar.id],
      });
      await db.run(`UPDATE memories SET tags = json_insert(
        COALESCE(tags, '[]'), '$[#]', ?
      ) WHERE id = ?`, ['has_semantic_duplicate:' + newId, similar.id]);
      return { action: 'semantic_match', existingId: similar.id, newId, inserted: true };
    }
  }

  // 无匹配 → 正常插入
  return insertNewFromCerebrum(db, entry, projectKey);
}

function normalizeForComparison(text) {
  return text.toLowerCase().replace(/\s+/g, ' ')
    .replace(/[^\w\s一-鿿]/g, '').trim();
}
```

#### C9: SessionStart 增量扫描

除了 `daily_consolidation` 的批量同步,`SessionStart` 也会增量检查 cerebrum.md 变更:

```javascript
// handlers/session-start.mjs (在 lazy catch-up 之后)

// C9: Incremental cerebrum.md sync on SessionStart
if (config.hooks.openwolfIntegration !== 'disabled') {
  const cerebrumPath = path.join(projectDir, '.wolf', 'cerebrum.md');
  const lastSync = await db.get(`
    SELECT MAX(created_at) as ts FROM memories
    WHERE source = 'cerebrum_import' AND project_key = ?
  `, [projectKey]);

  try {
    const stat = await fs.promises.stat(cerebrumPath);
    if (!lastSync?.ts || new Date(stat.mtime) > new Date(lastSync.ts)) {
      // cerebrum.md changed since last sync, queue incremental import
      await enqueueTask('cerebrum_incremental_sync', {
        project_key: projectKey,
        cerebrum_path: cerebrumPath,
        last_sync_ts: lastSync?.ts,
      });
      logger.debug('cerebrum.md changed, queued incremental sync');
    }
  } catch { /* cerebrum.md not present, skip */ }
}
```

### 9.3 检测与降级

```javascript
// C14.1: Multi-marker detection for OpenWolf presence
// cron-manifest.json may not exist on first run, so check multiple markers
function detectOpenWolf(projectDir) {
  const wolfDir = path.join(projectDir, '.wolf');
  
  // Primary: cron-manifest.json exists (OpenWolf cron already initialized)
  if (fs.existsSync(path.join(wolfDir, 'cron-manifest.json'))) {
    return { detected: true, mode: 'full' };
  }
  
  // Secondary: OPENWOLF.md exists (OpenWolf installed but cron not yet run)
  if (fs.existsSync(path.join(wolfDir, 'OPENWOLF.md'))) {
    return { detected: true, mode: 'partial' };
  }
  
  // Tertiary: config.json with openwolf markers
  const configPath = path.join(wolfDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.openwolf || config.cron) {
        return { detected: true, mode: 'partial' };
      }
    } catch { /* ignore parse errors */ }
  }
  
  return { detected: false };
}

const owDetection = detectOpenWolf(projectDir);
if (owDetection.detected) {
  if (owDetection.mode === 'full') {
    registerToOpenWolfCron();
  } else {
    // Partial mode: wait for cron-manifest.json, use standalone daemon for now
    process.stderr.write('ccmem: OpenWolf detected but cron not initialized, using standalone daemon\n');
    startStandaloneDaemon();
  }
} else {
  startStandaloneDaemon();
}
```

---

## 十、安全防护(三层意图判别 + 强制降级)

### 10.1 写入闸门(C2 核心)

```javascript
// lib/db.mjs
async function insertMemory(mem) {
  // 1. Tier 1: always-block pattern scan
  const t1 = scanTier1(mem.content);
  if (t1.matched) {
    await logAudit({
      action: 'insert_blocked',
      reason: 'tier1:' + t1.pattern,
      attempted_content: safeTrimChars(mem.content, 500),
      source: mem.source,
      session_id: mem.session_id,
    });
    throw new ThreatBlockedError(`Tier 1 pattern blocked: ${t1.pattern}`);
  }

  // 2. Secret scan
  const secrets = scanSecrets(mem.content);
  if (secrets.length > 0 && mem.scope === 'global') {
    await logAudit({ action: 'insert_blocked', reason: 'secret_in_global' });
    throw new SecretInGlobalError(`Secret patterns not allowed in global scope`);
  }

  // 3. Tier 2: dangerous-command context classification
  const t2 = await evaluateTier2(mem.content, mem.source, mem.type);
  if (t2.action === 'block') {
    await logAudit({
      action: 'insert_blocked',
      reason: 'tier2:' + t2.matched_pattern,
      details: JSON.stringify(t2.evidence),
    });
    throw new ThreatBlockedError(`Tier 2 instruction-shape detected`);
  } else if (t2.action === 'quarantine') {
    mem.decay_status = 'quarantine';
    mem.trust_score = 0.1;
    mem.probation_until = isoDateNDaysFromNow(30);
    mem.tags = [...(mem.tags || []), 'quarantined_pending_review'];
  } else if (t2.action === 'force_demote') {
    const originalType = mem.type;
    const originalScope = mem.scope;

    if (mem.type === 'rule' || mem.type === 'consolidated') {
      mem.type = 'episode';
      mem.half_life_days = 7;
    }
    if (mem.scope === 'global') {
      mem.scope = 'project';
    }
    mem.trust_score = Math.min(mem.trust_score, 0.6);
    mem.tags = [
      ...(mem.tags || []),
      'force_demoted_from_' + originalType,
      'dangerous_command',
      'require_periodic_revalidation',
    ];

    // User-visible notice (English, per cerebrum convention)
    process.stderr.write(
      `ccmem: demoted ${originalType}→episode due to dangerous command ` +
      `(use /ccmem:promote ${mem.id} to override)\n`
    );

    await logAudit({
      action: 'force_demoted',
      from: { type: originalType, scope: originalScope },
      to:   { type: mem.type, scope: mem.scope },
      details: JSON.stringify(t2.evidence),
    });
  } else if (t2.action === 'allow_with_tag') {
    mem.tags = [...(mem.tags || []), 'dangerous_command_discussed'];
  }

  // 4. Semantic contradiction detection (skipped for cron_consolidated)
  if (mem.source !== 'cron_consolidated') {
    const contradiction = await detectContradiction(mem);
    if (contradiction.high_risk) {
      mem.trust_score = Math.min(mem.trust_score, 0.5);
      mem.decay_status = 'probation';
      await queueForContradictionReview(mem, contradiction.similar);
    }
  }

  // 5. Generation check (M9)
  if (mem.generation >= 2) {
    throw new GenerationLimitError(`Generation must be < 2, got ${mem.generation}`);
  }

  // 6. C5: Capacity check with soft/hard limits (A+D solution)
  // See §10.1.1 for semantic explanation
  const scopeKey = mem.scope === 'global' ? 'global' : mem.project_key;
  const count = await db.get(`
    SELECT COUNT(*) as n FROM memories
    WHERE (scope = 'global' OR project_key = ?) AND decay_status = 'active'
  `, [scopeKey]);

  const softLimit = config.capacity.maxActivePerScope;
  const hardLimit = softLimit * (config.capacity.hardLimitMultiplier || 1.1);

  // Soft limit: warning + trigger async consolidation
  if (count.n >= softLimit * 0.95) {
    process.stderr.write(
      `ccmem: capacity warning (${count.n}/${softLimit})\n`
    );
    if (count.n >= softLimit * config.capacity.forceConsolidateAtPercent / 100) {
      await enqueueTask('force_consolidation', { scope: scopeKey });
    }
  }

  // 7. C12.1: Set requires_revalidation based on tags
  mem.requires_revalidation = (mem.tags || []).includes('require_periodic_revalidation') ? 1 : 0;

  // 8. Actual insert (with optional hard limit protection)
  let result;
  if (count.n >= hardLimit * 0.95 || config.capacity.strictMode) {
    // Hard limit: atomic check-and-insert
    result = await db.run(`
      INSERT INTO memories (id, scope, project_key, type, source, content, 
        trust_score, base_priority, half_life_days, decay_status,
        generation, recall_count, helpful_count, unhelpful_count,
        last_touched_at, created_at, modified_by, modified_at, tags,
        pinned, probation_until, requires_revalidation)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM memories 
        WHERE (scope = 'global' OR project_key = ?) AND decay_status = 'active'
      ) < ?
    `, [
      mem.id, mem.scope, mem.project_key, mem.type, mem.source, mem.content,
      mem.trust_score, mem.base_priority, mem.half_life_days, mem.decay_status,
      mem.generation, 0, 0, 0,
      now(), now(), mem.modified_by || 'system', now(), JSON.stringify(mem.tags || []),
      mem.pinned || 0, mem.probation_until, mem.requires_revalidation,
      scopeKey, hardLimit
    ]);

    if (result.changes === 0) {
      await logAudit({
        action: 'insert_blocked_hard_limit',
        details: JSON.stringify({ scope: scopeKey, count: count.n, hardLimit }),
      });
      throw new HardCapacityError(
        `Hard capacity limit reached (${hardLimit}). ` +
        `Run /ccmem:stats to check, or wait for consolidation.`
      );
    }
  } else {
    // Normal path: non-atomic insert (allows race within soft→hard buffer)
    result = await db.run(`INSERT INTO memories (...) VALUES (...)`, mem);
  }

  // 9. C2: Invalidate fresh cache if this is a recent episode
  //    Purpose: ensure subsequent sessions see newly created episodes
  if (mem.type === 'episode') {
    const cacheScope = mem.scope === 'global' ? 'global' : `project:${mem.project_key}`;
    await db.run(`
      UPDATE injection_cache
      SET ttl_seconds = 0, rendered_at = datetime('now', '-1 day')
      WHERE scope = ? AND segment = 'fresh'
    `, [cacheScope]);
  }

  return result;
}
```

#### 10.1.1 容量检查语义 (C5.1)

**默认行为**: 检查与插入非原子,高并发下可能短暂超出 `maxActivePerScope`。
超出量受限于 `并发窗口数 × 单窗口批量写入数`(通常 < 50 条),
下一个 `force_consolidation` 周期会清理。

**设计选择理由**:
- 原子操作需要数据库锁或条件 INSERT
- 写锁会阻塞其他窗口,增加 hook 延迟
- p95 ≤ 500ms 预算不允许长时间持锁
- 短暂超出对 FTS5 检索性能影响可忽略(< 3%)

**软上限 + 硬上限分离**:

| 限制 | 阈值 | 行为 |
|------|------|------|
| 警告线 | 95% of softLimit | stderr 警告 |
| 触发整合 | `forceConsolidateAtPercent` (默认 90%) | 异步入队 `force_consolidation` |
| 硬上限检查 | 95% of hardLimit (默认 110%) | 原子 INSERT,失败则抛 `HardCapacityError` |

**可选严格模式**: `config.capacity.strictMode: true` 时,所有写入都做原子检查(接受延迟代价)。

### 10.2 Tier 1 模式(always-block)

```javascript
const TIER1_PATTERNS = [
  /ignore\s+(previous|prior|above|all)\s+(instructions|prompts|context)/i,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>/,
  /[​‌‍﻿]/,                                            // zero-width chars
  /system\s*:\s*you\s+are\s+now/i,
  /forget\s+(everything|all)\s+you\s+(know|learned|remember)/i,
  /(?:you\s+are\s+now|从现在(?:开始|起))\s+(?:a|an|the|一个|一名)/i,
  /<!--\s*(?:system|admin|prompt|hidden|inject)/i,
  /(?:base64|atob)\s*[(:]/i,
];
```

### 10.3 Tier 2 模式 + 评分

```javascript
const TIER2_PATTERNS = [
  { name: 'rm_rf',      regex: /\brm\s+-rf\b/ },
  { name: 'format_disk', regex: /\b(format\s+c:|format\s+[a-z]:\s+\/q)/i },
  { name: 'del_recursive', regex: /\bdel\s+\/[fsq]+\s+/i },
  { name: 'pipe_to_shell', regex: /(curl|wget)\s+\S+\s*\|\s*(sh|bash|zsh|python)/i },
  { name: 'dangerous_eval', regex: /\b(eval|exec|spawn|subprocess)\s*\(/i },
  { name: 'sql_destructive', regex: /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM\s+\w+)\b/i },
  { name: 'perm_777', regex: /\bchmod\s+(?:-R\s+)?777\b/i },
  { name: 'iptables_flush', regex: /\biptables\s+-F\b/i },
];

// Default weights (overridable via config.security.tier2_weights)
const DEFAULT_TIER2_WEIGHTS = {
  in_code_block:          -3,
  in_quotes:              -2,
  imperative_prefix:      +2,
  no_explanation:         +1,
  short_content_dominant: +1,
};

const DEFAULT_TIER2_THRESHOLDS = {
  allow_below:    -1,
  block_above:    +2,
  // values in between: quarantine
};

async function evaluateTier2(content, source, type) {
  const matches = TIER2_PATTERNS
    .map(p => ({ name: p.name, match: content.match(p.regex) }))
    .filter(x => x.match);

  if (matches.length === 0) {
    return { action: 'allow', evidence: [] };
  }

  const weights = { ...DEFAULT_TIER2_WEIGHTS, ...(config.security.tier2_weights || {}) };
  const thresholds = { ...DEFAULT_TIER2_THRESHOLDS, ...(config.security.tier2_thresholds || {}) };

  let totalScore = 0;
  const evidence = [];

  for (const m of matches) {
    const idx = m.match.index;
    if (isInCodeBlock(content, idx))       { totalScore += weights.in_code_block;     evidence.push('in_code_block'); }
    if (isInQuotes(content, idx))          { totalScore += weights.in_quotes;          evidence.push('in_quotes'); }
    if (hasImperativePrefix(content, idx)) { totalScore += weights.imperative_prefix;  evidence.push('imperative_prefix'); }
    if (!hasExplanatoryFollow(content, idx)) { totalScore += weights.no_explanation;   evidence.push('no_explanation'); }
    if (isShortContentDominant(content))   { totalScore += weights.short_content_dominant; evidence.push('short_content_dominant'); }
  }

  // user_explicit is always lenient: never block, but still force_demote
  if (source === 'user_explicit') {
    if (totalScore >= thresholds.block_above) {
      return { action: 'force_demote', evidence, matched_pattern: matches[0].name };
    } else {
      return { action: 'allow_with_tag', evidence };
    }
  }

  // Other sources: decided by threshold
  if (totalScore <= thresholds.allow_below) {
    return { action: 'allow', evidence };
  }
  if (totalScore >= thresholds.block_above) {
    // type='rule' -> hard block; type='fact'/'episode' -> force-demote
    if (type === 'rule' || type === 'consolidated') {
      return { action: 'block', evidence, matched_pattern: matches[0].name };
    }
    return { action: 'force_demote', evidence, matched_pattern: matches[0].name };
  }
  return { action: 'quarantine', evidence };
}
```

### 10.4 上下文判别 helper

```javascript
function isInCodeBlock(text, index) {
  const before = text.slice(0, index);
  if ((before.match(/^```/gm) || []).length % 2 === 1) return true;
  if (countUnescapedTicks(before) % 2 === 1) return true;
  const co = (before.match(/<code\b[^>]*>/gi) || []).length;
  const cc = (before.match(/<\/code>/gi) || []).length;
  if (co > cc) return true;
  const po = (before.match(/<pre\b[^>]*>/gi) || []).length;
  const pc = (before.match(/<\/pre>/gi) || []).length;
  return po > pc;
}

function isInQuotes(text, index) {
  const before = text.slice(0, index).replace(/\\["']/g, '');
  return /["'「『](?:[^"'」』]*)$/.test(before);
}

function hasImperativePrefix(text, index) {
  const before = text.slice(Math.max(0, index - 60), index);
  return /\b(should|must|always|please|now|run|execute|exec)\b|必须|应该|请|从现在|立即|马上/i.test(before);
}

function hasExplanatoryFollow(text, index) {
  const after = text.slice(index, index + 120);
  // C12.4: Tightened regex - require more explicit explanatory patterns
  // Removed "will" which caused false positives like "rm -rf will delete"
  return /\b(this\s+(removes?|deletes?|means?|is\s+used)|because|用于|意思是|表示|含义是|之所以|原因是)\b/i.test(after);
}

function isShortContentDominant(text) {
  return text.trim().length < 100;
}
```

### 10.5 周期复核(revalidation_audit cron)

```sql
-- C12.1: Use boolean field instead of LIKE for performance
SELECT id, content, created_at, tags FROM memories
WHERE decay_status = 'active'
  AND trust_score >= 0.5
  AND requires_revalidation = 1
  AND (last_revalidated_at IS NULL
       OR julianday('now') - julianday(last_revalidated_at) > 30);
```

复核 prompt(英文输出):

```text
The following memories were created N days ago and involve dangerous operations
or time-sensitive content. Determine if they remain applicable.

{memory_dump_with_metadata}

For each memory return JSON:
{
  "id": "...",
  "verdict": "still_valid" | "stale" | "context_bound" | "should_archive",
  "reason": "..."
}

Actions taken based on verdict:
- still_valid: trust unchanged, last_revalidated_at updated
- stale: trust -= 0.3
- context_bound: add tag "scope_restricted", trust unchanged
- should_archive: decay_status='archived'
```

### 10.6 security_audit 兜底

```javascript
async function securityAudit() {
  // 1. trust < 0.4 cluster review (suspicious poisoning ring)
  const suspiciousCluster = await db.all(`
    SELECT m.id, m.content, m.trust_score, m.source, m.created_at, m.session_id
    FROM memories m
    WHERE m.trust_score < 0.4 AND m.decay_status='active'
    ORDER BY m.session_id, m.created_at
  `);
  // Group by session_id; entire-session-low-trust -> escalate to LLM review

  // 2. Retroactive scan when threat patterns are upgraded
  const patternsVersion = config.security.patterns_version || 'v1';
  const memoriesToRescan = await db.all(`
    SELECT id, content FROM memories
    WHERE decay_status='active'
      AND (last_scanned_patterns_version IS NULL OR last_scanned_patterns_version != ?)
  `, [patternsVersion]);
  for (const m of memoriesToRescan) {
    const t1 = scanTier1(m.content);
    if (t1.matched) {
      await db.run(`
        UPDATE memories SET decay_status='archived', trust_score=0
        WHERE id = ?
      `, [m.id]);
      await logAudit({
        action: 'retro_scan_archived',
        affected_ids: [m.id],
        reason: 'tier1:' + t1.pattern,
      });
    }
  }

  // 3. Consolidated cascade-degrade backstop (catches anything missed by sync paths)
  await db.run(`
    UPDATE memories SET decay_status='archived'
    WHERE type='consolidated' AND decay_status='active'
      AND NOT EXISTS (
        SELECT 1 FROM consolidated_lineage l
        JOIN memories src ON src.id = l.source_memory_id
        WHERE l.consolidated_id = memories.id
          AND src.decay_status = 'active'
      )
  `);
}
```

### 10.7 `/ccmem:forget` 同步级联(C5)

```javascript
async function forgetMemory(memId, options = {}) {
  await db.transaction(async (tx) => {
    // 1. Primary action
    await tx.run(`
      UPDATE memories
      SET decay_status='archived', last_touched_at=?, modified_by='user', modified_at=?
      WHERE id=?
    `, [now(), now(), memId]);

    // 2. Find all consolidated entries referencing this id
    const affected = await tx.all(`
      SELECT consolidated_id FROM consolidated_lineage WHERE source_memory_id=?
    `, [memId]);

    let cascadeArchived = 0;
    let cascadeDegraded = 0;

    for (const { consolidated_id: cid } of affected) {
      const allSources = await tx.all(`
        SELECT m.id, m.decay_status FROM consolidated_lineage l
        JOIN memories m ON m.id = l.source_memory_id
        WHERE l.consolidated_id = ?
      `, [cid]);

      const activeCount = allSources.filter(s => s.decay_status === 'active').length;
      const ratio = (allSources.length - activeCount) / allSources.length;

      if (activeCount === 0) {
        await tx.run(`UPDATE memories SET decay_status='archived' WHERE id=?`, [cid]);
        cascadeArchived++;
      } else if (ratio >= 0.5) {
        await tx.run(`
          UPDATE memories SET trust_score = MAX(0, trust_score - 0.30) WHERE id=?
        `, [cid]);
        cascadeDegraded++;
      } else {
        await tx.run(`
          UPDATE memories SET trust_score = MAX(0, trust_score - 0.10) WHERE id=?
        `, [cid]);
      }
    }

    // 3. Synchronously invalidate injection_cache segments (C1)
    await invalidateInjectionCacheFor(memId);

    await logAudit({
      action: 'user_forget',
      affected_ids: [memId, ...affected.map(a => a.consolidated_id)],
      details: JSON.stringify({ cascade_archived: cascadeArchived, cascade_degraded: cascadeDegraded }),
    });

    return {
      forgotten: memId,
      cascade_archived: cascadeArchived,
      cascade_degraded: cascadeDegraded,
    };
  });
}

async function invalidateInjectionCacheFor(memId) {
  // C4.1: Increment version to prevent race with concurrent regeneration
  await db.run(`
    UPDATE injection_cache SET ttl_seconds = 0, version = version + 1
    WHERE EXISTS (
      SELECT 1 FROM json_each(member_ids) WHERE value = ?
    )
  `, [memId]);
  await enqueueImmediate('regenerate_injection_cache_segments');
}
```

---

## 十一、注入格式(H7 规范)

### 11.1 SessionStart 注入文本示例

```
=== ccmem: project background ===

[CONSOLIDATED · GLOBAL]
- 用户偏好简洁直接的回答风格 <!--m1a2b3c-->
- 用户偏好 TypeScript 严格模式,禁用 any <!--m4d5e6f-->

[CONSOLIDATED · PROJECT git:github.com/me/myapp]
- Next.js 14 App Router + Tailwind CSS <!--m7g8h9i-->
- API 路由统一放在 /app/api/ <!--mjklmno-->
- 部署目标 AWS cn-north-1,使用 CDK <!--mpqrst-->

[PINNED · PROJECT(top 20 by trust)]
- 提交前必须跑 pnpm typecheck && pnpm test <!--muvwxy-->

[FRESH · last 24h]
- 上次添加 /api/upload 时遇到 4MB 限制,需在 next.config.js 调 bodySizeLimit <!--mzabcd-->

* Citation hint: 若回复采纳了上述记忆中的某条,请在末尾以 (ref: m1a2b3c) 形式
  标注 1-3 条最关键来源。
```

### 11.2 UserPromptSubmit 注入文本示例

```
=== ccmem: retrieved for "如何添加新的 API 路由" ===

[m2001] s|0.90|12d
新 API 路由步骤:1) 在 /app/api/<name>/route.ts 创建 2) 默认导出 GET/POST 命名函数 3) 用 zod 校验入参

[m2002] f|0.85|3d
所有 API 都要走 src/lib/auth.ts 的 requireAuth 中间件

[m2003] e|0.70|1d!ctx
危险操作记录:在 myapp 项目(2026-04)调试依赖冲突时使用了 `rm -rf node_modules && npm install` — 仅一次性场景,不作为通用规则

> **C12.5 注**: `!ctx` 表示 context-bound(含 `dangerous_command` tag),而非 `!p` (probation)。
```

### 11.3 紧凑格式规范

#### Memory ID 格式(确定性哈希)

```
完整 ID:  mem_<timestamp_hex>_<random_hex>  (例: mem_1a2b3c4d_5e6f7g8h)
短 ID:    m + SHA256(完整ID)[:7]             (例: m3f8a2c1)

映射函数(确定性,可从完整 ID 重算):
  shortId = 'm' + sha256(fullId).slice(0, 7)
```

**确定性保证**:即使 `injection_cache` 损坏,只要 `memories.id` 存在,短 ID 可重算,反馈归因不会丢失。

```javascript
// lib/memory-id.mjs
export function generateMemoryId() {
  const ts = Date.now().toString(16).padStart(8, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `mem_${ts}_${rand}`;
}

// Basic short ID generation (for display only, deterministic)
export function toShortId(fullId) {
  return 'm' + crypto.createHash('sha256')
    .update(fullId).digest('hex').slice(0, 7);
}

// Collision-safe short ID generation (C5.1)
// Used when uniqueness matters (e.g., injection markers for feedback attribution)
export async function toShortIdSafe(db, fullId) {
  const hash = crypto.createHash('sha256').update(fullId).digest('hex');
  
  // Try progressively longer prefixes until unique
  for (let len = 7; len <= 12; len++) {
    const candidate = 'm' + hash.slice(0, len);
    const collision = await db.get(`
      SELECT id FROM memories 
      WHERE id != ? AND 'm' || substr(hex(sha256(id)), 1, ?) = ?
    `, [fullId, len, candidate]);
    
    if (!collision) return candidate;
  }
  
  // Fallback: use full hash prefix (extremely rare)
  return 'm' + hash.slice(0, 16);
}

export function findByShortId(db, shortId) {
  // 遍历查找(短 ID 不存储,从完整 ID 计算)
  // 支持 7-16 字符长度的短 ID
  const len = shortId.length - 1; // minus 'm' prefix
  return db.get(`
    SELECT * FROM memories 
    WHERE 'm' || substr(hex(sha256(id)), 1, ?) = ?
  `, [len, shortId]);
  // 注: SQLite 无内置 sha256,实际用应用层过滤
}
```

#### 紧凑元数据格式

```
格式: [<shortId>] <type>|<trust>|<age><status_suffix>
示例: [m3f8a2c1] f|0.85|3d

type:    r=rule, f=fact, s=skill, e=episode, c=consolidated
trust:   两位小数,如 0.85
age:     基于 last_touched_at;Nd=N天前,Nh=N小时前
status:  可选后缀
  无后缀 = active
  !p      = probation
  !c      = candidate_expire
  !ctx    = context-bound(含 dangerous_command 等 tag)
```

### 11.4 格式三档

| 格式 | 用途 | 例 |
|------|------|-----|
| `verbose` | 调试 / `/ccmem:show` | `[memory#mem_1234abcd] (type=fact, trust=0.85, age_touched=3d, age_created=15d, hits=7, source=user_explicit)` |
| `compact` | 默认 / UserPromptSubmit | `[m1234] f\|0.85\|3d` |
| `raw` | SessionStart hot segments | (只显示内容,ID 在 HTML 注释里) |

---

## 十二、用户管理命令(slash commands)

### 12.1 命令清单

```
/ccmem:list [--scope all|global|project] [--type rule|...]
                          - List memories
/ccmem:show <id>          - Show single memory detail (trust history, lineage)
/ccmem:pin <id>           - Pin: trust=0.95, memories.pinned=1, never auto-archived
                            LIMIT: max 20 pinned per scope; exceeds → error + suggest unpin
/ccmem:unpin <id>         - Remove pin
/ccmem:forget <id>        - Mark archived; sync cascade to dependent consolidated
/ccmem:edit <id>          - Edit content (source→user_explicit, trust=0.95)
/ccmem:promote <id>       - Promote episode→rule (project scope; requires verbatim safety declaration)
/ccmem:promote-global <id>
                          - Promote rule (project)→rule (global); requires §12.4 safety declaration;
                            BLOCKED for memories tagged dangerous_command or contains_secret
/ccmem:init               - Bootstrap project with initial rules
/ccmem:stats              - Hit rate / acceptance / capacity / recent corrections
/ccmem:bench              - Measure hook latency, write to daily_metrics
/ccmem:migrate <old_key> <new_key>
                          - Project rename / merge
/ccmem:semantic on|off|switch <model>|status
                          - Manage embedding (opt-in)
/ccmem:semantic repair-registry [--dry-run | --interactive | --fix-all]
                          - Diagnose registry / physical-table / embedding inconsistencies (§12.5)
/ccmem:semantic purge-model <model_id>
                          - Drop cached embeddings + physical table for one model;
                            does NOT delete memory content (§12.6)
/ccmem:export [--scope ...]   - Export memories as JSON
/ccmem:import <file>      - Import (auto dedup + trust re-evaluation)

/ccmem:mode [active|shadow|off]
                          - Get/set mode (unifies enable/disable/shadow)
/ccmem:show-key           - Diagnose project_key resolution

/ccmem:daemon start|stop|restart|status
                          - Manage daemon process

/ccmem:purge project      - HIGH-RISK: delete all project memories (strong confirm)
/ccmem:purge-all          - HIGH-RISK: delete all user data (strongest confirm)

/ccmem:audit --recent     - Show recent audit log entries
/ccmem:audit-allow <id>   - Override block decision (requires reason)

/ccmem:diagnose           - Check database health, show operation mode (§16.3)
/ccmem:recover            - Attempt automatic recovery from degraded/safe mode
/ccmem:reset-db --confirm - HIGH-RISK: Force reset database (requires verbatim confirm)
```

### 12.2 `/ccmem:mode` 实现(S4)

```javascript
const VALID_MODES = ['active', 'shadow', 'off'];

async function modeCommand(arg) {
  if (!arg) {
    const { mode, set_at, set_by } = await getCurrentMode();
    return `Mode: ${mode} (set ${humanizeAge(set_at)} by ${set_by})`;
  }
  if (!VALID_MODES.includes(arg)) {
    throw new Error(`Invalid mode: ${arg}. Valid: ${VALID_MODES.join(', ')}`);
  }
  const prev = await getCurrentMode();
  await db.run(`
    INSERT OR REPLACE INTO mode_state (id, mode, set_at, set_by) VALUES (1, ?, ?, ?)
  `, [arg, now(), 'user_command']);
  await logAudit({ action: 'mode_change', details: JSON.stringify({ from: prev.mode, to: arg }) });
  return `ccmem: mode set to '${arg}'`;
}

async function shouldHookRun() {
  const { mode } = await getCurrentMode();
  if (mode === 'off') return { run: false, reason: 'mode_off' };
  return { run: true, mode };
}
```

Hook 入口:
```javascript
const { run, mode } = await shouldHookRun();
if (!run) {
  process.stderr.write(`ccmem: skipped (${mode === undefined ? 'unknown' : 'mode_off'})\n`);
  process.exit(0);
}
// In shadow mode, data is written normally but additionalContext stays empty.
```

### 12.3 `/ccmem:promote` 强确认(C2)

交互式:

```text
================ HIGH-RISK PROMOTION REQUEST ================
Memory ID: m1234abcd
Current type:  episode  (will become rule)
Current scope: project  (will remain project; use /ccmem:promote-global for global)
Current trust: 0.55     (will become 0.70)
Current tags:  [dangerous_command, force_demoted_from_rule,
                require_periodic_revalidation]

Content:
  Dangerous operation record: in myapp project (2026-04) debugging
  dependency conflict, used `rm -rf node_modules && npm install` —
  one-time scenario, not a general rule.

Matched dangerous patterns:
  - rm -rf (Tier 2: bulk file deletion)

Risk notice:
  This content will be treated as a general rule and may be injected
  into the LLM context in all future sessions of this project.
  The LLM may recommend executing rm -rf based on this rule.
  Confirm only if you fully understand the consequences.

==============================================================
Type the following declaration verbatim to confirm:

  "I understand the risk and confirm m1234abcd is safe to apply
   in all scenarios of this project"

>>> _
```

非交互(脚本/CI):

```bash
$ /ccmem:promote m1234abcd \
  --confirm-with-declaration "I understand the risk and confirm m1234abcd is safe to apply in all scenarios of this project"
```

声明文本必须包含 memory ID,且与命令的 ID 参数一致,防止脚本批量提权。

实现:

```javascript
async function promoteCommand(memId, opts = {}) {
  const mem = await db.get(`SELECT * FROM memories WHERE id = ?`, [memId]);
  if (!mem) throw new Error(`Memory not found: ${memId}`);
  if (mem.type === 'rule') {
    return `Memory ${memId} is already a rule. No action taken.`;
  }

  const expectedDeclaration =
    `I understand the risk and confirm ${memId} is safe to apply ` +
    `in all scenarios of this project`;

  if (opts.confirmWithDeclaration) {
    if (opts.confirmWithDeclaration !== expectedDeclaration) {
      throw new Error(`Declaration mismatch. Expected verbatim: "${expectedDeclaration}"`);
    }
  } else {
    // Interactive confirmation
    const got = await promptUser(formatPromoteRiskNotice(mem));
    if (got !== expectedDeclaration) {
      throw new Error('Declaration mismatch or aborted.');
    }
  }

  const fromType = mem.type;
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE memories
      SET type='rule', trust_score=0.70, half_life_days=90,
          modified_by='user_promote', modified_at=?,
          tags=?
      WHERE id=?
    `, [
      now(),
      JSON.stringify(
        (JSON.parse(mem.tags || '[]'))
          .filter(t => t !== 'force_demoted_from_episode'
                    && t !== 'force_demoted_from_rule'
                    && t !== 'dangerous_command')
        // Note: 'require_periodic_revalidation' is intentionally preserved
      ),
      memId,
    ]);
    await logAudit({
      action: 'promote_to_rule',
      affected_ids: [memId],
      details: JSON.stringify({
        from: { type: fromType, trust: mem.trust_score },
        to:   { type: 'rule', trust: 0.70 },
        declaration_received: true,
      }),
    });
  });

  return `ccmem: m${memId} promoted to rule (trust=0.70)`;
}
```

### 12.4 `/ccmem:promote-global` 强确认

`/ccmem:promote-global` 把项目级 rule 提升为全局 rule。**两步走的第二步**——
必须先 `/ccmem:promote` 把 episode 升为 project rule,才能再升 global。

#### 硬阻断规则

| 阻断条件 | 理由 | 用户可选恢复路径 |
|---------|------|----------------|
| `mem.type !== 'rule'` | 跨度太大,强制走两步 | 先 `/ccmem:promote <id>` |
| `mem.scope === 'global'` | 已经是 global,no-op | (无需操作) |
| tag 含 `dangerous_command` | Tier 2 demote 体系不允许跨项目危险规则 | `/ccmem:edit <id>` 重写为非危险措辞后再 promote |
| tag 含 `contains_secret` | secret 不可跨项目泄漏 | 同上 |

> 把 `dangerous_command` 硬阻断,而不是允许"强声明覆盖",是设计上的明确选择:
> Tier 2 防御的整个前提是危险命令的上下文相关性。如果允许 promote-global
> 覆盖,等于打通了 dangerous → global 的路径。用户若真的需要跨项目的"危险类
> 规则",应通过 `/ccmem:edit` 改写措辞(例如把 `rm -rf node_modules` 改成
> "清理依赖目录前先备份"),再正常 promote。这种摩擦是健康的。

#### 实现

```javascript
async function promoteGlobalCommand(memId, opts = {}) {
  const mem = await db.get(`SELECT * FROM memories WHERE id = ?`, [memId]);
  if (!mem) throw new Error(`Memory not found: ${memId}`);

  // 1. Must already be a rule (force two-step path)
  if (mem.type !== 'rule') {
    throw new Error(
      `promote-global requires type='rule', got '${mem.type}'. ` +
      `Run /ccmem:promote ${memId} first.`
    );
  }

  // 2. Already global -> no-op
  if (mem.scope === 'global') {
    return `Memory ${memId} is already global. No action taken.`;
  }

  // 3. Hard-block on dangerous tags (no override)
  const tags = JSON.parse(mem.tags || '[]');
  if (tags.includes('dangerous_command')) {
    throw new Error(
      `Cannot promote-global a memory tagged 'dangerous_command'. ` +
      `Tier 2 demotion enforces project-scope confinement. ` +
      `To make the rule global, use /ccmem:edit ${memId} to rewrite ` +
      `the content without dangerous-command pattern, then re-promote.`
    );
  }
  if (tags.includes('contains_secret')) {
    throw new Error(
      `Cannot promote-global a memory tagged 'contains_secret'. ` +
      `Secrets must stay project-scoped.`
    );
  }

  // 4. Strong verbatim confirmation
  const expectedDeclaration =
    `I confirm ${memId} is universally applicable across ` +
    `ALL my future projects and accept the cross-project risk`;

  if (opts.confirmWithDeclaration) {
    if (opts.confirmWithDeclaration !== expectedDeclaration) {
      throw new Error(`Declaration mismatch. Expected verbatim: "${expectedDeclaration}"`);
    }
  } else {
    const got = await promptUser(formatPromoteGlobalRiskNotice(mem));
    if (got !== expectedDeclaration) {
      throw new Error('Declaration mismatch or aborted.');
    }
  }

  // 5. Apply (transaction)
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE memories
      SET scope='global', project_key=NULL,
          modified_by='user_promote_global', modified_at=?,
          half_life_days = MAX(half_life_days, 90)
      WHERE id=?
    `, [now(), memId]);

    await logAudit({
      action: 'promote_to_global',
      affected_ids: [memId],
      details: JSON.stringify({
        from: { scope: 'project', project_key: mem.project_key },
        to:   { scope: 'global' },
        declaration_received: true,
      }),
    });
  });

  return `ccmem: ${memId} promoted to global rule`;
}
```

#### 用户视角

```text
$ /ccmem:promote-global m1234abcd

================ GLOBAL PROMOTION REQUEST ================
Memory ID:     m1234abcd
Current type:  rule          (no change)
Current scope: project: git:github.com/me/myapp
                              ↓ will become ↓
                              global (visible across ALL your future projects)
Current trust: 0.85           (no change)

Content:
  Prefer pnpm over npm/yarn for all dependency management.

Risk notice:
  This rule will be injected into the LLM context in ALL future
  Claude Code sessions across ALL your projects, including new
  projects you have not started yet. Confirm only if this rule is
  truly universal (not specific to one tech stack, framework, or
  team convention).

==========================================================
Type the following declaration verbatim to confirm:

  "I confirm m1234abcd is universally applicable across
   ALL my future projects and accept the cross-project risk"

>>> _
```

非交互模式(脚本/CI):

```bash
$ /ccmem:promote-global m1234abcd \
  --confirm-with-declaration "I confirm m1234abcd is universally applicable across ALL my future projects and accept the cross-project risk"
```

声明文本必须包含 memory ID 且与命令的 ID 参数一致,防止脚本批量提权。

### 12.5 `/ccmem:semantic repair-registry`

诊断 `embedding_model_registry`、`memory_embedding`、物理 `vec_*` 表三者之间
的状态一致性,并提供受控修复。该命令**只处理元数据/索引不一致**,**真正的
数据清理(包括派生数据)走 `/ccmem:semantic purge-model`**(§12.6)。

#### 5 类不一致场景

| # | 场景 | 检测方法 | 风险 |
|---|------|---------|------|
| 1 | registry 有但物理表缺失 | registry 行 vs `sqlite_master` 名匹配 | 检索时报 "no such table",自动 fallback 到 lexical |
| 2 | 物理表存在但 registry 缺 | 同上反向 | 占用磁盘,不被使用,无功能影响 |
| 3 | `embedding_active` 指向不存在的 registry | LEFT JOIN 为 NULL | 启用 hybrid 后崩溃 |
| 4 | `memory_embedding` 有 `model_id` 但 registry 缺 | LEFT JOIN registry IS NULL | 占用磁盘的孤儿数据 |
| 5 | registry 与物理表 dim 不一致 | 解析物理表 SQL 的 `FLOAT[N]` 与 `registry.dim` 对比 | 检索结果错误,无明显报错(最危险) |

#### 三种修复模式

```
/ccmem:semantic repair-registry              # 默认 --dry-run
/ccmem:semantic repair-registry --interactive   # 逐项 y/N/q 选择
/ccmem:semantic repair-registry --fix-all       # 批量,需 verbatim 'fix all'
```

#### dry-run 输出示例

```text
$ /ccmem:semantic repair-registry

=== ccmem embedding registry diagnostic ===

Active model:
  bge-small-zh-v1.5  (dim 384, status: ready)  OK

Registry entries (3):
  [OK]      bge-small-zh-v1.5  -> vec_bge_small_zh_v1_5_a1b2c3d4   (dim 384)  ready
  [ISSUE-1] minilm-l6-v2        -> vec_minilm_l6_v2_e5f6g7h8        MISSING physical table
  [STALE]   old-experimental    -> vec_old_experimental_z9y8x7w6    (dim 768)  status=failed

Physical vec_* tables (3):
  [OK]      vec_bge_small_zh_v1_5_a1b2c3d4   in registry
  [OK]      vec_old_experimental_z9y8x7w6    in registry (but status=failed)
  [ISSUE-2] vec_orphan_legacy_q1w2e3r4       ORPHAN: not in registry

memory_embedding rows (487 total):
  bge-small-zh-v1.5:  423 rows  (active model)
  old-experimental:   0 rows
  [ISSUE-4] unknown-model-x:  64 rows  ORPHAN: no registry entry

Dimension consistency:
  bge-small-zh-v1.5:  registry says 384, physical table says 384  OK
  old-experimental:   registry says 768, physical table says 768  OK

----------------------------------------------------
Summary: 3 issues found, 1 stale entry

Suggested actions:
  [1] Drop registry entry "minilm-l6-v2"
      Reason: physical table missing; no recoverable data
      Effect: 1 registry row removed; 0 memory_embedding rows affected

  [2] Drop orphan physical table "vec_orphan_legacy_q1w2e3r4"
      Reason: not referenced by any registry entry
      Effect: DROP TABLE; 0 memory_embedding rows affected

  [3] Delete 64 orphan rows from memory_embedding for "unknown-model-x"
      Reason: no registry entry exists for this model_id
      Sample memory_ids: m1a2b3c, m4d5e6f, m7g8h9i  (61 more)
      Effect: 64 rows deleted; disk reclaimed ~512KB

  [4] Clean up failed-status registry entry "old-experimental"
      (separate command: /ccmem:semantic purge-model old-experimental)
      Effect: registry row + physical table + memory_embedding rows all removed

This was a dry-run. No changes made.
Run with --interactive to choose per-issue, or --fix-all to apply all.
```

#### 安全约束

1. 所有 `DROP TABLE` 必须先确认 row count = 0(查物理表 + 关联的 memory_embedding 双重检查)
2. `DELETE` 操作前 sample 3-5 行展示给用户
3. 审计日志必写(每个 fix 一条 audit 记录)
4. **dim_mismatch 不提供自动修复**(数据可能已损坏,需用户决策,引导到 purge-model)
5. `--fix-all` 也要求 verbatim 确认 `fix all`(防止脚本误调)
6. **repair-registry 永远不删 memories 表的任何行**(那是 `/ccmem:forget` / `/ccmem:purge project` 的职责)

#### 实现框架

```javascript
const ISSUE_TYPES = {
  REGISTRY_MISSING_TABLE:  'registry_missing_physical_table',
  TABLE_NOT_IN_REGISTRY:   'physical_table_not_in_registry',
  ACTIVE_POINTS_TO_GHOST:  'active_model_not_in_registry',
  ORPHAN_EMBEDDINGS:       'memory_embedding_no_registry',
  DIM_MISMATCH:            'registry_dim_mismatch_physical',
};

async function diagnoseRegistry() {
  const issues = [];
  const registryEntries = await db.all(`SELECT * FROM embedding_model_registry`);
  const physicalTables = (await db.all(`
    SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'vec_*'
  `)).map(r => r.name);
  const active = await db.get(`SELECT * FROM embedding_active WHERE id = 1`);
  const embeddingModelIds = (await db.all(`
    SELECT DISTINCT model_id FROM memory_embedding
  `)).map(r => r.model_id);

  // ... (detect each of the 5 inconsistency categories above and construct issue records)
  return issues;
}

async function applyFix(issue, opts = {}) {
  if (issue.suggested_action.manual) {
    throw new Error(`Issue type ${issue.type} requires manual intervention`);
  }
  await logAudit({
    action: 'repair_registry_apply',
    details: JSON.stringify({
      issue_type: issue.type,
      action: issue.suggested_action.description,
      requested_by: opts.requested_by || 'user',
    }),
  });
  await db.run(issue.suggested_action.command, issue.suggested_action.args || []);
}

export async function repairRegistryCommand(opts = {}) {
  const issues = await diagnoseRegistry();

  if (!opts.mode || opts.mode === 'dry-run') {
    return formatDryRunReport(issues);
  }
  if (opts.mode === 'interactive') {
    for (const issue of issues) {
      const choice = await promptUser(formatIssueChoice(issue));
      if (choice === 'y') await applyFix(issue);
      else if (choice === 'q') break;
    }
  }
  if (opts.mode === 'fix-all') {
    const confirm = opts.confirmText || await promptUser(`Type 'fix all' to confirm:`);
    if (confirm !== 'fix all') throw new Error('Confirmation mismatch, aborted');
    for (const issue of issues) {
      try { await applyFix(issue); }
      catch (err) { await logAudit({ action: 'repair_registry_fix_failed', details: JSON.stringify({ issue, error: err.message }) }); }
    }
  }
  return formatFinalReport(issues);
}
```

### 12.6 `/ccmem:semantic purge-model`

清除某个 embedding model 的全部派生数据(向量缓存 + 物理索引表 + registry
条目)。**不影响任何 memory 内容**——`memories.content` 是 source of truth,
embeddings 可随时重新生成。

#### 数据分层(理解前提)

| 层 | 内容 | purge-model 影响 |
|---|------|---------------|
| `memories.content` | 用户记忆原始文本 | ❌ 不动(永远 source of truth) |
| `memory_embedding` (BLOB) | 该 model 的向量缓存 | ✅ 删除 |
| `vec_<model>` 虚拟表 | 该 model 的物理索引 | ✅ DROP |
| `embedding_model_registry` 该行 | model 元数据 | ✅ DELETE |
| `embedding_active`(若指向该 model) | active 指针 | ❌ 阻断(必须先 switch / off) |
| 其他模型的所有数据 | | ❌ 不动 |

#### 边界 case 处理

| Case | 处理 |
|------|------|
| 用户对 active model 运行 purge-model | **拒绝**,要求先 `/ccmem:semantic switch <other>` 或 `/ccmem:semantic off` |
| 用户对正在下载的(status=`downloading`) | **拒绝**,要求先 `/ccmem:semantic cancel-download` |
| 用户对 failed status 的 model | ✅ 允许(主要用途之一) |
| 物理表已不存在(只剩 registry) | ✅ 允许,跳过 DROP TABLE,只清 DB rows |
| 用户在 transaction 中途 Ctrl-C | SQLite 原子性保证回滚,无半成品 |

#### 实现

```javascript
async function purgeModelCommand(modelId, opts = {}) {
  // 1. Active-model check
  const active = await db.get(`SELECT active_model FROM embedding_active WHERE id = 1`);
  if (active && active.active_model === modelId) {
    throw new Error(
      `Cannot purge active model "${modelId}". ` +
      `Switch to another model first: /ccmem:semantic switch <other-model>, ` +
      `or disable embedding entirely: /ccmem:semantic off`
    );
  }

  // 2. Registry lookup + row stats
  const regEntry = await db.get(`
    SELECT * FROM embedding_model_registry WHERE model_id = ?
  `, [modelId]);
  if (!regEntry) {
    throw new Error(
      `Model "${modelId}" not in registry. ` +
      `Use /ccmem:semantic repair-registry for orphans.`
    );
  }
  if (regEntry.status === 'downloading') {
    throw new Error(
      `Cannot purge model "${modelId}" while download is in progress. ` +
      `Wait for completion or cancel via /ccmem:semantic cancel-download.`
    );
  }

  const embRowCount = await db.get(`
    SELECT COUNT(*) AS n FROM memory_embedding WHERE model_id = ?
  `, [modelId]);
  const vecTableExists = await db.get(`
    SELECT name FROM sqlite_master WHERE type='table' AND name = ?
  `, [regEntry.vec_table_name]);

  // 3. Strong confirmation
  process.stderr.write(formatPurgeModelRiskNotice({
    modelId,
    regStatus: regEntry.status,
    embRowCount: embRowCount.n,
    vecTableName: vecTableExists ? regEntry.vec_table_name : '(already missing)',
  }));

  const expected =
    `I want to purge embedding cache for ${modelId} and accept ` +
    `the cost of re-embedding if I reactivate later`;
  const got = opts.confirmWithDeclaration || await promptUser();
  if (got !== expected) {
    return `ccmem: purge-model aborted (declaration mismatch)`;
  }

  // 4. Audit + apply (transaction)
  await logAudit({
    action: 'purge_model',
    affected_ids: [modelId],
    details: JSON.stringify({
      embeddings_removed: embRowCount.n,
      physical_table: regEntry.vec_table_name,
      table_existed: !!vecTableExists,
    }),
  });

  await db.transaction(async (tx) => {
    if (vecTableExists) {
      await tx.run(`DROP TABLE ${regEntry.vec_table_name}`);
    }
    await tx.run(`DELETE FROM memory_embedding WHERE model_id = ?`, [modelId]);
    await tx.run(`DELETE FROM embedding_model_registry WHERE model_id = ?`, [modelId]);
  });

  return `ccmem: model "${modelId}" purged (${embRowCount.n} embeddings removed). Memory content unchanged.`;
}
```

#### 用户视角

```text
$ /ccmem:semantic purge-model old-experimental

================ MODEL PURGE REQUEST ================
Model ID:               old-experimental
Registry status:        failed
Embeddings to delete:   0 rows in memory_embedding
Physical index table:   vec_old_experimental_z9y8x7w6

WHAT THIS DOES:
  - Removes 0 cached embedding vectors
  - Drops the per-model index table
  - Removes the registry entry

WHAT THIS DOES NOT DO:
  - Does NOT delete any memory content (memories.content untouched)
  - Does NOT affect injection_cache (lexical retrieval still works)
  - Does NOT affect other models' embeddings

COST TO REVERSE:
  - Re-activating this model later requires re-embedding all
    your memories, which takes time proportional to your model's
    inference speed (typically 1-5 minutes for bge-small-zh-v1.5
    on 500 memories, CPU).

=====================================================
Type the following declaration verbatim to confirm:

  "I want to purge embedding cache for old-experimental and accept
   the cost of re-embedding if I reactivate later"

>>> _
```

#### 与 `/ccmem:purge-*` 的根本区别

| 命令 | 删除范围 | 数据可恢复? |
|------|---------|------------|
| `/ccmem:semantic purge-model <id>` | 仅嵌入向量(派生数据) | ✅ 可,re-activate 后台重算 |
| `/ccmem:purge project` | 该项目所有 memories + 嵌入 + 反馈 + lineage | ❌ 不可,memory 内容丢失 |
| `/ccmem:purge-all` | 全部用户数据(`~/.claude/ccmem/`) | ❌ 不可 |

purge-model 危险等级**远低于** purge-project / purge-all:前者清缓存,后者删数据。
但仍走强确认,因为 re-embed 有时间成本,用户应明确知道。

### 12.7 `/ccmem:purge-*` 高危删除(M5)

```javascript
async function purgeCommand(target, opts = {}) {
  if (!['project', 'all'].includes(target)) {
    throw new Error(`Invalid purge target: ${target}. Valid: project, all`);
  }

  // 1. Compute what will be deleted (summary)
  let summary;
  if (target === 'project') {
    const projectKey = resolveProjectKey();
    const counts = await db.get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN type='rule' THEN 1 ELSE 0 END) AS rules,
        SUM(CASE WHEN type='consolidated' THEN 1 ELSE 0 END) AS consolidated
      FROM memories WHERE project_key = ?
    `, [projectKey]);
    summary = {
      scope: `project: ${projectKey}`,
      total: counts.total, rules: counts.rules, consolidated: counts.consolidated,
    };
  } else {
    const counts = await db.get(`SELECT COUNT(*) AS total FROM memories`);
    const dirSize = await computeDirSize(getDataRoot());
    summary = {
      scope: 'ALL USER DATA',
      total: counts.total,
      data_dir: getDataRoot(),
      disk_size_mb: (dirSize / 1024 / 1024).toFixed(1),
    };
  }

  // 2. Show breakdown + require confirmation
  process.stderr.write(`
================ HIGH-RISK PURGE REQUEST ================
Scope:        ${summary.scope}
Total memories: ${summary.total}
${target === 'project' ? `  Rules:           ${summary.rules}\n  Consolidated:    ${summary.consolidated}` : ''}
${target === 'all'     ? `  Data directory:  ${summary.data_dir}\n  Disk size:       ${summary.disk_size_mb} MB` : ''}

THIS ACTION IS IRREVERSIBLE.
========================================================
Type the following declaration verbatim to confirm:

  "I want to permanently delete ${summary.scope} and accept data loss"

>>> 
`);

  const expected =
    `I want to permanently delete ${summary.scope} and accept data loss`;
  const got = opts.confirmWithDeclaration || await promptUser();
  if (got !== expected) {
    return `ccmem: purge aborted (declaration mismatch)`;
  }

  // 3. C11: Auto-backup before destructive operation
  const backupDir = path.join(getDataRoot(), 'backups');
  await fs.promises.mkdir(backupDir, { recursive: true });
  const backupTs = Date.now();
  const backupPath = path.join(backupDir, `pre-purge-${target}-${backupTs}.db`);

  if (target === 'project') {
    const projectDbPath = path.join(resolveProjectDir(), '.ccmem', 'project.db');
    if (fs.existsSync(projectDbPath)) {
      await fs.promises.copyFile(projectDbPath, backupPath);
      process.stderr.write(`ccmem: backup created at ${backupPath}\n`);
    }
  } else {
    await fs.promises.copyFile(getGlobalDbPath(), backupPath);
    process.stderr.write(`ccmem: backup created at ${backupPath}\n`);
  }

  // 4. Audit before destructive ops
  await logAudit({
    action: target === 'all' ? 'purge_all' : 'purge_project',
    details: JSON.stringify({ ...summary, backup_path: backupPath }),
  });

  // 5. Execute (must go through safe-fs, see section 16)
  if (target === 'project') {
    await purgeProjectData(resolveProjectKey());
  } else {
    await purgeAllUserData();
  }

  return `ccmem: ${target} purged. Backup at ${backupPath}`;
}
```

---

## 十三、评估指标(M6,SQLite 表)

### 13.1 metrics schema 与生成

```sql
-- Already defined in section 4.1
CREATE TABLE daily_metrics (
  date         TEXT PRIMARY KEY,
  metrics_json TEXT NOT NULL,
  updated_at   TIMESTAMP NOT NULL
);
```

`daily_consolidation` 末尾写入:

```javascript
async function computeDailyMetrics() {
  const today = todayDateStr();
  const metrics = {
    version: 1,
    as_of: today,
    rolling_7d: await compute7dStats(),
    memory_health: await computeMemoryHealth(),
    consolidation: await computeConsolidationStats(),
    observability: await computeObservability(),
  };
  await db.run(`
    INSERT OR REPLACE INTO daily_metrics (date, metrics_json, updated_at)
    VALUES (?, ?, ?)
  `, [today, JSON.stringify(metrics), now()]);
}
```

### 13.2 metrics 字段

```json
{
  "version": 1,
  "as_of": "2026-05-21",
  "rolling_7d": {
    "injection_count": 142,
    "hit_helpful": 87,
    "hit_unhelpful": 11,
    "hit_helpful_implicit": 33,
    "hit_unknown": 11,
    "helpful_rate": 0.61,
    "avg_injected_per_prompt": 4.3
  },
  "memory_health": {
    "total_active": 312,
    "total_archived": 47,
    "total_probation": 9,
    "total_quarantine": 2,
    "avg_trust_active": 0.78,
    "dangerous_command_count": 5,
    "pending_revalidation": 3
  },
  "consolidation": {
    "last_daily_run": "2026-05-21T02:17:00",
    "merged_last_7d": 23,
    "consolidated_last_7d": 4,
    "cascade_archived_last_7d": 2
  },
  "observability": {
    "hook_latency_ms": {
      "session_start":      { "p50": 180, "p95": 290, "p99": 450 },
      "user_prompt_submit": { "p50": 240, "p95": 540, "p99": 820 },
      "pre_compact":        { "p50": 25,  "p95": 60,  "p99": 120 },
      "stop":               { "p50": 18,  "p95": 45,  "p99": 90  }
    },
    "cron_catch_up_events_7d": 3,
    "tier2_demoted_7d": 8,
    "tier2_blocked_7d": 2,
    "tier1_blocked_7d": 0
  }
}
```

**注**:不含 `cache_hit_rate`(v2.1 移除),因 Anthropic prompt cache 不对 hook 暴露指标。

---

## 十四、配置文件

```jsonc
// ~/.claude/ccmem/config.json (覆盖 config.default.json)
{
  "version": "3.0",
  "paths": {
    "data_root": "~/.claude/ccmem",
    "project_subdir": ".ccmem"
  },
  "retrieval": {
    "mode": "lexical",
    "_comment_mode": "lexical (default, no download) | hybrid (opt-in, requires /ccmem:semantic on) | daemon (Phase 5 A) | prefetch (Phase 5 B)",
    "candidatesPerLane": 30,
    "promptSubmitTopK": 6,
    "sessionStartStableTopN": 8,
    "min_trust_inject": 0.4,
    "daemon_socket": "~/.claude/ccmem/daemon.sock"
  },
  "embedding": {
    "enabled": false,
    "active_model": "bge-small-zh-v1.5",
    "registry": {
      "bge-small-zh-v1.5": { "dim": 384,  "url": "...", "size_mb": 95  },
      "bge-m3":            { "dim": 1024, "url": "...", "size_mb": 567 },
      "all-minilm-l6-v2":  { "dim": 384,  "url": "...", "size_mb": 80  }
    },
    "purge_old_on_switch": false
  },
  "injection": {
    "format": "compact",
    "use_raw_for_hot_segments": true,
    "budget": {
      "consolidated_global":  1000,
      "consolidated_project": 1000,
      "pinned":               1000,
      "fresh":                500,
      "total_cap":            4000,
      "_comment":             "total_cap > sum 留 buffer (M4)",
      "pinned_max_lines":     20,
      "overflow_trim_order":  ["fresh", "consolidated_project", "consolidated_global", "pinned"],
      "_comment_trim":        "当总量超 total_cap 时,按此顺序裁剪(左侧先裁)"
    }
  },
  "priority": {
    "basePriority":      { "rule": 1.2, "fact": 1.0, "skill": 1.3, "episode": 0.7, "consolidated": 1.5 },
    "halfLifeDays":      { "rule": 90,  "fact": 60,  "skill": 90,  "episode": 14,  "consolidated": 180 },
    "frequencyBoostCap": 1.8,
    "frequencyBoostCoef": 0.08,
    "unhelpfulPenaltyCoef": 2.0,
    "frequencyFactorFloor": 0.1
  },
  "trust": {
    "sourceInitial": {
      "user_explicit": 0.9, "cron_consolidated": 0.85,
      "tool_output": 0.7, "auto_inferred": 0.5,
      "external": 0.3, "cerebrum_import": 0.8
    },
    "sourceMaxAfterProbation": {
      "user_explicit": 0.95, "cron_consolidated": 0.95,
      "tool_output": 0.9, "auto_inferred": 0.8,
      "external": 0.7, "cerebrum_import": 0.85
    },
    "probationDays": {
      "user_explicit": 0, "cron_consolidated": 0,
      "tool_output": 7, "auto_inferred": 14,
      "external": 14, "cerebrum_import": 7
    },
    "rewardOnHelpful": 0.05,
    "rewardOnHelpfulImplicit": 0.025,
    "penaltyOnUnhelpful": 0.10,
    "penaltyOnCorrection": 0.15
  },
  "cron": {
    "mode": "auto",
    "lazy_catch_up_on_hook": true,
    "auto_start_daemon": true,
    "tasks": {
      "summarize_pending":      { "schedule": "adaptive",   "max_catch_up_window_sec": 3600 },
      "daily_consolidation":    { "schedule": "17 2 * * *", "max_catch_up_window_sec": 86400 },
      "weekly_reflection":      { "schedule": "17 3 * * 0", "max_catch_up_window_sec": 604800 },
      "security_audit":         { "schedule": "17 4 * * 1", "max_catch_up_window_sec": 259200 },
      "revalidation_audit":     { "schedule": "17 4 * * 3", "max_catch_up_window_sec": 259200 }
    }
  },
  "security": {
    "tier1_patterns": "default",
    "tier2_patterns": "default",
    "tier2_weights": {
      "in_code_block":          -3,
      "in_quotes":              -2,
      "imperative_prefix":      2,
      "no_explanation":         1,
      "short_content_dominant": 1
    },
    "tier2_thresholds": {
      "allow_below": -1,
      "block_above": 2
    },
    "secret_patterns": "default",
    "block_secret_in_global": true,
    "revalidation_interval_days": 30,
    "force_demote_rule_to_episode": true,
    "force_scope_to_project": true,
    "auditTrustThreshold": 0.4,
    "cascadeDegradeOnLineageEmpty": true
  },
  "capacity": {
    "maxActivePerScope": 2000,
    "forceConsolidateAtPercent": 90,
    "evictBottomPercent": 20,
    "hardLimitMultiplier": 1.1,           // 硬上限 = maxActivePerScope × 1.1 (C5.1)
    "strictMode": false                    // true 时所有写入都做原子检查
  },
  "hooks": {
    "openwolfIntegration": "auto",
    "writeCerebrum": false
  },
  "feedback": {
    "enabled": true,
    "inference_window_turns": {
      "retrieved":         2,
      "session_start":     5
    },
    "negative_keywords_pattern":      "default",
    "correction_keywords_pattern":    "default",
    "assistant_selfcorrect_pattern":  "default",
    "implicit_helpful_boost":         0.025,
    "llm_review_sample_size":         100
  },
  "logging": {
    "daemon_log_rotation": {
      "rotate_daily":      true,
      "max_size_mb":       10,
      "retain_days":       90
    }
  }
}
```

---

## 十五、目录结构(L5)

```
~/.claude/plugins/ccmem/          # 代码与默认配置(版本管理跟着插件走)
├── package.json
├── config.default.json
├── scripts/
│   ├── hook.mjs                  # 单入口分发
│   ├── daemon.mjs
│   ├── handlers/
│   │   ├── session-start.mjs
│   │   ├── prompt-submit.mjs
│   │   ├── pre-compact.mjs
│   │   ├── stop.mjs
│   │   └── session-end.mjs
│   ├── lib/
│   │   ├── db.mjs
│   │   ├── safe-fs.mjs           # 全部删除操作必走此模块(§16)
│   │   ├── retrieve.mjs          # RetrievalProvider 抽象
│   │   ├── priority.mjs
│   │   ├── trust.mjs
│   │   ├── trust-constants.mjs   # SOURCE_MAX_TRUST 等
│   │   ├── embed.mjs             # opt-in
│   │   ├── threat-scan.mjs       # Tier 1/2/3 判别
│   │   ├── threat-patterns.mjs   # 正则库(版本化)
│   │   ├── secret-scan.mjs       # secret 模式库
│   │   ├── project-key.mjs       # normalizeGitUrl 等
│   │   ├── injection-cache.mjs   # 段渲染 + budget 裁剪
│   │   ├── lazy-catch-up.mjs
│   │   ├── daemon-control.mjs    # checkDaemonHealth / startDaemonDetached
│   │   ├── wake-file.mjs         # daemon.wake 触发 / 监听
│   │   ├── mode.mjs              # active/shadow/off
│   │   ├── audit.mjs             # logAudit 封装
│   │   ├── openwolf-bridge.mjs   # cron-manifest / cerebrum 解析
│   │   └── claude-p.mjs          # claude -p 子进程封装
│   ├── cron/
│   │   ├── summarize-pending.mjs
│   │   ├── daily-consolidation.mjs
│   │   ├── weekly-reflection.mjs
│   │   ├── security-audit.mjs
│   │   └── revalidation-audit.mjs
│   ├── migrations/
│   │   └── 001_initial.sql
│   └── platform/
│       ├── launchd.plist.tmpl    # macOS,含 WakeFromSleep
│       ├── systemd.service.tmpl  # Linux,timer 配 Persistent=true
│       └── win-task.xml.tmpl     # Windows,missed-trigger catch-up
├── commands/                     # /ccmem:xxx slash command 定义
│   ├── ccmem-list.md
│   ├── ccmem-show.md
│   ├── ccmem-pin.md
│   ├── ccmem-unpin.md
│   ├── ccmem-forget.md
│   ├── ccmem-edit.md
│   ├── ccmem-promote.md
│   ├── ccmem-init.md
│   ├── ccmem-stats.md
│   ├── ccmem-bench.md
│   ├── ccmem-migrate.md
│   ├── ccmem-semantic.md
│   ├── ccmem-export.md
│   ├── ccmem-import.md
│   ├── ccmem-mode.md
│   ├── ccmem-show-key.md
│   ├── ccmem-daemon.md
│   ├── ccmem-purge.md
│   ├── ccmem-audit.md
│   └── ccmem-audit-allow.md
└── tests/

~/.claude/ccmem/                  # 用户数据(不跟版本走)
├── config.json                   # 用户配置(覆盖 config.default.json)
├── global.db                     # 全局记忆 DB
├── daemon.pid                    # daemon 进程信息
├── daemon.log                    # daemon 滚动日志
├── daemon.wake                   # Stop hook 触发文件
├── daemon.sock                   # Phase 5 daemon IPC(可选)
├── embeddings/                   # 模型缓存(按需下载)
│   └── bge-small-zh-v1.5/
│       ├── tokenizer.json
│       ├── model.onnx
│       └── tmp_<uuid>.partial    # 下载临时文件
├── audit/                        # 审计日志归档(daemon 滚动)
│   ├── 2026-W20.log
│   └── 2026-W21.log
└── README.md                     # 自动生成,提示用户内容与清理方式

<project>/.ccmem/                 # 项目数据
├── project.db
└── .gitignore                    # 推荐:`*.db` + `!.gitkeep`
```

### 用户清理路径

| 操作 | 影响 |
|------|------|
| `rm -rf ~/.claude/plugins/ccmem` | 卸载插件,**数据保留** |
| `rm -rf ~/.claude/ccmem` | 删除全部用户数据(global + 缓存 + 日志) |
| `rm -rf <project>/.ccmem` | 仅删该项目记忆 |
| `/ccmem:purge project` | 同上,**走特批高危删除**(强确认 + 审计) |
| `/ccmem:purge-all` | 同 `~/.claude/ccmem` 全删,**特批高危** |

---

## 十六、安全删除与逃生口

### 16.1 safe-fs 模块(M5)

**永不使用 `rm -rf` 或任何 shell 通配删除**。

```javascript
// scripts/lib/safe-fs.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CCMEM_DATA_ROOT = path.resolve(
  process.env.CCMEM_DATA_ROOT
    || path.join(os.homedir(), '.claude/ccmem')
);

export async function safeDeleteFile(filePath, opts = {}) {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`safeDeleteFile requires absolute path: ${filePath}`);
  }

  const resolved = await fs.realpath(filePath).catch(() => path.resolve(filePath));
  const allowedRoots = (opts.allowedRoots || [CCMEM_DATA_ROOT]).map(r => path.resolve(r));

  const inAllowedRoot = allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!inAllowedRoot) {
    throw new Error(
      `Refusing to delete outside allowed roots:\n` +
      `  path: ${resolved}\n` +
      `  allowed: ${allowedRoots.join(', ')}`
    );
  }

  const stat = await fs.lstat(resolved);
  if (!stat.isFile()) {
    throw new Error(
      `safeDeleteFile only deletes regular files: ${resolved} ` +
      `is ${stat.isDirectory() ? 'directory' : 'special'}`
    );
  }

  if (opts.filenamePattern && !opts.filenamePattern.test(path.basename(resolved))) {
    throw new Error(`Filename does not match expected pattern: ${path.basename(resolved)}`);
  }

  await logAudit({
    action: 'safe_delete_file',
    path: resolved,
    size: stat.size,
    requested_by: opts.requested_by || 'system',
  });

  await fs.unlink(resolved);
}

// 不实现 safeDeleteDirectory(避免递归删除的风险扩散)
// 删除目录:遍历调用 safeDeleteFile + 最后单独删空目录
export async function safeEmptyAndRemoveDir(dirPath, opts = {}) {
  if (!path.isAbsolute(dirPath)) throw new Error(`absolute path required`);
  const resolved = await fs.realpath(dirPath).catch(() => path.resolve(dirPath));
  const allowedRoots = (opts.allowedRoots || [CCMEM_DATA_ROOT]).map(r => path.resolve(r));
  if (!allowedRoots.some(r => resolved === r || resolved.startsWith(r + path.sep))) {
    throw new Error(`Refusing to remove directory outside allowed roots: ${resolved}`);
  }

  // 递归遍历,只删 file(走 safeDeleteFile),不接受目录中的目录链接
  for await (const entry of walkFilesOnly(resolved)) {
    await safeDeleteFile(entry, {
      allowedRoots: [resolved],
      requested_by: opts.requested_by || 'system',
    });
  }

  // 删空目录(自底向上)
  await removeEmptyDirsRecursive(resolved);
}

async function walkFilesOnly(root) { /* ... */ }
async function removeEmptyDirsRecursive(root) { /* 用 rmdir,不接受 recursive */ }
```

### 16.2 Kill switch(L10)

`/ccmem:mode off` 已覆盖此场景(§12.2):
- mode_state 表为 `off` 时,所有 hook 立即 `exit 0`
- daemon 主循环 mode='off' 时只休眠
- 用户运行 `/ccmem:mode active` 恢复

### 16.3 数据库故障容错(A11)

当数据库损坏、磁盘满、权限错误时,ccmem 不应导致 Claude Code 完全不可用。

#### 4 级降级模式

| 模式 | 触发条件 | 功能 |
|------|---------|------|
| `normal` | 数据库健康 | 全部功能 |
| `degraded` | 数据库被锁定 | Hook 正常,daemon 不运行 |
| `safe` | 数据库损坏/只读 | 仅注入(用缓存),不写入 |
| `bypass` | 无法恢复的错误 | ccmem 完全禁用 |

#### 功能矩阵

| 功能 | normal | degraded | safe | bypass |
|------|--------|----------|------|--------|
| 记忆注入 | ✓ | ✓ | ✓ (cached) | ✗ |
| 记忆写入 | ✓ | ✓ | ✗ | ✗ |
| 反馈记录 | ✓ | ✓ | ✗ | ✗ |
| Daemon | ✓ | ✗ | ✗ | ✗ |
| Cron 任务 | ✓ | ✗ | ✗ | ✗ |
| 用户命令 | ✓ | ✓ (部分) | ✓ (只读) | ✗ |

#### 实现

```javascript
// lib/daemon-lock.mjs
const OPERATION_MODES = {
  NORMAL: 'normal', DEGRADED: 'degraded', SAFE: 'safe', BYPASS: 'bypass'
};

let currentMode = OPERATION_MODES.NORMAL;

export async function acquireDaemonLockWithFallback() {
  try {
    await verifyDatabaseHealth();
    return await acquireDaemonLock();
  } catch (e) {
    return handleLockFailure(e);
  }
}

async function verifyDatabaseHealth() {
  const checks = ['file_exists', 'file_writable', 'schema_valid', 'lock_table'];
  for (const check of checks) {
    const result = await runCheck(check);
    if (!result.ok) throw new DbHealthError(check, result.error);
  }
}

function handleLockFailure(error) {
  const classification = classifyDbError(error);
  
  switch (classification.type) {
    case 'corruption':
    case 'permission':
    case 'disk_full':
      currentMode = OPERATION_MODES.SAFE;
      break;
    case 'locked':
      currentMode = OPERATION_MODES.DEGRADED;
      break;
    case 'missing':
      return { mode: OPERATION_MODES.NORMAL, firstRun: true };
    default:
      currentMode = OPERATION_MODES.DEGRADED;
  }
  
  logDegradation(classification, error);
  return { mode: currentMode, reason: classification.type };
}

function classifyDbError(error) {
  const msg = error.message.toLowerCase();
  if (msg.includes('malformed') || msg.includes('corrupt')) return { type: 'corruption' };
  if (msg.includes('permission') || msg.includes('readonly')) return { type: 'permission' };
  if (msg.includes('disk full') || msg.includes('enospc')) return { type: 'disk_full' };
  if (msg.includes('locked') || msg.includes('busy')) return { type: 'locked' };
  if (msg.includes('no such file')) return { type: 'missing' };
  return { type: 'unknown' };
}

// Hook 入口使用
export function canWrite() {
  return currentMode === OPERATION_MODES.NORMAL || currentMode === OPERATION_MODES.DEGRADED;
}
export function canInject() {
  return currentMode !== OPERATION_MODES.BYPASS;
}
export function canRunDaemon() {
  return currentMode === OPERATION_MODES.NORMAL;
}
```

#### Hook 入口集成

```javascript
// handlers/session-start.mjs
async function handleSessionStart(hookData) {
  const lockResult = await acquireDaemonLockWithFallback();
  
  if (lockResult.mode === 'bypass') {
    process.stderr.write('ccmem: disabled due to unrecoverable error\n');
    process.exit(0);
  }
  if (lockResult.mode === 'safe') {
    process.stderr.write('ccmem [safe mode]: read-only, run /ccmem:diagnose\n');
  }
  if (lockResult.mode === 'degraded') {
    process.stderr.write('ccmem [degraded]: daemon unavailable\n');
  }

  // 模式感知的逻辑分支
  if (canWrite()) {
    await recordFeedback(...);
    await bumpRecallCounters(...);
  }
  if (canInject()) {
    // ... injection logic
  }
}
```

#### 用户诊断命令

```bash
/ccmem:diagnose    # 检查数据库健康状态
/ccmem:recover     # 尝试自动恢复
/ccmem:reset-db --confirm  # 强制重置(高危)
```

---

## 十七、实现路线图

### Phase 0:基础设施

- 目录结构 + SQLite + schema migration 001
- `project_key` 解析(git remote 优先)
- safe-fs 模块 + 单元测试
- audit log 模块
- mode 切换骨架

### Phase 1:核心 hook 链(lexical-only)

- SessionStart:injection_cache 读取 + pinned/fresh 实时渲染 + lazy catch-up
- UserPromptSubmit:LexicalProvider(FTS5 + Jaccard) + 反馈写入
- Stop / SessionEnd:写 pending_summarize + wake file
- 写入闸门 insertMemory():Tier 1 + secret + Tier 2 + 强制降级
- `/ccmem:mode`, `/ccmem:list`, `/ccmem:show`, `/ccmem:forget`(同步级联), `/ccmem:show-key`
- 反馈推断 L1(关键词 + 上下文判别)

### Phase 2:Daemon + 异步整合

- 独立 daemon(单实例锁 + 心跳 + wake file)
- daemon 自动拉起(checkDaemonHealth + startDaemonDetached)
- `summarize_pending` cron(自适应轮询 + 高优先级 + claude -p 封装)
- `daily_consolidation`(half-life + dedupe + 删除归档)
- 反馈推断 L2(transcript 自纠) + L3(沉默通过)
- `/ccmem:pin`, `/ccmem:unpin`, `/ccmem:edit`, `/ccmem:promote`, `/ccmem:stats`, `/ccmem:daemon`, `/ccmem:bench`

### Phase 3:深度反思与防护

- `weekly_reflection`:consolidated_rules + injection_cache 重生 + lineage 写入 + L4 反馈复核
- PreCompact hook(估算 ~70% 边界入队，实际压缩是 LLM 驱动)
- 语义矛盾检测 + quarantine 状态
- `security_audit` + `revalidation_audit`
- consolidated 级联降级兜底
- `/ccmem:audit`, `/ccmem:audit-allow`

### Phase 4:OpenWolf 集成 + 评估

- 检测 `.wolf/cron-manifest.json` 自动注册
- cerebrum.md 段落映射 sync 子步骤(读)
- `/ccmem:export`, `/ccmem:import`, `/ccmem:migrate`
- daily_metrics 完整指标 + `/ccmem:stats` 输出
- 跨平台守护模板(launchd / systemd / scheduled task)
- `/ccmem:purge`, `/ccmem:purge-all`(特批高危删除)

### Phase 5:增强(opt-in)

- `embedding` opt-in 流程:`/ccmem:semantic on/switch/repair-registry`
  - 5 层唯一性防御(validateModelId / hash 后缀 / UNIQUE 约束 / 运行时活检 / repair 命令)
  - 多 vec_index 表 + BLOB 原始数据
  - 后台 embed worker
- HybridProvider 上线
- 评估实测:容量、p95、helpful_rate 决定是否进 DaemonIpcProvider 或 PrefetchProvider
- 容量保护与强制整合
- 可视化 dashboard(可选)
- shadow mode 数据观察(beta 用户试用 1 周再切 active)

---

## 十八、Known unknowns

- **Embedding 模型可选下载体验**:`/ccmem:semantic on` 时后台下载 ~95MB(bge-small),需明确进度提示。下载期间检索自动 fallback 到 lexical。
- **Windows 守护进程**:`scheduled tasks` 可靠性不如 launchd/systemd。Layer 1 lazy catch-up + daemon 自动拉起组合应可兜底,但用户从不开 Claude Code 时会持续积压。
- **多机同步**:目前设计是单机本地,跨设备同步(笔记本 + 台式)未覆盖。可能策略:`<project>/.ccmem/project.db` 纳入 git;`global.db` 留本地,通过 `/ccmem:export/import` 手动同步。
- **多用户共享项目**:同一 git remote 下多人各自有自己的 ccmem,跨人的 project 记忆是否要合并?暂不考虑(隐私 + 个性化需求矛盾)。
- **反馈推断误判率**:L1/L2 关键词模板初版基于经验,需实测调整。L4 LLM 复核可纠正,但累积错误需观察。
- **`weekly_reflection` 周日深夜跑不到的概率**:已扩窗到 604800s (7 天, C8),覆盖整周未开机场景。Layer 1 lazy catch-up 在下次 SessionStart 时补执行。
- **fs.watch 在 NFS / 远程文件系统的可靠性**:已设计轮询降级,但需要在 CI 上覆盖。
- **summarize_pending 高频触发场景**:用户连开多个短会话,pending 队列可能膨胀。当前没有去重(同 session_id 多条 trigger 入队);可能需要 daemon 消费时合并。
- **dangerous_command tag 的国际化**:目前正则只覆盖中英,日韩等用户的场景未测。
- **prompt cache 利用率**:Anthropic prompt cache TTL 默认 5 分钟,在 agent 长时会话场景常 miss。**设计明确不依赖 cache 优化**——hot/injection_cache 的稳定性是为了"语义有用"而非"命中 cache"。已不在 metrics 中追踪。
- **多 Claude Code 窗口反馈冲突 (C15.1)**:用户同时打开多个窗口时,反馈推断基于 session_id 隔离,理论安全。但若用户混淆窗口说"刚才不对"时指的是另一个窗口,可能产生误判。暂无自动防御,依赖 L4 LLM 复核纠正。5 分钟时间窗口 (§6.6 C6) 可减少跨 session 干扰但不能完全消除用户心智混淆的场景。
