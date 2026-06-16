# ccmem v0.10 实施 spec

> 这是 v0.10 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) …
> [`ccmem-v0.9-spec.md`](./ccmem-v0.9-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.9 让 ccmem 学会了"自我清洁和自我发现"；v0.10 解决 ccmem 的**缓存灾难**——
> UserPromptSubmit 的"每 prompt 注入 `additionalContext`"设计导致系统提示缓存前缀每轮失效，
> 月损 ~$135-$1,350（按使用强度）。v0.10 采用**方案 E（文件旁路注入）**：检索结果写入
> `.ccmem/context.md` 文件，`additionalContext` 始终为空；Read 指令通过 SessionStart
> `additionalContext` 注入（代码控制，不可误删），Claude Read 文件获取记忆。
> 100% 消除 ccmem 导致的缓存失效，与 OpenWolf 的 stderr + 文件 Read 设计模式一致。
>
> **设计依据**：[`ccmem-cache-impact-analysis.md`](./ccmem-cache-impact-analysis.md)
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。

---

## 〇、与 v0.9 的关系与关键约定

### 0.1 v0.9 已实现的基线（不重复）

v0.9 已 ship 以下能力，v0.10 在其上叠加，**不重写**：

- 输入端治理升级（quality gate v2 + prompt 分级提取 + transcript_cleaner extra_rules）
- 整合端提质（candidate_expire 条件放宽 + 黑洞修复 + 原子 last_touched_at + consolidated 60d 快速过期）
- 检索可观测性（injection scores + never-injected + show history + diagnose --injections + stats hint）
- 预防性扩展（retrieval timing instrumentation）
- 跨项目知识自动发现（cross_project_patterns cron + promote_candidates + resurrect --promote-candidates）

### 0.2 关键实现约定（沿用 v0.2-v0.9）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.10 不引入新 LLM 调用 |
| **stdout/stderr 分流** | SessionStart 稳定上下文走 stdout `additionalContext`；UserPromptSubmit 检索结果走 `.ccmem/context.md` 文件（v0.10）；元数据走 stderr + `audit_log` |
| **命令 prelude 调 `maybeRunTier15`** | v0.10 新命令同样遵守 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |

### 0.3 版本号

- `config.default.json::version` 从 `"0.9"` 升到 `"0.10"`
- schema `schema_meta.version` 从 `11` 升到 `12`（migration `012_v010.sql`）
- `config.default.json::security.scan_patterns_version` **不 bump**（v0.10 不动 patterns）

### 0.4 v0.10 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — Stop | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **零变化** |
| Trust 系数 / 优先级公式 | 零变化 |
| L1 否定/正向 / L2 / L2.5 / L4 | 零变化 |
| summarize_pending | 零变化 |
| weekly_synthesis / security_audit / contradiction_audit / revalidation / monthly_meta | 零变化 |
| daily_maintenance | 零变化 |
| Tier 1.5 lazy maintenance | 零变化 |
| daemon self-restart / container fallback / platform 层 | 零变化 |
| EmbeddingProvider / 三路检索算法 / CJK tokenize / per-session dedup | 零变化 |
| quality gate v2 / transcript_cleaner | 零变化 |
| cross_project_patterns | 零变化 |

---

## 一、范围与时间预算

### 1.1 v0.10 做什么（M11，约 2 周）

| 阶段 | # | 能力 | 说明 |
|---|---|---|---|
| **P1** | A1 | **UserPromptSubmit 文件旁路注入** | 检索结果写入 `.ccmem/context.md`，`additionalContext` 返回空 → 缓存前缀 100% 不受 ccmem 影响 |
| **P1** | A2 | **SessionStart Read 指令注入** | 在 stable context 后拼接固定 Read 指令，引导 Claude Read `.ccmem/context.md`；session 内不变 → 缓存友好 |
| **P1** | A3 | **`.ccmem/` 文件管理** | `.gitignore` 提醒 + context.md 哈希门控写入（无 SessionEnd 清理——Claude Code Stop hook 无法区分 session 结束 vs turn 结束） |
| **P2** | B1 | **缓存效率诊断** | `diagnose --injections` 新增 cache efficiency 段 + metrics.jsonl 新增 3 个字段 |
| **P2** | B2 | **v0.9 backlog 修复** | `compileSafePattern` 复用 `pattern-safety.mjs`（M1）+ `resurrect --promote-candidates` 按项目过滤（M2） |

### 1.2 v0.10 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 跨项目冷启动继承 | v0.11 | 先让 v0.10 缓存改造跑稳 |
| better-sqlite3 + sqlite-vec ANN | v0.11+ | JS cosine 5000 mems 内 ~60ms，无性能压力 |
| 检索候选预过滤优化 | v0.11+（数据驱动） | B2 监控数据证明 retrieval p95 > 100ms 时再启动 |
| query embedding 缓存（API provider） | v0.11+ | 需先积累 API provider 用户的延迟数据 |
| Read 执行率 fallback（additionalContext 精简摘要兜底） | v0.11（数据驱动） | v0.10 dogfood 实测 Read 执行率 > 90% 则不需要 |
| SessionEnd 清理 context.md | v0.11+（数据驱动） | Stop hook 无法区分 session 结束 vs turn 结束（§4.3），context.md 残留无害——下次 UserPromptSubmit 自然覆盖 |
| context.md diff 模式（仅写增量） | v0.11+（数据驱动） | v0.10 先全量写入，收集 conversation token 增长数据 |
| Windows scheduled task | v0.11+ | 无 dogfood 设备 |

### 1.3 依赖关系

```
012 schema (仅 bump)
    → context-file.mjs (新模块)
        → prompt-submit.mjs (A1) + session-start.mjs (A2)
            → diagnose.mjs (B1)
                → B2 backlog fixes (独立, 可并行)
                    → config + 回归
```

### 1.4 完成判据（M11）

**A1 — UserPromptSubmit 文件旁路注入**：
1. 检索有结果 → `.ccmem/context.md` 非空 + `additionalContext === ''`
2. 检索无结果 → `.ccmem/context.md` 为空 + `additionalContext === ''`
3. mode=shadow → `.ccmem/context.md` 不写入 + `additionalContext === ''`
4. 20 连续 prompt → 所有 `additionalContext` 输出字节级一致（全空）
5. v0.9 检索算法（FTS5 + Jaccard + cosine 三路融合）行为零变化

**A2 — SessionStart Read 指令注入**：
6. SessionStart `additionalContext` = stable context + Read 指令，session 内不变
7. Read 指令文本由代码控制，不依赖用户 CLAUDE.md
8. `/compact` 后 Read 指令仍存在（`additionalContext` 不被 compact 压缩）

**A3 — 文件管理**：
9. `.ccmem/` 目录自动创建（`mkdirSync recursive`）
10. `.ccmem/context.md` 首行含 `<!-- content-hash: XXXXXXXX -->`
11. context.md 由每次 UserPromptSubmit 自然覆盖，session 间残留无害；检索无结果时写入 `<!-- ccmem: no relevant memories -->` 明确信号（非空字符串）
12. 首次运行时 stderr 提醒用户将 `.ccmem/` 加入 `.gitignore`（持久化标记，只提醒一次）

**B1 — 缓存效率诊断**：
13. `diagnose --injections` 新增 "Cache efficiency" 段
14. `metrics.jsonl` prompt_submit 行含 `context_file_written` / `context_file_bytes` / `additional_context_empty`

**B2 — v0.9 backlog 修复**：
15. `compileSafePattern` 增加 `isPatternSafe` 前置检查（fuzz-based ReDoS 检测，5 个恶意字符串 × 50ms 超时）
16. `resurrect --promote-candidates` 按当前 `project_key` 过滤

**通用**：
17. v0.9 测试套全量回归 100% 通过（1046/1046）
18. embedding 关闭时所有 hook 输出与 v0.9 字符级一致（`file_based=true` 时 UserPromptSubmit `additionalContext` 从注入改为空；`file_based=false` 降级时与 v0.9 完全一致）
19. context.md 大小超过 8KB 时自动截断（移除优先级最低的记忆）并 stderr 告警

---

## 二、架构（v0.10 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart (v0.10 改造 A2):                                        │
│    注入 stable context + Read 指令 (固定文本, session 内不变)          │
│    → additionalContext 缓存友好 ✅                                    │
│                                                                       │
│  UserPromptSubmit (v0.10 改造 A1):                                    │
│    retrieveMemories (算法不变)                                        │
│      → 有结果 → 写入 .ccmem/context.md (哈希门控)                     │
│      → 无结果 → 清空 .ccmem/context.md                                │
│    additionalContext = '' (始终为空) → 缓存前缀不变 ✅                 │
│    feedback / recent_injections / metrics (v0.9 行为不变)              │
│    stderr: "ccmem: RETRIEVE N mems → .ccmem/context.md"              │
│                                                                       │
│  Stop (v0.10 零变化)                                                  │
│                                                                       │
│  Claude Read .ccmem/context.md (引导式):                              │
│    → 内容进入 conversation messages (顶部动态区)                       │
│    → 不打破系统提示缓存前缀 ✅                                         │
│    → 哈希门控: 相同 hash 跳过 re-read                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.10 零变化)                                                │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (v0.10 零 schema 变化)                                        │
│    schema_meta.version 11 → 12 (migration 012 仅 bump)                │
└──────────────────────────────────────────────────────────────────────┘

