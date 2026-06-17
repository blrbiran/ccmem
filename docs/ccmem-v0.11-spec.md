# ccmem v0.11 实施 spec

> 这是 v0.11 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) …
> [`ccmem-v0.10-spec.md`](./ccmem-v0.10-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.10 解决了缓存灾难（file-based injection），但引入了两个新问题：
> (1) 多窗口并发时 context.md 被覆盖（last-write-wins 无锁竞争）；
> (2) context.md 无历史快照，dogfood review 无法还原实际注入内容。
> v0.11 聚焦这两个 **P2 工程稳定性项**，不扩展新功能。
>
> **设计依据**：[`ccmem-v0.10-dogfood.md`](./ccmem-v0.10-dogfood.md) §六 backlog #8/#9
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。

---

## 📌 开发过程记录（2026-06-16）

> **重要**：v0.11 开发过程中发现了 3 个超出原始 spec 范围的关键问题并修复：
>
> 1. **Finding 10（CRITICAL）**：embedding API 无超时导致 prompt_submit hook 全部超时 → 添加了 800ms AbortController + Path B 降级
> 2. **Finding 11（HIGH）**：memory 内容在 300 字符处硬截断 → 放宽到 500 字符 + AI 精炼机制
> 3. **Finding 12（NEW FEATURE）**：AI 精炼管道（content-refiner.mjs）→ 超 501 字符的内容先调 LLM 精炼，仍超才 word-boundary 截断
>
> 这些修复已实施并提交（commits: d1611a6, 3d56d22, 9e9d3b8），详见 [`ccmem-v0.11-dogfood.md`](./ccmem-v0.11-dogfood.md) §Finding 10/11/12。
>
> **影响范围**：
> - `summarize_pending`：从"零变化"改为"微改"（添加了 AI 精炼集成）
> - `retrieval.mjs`：添加了 embedding API 超时和 Path B 降级
> - `llm-parse.mjs`：添加了 `skipTruncate` 选项
> - 新增 `content-refiner.mjs`：AI 精炼管道
> - 所有 LLM schema 的 `maxLength`：300 → 500

---

## 〇、与 v0.10 的关系与关键约定

### 0.1 v0.10 已实现的基线（不重复）

v0.10 已 ship 以下能力，v0.11 在其上叠加，**不重写**：

- UserPromptSubmit 文件旁路注入（检索结果写入 `.ccmem/context.md`，`additionalContext` 始终为空）
- SessionStart Read 指令注入（固定文本，session 内不变，缓存友好）
- `.ccmem/` 文件管理（`.gitignore` 提醒 + context.md 哈希门控写入）
- 缓存效率诊断（`diagnose --injections` cache efficiency 段 + metrics.jsonl 3 个新字段）
- v0.9 backlog 修复（`compileSafePattern` ReDoS 防护 + `resurrect --promote-candidates` 按项目过滤）

### 0.2 关键实现约定（沿用 v0.2-v0.10）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **stdout/stderr 分流** | SessionStart 稳定上下文走 stdout `additionalContext`；UserPromptSubmit 检索结果走 `.ccmem/context-{session_id_prefix}.md` 文件（v0.11）；元数据走 stderr + `audit_log` |
| **命令 prelude 调 `maybeRunTier15`** | v0.11 新命令同样遵守 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |

### 0.3 版本号

- `config.default.json::version` 从 `"0.10"` 升到 `"0.11"`
- schema `schema_meta.version` 从 `12` 升到 `13`（migration `013_v011.sql`）
- `package.json::version` 不改（独立版本号）

### 0.4 v0.11 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为 — SessionStart | **微改**：Read 指令引用 session-scoped 文件名 + 末尾清理旧文件 |
| Hook 行为 — UserPromptSubmit | **微改**：`writeContextFile` / `clearContextFile` 传入 session_id |
| Hook 行为 — Stop | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **零变化** |
| Trust 系数 / 优先级公式 | 零变化 |
| L1 否定/正向 / L2 / L2.5 / L4 | 零变化 |
| summarize_pending | 零变化 |
| weekly_synthesis / security_audit / contradiction_audit / revalidation / monthly_meta | 零变化 |
| daily_maintenance | **微增**（末尾追加 snapshot 清理 step） |
| Tier 1.5 lazy maintenance | 零变化 |
| daemon self-restart / container fallback / platform 层 | 零变化 |
| EmbeddingProvider / 三路检索算法 / CJK tokenize / per-session dedup | 零变化 |
| quality gate v2 / transcript_cleaner | 零变化 |
| cross_project_patterns | 零变化 |
| 降级开关 `file_based=false` | 不变 |

---

## 一、范围与时间预算

### 1.1 v0.11 做什么（M12，约 2 周）

| 阶段 | # | 能力 | 说明 |
|---|---|---|---|
| **P1** | A1 | **多窗口并发隔离** | context 文件名从 `context.md` 改为 `context-{session_id[:8]}.md`，SessionStart 时清理非当前 session 的旧文件 |
| **P1** | A2 | **context 写入历史** | SQLite content-addressed snapshot store + write log，支持 dogfood review 查询 |

### 1.2 v0.11 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 跨项目冷启动继承 | v0.12+ | 现有 promote_candidates 机制已够用，用户自然会 promote |
| context diff 模式（仅写增量） | 删除 | Claude Read 无法增量更新，实际效果有限 |
| better-sqlite3 + sqlite-vec ANN | v0.12+ | JS cosine 5000 mems 内 ~60ms，无性能压力 |
| 检索候选预过滤优化 | v0.12+（数据驱动） | 需 B2 监控数据证明 retrieval p95 > 100ms |
| query embedding 缓存（API provider） | v0.12+ | 需先积累 API provider 用户的延迟数据 |
| Read 执行率 fallback（additionalContext 精简摘要兜底） | v0.12+（数据驱动） | v0.10 dogfood 实测 Read 执行率 > 90% 则不需要 |
| SessionEnd 清理 context.md | v0.12+ | Stop hook 无法区分 session 结束 vs turn 结束，SessionStart 清理已足够 |
| Windows scheduled task | v0.12+ | 无 dogfood 设备 |

### 1.3 依赖关系

```
013 schema
    → context-file.mjs (文件名参数化 + cleanup + 写 history)
        → prompt-submit.mjs (传 session_id) + session-start.mjs (Read 指令 + cleanup)
            → daily-maintenance.mjs (追加 snapshot 清理 step)
                → diagnose.mjs (context-history 子命令)
                    → config + 回归
```

### 1.4 完成判据（M12）

**A1 — 多窗口并发隔离**：
1. 多窗口测试：开 2 个 Claude Code 窗口，确认各自 context 文件独立（`context-{session1}.md` 和 `context-{session2}.md` 互不覆盖）
2. SessionStart 清理：新 session 启动后，非当前 session 的 context 文件被删除
3. Read 指令引用 session-scoped 文件名（`context-{session_id[:8]}.md`）
4. `clearContextFile` 只清当前 session 的文件（不影响其他窗口）
5. 缓存影响：零（Read 指令 session 内不变，`additionalContext` 仍满足"session 内不变"）
6. 向后兼容：`injection.file_based=false` 降级时行为与 v0.10 一致

**A2 — context 写入历史**：
7. 新 hash 写入 → `context_snapshots` INSERT + `context_write_log` INSERT（written=1）
8. hash gate 命中 → `context_snapshots.hit_count++` + `context_write_log` INSERT（written=0）
9. `clearContextFile` → `context_write_log` INSERT（hash='empty', bytes=0）
10. `daily_maintenance` 末尾清理 30d 前的 write_log + 无引用 snapshot
11. `ccmem admin context-history --session <id>` 输出该 session 的写入序列
12. `ccmem admin context-history --hash <hash>` 输出该 hash 的实际内容
13. `ccmem admin context-history --days N` 输出最近 N 天的写入统计

**通用**：
14. v0.10 测试套全量回归 100% 通过（1073 tests）
15. embedding 关闭时所有 hook 输出与 v0.10 字符级一致（仅文件名变化）
16. `diagnose --context-history` 输出正确（hash gate 效率、写入趋势）

---

## 二、架构（v0.11 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart (v0.11 改造 A1):                                        │
│    注入 stable context + Read 指令 (引用 .ccmem/context-{sid}.md)    │
│    + cleanupStaleContextFiles(cwd, sessionId)                        │
│    → additionalContext 缓存友好 ✅                                    │
│                                                                       │
│  UserPromptSubmit (v0.11 改造 A1):                                    │
│    retrieveMemories (算法不变)                                        │
│      → 有结果 → 写入 .ccmem/context-{session_id[:8]}.md (哈希门控)   │
│      → 无结果 → 清空 .ccmem/context-{session_id[:8]}.md              │
│    → 同时写入 context_write_log + context_snapshots (A2)             │
│    additionalContext = '' (始终为空) → 缓存前缀不变 ✅                 │
│    feedback / recent_injections / metrics (v0.10 行为不变)            │
│    stderr: "ccmem: RETRIEVE N mems → .ccmem/context-{sid}.md"       │
│                                                                       │
│  Stop (v0.11 零变化)                                                  │
│                                                                       │
│  Claude Read .ccmem/context-{sid}.md (引导式):                        │
│    → 内容进入 conversation messages (顶部动态区)                       │
│    → 不打破系统提示缓存前缀 ✅                                         │
│    → 哈希门控: 相同 hash 跳过 re-read                                  │
│    → session-scoped: 多窗口不互相覆盖 ✅ (v0.11 新增)                 │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.11 微改):                                                 │
│    daily_maintenance (v0.10, +step N snapshot 清理, A2)              │
│    其它 cron 零变化                                                   │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite (v0.11 增量, A2):                                             │
│    context_snapshots (新表, content-addressed, hash PK)              │
│    context_write_log (新表, 每次写入事件记录)                          │
│    schema_meta.version 12 → 13 (migration 013)                       │
└──────────────────────────────────────────────────────────────────────┘