Daemon 缺席影响：v0.10 全部改造在 Tier 1（hook 层），daemon 缺席时 100% 工作，无降级。
```

### 2.1 缓存前缀影响对比

```
v0.9 (当前):
  ┌───────────────────────────────────────────┐
  │ 工具定义 (静态)                            │ ← 缓存 ✅
  ├───────────────────────────────────────────┤
  │ CLAUDE.md + additionalContext             │ ← ⚠ ccmem 每 prompt 变
  │   (含 SessionStart stable + UPS 检索)     │    → 从此层往下缓存失效 🔴
  ├───────────────────────────────────────────┤
  │ 会话上下文                                 │ ← 前缀失效，增量缓存不可用 🔴
  ├───────────────────────────────────────────┤
  │ 对话消息                                   │ ← 本就不缓存
  └───────────────────────────────────────────┘

v0.10 (方案 E):
  ┌───────────────────────────────────────────┐
  │ 工具定义 (静态)                            │ ← 缓存 ✅
  ├───────────────────────────────────────────┤
  │ CLAUDE.md + additionalContext             │ ← session 内不变
  │   (SessionStart stable + Read 指令)       │    → 缓存命中 ✅
  ├───────────────────────────────────────────┤
  │ 会话上下文                                 │ ← 缓存命中 ✅
  ├───────────────────────────────────────────┤
  │ 对话消息 (含 Read .ccmem/context.md 结果) │ ← 本就不缓存
  └───────────────────────────────────────────┘
```

### 2.2 新增 / 修改模块清单

```
scripts/
├── handlers/
│   ├── prompt-submit.mjs        # 【改】检索结果写文件, additionalContext 返回空
│   ├── session-start.mjs        # 【改】拼接 Read 指令到 additionalContext
│   └── stop.mjs                 # 【不改】无 SessionEnd 事件，context.md 由 UPS 自然覆盖
├── lib/
│   ├── context-file.mjs         # 【新增】context.md 写入/清空/哈希门控
│   ├── transcript-cleaner.mjs   # 【改】compileSafePattern 增加 isPatternSafe 前置检查 (B2-M1)
│   ├── cmd/
│   │   └── resurrect.mjs        # 【改】--promote-candidates 按项目过滤 (B2-M2)
│   └── admin/
│       └── diagnose.mjs         # 【改】cmdDiagnoseInjections +cache efficiency 段 (B1)
│                                #       + 提取 readMetricsLines 工具函数（从 aggregateRetrievalTiming 内联逻辑中）
├── config.default.json          # 【改】version 0.10 + injection 配置段
├── migrations/
│   └── 012_v010.sql             # 【新增】v0.10 schema (仅 version bump)
.gitignore                       # 【不改】stderr 提醒用户手动添加 .ccmem/
```

---

## 三、Schema 迁移（v0.9 → v0.10）

### 3.1 迁移文件 `migrations/012_v010.sql`

v0.10 核心改造在文件 I/O 层，不需要新表或新列。迁移仅推进 schema 版本号。

```sql
-- ============================================================
-- migrations/012_v010.sql — v0.10 schema (cache-friendly injection)
-- ============================================================

-- v0.10 核心改造在 hook 行为层（文件旁路注入），不新增 DB schema。
-- 仅推进版本号以标记 v0.10 已应用。