Daemon 缺席影响：核心注入（session-scoped 文件 + history 写入）100% 工作，无降级。
snapshot 表会在 daemon 缺席期间持续增长（每条 unique context ~8KB），直到下一次 daily_maintenance 执行 30 天清理。
正常使用场景下增长可控（单 session 通常 <100KB），可接受。
```

### 2.1 多窗口并发隔离前后对比

```
v0.10 (单文件):
  窗口A prompt → 写 .ccmem/context.md
  窗口B prompt → 写 .ccmem/context.md ← 覆盖A的内容
  窗口A Read → 读到B的检索结果 ❌

v0.11 (session-scoped):
  窗口A prompt → 写 .ccmem/context-a1b2c3d4.md
  窗口B prompt → 写 .ccmem/context-e5f6g7h8.md ← 独立文件
  窗口A Read → 读到A的检索结果 ✅
  窗口B Read → 读到B的检索结果 ✅
```

### 2.2 新增 / 修改模块清单

```
scripts/
├── handlers/
│   ├── prompt-submit.mjs        # 【改】writeContextFile / clearContextFile 传 session_id
│   ├── session-start.mjs        # 【改】Read 指令引用 session-scoped 文件名 + 末尾 cleanup
│   └── stop.mjs                 # 【不改】
├── lib/
│   ├── context-file.mjs         # 【改】文件名参数化 + cleanupStaleContextFiles + 写 history
│   ├── cmd/
│   │   └── diagnose.mjs         # 【改】context-history 子命令
│   └── admin/
│       └── (无变化)
├── daemon/
│   └── tasks/
│       └── daily-maintenance.mjs # 【改】追加 snapshot 清理 step
├── config.default.json          # 【改】version 0.11
├── migrations/
│   └── 013_v011.sql             # 【新增】v0.11 schema
```

---

## 三、Schema 迁移（v0.10 → v0.11）

### 3.1 迁移文件 `migrations/013_v011.sql`

v0.11 新增两张表支持 context 写入历史（A2），不修改现有表结构。

```sql
-- ============================================================
-- migrations/013_v011.sql — v0.11 schema (context write history)
-- ============================================================

-- ---- 1. context_snapshots (content-addressed, hash PK) ----
-- 存储 context.md 的实际内容，hash 去重避免重复存储相同内容。
-- 用于 dogfood review 时还原某次注入的完整内容。
CREATE TABLE context_snapshots (
  content_hash  TEXT PRIMARY KEY,       -- 8-char hex, 与 context.md 首行一致
  content       TEXT NOT NULL,          -- 实际写入内容（≤8KB）
  first_seen_at INTEGER NOT NULL,       -- 首次出现的 Unix ms
  hit_count     INTEGER DEFAULT 1       -- 相同内容被命中的次数（hash gate skip 时 ++）
);

-- ---- 2. context_write_log (每次写入事件) ----
-- 记录每次 writeContextFile / clearContextFile 的调用，支持 dogfood review 查询。
-- 与 recent_injections 的区别：这里记录的是文件层面的写入事件，不是注入的 memory IDs。
CREATE TABLE context_write_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  prompt_idx    INTEGER,                -- 0=SessionStart, 1+=UserPromptSubmit
  content_hash  TEXT NOT NULL,          -- FK → context_snapshots.content_hash; 'empty' 表示 clearContextFile
  bytes         INTEGER NOT NULL,       -- 写入的字节数（0 表示 clearContextFile）
  written       INTEGER NOT NULL,       -- 1=实际写文件, 0=hash gate skip
  written_at    INTEGER NOT NULL        -- Unix ms
);
CREATE INDEX idx_cwl_session ON context_write_log(session_id, prompt_idx);
CREATE INDEX idx_cwl_time ON context_write_log(written_at);