UPDATE schema_meta SET version = 12, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (11, 12, 'v0.10: cache-friendly file-based injection',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

> **daemon self-restart**：migration 012 应用后 schema 版本从 11→12，v0.5 `checkSchemaStaleness` 自动检测到不一致，触发 daemon 优雅重启（已有机制，无需新代码）。

### 3.2 `audit_log.action` 新增值

v0.10 **无新增 audit action**。文件写入成功/失败通过 `metrics.jsonl` 的 `context_file_written` / `context_file_bytes` 字段追踪（`-1` 表示写入异常），`.gitignore` 提醒通过 stderr 输出。by design 不走 audit_log——避免每 prompt 产生 audit 噪音。

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.9 daemon（in-memory schema=11）看到 DB schema=12 | v0.5 self-restart 自动处理 |
| v0.1-v0.9 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002-012 |
| `.ccmem/context.md` 不存在 | Claude Read 指令含 "If file is empty or missing, proceed normally" |

---

## 四、Hooks（v0.10 改造）

### 4.1 SessionStart（A2：拼接 Read 指令）

v0.9 行为：注入 stable context（热记忆）到 `additionalContext`。
v0.10 变更：在 stable context **后面**拼接固定的 Read 指令文本。

```javascript
// scripts/handlers/session-start.mjs (v0.10 改造)

// Read 指令：固定文本，代码控制，用户不可误删
const CCMEM_READ_INSTRUCTION = [
  '',
  '## ccmem context',
  'Read `.ccmem/context.md` at session start and after each /compact.',
  'After /compact, ALWAYS re-read regardless of compressed summary content.',
  'Re-read if you haven\'t read it in the last 5 turns or when switching to a different task.',
  'Context may be from a previous session; prioritize user\'s current prompt over cached context.',
  'If file contains only "<!-- ccmem: no relevant memories -->" or is missing, proceed normally.',
].join('\n');

// ... 现有 stable context 构建逻辑不变 ...

// v0.10: shadow 模式不注入 Read 指令（与 v0.9 shadow 行为一致：no writes, no inject）
if (mode === 'shadow') return { additionalContext: '' };

// v0.10: 拼接 Read 指令到 stable context 后面
const additionalContext = [stableContext, CCMEM_READ_INSTRUCTION]
  .filter(Boolean).join('\n\n');

return { additionalContext };
```

**关键约束**：
- Read 指令是**固定文本**（不含时间戳、计数器等动态元素），session 内不变 → 缓存友好
- `CCMEM_READ_INSTRUCTION` 约 ~40 token，"固定税"可接受
- mode=shadow 时**不拼接 Read 指令**，直接 `return { additionalContext: '' }`——与 v0.9 shadow 行为一致（"no writes, no inject"）

**compact 后行为链**：
1. `/compact` 压缩 conversation messages（含之前 Read 的 context.md 内容）
2. `additionalContext`（系统提示区域）**不被 compact 压缩** → Read 指令仍完整存在
3. Claude 看到 Read 指令 → 重新 Read `.ccmem/context.md` → 获取最新记忆

### 4.2 UserPromptSubmit（A1：文件旁路注入）

v0.9 行为：检索记忆 → 渲染为 markdown → 写入 `additionalContext`。
v0.10 变更：检索记忆 → 写入 `.ccmem/context.md` 文件 → `additionalContext` 返回空。

```javascript
// scripts/handlers/prompt-submit.mjs (v0.10 改造)

import { writeContextFile, clearContextFile } from '../lib/context-file.mjs';

export async function handlePromptSubmit(hookData, tEntry) {
  return withHookSafety('prompt_submit', 1500, async () => {
    const { run, mode } = shouldHookRun();
    if (!run) return { additionalContext: '' };

    const db = openDb();
    ensureSchema(db);
    const config = loadConfig(hookData.cwd);
    const projectKey = resolveProjectKey(hookData.cwd);
    const prompt = (hookData.prompt || '').trim();
    if (!prompt) return { additionalContext: '' };

    const searchPrompt = prompt.length > MAX_PROMPT_FOR_RETRIEVAL
      ? prompt.slice(0, MAX_PROMPT_FOR_RETRIEVAL) : prompt;

    // Step 1: 检索相关记忆（与 v0.9 完全相同）
    const { rows, queryVec, cosineContribution, timing } = await retrieveMemories(
      db, searchPrompt, projectKey, config
    );

    // Step 2: 写入 context.md（try-catch 保护，失败不阻断 feedback）
    let contextFileWritten = false;
    let contextFileBytes = 0;
    try {
      if (rows.length > 0) {
        const result = writeContextFile(hookData.cwd, rows);
        // written=true 实际写入；skipped=true 哈希门控跳过（文件已存在且内容一致）
        // 两者都表示文件可用，但 metrics 区分记录
        contextFileWritten = result.written;
        contextFileBytes = result.bytes;
      } else {
        clearContextFile(hookData.cwd);
      }
    } catch (e) {
      process.stderr.write(`ccmem: context file write failed (${e.message})\n`);
      contextFileBytes = -1;  // 标记异常
    }

    // Step 3: 记录指标（与 v0.9 相同 + v0.10 新增 3 个字段）
    recordMetric({
      hook: 'prompt_submit',
      matched: rows.length,
      empty: rows.length === 0 || undefined,
      fts_count: rows.filter(r => r.lane === 'fts').length,
      like_count: rows.filter(r => r.lane === 'like').length,
      fused_count: rows.filter(r => r.lane === 'fused').length,
      cosine_contribution: cosineContribution,
      retrieval_embed_ms: timing?.embedMs,
      retrieval_db_ms: timing?.dbReadMs,
      retrieval_cosine_ms: timing?.cosineMs,
      retrieval_pool: timing?.candidatePool,
      // v0.10 新增
      context_file_written: contextFileWritten,
      context_file_bytes: contextFileBytes,
      additional_context_empty: true,           // v0.10 始终为 true
    });

    // defense-in-depth: shadow already handled by shouldHookRun() above
    if (mode === 'shadow') return { additionalContext: '' };

    // Step 3+4: Feedback + recent_injections（与 v0.9 完全相同）
    // applyPromptFeedback 内部调用：
    //   - inferPrevTurnOutcome / inferPositiveFeedback (L1 反馈)
    //   - getNextPromptIdx → writeRecentInjection + scores (如有 rows)
    //   - memory_feedback INSERT (如有 rows)
    applyPromptFeedback(db, hookData.session_id, prompt, rows, config, queryVec);

    // Step 5: 元信息走 stderr（v0.10 改造）
    process.stderr.write(
      `ccmem: RETRIEVE ${rows.length} mems → .ccmem/context.md\n`
    );

    // 关键：additionalContext 返回空 → 系统提示区域不变 → 缓存命中 ✅
    return { additionalContext: '' };
  }, tEntry);
}
```

**与 v0.9 的关键差异**：

| 环节 | v0.9 | v0.10 |
|---|---|---|
| 检索结果去向 | `additionalContext`（系统提示区域） | `.ccmem/context.md`（文件 → Read → conversation messages） |
| `additionalContext` 返回值 | 渲染后的 markdown（每 prompt 变） | `''`（始终为空） |
| 缓存影响 | 🔴 每 prompt 打破前缀 | ✅ 零影响 |
| Claude 如何看到记忆 | 自动注入 | 通过 Read 指令引导读取 |
| 检索算法 | 不变 | 不变 |
| Feedback / recent_injections | 不变 | 不变 |
| stderr 输出 | 不变 | 微调：增加 `→ .ccmem/context.md` 指向 |

### 4.3 Stop（A3：context.md 生命周期管理）

> **⚠ 关键事实**：Claude Code 的 Stop hook 在**每个 turn 结束时**触发，
> 没有 `stop_hook_type` 字段来区分 session 结束 vs 普通 turn 结束。
> hooks.json 中也没有单独的 `SessionEnd` 事件。因此 **不能在 Stop hook 中做
> "仅 session 结束时清理"**。

v0.9 行为：`runStop` → session_context + enqueue summarize_pending + L2/L2.5 反馈 + wake daemon。
v0.10 变更：**Stop hook 不动**。context.md 的生命周期由以下机制管理：

| 时机 | 行为 | 机制 |
|---|---|---|
| 每 prompt（UserPromptSubmit） | 覆盖写入最新检索结果 | 自然覆盖，无残留问题 |
| session 间 | 上次 session 的 context.md 残留 | 下次 SessionStart 后首次 UserPromptSubmit 覆盖 |
| 用户手动清理 | `rm .ccmem/context.md` | 可选，Read 指令含 "If file is empty or missing, proceed normally" |

> **⚠ 跨 session 残留时序窗口**：新 session 开始时，SessionStart 注入 Read 指令 →
> Claude 可能在用户发第一个 prompt **之前**就 Read 了 `.ccmem/context.md`——此时文件内容
> 是**上次 session 的残留**。这些旧记忆可能与当前 session 主题无关。
> **风险评估**：低。旧记忆不有害（只是不相关），且用户发第一个 prompt 后 UPS 立即覆盖。
> dogfood V5 将验证此场景是否导致 Claude 产生混淆。

**为什么不在 Stop hook 中清理**：
1. Stop 在每个 turn 都触发，如果清理则用户连续多 prompt 时中间 turn 会删掉 context.md
2. Claude Code 没有 `SessionEnd` 事件，无法区分"最后一个 turn"
3. context.md 残留无害——下次 session 的 UserPromptSubmit 会覆盖，且 `.gitignore` 排除了版本控制污染

**`stop.mjs` 零变化**。`runStop` 逻辑完全不动。

---

## 五、核心改动

### 5.1 A1+A3 — context-file.mjs（新增模块）

```javascript
// scripts/lib/context-file.mjs

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderRetrievedBlock } from './render.mjs';  // 复用 v0.9 已有的渲染函数

const CONTEXT_DIR = '.ccmem';
const CONTEXT_FILE = 'context.md';
const MAX_CONTEXT_FILE_BYTES = 8192;  // 8KB 硬上限，超出时截断（保留优先级最高的前 N 条）

/**
 * 将检索结果写入 .ccmem/context.md，返回结构化结果。
 * 哈希门控：内容未变则跳过写入，`written=false, skipped=true`。
 *
 * 文件格式与 v0.9 additionalContext 注入内容一致（复用 renderRetrievedBlock）：
 *   <!-- content-hash: XXXXXXXX -->
 *   === ccmem: retrieved for current prompt ===
 *
 *   [m42*] rule | global  Prefer ESM imports...
 *   [m58]  fact | project Project uses pnpm...
 *
 * @returns {{ written: boolean, bytes: number, skipped: boolean }}
 */
export function writeContextFile(cwd, rows) {
  const dir = join(cwd, CONTEXT_DIR);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, CONTEXT_FILE);
  const content = renderRetrievedBlock(rows);  // 复用 render.mjs 已有函数
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 8);

  // 哈希门控：读取现有文件首行 hash，一致则跳过
  if (existsSync(filePath)) {
    try {
      const firstLine = readFileSync(filePath, 'utf8').split('\n')[0];
      const existingHash = firstLine.match(/content-hash:\s*([a-f0-9]+)/)?.[1];
      if (existingHash === contentHash) {
        // 返回文件实际大小（而非 0），让 metrics 区分 "无记忆" vs "哈希跳过"
        const fileBytes = Buffer.byteLength(readFileSync(filePath, 'utf8'), 'utf8');
        return { written: false, bytes: fileBytes, skipped: true };
      }
    } catch { /* 文件损坏，覆盖写入 */ }
  }

  const header = `<!-- content-hash: ${contentHash} -->\n`;
  let fullContent = header + content;

  // L3: 文件大小上限保护——超出时逐条移除末尾记忆（优先级最低的排最后）
  while (Buffer.byteLength(fullContent, 'utf8') > MAX_CONTEXT_FILE_BYTES && rows.length > 1) {
    rows.pop();
    const trimmedContent = renderRetrievedBlock(rows);
    const trimmedHash = createHash('sha256').update(trimmedContent).digest('hex').slice(0, 8);
    fullContent = `<!-- content-hash: ${trimmedHash} -->\n` + trimmedContent;
    process.stderr.write(`ccmem: context.md exceeded ${MAX_CONTEXT_FILE_BYTES}B, trimmed to ${rows.length} mems\n`);
  }

  writeFileSync(filePath, fullContent, 'utf8');

  // .gitignore 提醒（持久化标记，真正只提醒一次）
  warnGitignoreOnce(cwd);

  return { written: true, bytes: Buffer.byteLength(fullContent, 'utf8'), skipped: false };
}

/**
 * 清空 context.md（检索无结果时）。写入明确的"无记忆"信号而非空字符串，
 * 让 Claude Read 后立即理解无相关记忆，也避免空文件无 content-hash 首行
 * 导致下次写入时哈希门控误判。
 * 目录不存在时跳过（避免首次安装无匹配时创建空目录 + 触发 gitignore 提醒）。
 */
export function clearContextFile(cwd) {
  const filePath = join(cwd, CONTEXT_DIR, CONTEXT_FILE);
  if (existsSync(filePath)) {
    writeFileSync(filePath, '<!-- ccmem: no relevant memories -->\n', 'utf8');
  }
  return 0;
}

/**
 * stderr 提醒用户将 .ccmem/ 加入 .gitignore（持久化标记，真正只提醒一次）。
 * 使用 .ccmem/.gitignore_warned 文件标记替代 global[]（hook 每次是独立进程，
 * global 无法跨进程持久化）。
 */
function warnGitignoreOnce(cwd) {
  const dir = join(cwd, CONTEXT_DIR);
  const warnedPath = join(dir, '.gitignore_warned');
  if (existsSync(warnedPath)) return;

  const gitignorePath = join(cwd, '.gitignore');
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf8');
      if (content.includes('.ccmem')) {
        // 已有，写标记后静默返回
        writeFileSync(warnedPath, '', 'utf8');
        return;
      }
    }
    process.stderr.write('ccmem: hint — add .ccmem/ to .gitignore to exclude context cache\n');
    writeFileSync(warnedPath, '', 'utf8');
  } catch { /* 忽略 */ }
}
```

> **关键**：`renderRetrievedBlock` 直接 import 自 `render.mjs`（v0.2 引入的已有模块），
> **不重新实现**。输出格式与 v0.9 `additionalContext` 注入内容完全一致：
> ```
> === ccmem: retrieved for current prompt ===
>
> [m42*] rule | global  Prefer ESM imports over CommonJS require
> [m58]  fact | project Project uses pnpm as package manager
> ```
> 唯一新增的是首行 `<!-- content-hash: XXXXXXXX -->` 用于哈希门控。

**关键设计决策**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 写入方式 | `writeFileSync`（同步阻塞） | hook 进程内执行，写完后才退出；Claude Read 在 hook 完成后发生，无读写竞争 |
| 原子性 | 不使用 write-to-tmp + rename | context.md 有 8KB 硬上限（超出自动截断），半写风险可忽略；rename 在 Windows 上有跨盘限制 |
| 哈希算法 | SHA-256 截断 8 字符 | 碰撞概率 ~2^-32，对此场景足够 |
| `.gitignore` 处理 | stderr 提醒，不自动修改 | ccmem 作为 plugin 不应修改用户的仓库文件 |

### 5.2 B1 — 缓存效率诊断

`cmdDiagnoseInjections`（`diagnose.mjs` 中的独立函数，由 `--injections` flag 路由调用）
在现有 "Retrieval performance" 段之后追加 "Cache efficiency" 段：

```javascript
// scripts/lib/admin/diagnose.mjs — cmdDiagnoseInjections 函数 (v0.10 增量)

// 在现有 Retrieval performance 段之后追加:

// 读取 metrics.jsonl 中 prompt_submit 行的 v0.10 新增字段
// 复用 v0.9 已有的 metrics.jsonl 逐行解析逻辑（aggregateRetrievalTiming 同源）
const promptMetrics = readMetricsLines(days)
  .filter(m => m.hook === 'prompt_submit');
const totalPrompts = promptMetrics.length;
const emptyAcCount = promptMetrics.filter(m => m.additional_context_empty === true).length;
const fileWrites = promptMetrics.filter(m => m.context_file_written === true).length;
const totalBytes = promptMetrics.reduce((s, m) => s + (m.context_file_bytes || 0), 0);

lines.push('');
lines.push('  Cache efficiency (v0.10 file-based injection)');
lines.push(`    injection mode:         file-based`);
lines.push(`    additionalContext empty: ${emptyAcCount}/${totalPrompts} (${totalPrompts > 0 ? (emptyAcCount/totalPrompts*100).toFixed(0) : 0}%)`);
lines.push(`    context file writes:     ${fileWrites}/${totalPrompts}`);
lines.push(`    total file bytes:        ${(totalBytes/1024).toFixed(1)} KB`);
const cacheStatus = emptyAcCount === totalPrompts ? '0% ✅' : 'WARN — some prompts injected additionalContext';
lines.push(`    cache impact:            ${cacheStatus}`);
```

> **`readMetricsLines(days)`** 是 v0.9 `aggregateRetrievalTiming` 内部已有的 metrics.jsonl
> 逐行解析逻辑。v0.10 将其抽取为可复用的工具函数（从 `aggregateRetrievalTiming` 中提取，
> 两处共用），避免重复实现。

### 5.3 B2 — v0.9 backlog 修复

#### 5.3.1 M1：compileSafePattern 增加 ReDoS 防护

**现状**：`transcript-cleaner.mjs` 内联的 `compileSafePattern` 仅做 `try { new RegExp(str) } catch`，
无 ReDoS 防护。`pattern-safety.mjs` 导出的是 `isPatternSafe`（fuzz 测试 5 个恶意字符串，50ms 超时），
但接口是安全检查而非编译。

**修复**：在 `compileSafePattern` 中调用 `isPatternSafe` 作为编译前置检查：

```javascript
// scripts/lib/transcript-cleaner.mjs (v0.10 修正)

import { isPatternSafe } from './pattern-safety.mjs';

function compileSafePattern(str) {
  if (!str || typeof str !== 'string') return null;
  // v0.10: 复用 pattern-safety.mjs 的 fuzz-based ReDoS 检测
  const safety = isPatternSafe(str);
  if (!safety.safe) {
    process.stderr.write(`ccmem: extra_rule pattern rejected: ${safety.reason}\n`);
    return null;
  }
  try { return new RegExp(str, 'm'); }
  catch { return null; }
}

// loadRules 逻辑不变
```

**关键差异**：不是简单的 `import { compileSafePattern }`（`pattern-safety.mjs` 不导出该函数），
而是在现有 `compileSafePattern` 内部增加 `isPatternSafe` 前置检查。

#### 5.3.2 M2：resurrect --promote-candidates 按项目过滤

```javascript
// scripts/lib/cmd/resurrect.mjs (v0.10 修正)

// v0.9: 展示所有未裁决的 promote_candidates（含 OR EXISTS similar_in 匹配）
// v0.10: 新增 --all flag 展示所有项目；默认仍按 project_key 过滤（保留 v0.9 OR EXISTS 语义）
const projectKey = resolveProjectKey(cwd);
const candidates = flags.all
  ? db.prepare(`
      SELECT pc.*, m.content, m.type, m.scope, m.trust_score
      FROM promote_candidates pc
      JOIN memories m ON pc.mem_id = m.id
      WHERE pc.acknowledged_at IS NULL
      ORDER BY pc.detected_at DESC
    `).all()
  : db.prepare(`
      SELECT pc.*, m.content, m.type, m.scope, m.trust_score
      FROM promote_candidates pc
      JOIN memories m ON pc.mem_id = m.id
      WHERE pc.acknowledged_at IS NULL
        AND (pc.project_key = ? OR EXISTS (
          SELECT 1 FROM json_each(pc.similar_in) je
          WHERE json_extract(je.value, '$.project_key') = ?))
      ORDER BY pc.detected_at DESC
    `).all(projectKey, projectKey);
```

---

## 六、配置

### 6.1 config.default.json 新增段

```jsonc
{
  "version": "0.10",

  // v0.10 新增
  "injection": {
    "file_based": true                   // 启用文件旁路注入（方案 E，默认 true）
    // context_file 路径硬编码为 .ccmem/context.md（与 CCMEM_READ_INSTRUCTION 一致）
    // 如需用户可配，需同步改 context-file.mjs 常量 + Read 指令文本（推迟到 v0.11+）
  }

  // ... 其它配置段不变 ...
}
```

### 6.2 配置向后兼容

| 配置 | 默认值 | 行为 |
|---|---|---|
| `injection.file_based = true` | 默认 | v0.10 正常模式：文件旁路注入 |
| `injection.file_based = false` | — | 降级回 v0.9 行为（additionalContext 直接注入），用于 Read 执行率过低时的临时回退 |

降级开关在 `prompt-submit.mjs` 中实现：

```javascript
const useFileBased = loadConfig(hookData.cwd).injection?.file_based !== false;

if (useFileBased) {
  // v0.10: 写文件，additionalContext 返回空
  // try-catch 与主流程 §4.2 保持一致，失败不阻断 feedback
  try {
    writeContextFile(hookData.cwd, rows);
  } catch (e) {
    process.stderr.write(`ccmem: context file write failed (${e.message})\n`);
  }
  return { additionalContext: '' };
} else {
  // v0.9 降级：直接注入 additionalContext
  return { additionalContext: renderRetrievedBlock(rows) };
}
```

---

## 七、测试策略

### 7.1 新增测试

| 类别 | 预计数 | 覆盖对象 |
|---|---|---|
| context-file | 10 | writeContextFile 写入/哈希门控跳过(返回实际文件大小)/clearContextFile写"no relevant memories"信号/目录自动创建/gitignore持久化标记(.gitignore_warned)/首行hash格式/8KB截断+stderr告警/截断后hash重算 |
| prompt-submit-file-based | 11 | 有结果→文件非空+AC空 / 无结果→文件空+AC空 / shadow→不写文件+AC空 / 降级开关(file_based=false)→AC输出与v0.9字符级一致 / 降级时context.md不被创建或修改 / 降级后config改回true立即生效 / 20 连续 prompt AC 字节级一致 |
| session-start-read-instruction | 4 | Read 指令拼接到 stable context 后 / 固定文本断言（不含动态元素）/ mode=shadow → `additionalContext` 为空（不含 Read 指令）/ Read 指令不含动态元素（正则断言） |
| diagnose-cache | 4 | cache efficiency 段输出完整 / 空数据兜底 / 100% additional_context_empty 断言 / readMetricsLines 复用 |
| migration-012 | 3 | schema 版本 11→12 / 幂等 / v0.1-v0.9 升级链兼容 |
| backlog-m1 | 3 | compileSafePattern + isPatternSafe 前置拦截 / ReDoS pattern 拒绝+stderr 告警 / 合法 pattern 正常编译 |
| backlog-m2 | 3 | resurrect --promote-candidates 按 project_key 过滤 / --all flag 展示全部 / 无候选友好提示 |

**预计新增**：~38 个测试。总计 1046 + 38 = ~1084。

### 7.2 回归测试

v0.9 全量 1046 tests 必须 100% 通过。

**特别关注**：
- `prompt-submit` 现有测试中断言 `additionalContext` 内容的用例需更新（v0.10 始终返回空）
- `session-start` 现有测试中断言 `additionalContext` 内容的用例需更新（v0.10 追加 Read 指令）

### 7.3 手工验证（dogfood 前）

| 步骤 | 预期 |
|---|---|
| 正常使用 3 个 prompt | `.ccmem/context.md` 文件被创建且包含检索结果 |
| 检查 `context.md` 首行 | `<!-- content-hash: XXXXXXXX -->` |
| 连续 2 个相同主题 prompt | 第 2 次哈希门控生效，跳过写入（返回 0 bytes） |
| `/compact` 后继续对话 | Claude 重新 Read `context.md` |
| `mode shadow` | `context.md` 不被写入，`additionalContext` 为空 |
| 关闭 Claude 后重新打开 | context.md 残留，新 session 首次 UPS 覆盖 |

---

## 八、dogfood 验证计划

### P0 — 必须在首日验证

#### V1: additionalContext 始终为空

**验证方法**：
1. 正常使用 5+ prompt
2. 检查 metrics.jsonl：`grep additional_context_empty metrics.jsonl | tail -5`
3. 确认所有行 `additional_context_empty: true`

**关注点**：
- [ ] 所有 prompt 的 `additionalContext` 均为空
- [ ] 系统提示缓存前缀未受 ccmem 影响

#### V2: .ccmem/context.md 文件写入正常

**验证方法**：
1. `cat .ccmem/context.md` 检查内容
2. 确认首行含 `<!-- content-hash: ... -->`
3. 确认内容格式与 v0.9 注入格式一致

**关注点**：
- [ ] 文件内容是否与 v0.9 additionalContext 注入内容一致
- [ ] 哈希门控是否生效（连续相同主题 prompt 不重复写入）

#### V3: Claude 实际 Read context.md 的执行率

**验证方法**：
1. 正常使用 10+ prompt，观察 Claude 是否在 session 开始和 /compact 后 Read `.ccmem/context.md`
2. 手动检查对话历史中是否出现 Read `.ccmem/context.md` 的工具调用

**关注点**：
- [ ] Read 执行率是否 > 90%（v0.10 的核心假设）
- [ ] Claude 在哪些情况下跳过了 Read
- [ ] compact 后是否重新 Read
- [ ] 如果 Read 执行率 < 90%，考虑 v0.11 fallback 方案

#### V4: 降级开关可用

**验证方法**：
1. 在 `config.default.json` 设置 `injection.file_based = false`
2. 确认回退到 v0.9 行为（additionalContext 直接注入）

### P1 — 首周验证

#### V5: context.md 跨 session 残留无害

**验证方法**：
1. 正常使用后退出 Claude（context.md 残留）
2. 重新启动新 session，发送首个 prompt
3. 确认 context.md 被新检索结果覆盖

**关注点**：
- [ ] 新 session 首次 UserPromptSubmit 是否正确覆盖旧 context.md
- [ ] Claude 在新 session Read 到旧 session 残留内容时是否产生混淆

#### V6: v0.9 回归无异常

**验证方法**：
1. 检索算法行为（FTS5 + Jaccard + cosine）无变化
2. Feedback / trust 更新无变化
3. daemon cron 任务正常运行

#### V7: diagnose --injections cache efficiency 段

**验证方法**：
1. 积累 3+ 天使用数据
2. `/ccmem:admin diagnose --injections`
3. 确认 "Cache efficiency" 段输出正常

### P2 — dogfood 期持续观察

#### V8: conversation token 增长速度

**观察项**：
- [ ] 每 prompt Read context.md 增加 ~500-2000 token（conversation messages）
- [ ] 是否导致 compact 触发更频繁
- [ ] compact 后记忆是否正确恢复（Claude 重新 Read）

#### V9: Read 执行率长期稳定性

**观察项**：
- [ ] 多日使用后 Read 执行率是否保持 > 90%
- [ ] 长 session（50+ prompt）是否出现 Read 遗忘
- [ ] 在复杂任务中 Read 指令是否被其他指令淹没

#### V10: 缓存命中率实测

**观察项**：
- [ ] 如有方式（CC 内部日志 / API 响应头），观察实际缓存命中率
- [ ] v0.10 vs v0.9 响应延迟对比
- [ ] token 成本对比（如可度量）

---

## 九、不变量

| 不变量 | 验证方式 |
|---|---|
| 检索算法（FTS5 + Jaccard + cosine 三路融合）零变化 | 回归测试 |
| 写入闸门（Tier 1/2/2.5/3）零变化 | 回归测试 |
| Trust / 优先级公式零变化 | 回归测试 |
| Feedback 机制（L1/L2/L2.5）零变化 | 回归测试 |
| `recent_injections` 写入零变化 | 回归测试 |
| daemon cron 任务（summarize / synthesis / security / contradiction / cross_project）零变化 | 回归测试 |
| SessionStart stable context 内容零变化（仅追加 Read 指令） | 字节级比对（除 Read 指令部分） |

---

## 十、backlog 项

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | Read 执行率 fallback（additionalContext 精简摘要兜底） | v0.10 dogfood | P2 | 视 V3 数据决定是否启动 |
| 2 | context.md diff 模式（仅写增量，减少 Read token） | v0.10 设计 | P3 | 视 V8 数据决定 |
| 3 | `synthesized=0` 连续 skip logic（v0.8 backlog #4） | v0.8 遗留 | P3 | 待 weekly_synthesis 更多数据 |
| 4 | 跨项目冷启动继承 | v0.9 defer | P2 | v0.11 |
| 5 | better-sqlite3 + sqlite-vec ANN | v0.9 defer | P3 | v0.11+ |
| 6 | never-injected 查询 json_each 性能（v0.9 #4） | v0.9 遗留 | P3 | 监控 |

---

## 附录 A：v0.10 不变量 checklist（CI grep）

| # | 不变量 | grep 命令 | 预期 |
|---|---|---|---|
| 91 | UserPromptSubmit `additionalContext` 始终返回空 | `grep -n "additionalContext.*''" scripts/handlers/prompt-submit.mjs` | ≥ 2（正常路径 + shadow 路径） |
| 92 | `CCMEM_READ_INSTRUCTION` 无动态元素 | `grep -n '${\|Date.now()\|new Date()' scripts/handlers/session-start.mjs` | 在 `CCMEM_READ_INSTRUCTION` 范围内为空 |
| 93 | `context-file.mjs` 使用 `writeFileSync`（同步） | `grep -n 'writeFileSync\|writeFile(' scripts/lib/context-file.mjs` | `writeFileSync` ≥ 2；`writeFile(` 不含非 Sync 版本 |
| 94 | SessionStart shadow 分支返回空 `additionalContext` | `grep -n "shadow.*additionalContext" scripts/handlers/session-start.mjs` | ≥ 1 |
| 95 | v0.10 新增文件 100% 用 `writeAudit`，禁止 `logAudit(` | `grep -rn 'logAudit(' scripts/lib/context-file.mjs` | 为空 |

---

**End of v0.10 spec.**