-- ---- 3. schema 版本推进 ----
UPDATE schema_meta SET version = 13, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (12, 13, 'v0.11: context_snapshots + context_write_log for write history',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值

v0.11 **无新增 audit action**。snapshot 和 write_log 的写入通过各自表的 INSERT/UPDATE 直接记录，不走 audit_log——避免每 prompt 产生 audit 噪音（与 v0.10 context_file_written metrics 设计一致）。

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.10 daemon（in-memory schema=12）看到 DB schema=13 | v0.5 self-restart 自动处理 |
| v0.1-v0.10 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002-013 |
| `.ccmem/context.md` 存在（v0.10 遗留） | v0.11 SessionStart 的 `cleanupStaleContextFiles` 会清理它（不属于任何 session） |
| `context_snapshots` / `context_write_log` 空表 | 新表，v0.10 数据不迁移（历史 context.md 内容无法回溯，从 v0.11 开始记录） |

---

## 四、Hooks（v0.11 改造）

### 4.1 SessionStart（A1：Read 指令引用 session-scoped 文件名 + cleanup）

v0.10 行为：注入 stable context + Read 指令（引用 `.ccmem/context.md`）。
v0.11 变更：Read 指令引用 `.ccmem/context-{session_id[:8]}.md`；末尾清理非当前 session 的旧文件。

```javascript
// scripts/handlers/session-start.mjs (v0.11 改造)

import { withHookSafety } from '../lib/hook-safety.mjs';
import { openDb, ensureSchema } from '../lib/db.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { loadConfig } from '../lib/config.mjs';
import { shouldHookRun } from '../lib/mode.mjs';
import { trimToCharLimit } from '../lib/render.mjs';
import { writeRecentInjection } from '../lib/recent-injections.mjs';
import { cleanupStaleContextFiles } from '../lib/context-file.mjs';  // v0.11 新增

export async function handleSessionStart(hookData, tEntry) {
  return withHookSafety('session_start', 800, async () => {
    const { run, mode } = shouldHookRun();
    if (!run) return { additionalContext: '' };

    if (mode === 'shadow') {
      process.stderr.write('ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n');
    }

    const db = openDb();
    ensureSchema(db);

    const config = loadConfig(hookData.cwd);
    const projectKey = resolveProjectKey(hookData.cwd);

    const rows = db.prepare(`
      SELECT rendered_text, member_ids FROM injection_cache
      WHERE scope = 'global' OR scope = ?
      ORDER BY (scope = 'global') DESC
    `).all(`project:${projectKey}`);

    const text = rows.map(r => r.rendered_text).filter(Boolean).join('\n\n');
    const trimmed = trimToCharLimit(text, config.inject?.max_chars ?? 3000);

    if (mode === 'shadow') return { additionalContext: '' };

    // v0.2: record the injection so /ccmem:forget --last can reference it (Q-1).
    recordSessionStartInjection(db, hookData.session_id, rows);

    // v0.10: append Read instruction when file-based injection is enabled
    const useFileBased = config.injection?.file_based !== false;
    
    // v0.11 A1: Read 指令引用 session-scoped 文件名
    let stableContext = trimmed;
    if (useFileBased) {
      const sessionPrefix = hookData.session_id.slice(0, 8);
      const readInstruction = 
        '\n\n<!-- ccmem: file-based memory injection -->\n' +
        'IMPORTANT: After each user message, Read the file `.ccmem/context-' + sessionPrefix + '.md` ' +
        'in the project root to load relevant memories retrieved by ccmem. ' +
        'This file is updated before each prompt with context-specific memories. ' +
        'Also re-read it after /compact to restore memory context.';
      stableContext = trimmed + readInstruction;
      
      // v0.11 A1: 清理非当前 session 的旧 context 文件（包括 v0.10 遗留的 context.md）
      cleanupStaleContextFiles(hookData.cwd, hookData.session_id);
    }

    return { additionalContext: stableContext };
  }, tEntry);
}

// v0.2: write a single prompt_idx=0 recent_injections row holding the union of
// the injection_cache member ids for this session. No-op if nothing was injected.
export function recordSessionStartInjection(db, sessionId, cacheRows) {
  if (!sessionId) return;
  const ids = [];
  for (const r of cacheRows) {
    try {
      const arr = JSON.parse(r.member_ids);
      if (Array.isArray(arr)) ids.push(...arr);
    } catch { /* skip malformed member_ids */ }
  }
  if (ids.length === 0) return;
  writeRecentInjection(db, sessionId, 0, 'session_start', ids);
}
```

**关键约束**：
- Read 指令引用 `context-{session_id[:8]}.md`，session 内不变 → 缓存友好
- `cleanupStaleContextFiles` 在 hook 末尾调用，不影响 Read 指令的稳定性
- mode=shadow 时**不调 cleanup**（与 v0.10 shadow 行为一致："no writes, no inject"）

### 4.2 UserPromptSubmit（A1：传 session_id 给 context-file.mjs）

v0.10 行为：检索记忆 → 写入 `.ccmem/context.md` → `additionalContext` 返回空。
v0.11 变更：写入 `.ccmem/context-{session_id[:8]}.md`；同时写入 history 表（A2）。

```javascript
// scripts/handlers/prompt-submit.mjs (v0.11 改造, 仅展示关键改动)

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

    const { rows, queryVec, cosineContribution, timing } = await retrieveMemories(db, searchPrompt, projectKey, config);

    const useFileBased = config.injection?.file_based !== false;

    // v0.10: file-based injection metrics
    let contextFileWritten = false;
    let contextFileBytes = 0;

    if (mode === 'shadow') {
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
        additional_context_empty: true,
        context_file_written: false,
        context_file_bytes: 0,
      });
      return { additionalContext: '' };
    }

    applyPromptFeedback(db, hookData.session_id, prompt, rows, config, queryVec);

    if (useFileBased) {
      // v0.11 A1: 传 session_id 给 context-file.mjs
      try {
        if (rows.length === 0) {
          clearContextFile(hookData.cwd, hookData.session_id, db);  // v0.11: 传 session_id + db
        } else {
          const result = writeContextFile(hookData.cwd, rows, hookData.session_id, db);  // v0.11: 传 session_id + db
          contextFileWritten = result.written;
          contextFileBytes = result.bytes;
        }
      } catch (writeError) {
        process.stderr.write(
          `ccmem: context file write failed (${writeError.message})\n`
        );
      }

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
        additional_context_empty: true,
        context_file_written: contextFileWritten,
        context_file_bytes: contextFileBytes,
      });

      return { additionalContext: '' };
    }

    // v0.9 fallback: direct additionalContext injection
    const additionalContext = rows.length === 0 ? '' : renderRetrievedBlock(rows);

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
      additional_context_empty: additionalContext === '',
      context_file_written: false,
      context_file_bytes: 0,
    });

    return { additionalContext };
  }, tEntry);
}

// applyPromptFeedback 不变（v0.10 实现）
```

**与 v0.10 的关键差异**：

| 环节 | v0.10 | v0.11 |
|---|---|---|
| 文件名 | `.ccmem/context.md` | `.ccmem/context-{session_id[:8]}.md` |
| `writeContextFile` 签名 | `(cwd, rows)` | `(cwd, rows, sessionId, db)` |
| `clearContextFile` 签名 | `(cwd)` | `(cwd, sessionId, db)` |
| history 写入 | 无 | `writeContextFile` / `clearContextFile` 内部写 `context_write_log` + `context_snapshots` |

### 4.3 Stop（零变化）

`stop.mjs` 不动。context 文件的生命周期由 SessionStart cleanup + UserPromptSubmit 自然覆盖管理。

---

## 五、核心改动

### 5.1 A1 — 多窗口并发隔离（context-file.mjs 文件名参数化 + cleanup）

```javascript
// scripts/lib/context-file.mjs (v0.11 改造)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { renderRetrievedBlock } from './render.mjs';

const CONTEXT_DIR = '.ccmem';
const MAX_FILE_BYTES = 8 * 1024; // 8 KB hard cap

/**
 * Compute an 8-char hex hash of content for dedup gating.
 */
function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * v0.11 A1: 生成 session-scoped 文件名。
 * 使用 session_id 前 8 字符（UUID 碰撞概率 ~1/4B，文件名可读）。
 * 如果 session_id 无效或过短，使用 'unknown' 作为降级。
 */
function contextFileName(sessionId) {
  if (!sessionId || sessionId.length < 8) {
    sessionId = 'unknown';
  }
  const prefix = sessionId.slice(0, 8);
  return `context-${prefix}.md`;
}

/**
 * Write retrieved memory rows to .ccmem/context-{session_id[:8]}.md.
 *
 * Returns:
 *   { written: true,  bytes: N, skipped: false } — file was (re)written
 *   { written: false, bytes: N, skipped: true  } — hash matched, no write
 *
 * The first line is always `<!-- content-hash: XXXXXXXX -->` so the next
 * call can compare hashes and skip redundant writes.
 *
 * If the rendered content exceeds MAX_FILE_BYTES the body is truncated and
 * a stderr warning is emitted. The hash is recomputed AFTER truncation so
 * subsequent calls with the same (truncated) content still gate correctly.
 *
 * v0.11 A2: 写入 context_snapshots + context_write_log 支持 dogfood review。
 */
export function writeContextFile(cwd, rows, sessionId, db) {
  const dir = join(cwd, CONTEXT_DIR);
  const filePath = join(dir, contextFileName(sessionId));

  // Render body (same format as v0.10 additionalContext)
  let body = renderRetrievedBlock(rows);

  // Truncate if over budget (accounting for the hash header line added below)
  const headerLen = Buffer.byteLength('<!-- content-hash: XXXXXXXX -->\n', 'utf8');
  const bodyBudget = MAX_FILE_BYTES - headerLen;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > bodyBudget) {
    // Character-based truncation to preserve UTF-8 integrity
    // Binary truncation (Buffer.subarray) can break multi-byte CJK chars
    let truncated = body;
    while (Buffer.byteLength(truncated, 'utf8') > bodyBudget && truncated.length > 0) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    body = truncated;
    process.stderr.write(
      `ccmem: context.md truncated from ${bodyBytes} to ${Buffer.byteLength(body, 'utf8')} bytes\n`
    );
  }

  const hash = contentHash(body);

  // Hash gate: skip write if existing file has the same hash
  if (existsSync(filePath)) {
    try {
      const existing = readFileSync(filePath, 'utf8');
      const firstLine = existing.split('\n', 1)[0];
      const existingHashMatch = firstLine.match(/^<!-- content-hash: ([0-9a-f]{8}) -->$/);
      if (existingHashMatch && existingHashMatch[1] === hash) {
        // v0.11 A2: hash gate 命中 → UPDATE hit_count + INSERT log (written=0)
        recordWriteHistory(db, sessionId, hash, body, Buffer.byteLength(existing, 'utf8'), false);
        // Return actual file size, not 0 — distinguishes "no data" from "unchanged"
        const fileBytes = Buffer.byteLength(existing, 'utf8');
        return { written: false, bytes: fileBytes, skipped: true };
      }
    } catch { /* read failure → re-write */ }
  }

  const fullContent = `<!-- content-hash: ${hash} -->\n${body}`;

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  writeFileSync(filePath, fullContent, 'utf8');

  // v0.11 A2: 新 hash → INSERT snapshot + INSERT log (written=1)
  recordWriteHistory(db, sessionId, hash, body, Buffer.byteLength(fullContent, 'utf8'), true);

  // .gitignore reminder (persistent marker — truly remind only once)
  warnGitignoreOnce(cwd);

  return { written: true, bytes: Buffer.byteLength(fullContent, 'utf8'), skipped: false };
}

/**
 * Clear context-{session_id[:8]}.md (when retrieval returns no results). Writes an explicit
 * "no memories" signal rather than an empty string — lets Claude understand
 * immediately, and avoids hash-gate mismatch on next write.
 *
 * v0.11 A1: 只清当前 session 的文件（不影响其他窗口）。
 * v0.11 A2: 写入 context_write_log (hash='empty', bytes=0)。
 *
 * Skips if directory does not exist (avoids creating an empty dir on first
 * install when no matches trigger the write path).
 */
export function clearContextFile(cwd, sessionId, db) {
  const filePath = join(cwd, CONTEXT_DIR, contextFileName(sessionId));
  if (existsSync(filePath)) {
    writeFileSync(filePath, '<!-- ccmem: no relevant memories -->\n', 'utf8');
    // v0.11 A2: 记录 clear 事件
    recordWriteHistory(db, sessionId, 'empty', '', 0, true);
  }
  return 0;
}

/**
 * v0.11 A1: 清理非当前 session 的旧 context 文件（包括 v0.10 遗留的 context.md）。
 * 在 SessionStart 时调用，避免磁盘堆积。
 *
 * 清理策略：
 * - 删除 .ccmem/context-*.md（不属于当前 session）
 * - 删除 .ccmem/context.md（v0.10 遗留）
 * - 保留 .ccmem/context-{current_session_id[:8]}.md
 * - 保留 .ccmem/.gitignore_warned（非 context 文件）
 */
export function cleanupStaleContextFiles(cwd, currentSessionId) {
  const dir = join(cwd, CONTEXT_DIR);
  if (!existsSync(dir)) return;

  const currentFile = contextFileName(currentSessionId);
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      // 清理 context-*.md（不属于当前 session）和 context.md（v0.10 遗留）
      if ((file.startsWith('context-') && file.endsWith('.md') && file !== currentFile) ||
          file === 'context.md') {
        try {
          unlinkSync(join(dir, file));
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * v0.11 A2: 记录写入历史到 context_snapshots + context_write_log。
 * 在 writeContextFile / clearContextFile 内部调用。
 *
 * 逻辑：
 * - 新 hash → INSERT snapshot (first_seen_at=now, hit_count=1) + INSERT log (written=1)
 * - hash gate 命中 → UPDATE snapshot.hit_count++ + INSERT log (written=0)
 * - clearContextFile → INSERT log (hash='empty', bytes=0, written=1)
 *
 * 使用 INSERT OR IGNORE 避免并发写入时 snapshot 重复插入报错。
 * 使用 UPDATE OR INSERT 模式确保 hit_count 正确递增。
 */
function recordWriteHistory(db, sessionId, hash, content, bytes, written) {
  try {
    const now = Date.now();
    const promptIdx = getPromptIdx(db, sessionId);  // 0=SessionStart, 1+=UserPromptSubmit

    if (hash === 'empty') {
      // clearContextFile: 只写 log，不写 snapshot
      db.prepare(`
        INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, promptIdx, 'empty', 0, written ? 1 : 0, now);
    } else {
      // writeContextFile: 写 snapshot（新 hash 或 hit_count++）+ 写 log
      if (written) {
        // 新 hash: INSERT snapshot
        db.prepare(`
          INSERT OR IGNORE INTO context_snapshots (content_hash, content, first_seen_at, hit_count)
          VALUES (?, ?, ?, 1)
        `).run(hash, content, now);
        // 如果 INSERT OR IGNORE 没插入（hash 已存在），则 UPDATE hit_count
        const result = db.prepare(`SELECT hit_count FROM context_snapshots WHERE content_hash = ?`).get(hash);
        if (result && result.hit_count === 1) {
          // 刚插入的，不需要 UPDATE
        } else {
          // hash 已存在，递增 hit_count
          db.prepare(`UPDATE context_snapshots SET hit_count = hit_count + 1 WHERE content_hash = ?`).run(hash);
        }
      } else {
        // hash gate 命中: 只 UPDATE hit_count
        db.prepare(`UPDATE context_snapshots SET hit_count = hit_count + 1 WHERE content_hash = ?`).run(hash);
      }
      // INSERT log
      db.prepare(`
        INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, promptIdx, hash, bytes, written ? 1 : 0, now);
    }
  } catch (e) {
    // history 写入失败不阻断主流程（与 v0.10 metrics 写入失败处理一致）
    process.stderr.write(`ccmem: context history write failed (${e.message})\n`);
  }
}

/**
 * v0.11 A2: 获取当前 session 的 prompt_idx。
 * 0=SessionStart（由 session-start.mjs 调用 writeContextFile 时传入）,
 * 1+=UserPromptSubmit（由 recent_injections 表的 MAX(prompt_idx) + 1 计算）。
 *
 * 这里简化为：如果 context_write_log 中该 session 已有记录，则取 MAX(prompt_idx) + 1；
 * 否则返回 1（SessionStart 不调用 writeContextFile，首次 UserPromptSubmit 为 1）。
 */
function getPromptIdx(db, sessionId) {
  const result = db.prepare(`
    SELECT MAX(prompt_idx) AS max_idx FROM context_write_log WHERE session_id = ?
  `).get(sessionId);
  return (result?.max_idx ?? 0) + 1;
}

/**
 * stderr reminder to add .ccmem/ to .gitignore (persistent file marker so
 * the reminder fires at most once per project). Uses .ccmem/.gitignore_warned
 * instead of a global variable (hook runs as a fresh process each time).
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
        // Already listed — write marker and return silently
        writeFileSync(warnedPath, '', 'utf8');
        return;
      }
    }
    process.stderr.write(
      'ccmem: hint — add .ccmem/ to .gitignore to exclude context cache\n'
    );
    writeFileSync(warnedPath, '', 'utf8');
  } catch { /* ignore */ }
}
```

**关键设计决策**：

| 决策 | 选择 | 理由 |
|---|---|---|
| session_id 截取 | 前 8 字符 | UUID 碰撞概率 ~1/4B，文件名可读 |
| 旧文件清理时机 | SessionStart | 避免磁盘堆积；不影响当前 session 的 Read |
| `clearContextFile` 范围 | 只清当前 session | 不影响其他窗口 |
| history 写入失败处理 | try-catch + stderr，不阻断主流程 | 与 v0.10 metrics 写入失败处理一致 |
| snapshot 去重 | `INSERT OR IGNORE` + `UPDATE hit_count` | 避免并发写入时重复插入报错 |
| prompt_idx 计算 | `MAX(prompt_idx) + 1` | 与 recent_injections 的 prompt_idx 计算方式一致 |

### 5.2 A2 — daily_maintenance 追加 snapshot 清理 step

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.11 增量, 末尾追加)

// step N: 清理 30d 前的 context_write_log + 无引用的 context_snapshots
const retentionDays = loadConfig().context_history?.retention_days ?? 30;
const cutoffMs = Date.now() - retentionDays * 86400000;

// 1. 删除 30d 前的 write_log
db.prepare(`DELETE FROM context_write_log WHERE written_at < ?`).run(cutoffMs);

// 2. 删除无引用的 snapshot（没有任何 write_log 引用它的 snapshot）
db.prepare(`
  DELETE FROM context_snapshots
  WHERE content_hash NOT IN (
    SELECT DISTINCT content_hash FROM context_write_log WHERE content_hash != 'empty'
  )
`).run();
```

**关键约束**：
- 清理周期 30 天（与 `recent_injections.retention_days` 一致）
- `content_hash = 'empty'` 的 log 行不引用 snapshot，删除时不影响 snapshot 表
- 无引用 snapshot 的删除使用 `NOT IN` 子查询，性能可接受（write_log 行数 < 10K）

---

## 六、命令延伸

所有命令遵守 v0.1 R-4 原则。命令 prelude 调 `maybeRunTier15`。

### 6.1 命令矩阵（v0.11 新增 / 扩展）

| Slash | CLI | 实现 | 类型 |
|---|---|---|---|
| `/ccmem:admin context-history [--session <id>] [--hash <hash>] [--days N]` | 同 | `lib/cmd/diagnose.mjs` 新 flag | 新增 |

### 6.2 `/ccmem:admin context-history`

```javascript
// scripts/lib/cmd/diagnose.mjs (v0.11 增量)

export function cmdContextHistory(db, { session, hash, days }) {
  try { maybeRunTier15(db); } catch {}

  if (hash) {
    // 模式 1: 查看某 hash 的实际内容
    const snapshot = db.prepare(`
      SELECT content, first_seen_at, hit_count
      FROM context_snapshots WHERE content_hash = ?
    `).get(hash);
    if (!snapshot) {
      process.stdout.write(`ccmem: no snapshot found for hash ${hash}\n`);
      return;
    }
    process.stdout.write(`Hash: ${hash}\n`);
    process.stdout.write(`First seen: ${new Date(snapshot.first_seen_at).toISOString()}\n`);
    process.stdout.write(`Hit count: ${snapshot.hit_count}\n`);
    process.stdout.write(`\nContent:\n${snapshot.content}\n`);
    return;
  }

  if (session) {
    // 模式 2: 查看某 session 的写入序列
    const logs = db.prepare(`
      SELECT prompt_idx, content_hash, bytes, written, written_at
      FROM context_write_log
      WHERE session_id = ?
      ORDER BY prompt_idx
    `).all(session);
    if (logs.length === 0) {
      process.stdout.write(`ccmem: no write history for session ${session}\n`);
      return;
    }
    process.stdout.write(`Session: ${session} (${logs.length} writes)\n\n`);
    for (const log of logs) {
      const ts = new Date(log.written_at).toISOString();
      const status = log.written ? 'written' : 'skipped (hash gate)';
      process.stdout.write(
        `  prompt ${log.prompt_idx}: ${log.content_hash} ${log.bytes}B ${status} ${ts}\n`
      );
    }
    return;
  }

  // 模式 3: 查看最近 N 天的写入统计
  const daysN = days ?? 7;
  const cutoffMs = Date.now() - daysN * 86400000;
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(written) AS actual_writes,
      COUNT(*) - SUM(written) AS gate_skips
    FROM context_write_log
    WHERE written_at > ?
  `).get(cutoffMs);

  process.stdout.write(`Context write history (last ${daysN} days)\n\n`);
  process.stdout.write(`  Total writes: ${stats.total}\n`);
  process.stdout.write(`  Actual writes: ${stats.actual_writes}\n`);
  process.stdout.write(`  Hash gate skips: ${stats.gate_skips}\n`);
  const efficiency = stats.total > 0
    ? ((stats.gate_skips / stats.total) * 100).toFixed(1)
    : '0.0';
  process.stdout.write(`  Gate efficiency: ${efficiency}%\n`);

  // 显示 top 10 高频 hash
  const topHashes = db.prepare(`
    SELECT content_hash, COUNT(*) AS count
    FROM context_write_log
    WHERE written_at > ? AND content_hash != 'empty'
    GROUP BY content_hash
    ORDER BY count DESC
    LIMIT 10
  `).all(cutoffMs);

  if (topHashes.length > 0) {
    process.stdout.write(`\n  Top 10 hashes:\n`);
    for (const h of topHashes) {
      process.stdout.write(`    ${h.content_hash}: ${h.count} writes\n`);
    }
  }
}
```

**关键约束**：
- 三种模式互斥：`--hash` > `--session` > 默认统计
- `--hash` 输出完整内容（可能 > 8KB），用户主动查询允许
- `--session` 输出该 session 的完整写入序列
- 默认输出统计摘要 + top 10 hash

### 6.3 命令 prelude 调用

| 命令 | prelude 调用 | 理由 |
|---|---|---|
| `/ccmem:admin context-history` | `maybeRunTier15(db)` | 与 `--tuning` / `--metrics` / `--injections` 一致 |

### 6.4 输出契约（R-4 LLM-safe）

- `context-history` 诊断输出 ≤ 50 行（用户主动查询，允许富格式）
- 元解释走 `audit_log`（本命令无元解释需求）

---

## 七、配置

### 7.1 config.default.json 新增段

```jsonc
{
  "version": "0.11",

  // v0.11 新增
  "context_history": {
    "retention_days": 30                    // context_write_log + context_snapshots 清理周期
  }

  // ... 其它配置段不变 ...
}
```

### 7.2 配置向后兼容

| 配置 | 默认值 | 行为 |
|---|---|---|
| `context_history.retention_days` | 30 | 与 `recent_injections.retention_days` 一致 |
| `injection.file_based` | true（v0.10 默认） | 不变 |

---

## 八、测试策略

### 8.1 新增测试

| 类别 | 预计数 | 覆盖对象 |
|---|---|---|
| context-file-session-scoped | 7 | writeContextFile 写 session-scoped 文件 / clearContextFile 只清当前 session / cleanupStaleContextFiles 清理旧文件 + v0.10 遗留 / 文件名参数化 / session_id[:8] 截取 / 多 session 文件独立 / **session_id 无效时 fallback 到 'unknown'** |
| context-file-history | 8 | 新 hash INSERT snapshot + log / hash gate 命中 UPDATE hit_count + log / clearContextFile INSERT log (empty) / prompt_idx 计算 / history 写入失败 try-catch / snapshot 去重 (INSERT OR IGNORE) / bytes 记录正确 / written 字段正确 |
| prompt-submit-session-id | 3 | writeContextFile 传 session_id / clearContextFile 传 session_id / session_id 缺失时 fallback 到 'unknown' |
| session-start-cleanup | 3 | Read 指令引用 session-scoped 文件名 / cleanupStaleContextFiles 调用 / mode=shadow 不调 cleanup |
| daily-maintenance-cleanup | 4 | 30d 前 write_log 删除 / 无引用 snapshot 删除 / 'empty' hash log 不影响 snapshot / retention_days 配置生效 |
| diagnose-context-history | 5 | --hash 输出内容 / --session 输出序列 / 默认统计输出 / top 10 hash / 无数据友好提示 |
| migration-013 | 3 | schema 版本 12→13 / 两张新表创建 / v0.1-v0.10 升级链兼容 |

**预计新增**：~33 个测试。总计 1073 + 33 = ~1106。

### 8.2 回归测试

v0.10 全量 1073 tests 必须 100% 通过。

**特别关注**：
- `prompt-submit-file-based` 现有测试中 `writeContextFile` / `clearContextFile` 调用需更新（v0.11 新增 session_id + db 参数）
- `session-start-read-instruction` 现有测试中 Read 指令断言需更新（v0.11 引用 session-scoped 文件名）
- `context-file` 现有测试中文件名断言需更新（v0.11 从 `context.md` 改为 `context-{session_id[:8]}.md`）

### 8.3 手工验证（dogfood 前）

| 步骤 | 预期 |
|---|---|
| 正常使用 1 个 prompt | `.ccmem/context-{session_id[:8]}.md` 文件被创建 |
| 开 2 个 Claude Code 窗口 | 各自 context 文件独立（文件名不同） |
| 关闭 1 个窗口，开新 session | SessionStart 清理旧 session 的 context 文件 |
| `ccmem admin context-history --session <id>` | 输出该 session 的写入序列 |
| `ccmem admin context-history --hash <hash>` | 输出该 hash 的实际内容 |
| `ccmem admin context-history` | 输出最近 7 天的写入统计 |

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
| SessionStart stable context 内容零变化（仅 Read 指令文件名变化） | 字节级比对（除 Read 指令部分） |
| context 文件名 session-scoped（`context-{session_id[:8]}.md`） | 单元测试 |
| history 写入不阻断主流程（try-catch） | 单元测试 |

---

## 十、backlog 项

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | Read 执行率 fallback（additionalContext 精简摘要兜底） | v0.10 dogfood | P2 | 视 V3 数据决定是否启动 |
| 2 | ~~context.md diff 模式（仅写增量）~~ | v0.10 spec §1.2 | P3 | **删除**（Claude Read 无法增量更新） |
| 3 | `synthesized=0` 连续 skip logic（v0.8 backlog #4） | v0.8 遗留 | P3 | 待 weekly_synthesis 更多数据 |
| 4 | ~~跨项目冷启动继承~~ | v0.9 defer | P2 | **推迟到 v0.12+**（现有 promote_candidates 机制已够用） |
| 5 | better-sqlite3 + sqlite-vec ANN | v0.9 defer | P3 | v0.12+ |
| 6 | never-injected 查询 json_each 性能（v0.9 #4） | v0.9 遗留 | P3 | 监控 |
| 7 | 检索候选预过滤优化 | v0.10 defer | P3 | v0.12+（数据驱动） |
| 8 | query embedding 缓存（API provider） | v0.10 defer | P3 | v0.12+ |

---

## 附录 A：v0.11 不变量 checklist（CI grep）

| # | 不变量 | grep 命令 | 预期 |
|---|---|---|---|
| 96 | context 文件名 session-scoped | `grep -n "context-{session" scripts/handlers/session-start.mjs scripts/lib/context-file.mjs` | ≥ 2 |
| 97 | `cleanupStaleContextFiles` 在 SessionStart 调用 | `grep -n "cleanupStaleContextFiles" scripts/handlers/session-start.mjs` | ≥ 1 |
| 98 | `writeContextFile` 签名含 session_id + db | `grep -n "function writeContextFile(cwd, rows, sessionId, db)" scripts/lib/context-file.mjs` | = 1 |
| 99 | `clearContextFile` 签名含 session_id + db | `grep -n "function clearContextFile(cwd, sessionId, db)" scripts/lib/context-file.mjs` | = 1 |
| 100 | history 写入 try-catch 保护 | `grep -n "recordWriteHistory" scripts/lib/context-file.mjs` 后的 5 行内含 `try` | ≥ 1 |
| 101 | snapshot INSERT OR IGNORE 去重 | `grep -n "INSERT OR IGNORE INTO context_snapshots" scripts/lib/context-file.mjs` | = 1 |
| 102 | daily_maintenance 清理 context_write_log | `grep -n "DELETE FROM context_write_log" scripts/daemon/tasks/daily-maintenance.mjs` | = 1 |
| 103 | daily_maintenance 清理无引用 snapshot | `grep -n "DELETE FROM context_snapshots" scripts/daemon/tasks/daily-maintenance.mjs` | = 1 |
| 104 | v0.11 新增文件 100% 用 `writeAudit`，禁止 `logAudit(` | `grep -rn 'logAudit(' scripts/lib/context-file.mjs scripts/lib/cmd/diagnose.mjs` | 为空 |

---

**End of v0.11 spec.**
