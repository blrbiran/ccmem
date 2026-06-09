# ccmem v0.5 实施 spec

> 这是 v0.5 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) /
> [`ccmem-v0.2-spec.md`](./ccmem-v0.2-spec.md) / [`ccmem-v0.3-spec.md`](./ccmem-v0.3-spec.md) /
> [`ccmem-v0.4-spec.md`](./ccmem-v0.4-spec.md) 平级，共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.4 把 ccmem 带到 Linux 用户的真实机器上（Portability & Observability）；
> v0.5 把它**修得能自己稳住**——daemon code 升级后自动 refresh、单位/字段命名统一、
> dogfood 期实证暴露的边角 bug 修齐（Stability & Polish）。
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。
> design.md 引用仅作为决策 rationale 的指针。
>
> **当前状态（2026-06-03）**：草稿 → **设计中**。v0.4 dogfood Day 1 实证 3+1 个确认问题，
> 全部提升到 Tier A：(1) daemon self-restart（blocker）；(2) CLI fresh-install crash（C7）；
> (3) dead cron config（C8）；(4) Docker/容器环境 daemon 不可用（systemd-user bus 不存在）。
> Tier B 哨兵触发项不变；Tier B' 缩减为 C1-C6。

> **⚠ 2026-06-03 dogfood Day 1 修订 #2**（migration backup 文件增殖，已在 dev 修复）：
> - **§6.12 A5 — migration backup 增殖修复**：`~/.claude/ccmem/` 下累积 274 个 `global.db.bak.*` 文件。
>   根因三叠加：(1) `runMigration()` per-file backup（6 个 migration 文件 = 每次升级 6 个 backup）；
>   (2) 并发竞态——多 hook/CLI/daemon 进程同时读到旧 `schema_meta.version`，各自创建 backup（每秒 ~10 个）；
>   (3) `.bak` 文件从未被清理（spec 中无此设计）。
>   **修复三层**：(a) backup 移到循环外——一次 `runMigration()` 最多一个 backup；
>   (b) 跨进程去重——60s 内已有同大小 `.bak` 则跳过；(c) `daily_maintenance` step 14 自动清理只保留最近 5 个。

---

## 〇、与 v0.4 的关系与关键约定

### 0.1 v0.4 已实现的基线（不重复）

v0.4 已 ship 以下能力，v0.5 在其上叠加，**不重写**：

- `revalidation_audit` 纯 SQL（Tier 1.5 lazy + daily + manual 三触发）
- `metrics_daily_rollup` 表 + `/ccmem:admin diagnose --tuning/--metrics`
- Linux systemd-user 全套 + macOS launchd 平台抽象层（`lib/admin/platform/`）
- `writeAudit` 唯一签名（`logAudit` adapter）
- 8 个 critic 复审 fix（S1-S4 + S6 + S7 + M1 + M2）

### 0.2 关键实现约定（沿用 v0.2/v0.3/v0.4）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务。v0.5 不引入新 LLM 任务 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.5 不引入新 schema |
| **stdout/stderr 都进 LLM 上下文** | 元数据走 `audit_log`，stderr ≤ 2 行 LLM-safe 指针 |
| **命令 prelude 调 `maybeRunTier15`** | v0.5 不新增命令此约束依旧 |
| **writeAudit 唯一签名** | `writeAudit(db, action, mem_id, details)`；新文件禁止 `logAudit(` |
| **`{XXX}` 模板占位符** | install 时由 `renderPlist` / `renderUnit` 替换 |

### 0.3 版本号

- `config.default.json::version` 从 `"0.4"` 升到 `"0.5"`
- schema `schema_meta.version` 从 `5` 升到 `6`（migration `006_v05.sql`）
- `config.default.json::security.scan_patterns_version` **不 bump**（v0.5 不动 patterns，避免无谓 revalidation）

### 0.4 v0.5 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为（SessionStart / UserPromptSubmit / Stop） | **零变化** |
| 写入闸门 Tier 1 / 2 / 2.5 / 3 | **零变化** |
| Trust 系数 / 优先级公式 / 反馈推断 L1-L4 | 零变化 |
| summarize / weekly_synthesis / security_audit / revalidation | **零变化**（v0.5 不动算法） |
| daily_maintenance | **微增**（step 14 `.bak` 文件清理）；**触发时间**改为从 config 读（C8） |
| Tier 1.5 lazy maintenance | 零变化 |
| writeAudit / logAudit | v0.4 adapter 保留；v0.5 不再统一更多老 caller（YAGNI） |

---

## 一、范围与时间预算

### 1.1 v0.5 做什么（M6，约 2 周）

| Tier | 能力 | 触发 |
|---|---|---|
| **A1 必做** | **daemon self-restart on schema mismatch** | 2026-06-03 dogfood 实证 hard-bug |
| **A2 必做** | **CLI first-install ensureSchema**（C7） | 2026-06-03 V18 fix 附带发现：fresh DB 首次跑任意 CLI 命令 crash |
| **A3 必做** | **cron config wire-up**（C8） | 2026-06-03 架构分析：`cron.daily_at` / `cron.weekly_at` 声明但 daemon 不读 |
| **A4 必做** | **Container/Docker daemon fallback** | 2026-06-03 Ubuntu Docker 实证：`systemctl --user` 因无 D-Bus 用户总线失败，daemon 完全不可用 |
| **A5 必做** | **migration backup 增殖修复** | 2026-06-03 dogfood 实证：274 个 `.bak` 文件累积（per-file backup + 并发竞态 + 无清理） |

**4 项**。A1 是 blocker；A2 是 first-install 体验 crash（新用户第一步就炸）；
A3 是 config 契约违反（声明了旋钮但不生效）；A4 是 Docker/容器用户无法使用 Tier 2 的 blocker。
其余项目走 Tier B 哨兵触发或 Tier B' 累积决策。

### 1.2 v0.5 候选但默认 defer（哨兵触发就启动）

| # | 能力 | 哨兵 | 默认状态 |
|---|---|---|---|
| B1 | `audit_log.ts` 秒 → 毫秒迁移 | v0.4-dogfood §三 V13："我刚 keep 怎么又 flag 了我" ≥ 2 次 | defer |
| B2 | systemd `RestartLimitBurst` / `StartLimitIntervalSec` | V15: `systemctl --user status com.ccmem.daemon` 出现 `start-limit-hit` | defer |
| B3 | `tier15.mjs` 注释步骤号跳号修正（M3） | 顺手做即可 | cosmetic, defer |
| B4 | `trendArrow` 第二分支 NaN 边界（M5） | `/ccmem:admin diagnose --metrics` 输出字面 `trend: NaN%` | defer |
| B5 | darwin plist `--experimental-sqlite --no-warnings` 拆两个 string（M6） | 永远不会出错（launchd 解析正常） | cosmetic, defer |

**重要**：B1-B5 命中哨兵后再开 sub-spec，**不在 v0.5 上线时实现**。

### 1.3 v0.5 候选但需更多决策（Tier B'）

dogfood 期累积信号后再决定是否进入 v0.5（或推 v0.6）：

| # | 能力 | 待决策点 |
|---|---|---|
| C1 | 语义矛盾检测（跨记忆 LLM 比对） | 与 embedding gate 一起评估更经济；dogfood 是否已经通过 cross_scope_alerts 覆盖了主要用例 |
| C2 | `monthly_meta_synthesis`（W-4） | consolidated 池在 v0.5 自用阶段是否膨胀到需要月度元整合 |
| C3 | L1 中文正向关键词（对/嗯/好） | "对/嗯/好" 歧义解决方案（标点上下文 + 句首 vs 句中 vs 句末）是否成熟 |
| C4 | `project_key_alias` 漂移检测 | git remote rename / mirror 切换是否在 dogfood 期撞到 |
| C5 | `/ccmem:admin import/export/migrate` | sqlite3 CLI 是否真的不够（多设备同步需求出现） |
| C6 | Windows scheduled task | 是否有 dogfood 设备（platform layer 已留 `unsupported` 出口） |
| ~~C7~~ | ~~cli.mjs 缺 ensureSchema~~ | **已提升到 Tier A2**（§6.6） |
| ~~C8~~ | ~~cron config dead~~ | **已提升到 Tier A3**（§6.7） |

### 1.5.A4 完成判据（Container fallback）

**A4 — Container/Docker daemon fallback**：
14. **检测逻辑**：`systemctl --user --version` 失败时（包含 "Failed to connect to bus" 或 exit ≠ 0）自动 fallback 到 container 方案
15. **install 成功**：Docker Ubuntu 容器内 `ccmem admin daemon install` 输出 `daemon installed (linux/container-fallback)` + exit 0
16. **wrapper loop 自动重拉**：daemon 进程 exit(0) 后 wrapper 10s 后拉起新进程（验 self-restart 在容器内也工作）
17. **PID file 生命周期**：install 写 PID file；status 读 PID file 检活（kill -0）；stop 发 SIGTERM + 清 PID file；uninstall 清 wrapper + PID file
18. **命令 prelude 检活重拉**：PID file 存在但进程死了 → 自动 spawn wrapper（用户无感）
19. **跨 self-restart 兼容**：A1 的 `process.exit(0)` 被 wrapper loop 捕获 → 10s 后拉新进程 → 新 daemon 读到新 schema 版本 → 不 mismatch

### 1.4 v0.5 明确不做（Tier C：永不 / v0.6+）

| 项 | 推迟到 | 理由 |
|---|---|---|
| 自动 nudge thresholds（B-wide 路径） | 永不 | turf war + 用户 config 风险 |
| `loginctl enable-linger` 自动化 | 永不 | 需 sudo / polkit，破坏 install 零交互承诺 |
| revalidation 内 LLM borderline 复核 | v0.6+ | v0.5 不引入新 LLM 任务（dogfood 期 LLM 用量先稳） |
| revalidation_audit 写新表 | 永不 | 复用 audit_log，避免表膨胀 |
| metrics_rollup 自动写入 metrics.jsonl | 永不 | metrics.jsonl 仍 append-only，rollup 是消费层 |

### 1.5 完成判据（M6，共 19 条）

**A1 — daemon self-restart**：
1. **端到端**：手动 bump `schema_meta.version` → daemon 心跳间隔（默认 20s）内 graceful exit(0) → launchd / systemd 拉起新进程 → 新 PID alive + heartbeat 同步 < 30s
2. **零误报**：跑一整天正常负载（无 schema 变化）daemon 不重启；observation 通过 `audit_log` action='daemon_self_restart' 的 row 数验证
3. **跨平台一致**：macOS launchd + Linux systemd-user 两端都通过 #1 测试
4. **Graceful shutdown 不丢任务**：mid-task 检测到 mismatch 时，等当前 task 结束才 exit（不允许 mid-summarize / mid-weekly 强退）
5. **配置 gate 工作**：`daemon.self_restart_on_schema_mismatch=false` 时跳过检测

**A2 — CLI first-install init**：
6. **fresh DB happy path**：`rm -rf ~/.claude/ccmem && ccmem list` 输出空列表（不 crash）；`ccmem save "test" --scope global` 成功写入并返回 exit 0
7. **hook 路径不受影响**：hook.mjs SessionStart 仍走自己的 ensureSchema 链，不重复执行
8. **幂等性**：已有 DB（version=6）上 cli.mjs 入口的 ensureSchema 是 no-op（runMigration skip）

**A3 — cron config wire-up**：
9. **daily_at 生效**：改 `cron.daily_at` 为 `"04:00"` → daemon 在 04:00 后才 claim daily lease（02:17 不再触发）
10. **weekly_at 生效**：改 `cron.weekly_at` 为 `"Sat 05:00"` → daemon 在周六 05:00 后才 claim weekly lease（周日不再触发）
11. **默认值不变**：不改 config 时行为与 v0.4 hardcode 完全一致（02:17 daily / Sun 03:17 weekly）
12. **security_audit 不受影响**：已有 config-driven 路径零改动

**A5 — migration backup 增殖修复**：
13. **单次 backup**：`runMigration()` 对 N 个 pending migration 只创建 1 个 `.bak` 文件（不是 N 个）
14. **跨进程去重**：60s 内并发 hook/CLI/daemon 调用 `runMigration()`，只产生 1 个 `.bak`（同大小检测）
15. **自动清理**：`daily_maintenance` step 14 只保留最近 5 个 `.bak` 文件，多余的自动删除
16. **config 可调**：`migration_backup.max_keep`（默认 5）控制保留数量

**通用**：
17. **v0.4 测试套全量回归 100% 通过**

---

## 二、架构（v0.5 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Claude Code 会话                              │
├──────────────────────────────────────────────────────────────────────┤
│  hooks / 写入闸门 / Tier 1.5 / 命令 (v0.5 全部零变化)                  │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (v0.5 增量)                                                   │
│   ├ 启动时记录: startupSchemaVersion = getSchemaVersion(db)            │
│   ├ 心跳里 (20s): checkSchemaStaleness()                              │
│   │   - SELECT version FROM schema_meta LIMIT 1                       │
│   │   - != startupSchemaVersion → 标 stale + 等当前 task 结束          │
│   │   - 当前无 task running → graceful exit(0)                        │
│   │   - 写 audit 'daemon_self_restart' (含 from/to version)           │
│   └ launchd KeepAlive / systemd Restart=always 自动拉新进程            │
│                                                                       │
│  其它 cron / runtask 流程零变化                                        │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite                                                               │
│   memories / audit_log / metrics_daily_rollup (v0.5 零字段变更)        │
│   audit_log.action 新增 1 个: 'daemon_self_restart'                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 新增 / 修改模块清单

```
scripts/
├── cli.mjs                      # 【改】A2: switch 前 ensureSchema(openDb())
├── daemon/
│   ├── main.mjs                 # 【改】A1: 启动时记 startup fingerprint
│   ├── lock.mjs                 # 【改】A1: refreshHeartbeat 顺手 checkSchemaStaleness
│   ├── loop.mjs                 # 【改】A1: runTask 完成路径 checkPendingRestart
│   │                            # 【改】A3: scheduleCronTasks 从 config 读 daily_at/weekly_at
│   └── self-restart.mjs         # 【新增】A1: checkSchemaStaleness + scheduleGracefulRestart
├── lib/
│   ├── tier15.mjs               # 【改】A4: + maybeRespawnDaemon() 命令 prelude 检活
│   └── admin/
│       ├── diagnose.mjs         # 【改】A1: + self-restart history 显示
│       ├── daemon.mjs           # 【改】A1: status 输出加 startup_schema_version 字段
│       │                        # 【改】A4: install output 加 variant 显示
│       └── platform/
│           ├── linux.mjs        # 【改】A4: install() probe systemd fallback; 各 verb isContainerInstall dispatch
│           └── container.mjs    # 【新增】A4: PID file + wrapper loop 6-verb 实现
├── config.default.json          # 【改】version 0.5 + daemon.self_restart_* 字段
└── migrations/
    └── 006_v05.sql              # 【新增】v0.5 schema (仅版本推进 + action 注释)
```

---

## 三、Schema 迁移（v0.4 → v0.5）

### 3.1 迁移文件 `migrations/006_v05.sql`

**v0.5 不加任何列、表、索引**——self-restart 是纯运行时机制，不需要持久化。schema migration
只推进版本号（让 daemon 启动后 schema_version=6 触发"老 daemon 看到 schema 升级 → 自重启"
的回归测试 happy path）。

```sql
-- ============================================================
-- migrations/006_v05.sql — v0.5 schema (daemon self-restart, no DDL)
-- ============================================================

-- v0.5 不加任何列/表/索引。
-- 1. schema 版本推进
UPDATE schema_meta SET version = 6, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (5, 6, 'v0.5: daemon self-restart on schema mismatch (no DDL)',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值（无 schema 变更）

| action | 写入时机 | mem_id | details JSON 关键字段 |
|---|---|---|---|
| `daemon_self_restart` | daemon 检测 schema mismatch → graceful exit(0) 之前 | null | `{from_version, to_version, daemon_pid, daemon_uptime_sec, in_flight_task_id, in_flight_task_type, waited_ms}` |

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.4 老 audit_log 行 | 不动；新 action 只追加 |
| v0.4 daemon 进程在 v0.5 升级时仍在跑 | **这正是要解决的场景**：v0.4 daemon (in-memory schema=5) 看到 DB schema=6 → 触发 self-restart → launchd / systemd 拉起 v0.5 daemon |
| v0.1-v0.4 升级链 | runMigration 按 fileVersion > currentVersion 依次应用 002 → 003 → 004 → 005 → 006 |

---

## 四、Hooks（v0.5 零变化）

`SessionStart` / `UserPromptSubmit` / `Stop` 实现不动。v0.5 测试包**回归断言**：
v0.4 hooks 输出哈希 / FTS5 检索结果集 id 列表 / Stop 入队 payload 全部一致。

---

## 五、写入闸门（v0.5 零变化）

`insertMemory` 的 Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine pipeline 不动。
self-restart 不经过任何写入闸门，零耦合。

---

## 六、v0.5 核心改动

> §6.0-6.5 = A1（daemon self-restart）；§6.6 = A2（CLI first-install）；§6.7 = A3（cron config）。

### A1 — Daemon Self-restart

### 6.0 设计原则

| 原则 | 取值 | 理由 |
|---|---|---|
| 触发信号 | `schema_meta.version` mismatch（启动时记 vs 心跳里查） | 最权威——schema 变了 code 必然变；零误报 |
| 检测频率 | 心跳间隔（默认 20s）顺手 SELECT，零独立 timer | 已有 heartbeat 跑 SELECT，加一个 SELECT 边际成本可忽略 |
| 退出方式 | `process.exit(0)`，让 launchd `KeepAlive` / systemd `Restart=always` 自动拉 | 跨平台一致；不需要额外 spawn |
| Mid-task 保护 | 检测 mismatch 时若有 task running → 等任务结束再 exit | 不允许 mid-summarize / mid-weekly 强退 |
| 配置 gate | `daemon.self_restart_on_schema_mismatch: true`（默认 on） | 用户可关（dev 期偶尔需要 daemon 跑老 code 跨 schema 版本） |
| 防 ping-pong | 启动时若 schema 已经领先记录的"上次 self-restart 后版本" → 信任并 stamp | 避免新 daemon 启动后立刻又判 mismatch（理论上 v0.5 startup 后 schema_version 等于 6，不会 mismatch；保险起见加） |

### 6.1 `lib/daemon/self-restart.mjs`（新增）

```javascript
// scripts/daemon/self-restart.mjs
import { writeAudit } from '../lib/audit.mjs';
import { loadConfig } from '../lib/config.mjs';

let pendingRestart = false;          // 模块级标志, 避免重复触发
let restartScheduledAt = null;

/**
 * 启动时调一次, 返回当前 schema_meta.version 作为 startup fingerprint
 */
export function getStartupSchemaVersion(db) {
  const row = db.prepare(`SELECT version FROM schema_meta LIMIT 1`).get();
  return row?.version ?? 0;
}

/**
 * 心跳里调 (refreshHeartbeat 末尾顺手). 检测 mismatch.
 * 返回: { stale: bool, current_version, startup_version }
 */
export function checkSchemaStaleness(db, startupVersion) {
  const cfg = loadConfig().daemon;
  if (cfg?.self_restart_on_schema_mismatch === false) {
    return { stale: false, current_version: startupVersion, startup_version: startupVersion };
  }
  const row = db.prepare(`SELECT version FROM schema_meta LIMIT 1`).get();
  const current = row?.version ?? 0;
  return {
    stale: current !== startupVersion,
    current_version: current,
    startup_version: startupVersion,
  };
}

/**
 * 调度 graceful restart. 调用方式: 心跳检测到 stale 后调.
 * - 已 scheduled: idempotent return
 * - 无 in-flight task: 立即 exit(0)
 * - 有 in-flight task: 标 pendingRestart, 由 runTask 完成路径检查
 *
 * @param {object} db
 * @param {object} schemaResult - checkSchemaStaleness 返回值
 * @param {object} daemonInfo - { pid, uptimeSec, currentTaskId, currentTaskType }
 * @returns {object} { willRestart, immediate, deferred_reason }
 */
export function scheduleGracefulRestart(db, schemaResult, daemonInfo) {
  if (pendingRestart) {
    return { willRestart: true, immediate: false, deferred_reason: 'already_scheduled' };
  }
  pendingRestart = true;
  restartScheduledAt = Date.now();

  if (daemonInfo.currentTaskId == null) {
    // 立即 restart
    writeAudit(db, 'daemon_self_restart', null, {
      from_version: schemaResult.startup_version,
      to_version: schemaResult.current_version,
      daemon_pid: daemonInfo.pid,
      daemon_uptime_sec: daemonInfo.uptimeSec,
      in_flight_task_id: null,
      in_flight_task_type: null,
      waited_ms: 0,
    });
    process.exit(0);   // launchd/systemd 自动拉新进程
    return { willRestart: true, immediate: true, deferred_reason: null };
  }

  // 有 in-flight task: 不立即退, 由 runTask 完成路径调 checkPendingRestart()
  return {
    willRestart: true, immediate: false,
    deferred_reason: `in_flight:${daemonInfo.currentTaskType}#${daemonInfo.currentTaskId}`,
  };
}

/**
 * runTask 完成路径调. 若已 scheduled, 写 audit + exit(0).
 *
 * @param {object} db
 * @param {object} startupCtx - { startupVersion, pid, startedAt }
 * @param {object} justFinishedTask - { id, type }
 */
export function checkPendingRestart(db, startupCtx, justFinishedTask) {
  if (!pendingRestart) return;
  // 再查一次确认 (理论上不会变, 防御性)
  const row = db.prepare(`SELECT version FROM schema_meta LIMIT 1`).get();
  const current = row?.version ?? 0;
  writeAudit(db, 'daemon_self_restart', null, {
    from_version: startupCtx.startupVersion,
    to_version: current,
    daemon_pid: startupCtx.pid,
    daemon_uptime_sec: Math.floor((Date.now() - startupCtx.startedAt) / 1000),
    in_flight_task_id: justFinishedTask?.id ?? null,
    in_flight_task_type: justFinishedTask?.type ?? null,
    waited_ms: Date.now() - restartScheduledAt,
  });
  process.exit(0);
}

// 测试钩子: 重置模块级状态
export function _resetForTest() {
  pendingRestart = false;
  restartScheduledAt = null;
}
```

### 6.2 `daemon/main.mjs` 增量

```javascript
// scripts/daemon/main.mjs (v0.5 增量, 在 v0.2 §7.1 基础上)
import { getStartupSchemaVersion, checkSchemaStaleness, scheduleGracefulRestart,
         checkPendingRestart } from './self-restart.mjs';

async function main() {
  const db = openDb();
  ensureSchema(db);

  const lock = acquireDaemonLock(db);
  reclaimStaleLeases(db);

  // ── v0.5: 启动时记 schema fingerprint ──
  const startupCtx = {
    startupVersion: getStartupSchemaVersion(db),
    pid: process.pid,
    startedAt: Date.now(),
  };

  // 心跳: refreshHeartbeat 内部已 SELECT, 加 self-restart 检测
  const hbTimer = setInterval(() => {
    refreshHeartbeat(db);
    // v0.5 增量: 心跳里顺手检 schema 是否 stale
    const r = checkSchemaStaleness(db, startupCtx.startupVersion);
    if (r.stale) {
      const inFlight = db.prepare(`SELECT id, type FROM tasks
        WHERE status='running' ORDER BY started_at ASC LIMIT 1`).get();
      scheduleGracefulRestart(db, r, {
        pid: startupCtx.pid,
        uptimeSec: Math.floor((Date.now() - startupCtx.startedAt) / 1000),
        currentTaskId: inFlight?.id ?? null,
        currentTaskType: inFlight?.type ?? null,
      });
    }
  }, 20_000);

  // ... 其它启动逻辑不变 ...
  await mainLoop(db, () => stop, startupCtx);
}
```

### 6.3 `daemon/loop.mjs::runTask` 增量

```javascript
// scripts/daemon/loop.mjs (v0.5 增量)
import { checkPendingRestart } from './self-restart.mjs';

async function runTask(db, task, startupCtx) {
  db.prepare(`UPDATE tasks SET status='running', started_at=? WHERE id=?`)
    .run(Date.now(), task.id);
  let result, error;
  try {
    result = await dispatch(db, task);
  } catch (e) { error = e; }
  if (error && isRetryable(error)) { scheduleRetry(db, task, error); return; }
  db.prepare(`UPDATE tasks SET status=?, finished_at=? WHERE id=?`)
    .run(error ? 'failed' : 'success', Date.now(), task.id);
  if (error) db.prepare(`UPDATE tasks SET error_excerpt=? WHERE id=?`)
    .run(truncate(String(error), 500), task.id);

  // v0.5: task 完成后检查 pending self-restart
  checkPendingRestart(db, startupCtx, { id: task.id, type: task.type });
}
```

### 6.4 防 ping-pong 与 KeepAlive 节流

| 风险 | 缓解 |
|---|---|
| 新 daemon 启动后立刻又触发（schema 版本理论上等于） | 启动时 `getStartupSchemaVersion` 记的是 DB 当前值，新 daemon 启动后两者必相等 → check 永远返回 stale=false |
| launchd / systemd 反复 KeepAlive 拉死的 daemon | 已有 launchd `ThrottleInterval`（默认 10s）+ systemd `RestartSec=10`；self-restart 1 次/版本升级，不会高频触发 |
| 用户在测试期手动 UPDATE schema_meta 反复触发 | config gate `daemon.self_restart_on_schema_mismatch=false` 关闭；audit_log 留痕便于诊断 |

### 6.5 跨平台行为表

| 平台 | exit(0) 后行为 |
|---|---|
| macOS launchd | `KeepAlive=true` → 自动拉起；`ThrottleInterval=10`（默认）→ 10s 后才再拉 |
| Linux systemd | `Restart=always` + `RestartSec=10` → 10s 后自动拉起 |
| 无 daemon supervisor（dev 期手起） | exit(0) → 进程消失，需手动重启（dev 期会被注意到，是 acceptable） |

### A2 — CLI First-install Init（C7）

#### 6.6 问题

`cli.mjs` 的所有命令路径（`list`、`save`、`show`、`resurrect` 等）调用 `openDb()` 获取
DB 句柄，但 `openDb()` 只创建空 SQLite 文件 + 设置 PRAGMA，**不建表**。`ensureSchema()`
（调用 `runMigration()`）是独立导出，需要调用方显式调用。

hooks 路径不受影响——`hook.mjs` → `handleSessionStart` 最终走到 `ensureSchema()`。但
CLI 路径**零处调用** `ensureSchema()`，所有命令都假设 DB 已被 hook 初始化过。

**复现**：
```bash
rm -rf ~/.claude/ccmem
ccmem list
# → SqliteError: no such table: memories
```

这是 first-install 体验 bug：新用户安装 ccmem 后第一次在终端跑 `ccmem list`（而非先
开一次 Claude Code 会话触发 SessionStart hook），直接 crash。

#### 6.7 设计决策

| 方案 | 优点 | 劣势 | 结论 |
|---|---|---|---|
| A. `cli.mjs` switch 前加 `ensureSchema(openDb())` | 最小改动（2 行）；hooks 不受影响；语义清晰（CLI 是用户直接入口，负责 first-install init） | openDb() 不自带 init → 其它未来入口仍可能漏 | **采纳** |
| B. `openDb()` 内部自动调 `ensureSchema()` | 更 foolproof | 每次 hook 调用都多走一次 migration check（SELECT schema_meta）；hook 预算增加 ~1ms；违反"openDb 只管连接"的单一职责 | 否决 |

#### 6.8 实现

```javascript
// scripts/cli.mjs (v0.5 增量, 2 行)
import { openDb, ensureSchema } from './lib/db.mjs';
// ... 其它 import 不变 ...

export async function run(argv) {
  const cmd = argv[0];
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  // v0.5 A2: CLI 是用户直接入口, 必须处理 fresh DB
  ensureSchema(openDb());

  try {
    switch (cmd) {
      // ... 所有 case 不变 ...
```

**关键约束**：
- `ensureSchema()` 在 `--help` / `-h` 之后：help 不需要 DB，避免 fresh install 看帮助时创建空 DB
- `ensureSchema()` 在 switch 之前：所有命令都受益，不需要逐 case 加
- `ensureSchema()` 调用 `runMigration()`，后者是幂等的（skip files ≤ current version）

### A3 — Cron Config Wire-up（C8）

#### 6.9 问题

`config.default.json` 声明了 cron schedule 旋钮：

```json
"cron": {
  "daily_at": "02:17",
  "weekly_at": "Sun 03:17",
  "dead_letter_alert": 5
}
```

但 `loop.mjs::scheduleCronTasks` **hardcode** 了时间比较：

```javascript
// daily: hardcode 02:17
if (now.getHours() > 2 || (now.getHours() === 2 && now.getMinutes() >= 17))
// weekly: hardcode Sunday 03:17
if (now.getDay() === 0 && (now.getHours() > 3 || (now.getHours() === 3 && now.getMinutes() >= 17)))
```

用户改了 `cron.daily_at` 不生效 → 违反 config 契约。

同文件的 `security_audit` **已经从 config 读**（`sa.schedule_weekday` / `sa.schedule_hour` /
`sa.schedule_minute`），daily/weekly 应跟进同一模式。

#### 6.10 设计决策

| 方案 | 优点 | 劣势 | 结论 |
|---|---|---|---|
| A. 让 daily/weekly 也读 config（与 security_audit 一致） | config 声明的旋钮真正生效；用户可调 cron 时间避开业务高峰；~15 行代码 | 多了解析逻辑（trivial） | **采纳** |
| B. 删除 dead config 字段 | 更简单 | 牺牲可调性；v0.6+ 要再加回来；security_audit 已证明 config-driven 路径可行 | 否决 |

#### 6.11 实现

**新增 helper**（`loop.mjs` 内部，不导出）：

```javascript
// ── v0.5 A3: cron config parsing ──
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseDailyAt(str) {
  const [h, m] = (str || '02:17').split(':').map(Number);
  return { hour: h || 0, minute: m || 0 };
}

function parseWeeklyAt(str) {
  const parts = (str || 'Sun 03:17').trim().split(/\s+/);
  const weekday = WEEKDAYS[(parts[0] || 'sun').slice(0, 3).toLowerCase()] ?? 0;
  const [h, m] = (parts[1] || '03:17').split(':').map(Number);
  return { weekday, hour: h || 0, minute: m || 0 };
}

function isTimeAfter(now, hour, minute) {
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}
```

**更新 `scheduleCronTasks`**：

```javascript
export function scheduleCronTasks(db, now = new Date()) {
  const cronCfg = loadConfig().cron ?? {};

  // daily_maintenance — v0.5: 从 config 读时间（原 hardcode 02:17）
  const daily = parseDailyAt(cronCfg.daily_at);
  if (isTimeAfter(now, daily.hour, daily.minute)) {
    if (tryClaimLease(db, { type: 'daily_maintenance', date_key: dayKey(now), ran_by: RAN_BY.DAEMON })) {
      enqueue(db, 'daily_maintenance');
    }
  }

  // weekly_synthesis — v0.5: 从 config 读时间（原 hardcode Sun 03:17）
  const weekly = parseWeeklyAt(cronCfg.weekly_at);
  if (now.getDay() === weekly.weekday && isTimeAfter(now, weekly.hour, weekly.minute)) {
    if (tryClaimLease(db, { type: 'weekly_synthesis', date_key: weekKey(now), ran_by: RAN_BY.DAEMON })) {
      enqueue(db, 'weekly_synthesis');
    }
  }

  // security_audit — 已从 config 读, 零变化
  const sa = loadConfig().security?.audit;
  if (sa?.enabled
      && now.getDay() === sa.schedule_weekday
      && (now.getHours() > sa.schedule_hour
          || (now.getHours() === sa.schedule_hour && now.getMinutes() >= sa.schedule_minute))) {
    if (tryClaimLease(db, { type: 'security_audit', date_key: weekKey(now), ran_by: RAN_BY.DAEMON })) {
      enqueue(db, 'security_audit');
    }
  }
}
```

**Config 语义**：

| 字段 | 格式 | 默认 | 示例 |
|---|---|---|---|
| `cron.daily_at` | `"HH:MM"` | `"02:17"` | `"04:00"` = 凌晨 4 点 |
| `cron.weekly_at` | `"Day HH:MM"`（Day = Sun/Mon/Tue/Wed/Thu/Fri/Sat，大小写不敏感，前 3 字符匹配） | `"Sun 03:17"` | `"Sat 05:00"` = 周六凌晨 5 点 |
| `cron.dead_letter_alert` | 整数（不变） | `5` | 不变 |

**关键约束**：
- `parseDailyAt` / `parseWeeklyAt` 对无效输入 fallback 到默认值（defensive parsing），不 throw
- `loadConfig()` 已有 4 层合并（default < user < project < env），cron 时间自然可被用户级 config 覆盖
- `security_audit` 代码路径**零改动**——它已经是 config-driven 的，只是 daily/weekly 追上

### A4 — Container/Docker Daemon Fallback

#### 6.12 问题

`linux.mjs::install()` 在 Docker / LXC / WSL1 / 任何无 systemd-user 的环境下失败：
`systemctl --user daemon-reload` → exit 1 `Failed to connect to bus: No such file or directory`。
用户看到 WARNING，Tier 2 完全不可用。

根因：容器环境无 systemd 作为 PID 1，没有 D-Bus user session bus（`/run/user/<UID>/bus` 不存在）。
这不是配置问题——systemd-user 在此类环境下**根本不能工作**。

#### 6.13 设计决策

| 方案 | 优点 | 劣势 | 结论 |
|---|---|---|---|
| A. probe systemd → 失败自动 fallback 到 PID+wrapper | 用户无需手动判断环境；installer 接口不变（6-verb）；与 A1 self-restart 兼容（wrapper loop 捕获 exit(0)） | 多了 ~80 行 container.mjs | **采纳** |
| B. 文档化 "容器内手动跑 main.mjs" | 零代码 | 用户体验差；restart/status/stop 全手动；ccmem admin daemon 命令形同虚设 | 否决 |
| C. 引入 supervisord 依赖 | 成熟方案 | 新依赖，破坏零额外安装承诺；不是所有容器都有 | 否决 |

**核心思路**：`linux.mjs` probe systemd → 不可用时 delegate 到 `container.mjs`。`container.mjs` 用
wrapper shell loop（3 行）+ PID file + nohup 模拟 systemd 的 `Restart=always` 语义。

#### 6.14 Detection（probe systemd-user）

```javascript
// scripts/lib/admin/platform/linux.mjs install() 入口修改
export function install(opts = {}) {
  const spawnSync = opts._spawn ?? nodeSpawnSync;
  // ... detectNodeAbsolute (已有) ...

  // v0.5 A4: probe systemd-user bus 是否可用
  const probe = systemctlUser(spawnSync, ['show-environment']);
  if (probe.status !== 0
      || (probe.stderr || '').includes('Failed to connect to bus')) {
    // systemd-user 不可用 → container fallback
    return containerMod.install(opts);
  }

  // ... 原有 systemd 路径不变 ...
}
```

**为什么 probe `show-environment` 而不是 `--version`**：
- `--version` 只读取二进制版本信息，**不连接 D-Bus**——在 Docker 内仍返回 exit 0（dogfood 实证）
- `show-environment` 需要活跃的 user session bus 连接，无 bus 时立即 exit 1 + "Failed to connect to bus"
- 比 `daemon-reload` 更轻量（只读，不修改状态）
- 避免在 probe 阶段就写 unit 文件（原代码先 writeFileSync 再 daemon-reload）

#### 6.15 `container.mjs`（新增）

```javascript
// scripts/lib/admin/platform/container.mjs
// v0.5 A4: Container/Docker fallback — PID file + wrapper loop.
// 实现 6-verb 接口：install / uninstall / status / start / stop / restart。
//
// 无 systemd 时模拟 Restart=always 语义：
//   wrapper.sh (while loop + sleep 10) → main.mjs
//   PID file → wrapper 进程 PID（status/stop/restart 用）
//
// 与 A1 self-restart 兼容：main.mjs exit(0) 被 wrapper loop 捕获 →
// sleep 10 → 拉新 main.mjs → 新 daemon 读到新 schema 版本。
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import { getDataRoot } from '../../db.mjs';
import { detectNodeAbsolute } from './detect-node.mjs';

const DATA_ROOT = () => getDataRoot();
const PID_FILE = () => path.join(DATA_ROOT(), 'daemon-wrapper.pid');
const WRAPPER_SCRIPT = () => path.join(DATA_ROOT(), 'daemon-wrapper.sh');
const OUT_LOG = () => path.join(DATA_ROOT(), 'daemon.out.log');
const ERR_LOG = () => path.join(DATA_ROOT(), 'daemon.err.log');

function renderWrapper({ NODE_PATH, PLUGIN_ROOT }) {
  return `#!/bin/sh
# ccmem daemon wrapper (container fallback) — auto-generated, do not edit
while true; do
  "${NODE_PATH}" --experimental-sqlite --no-warnings "${PLUGIN_ROOT}/scripts/daemon/main.mjs"
  sleep 10
done
`;
}

export function install(opts = {}) {
  const fs = opts._fs ?? nodeFs;
  const spawnFn = opts._spawn ?? nodeSpawn;
  let node;
  try { node = detectNodeAbsolute(opts); }
  catch { return { ok: false, message: 'Node binary not found.' }; }

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');

  // 写 wrapper script
  const wrapper = renderWrapper({ NODE_PATH: node.fullPath, PLUGIN_ROOT: pluginRoot });
  fs.mkdirSync(DATA_ROOT(), { recursive: true });
  fs.writeFileSync(WRAPPER_SCRIPT(), wrapper, { mode: 0o755 });

  // nohup 启动 wrapper（detach）
  const child = spawnFn('sh', [WRAPPER_SCRIPT()], {
    detached: true,
    stdio: ['ignore',
      fs.openSync(OUT_LOG(), 'a'),
      fs.openSync(ERR_LOG(), 'a')],
  });
  child.unref();

  // 写 PID file（wrapper 进程 PID）
  fs.writeFileSync(PID_FILE(), String(child.pid));

  return { ok: true, variant: 'container-fallback' };
}

export function uninstall(opts = {}) {
  const fs = opts._fs ?? nodeFs;
  stop(opts);
  try { fs.unlinkSync(WRAPPER_SCRIPT()); } catch {}
  try { fs.unlinkSync(PID_FILE()); } catch {}
  return { ok: true };
}

export function status(opts = {}) {
  const fs = opts._fs ?? nodeFs;
  let pid;
  try { pid = parseInt(fs.readFileSync(PID_FILE(), 'utf8').trim(), 10); }
  catch { return { alive: false, source: 'container-fallback' }; }

  // kill -0 检活
  try { process.kill(pid, 0); }
  catch { return { alive: false, source: 'container-fallback', stale_pid: pid }; }

  return { alive: true, pid, source: 'container-fallback' };
}

export function start(opts = {}) {
  // 已跑 → no-op; 未跑 → re-install（wrapper 必须存在）
  const st = status(opts);
  if (st.alive) return { ok: true, message: 'already running' };
  return install(opts);
}

export function stop(opts = {}) {
  const fs = opts._fs ?? nodeFs;
  const st = status(opts);
  if (!st.alive) return { ok: true, message: 'not running' };
  try {
    // SIGTERM wrapper → wrapper 的 shell 会把 signal 传给 node 子进程
    process.kill(st.pid, 'SIGTERM');
    // 等 wrapper 退出（最多 5s）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(st.pid, 0); } catch { break; }
      const spawnSync = opts._spawn ?? nodeSpawnSync;
      spawnSync('sleep', ['0.2']);
    }
  } catch {}
  try { fs.unlinkSync(PID_FILE()); } catch {}
  return { ok: true };
}

export function restart(opts = {}) {
  stop(opts);
  return install(opts);
}
```

#### 6.16 `platform/index.mjs` 变更

```javascript
// scripts/lib/admin/platform/index.mjs (v0.5 增量)
// 不改 installerFor() 的公共接口 —— linux.mjs install() 内部自行 fallback。
// 但 status/start/stop/restart 也需要感知 container fallback。

import * as containerMod from './container.mjs';

// linux.mjs 的 6-verb 导出需要在 status/start/stop/restart 时也 probe:
// 如果 PID file 存在 → 说明是 container 模式安装的 → delegate 到 container.mjs。
// 如果 PID file 不存在 → 走原有 systemd 路径。
//
// 具体实现: linux.mjs 每个 verb 顶部加:
//   if (isContainerInstall()) return containerMod[verb](opts);
```

**判断 "当前是 container 安装" 的方式**：检查 PID file 是否存在（不是 probe systemd——
因为 `status` / `stop` 在 systemd-user 不可用时也会失败）。这避免了每次操作都 probe systemd 的开销。

```javascript
// scripts/lib/admin/platform/linux.mjs 新增 helper
function isContainerInstall() {
  try {
    nodeFs.accessSync(path.join(getDataRoot(), 'daemon-wrapper.pid'));
    return true;
  } catch { return false; }
}

// 各 verb 顶部加判断（status/start/stop/restart/uninstall）
export function status(opts = {}) {
  if (isContainerInstall()) return containerMod.status(opts);
  // ... 原有 systemd 路径 ...
}
```

#### 6.17 `cmdAdminDaemon` output 变更

```javascript
// scripts/lib/admin/daemon.mjs install verb (v0.5 增量)
if (verb === 'install') {
  if (r.ok) {
    const variant = r.variant ? ` (${platform}/${r.variant})` : ` (${platform})`;
    process.stdout.write(`ccmem: daemon installed${variant}\n`);
    // container-fallback 不需要 enable-linger 提示
    if (platform === 'linux' && !r.variant) {
      process.stderr.write(
        `ccmem: to survive logout, run: loginctl enable-linger $USER\n`);
    }
  }
  // ... 失败路径不变 ...
}
```

#### 6.18 命令 prelude 检活重拉

`maybeRunTier15()` 已在每次命令前运行。新增：若 container-fallback 模式下 wrapper 进程不在了，
自动 respawn。

```javascript
// scripts/lib/tier15.mjs (v0.5 增量, 命令 prelude 末尾)
import { installerFor, detectPlatform } from './admin/platform/index.mjs';

function maybeRespawnDaemon() {
  if (process.platform !== 'linux') return; // macOS 由 launchd 管
  try {
    const installer = installerFor(detectPlatform());
    const st = installer.status();
    if (!st.alive && st.source === 'container-fallback' && st.stale_pid) {
      // wrapper 死了但 PID file 残留 → 重拉
      installer.start();
      process.stderr.write('ccmem: daemon respawned (container-fallback auto-recovery)\n');
    }
  } catch { /* non-critical */ }
}
```

#### 6.19 与 A1 self-restart 的交互

| 场景 | 行为 |
|---|---|
| A1 检测 schema mismatch → `process.exit(0)` | wrapper loop 的 `while true` 捕获 → `sleep 10` → 拉新 `main.mjs` |
| 新 `main.mjs` 启动 | `getStartupSchemaVersion()` 读到新 version → 不 mismatch → 正常运行 |
| `ccmem admin daemon restart` | `container.mjs::restart()` = stop(SIGTERM) + install(新 spawn wrapper) |
| Wrapper 自身被 OOM kill | 命令 prelude `maybeRespawnDaemon()` 在下次用户跑命令时检测 + 重拉 |

**A1 self-restart 对容器环境完全兼容**——wrapper loop 扮演了 systemd `Restart=always` 的角色。

---

## 七、命令延伸

v0.5 不新增命令，仅扩展 2 个现有命令的输出：

### 7.1 `/ccmem:admin daemon status` 增量

输出加 1 个字段：

```
$ /ccmem:admin daemon status
{
  "alive": true,
  "pid": 56800,
  "source": "launchd",
  "startup_schema_version": 6,      // ← v0.5 新增
  "uptime_sec": 1234
}
```

数据来源：`startupCtx.startupVersion` 通过 daemon → admin 命令的查询接口暴露。最简方案：daemon
启动时把 `startupVersion` 写到 `config_kv`（key=`daemon_startup_schema_version`），`status` 读。

### 7.2 `/ccmem:admin diagnose --restart-history` 新增 flag

```
$ /ccmem:admin diagnose --restart-history
Daemon self-restart history (last 10)

  2026-06-15 02:18:12  v5 → v6  (uptime 13d 4h)  task: none
  2026-05-29 16:04:11  v1 → v2  (uptime 7d 0h)   task: weekly_synthesis#142 (waited 8.3s)
  ...
```

数据源：`SELECT * FROM audit_log WHERE action='daemon_self_restart' ORDER BY id DESC LIMIT N`。

`--restart-history` 与现有 `--security` / `--tuning` / `--metrics` 平级 flag。无 flag 时不输出
restart history（避免 LLM token 浪费）。

---

## 八、配置（v0.5 增量）

`config.default.json` 升到 `"version": "0.5"`。新增：

```jsonc
{
  "version": "0.5",
  "daemon": {
    // v0.4 已有 platform_install_fallback_node_paths
    "self_restart_on_schema_mismatch": true,   // v0.5 A1 新增, 默认 on
    "self_restart_check_interval_ms": 20000    // v0.5 A1 新增, = heartbeat 间隔
    // 注: 实际心跳间隔仍是硬编码 20_000 (lock.mjs setInterval), 此 config 仅为未来
    //     可调留位; v0.5 实施时不解耦
  },
  "cron": {
    "daily_at": "02:17",       // v0.5 A3: 从 dead config 变为 live config
    "weekly_at": "Sun 03:17",  // v0.5 A3: 同上; scheduleCronTasks 现在读这两个字段
    "dead_letter_alert": 5     // 不变
  }
}
```

**A3 config 语义变更**：v0.4 时 `cron.daily_at` / `cron.weekly_at` 是 dead config（声明存在但
daemon 不读）；v0.5 起 `scheduleCronTasks` 真正解析这两个字段。**默认值不变**（`02:17` /
`Sun 03:17`），用户如未覆盖则行为 = v0.4。

4 层合并（default < user < project < env）沿用 v0.2，项目级仍只认 `project_key` /
`project_key_remote_priority`（B5）。**`daemon.self_restart_on_schema_mismatch` 不接受项目级覆盖**——
避免单项目关全局自重启机制。`cron.daily_at` / `cron.weekly_at` 可被用户级 config 覆盖。

---

## 九、测试策略

| 类别 | 覆盖对象 | 关键断言 |
|---|---|---|
| **Schema migration** | `006_v05.sql` 幂等；v0.4 DB(version=5) 升 6 | schema_meta.version=6；无 DDL 变更；schema_migrations 加 1 行 |
| **Unit: getStartupSchemaVersion** | DB 已 init / DB 损坏返回 0 | 正常返回数字；schema_meta 不存在 fallback 0 |
| **Unit: checkSchemaStaleness** | startup=5 / current=5 → not stale；startup=5 / current=6 → stale；config off → 永远 not stale | gate 工作；正确比对 |
| **Unit: scheduleGracefulRestart** | 无 in-flight → exit(0) called；有 in-flight → pendingRestart=true 不 exit；重复调 → idempotent | audit 写入；exit 用 mock 拦；in_flight 字段正确 |
| **Unit: checkPendingRestart** | pendingRestart=true → 写 audit + exit(0)；pendingRestart=false → no-op | waited_ms 字段正确；just_finished_task 字段正确 |
| **Integration: daemon mid-task mismatch** | 启动 daemon → mock dispatch 跑 weekly_synthesis 10s → 期间 UPDATE schema_meta.version=999 → 等 task 完成 → 验证 exit(0) + audit 行 in_flight 字段 | task 不被中断；audit waited_ms > 8000 |
| **Integration: daemon idle mismatch** | 启动 daemon → 无 task → UPDATE schema_meta → 心跳后 < 25s 内 exit(0) + audit | 立即 restart；audit in_flight 字段 null |
| **Integration: launchd 拉起** | macOS：daemon exit(0) → launchctl list 看 PID 在 ThrottleInterval 后变化 | new PID != old PID；heartbeat 在新 PID 下刷新 |
| **Integration: systemd 拉起** | Linux CI (Layer 2)：daemon exit(0) → systemctl --user is-active 仍 active；新 PID | 同上 |
| **Integration: config off** | `self_restart_on_schema_mismatch=false` → schema 变化也不退 | daemon 仍跑老 PID；audit 不写 daemon_self_restart |
| **Integration: stats 字段** | `/ccmem:admin daemon status` 输出含 startup_schema_version | 字段存在且数字正确 |
| **Integration: diagnose --restart-history** | 注入 3 行 audit → 跑 diagnose → 看输出 | 倒序、字段齐全 |
| **A2 Unit: cli.mjs ensureSchema** | fresh DB（无 schema_meta 表）→ `run(['list'])` 不 crash | 输出空列表或 `(0 memories)`;DB 文件含 memories 表 |
| **A2 Unit: ensureSchema 幂等** | 已有 version=6 DB → cli.mjs ensureSchema → 无 migration 执行 | schema_meta.version 仍为 6；schema_migrations 不增行 |
| **A2 Unit: help 不触发 ensureSchema** | fresh DB → `run(['--help'])` | 不创建 DB 文件（ensureSchema 在 help 分支之后） |
| **A2 Integration: fresh install e2e** | `rm -rf $CCMEM_TEST_DB_DIR && ccmem save "test" --scope global && ccmem list` | save exit 0 + list 显示 1 条 |
| **A3 Unit: parseDailyAt** | `"02:17"` → `{hour:2,minute:17}`；`"04:00"` → `{hour:4,minute:0}`；`null` → `{hour:2,minute:17}`（默认）；`"invalid"` → `{hour:0,minute:0}`（defensive） | 解析正确；无 throw |
| **A3 Unit: parseWeeklyAt** | `"Sun 03:17"` → `{weekday:0,hour:3,minute:17}`；`"Sat 05:00"` → `{weekday:6,hour:5,minute:0}`；`"sat 05:00"` 大小写不敏感 | 解析正确 |
| **A3 Unit: isTimeAfter** | `12:30` after `12:00` → true；`12:00` after `12:00` → true（≥）；`11:59` after `12:00` → false | 边界正确 |
| **A3 Unit: scheduleCronTasks config** | mock `loadConfig()` 返回 `daily_at:"04:00"` → 在 02:17 不 enqueue daily；在 04:00 enqueue | config 生效 |
| **A3 Unit: scheduleCronTasks default** | mock `loadConfig()` 返回 `{}` → 在 02:17 enqueue daily | 默认值 = v0.4 行为 |
| **A3 Integration: weekly config** | mock `weekly_at:"Sat 05:00"` → weekday=6(Sat) hour=5 → Sunday 不触发 | lease 不创建 |
| **A4 Unit: isContainerInstall** | PID file 存在 → true；不存在 → false | 简单 fs.accessSync mock |
| **A4 Unit: renderWrapper** | 输出含 NODE_PATH / PLUGIN_ROOT / while loop / sleep 10 | 正则断言关键字段 |
| **A4 Unit: container install** | mock spawn → 返回 child.pid → PID file 写入正确 | PID file 内容 = mock pid |
| **A4 Unit: container status** | PID file 存在 + kill(0) 成功 → alive; kill(0) ESRCH → not alive + stale_pid | mock process.kill |
| **A4 Unit: container stop** | SIGTERM 发送 + PID file 清理 | mock kill + fs |
| **A4 Unit: container restart** | stop + install 依次调用 | spy 验证顺序 |
| **A4 Integration: linux.mjs probe fallback** | mock `systemctl --user --version` exit 1 + stderr "Failed to connect to bus" → 走 container.mjs::install | 返回 `{ ok: true, variant: 'container-fallback' }` |
| **A4 Integration: linux.mjs probe success** | mock `systemctl --user --version` exit 0 → 走原 systemd 路径 | 返回 `{ ok: true }`（无 variant） |
| **A4 Integration: status/stop/restart dispatch** | PID file 存在 → 各 verb 走 container.mjs；PID file 不存在 → 走 systemd | spy 验证 delegate |
| **A4 Integration: self-restart in container** | wrapper 跑着 → main.mjs exit(0) → wrapper 10s 后拉新进程 → 新 PID ≠ 旧 PID | 超时 15s 检测 |
| **A4 Integration: prelude respawn** | 手动 kill wrapper → `maybeRespawnDaemon()` 检测 stale PID → 重新 spawn | status 从 not alive → alive |
| **回归：v0.4 全套** | 复用 v0.4 测试套不改 | hooks 输出 / Tier 3 / security_audit / revalidation / metrics_rollup 全 PASS |

**强制门禁**：
- A1: Schema migration + self-restart unit + 端到端 mid-task / idle / config off 通过
- A1: macOS + Linux Layer 2 跨平台 daemon 拉起通过
- A2: fresh DB → cli.mjs list/save 不 crash
- A3: scheduleCronTasks 读 config + 默认值向后兼容
- A4: Docker 容器内 `ccmem admin daemon install` 成功 + wrapper loop 自动重拉 + prelude 检活
- v0.4 全量回归 100% 通过

---

## 十、实施顺序（2 周 / M6）

### Week 1 — A1 self-restart 核心 + A2 CLI init

1. `migrations/006_v05.sql`（仅版本推进）+ migration 测试
2. `lib/daemon/self-restart.mjs::getStartupSchemaVersion / checkSchemaStaleness` + unit
3. `scheduleGracefulRestart` + mock exit + unit（含 in-flight / idle / config off / idempotent）
4. `checkPendingRestart` + waited_ms 字段 + unit
5. `daemon/main.mjs` 接入：启动时记 startupCtx，心跳里检测 + dispatch staleness
6. `daemon/loop.mjs::runTask` 接入：task 完成后调 checkPendingRestart
7. Integration: daemon idle mismatch 端到端
8. **A2**: `cli.mjs` 加 `ensureSchema(openDb())` + fresh DB unit + help 不触发 unit + e2e

### Week 2 — A3 cron config + A4 container fallback + 命令 + 跨平台 + 加固

9. **A3**: `parseDailyAt` / `parseWeeklyAt` / `isTimeAfter` helper + unit
10. **A3**: `scheduleCronTasks` 改读 config + unit（config 生效 + 默认值向后兼容）
11. **A3**: Integration: weekly config 变更验证
12. **A4**: `container.mjs` 6-verb 实现（renderWrapper / install / status / stop / restart / uninstall）+ unit
13. **A4**: `linux.mjs` probe systemd fallback + `isContainerInstall` 各 verb dispatch + unit
14. **A4**: `daemon.mjs` output 增 variant 显示 + `tier15.mjs` maybeRespawnDaemon + unit
15. **A4**: Integration: probe fallback 端到端（mock systemctl 失败 → container install 成功）
16. **A4**: Integration: self-restart in container（wrapper loop 捕获 exit(0) → 拉新进程）
17. `config_kv` 写入 `daemon_startup_schema_version` + `/ccmem:admin daemon status` 输出字段
18. `lib/admin/diagnose.mjs` 加 `--restart-history` flag + unit
19. `config.default.json` 升级 0.5 + 加 `daemon.self_restart_*` 字段
20. Integration: daemon mid-task mismatch 端到端（mock dispatch slow task）
21. Integration: macOS launchd 拉起验证（手动 exit + launchctl list）
22. Integration: Linux Layer 2 GitHub Actions VM smoke 测试（systemd 拉起）
23. mode 矩阵：shadow/off 下 self-restart 行为（应仍生效——daemon 与 mode 无关）
24. v0.4 全量回归
25. **M6 验收**（§1.5 完成判据 19 条）

### 依赖关系

```
006 schema (版本推进) → getStartupSchemaVersion → checkSchemaStaleness
                                                       ↓
                          scheduleGracefulRestart ─┬─→ exit(0)
                                                   └─→ pendingRestart flag
                                                       ↓
                          checkPendingRestart (runTask 完成路径) → exit(0)
                                                       ↓
                          launchd / systemd 拉起新进程 → 新 daemon 启动 → 心跳正常
                                                       ↓
                          admin daemon status + diagnose --restart-history

A2 (cli.mjs ensureSchema) — 独立于 A1, 可并行

A3 (cron config wire-up) — 独立于 A1/A2, 可并行;
  parseDailyAt/parseWeeklyAt → scheduleCronTasks 改读 config → integration test

A4 (container fallback) — 独立于 A2/A3, 依赖 A1 (self-restart 需与 wrapper loop 交互验证):
  container.mjs 6-verb → linux.mjs probe + dispatch → daemon.mjs output
                                                      → tier15.mjs maybeRespawnDaemon
                                                      → integration: wrapper loop + self-restart
```

---

## 附录 A：v0.5 不变量 checklist（CI grep）

沿用 v0.4 附录 A 全部 27 条，新增 v0.5 专属：

28. `checkSchemaStaleness` 只在 daemon 进程内调用
    （`grep -rn 'checkSchemaStaleness' scripts/handlers/ scripts/lib/cmd/` 应为空）
29. `process.exit(0)` 在 daemon 内仅由 `self-restart.mjs` 与 SIGTERM handler 调用
    （`grep -rn 'process.exit(0)' scripts/daemon/` 应在 `self-restart.mjs` + `main.mjs` SIGTERM handler，其它位置应为空）
30. `daemon_self_restart` audit action 仅由 `self-restart.mjs` 写入
    （`grep -rn "'daemon_self_restart'" scripts/` 应只在 `self-restart.mjs`）
31. `self-restart.mjs` 不调 LLM / 不 spawn 子进程 / 不持长事务
    （`grep -n 'callClaudeP\|spawn\|BEGIN' scripts/daemon/self-restart.mjs` 应为空）
32. config gate `self_restart_on_schema_mismatch` 至少在 `checkSchemaStaleness` 入口判一次
    （`grep -n 'self_restart_on_schema_mismatch' scripts/daemon/self-restart.mjs` ≥ 1）
33. `cli.mjs` 在 switch 前调 `ensureSchema`（A2）
    （`grep -n 'ensureSchema' scripts/cli.mjs` ≥ 1；且在 `switch (cmd)` 之前）
34. `cli.mjs` 的 `--help` 分支在 `ensureSchema` 之前 early return（不创建 fresh DB）
    （code review 验证：help return 在 ensureSchema 调用行之上）
35. `scheduleCronTasks` 不含 hardcoded 时间数字（A3）
    （`grep -n 'getHours() > 2\|getHours() === 2\|getHours() > 3\|getHours() === 3' scripts/daemon/loop.mjs` 应为空——daily/weekly 改读 config，security_audit 已从 config 读）
36. `parseDailyAt` / `parseWeeklyAt` 对 null / undefined 输入不 throw
    （unit test 覆盖：`parseDailyAt(null)` / `parseWeeklyAt(undefined)` 返回默认值）
37. `container.mjs` 不依赖 systemctl / systemd — 纯 Node.js + shell（A4）
    （`grep -n 'systemctl\|systemd' scripts/lib/admin/platform/container.mjs` 应为空）
38. `linux.mjs` 各 verb（status/start/stop/restart/uninstall）顶部有 `isContainerInstall()` 判断（A4）
    （`grep -cn 'isContainerInstall' scripts/lib/admin/platform/linux.mjs` ≥ 5）
39. PID file 路径固定在 DATA_ROOT / `daemon-wrapper.pid`（A4）
    （`grep -n 'daemon-wrapper.pid' scripts/lib/admin/platform/container.mjs` ≥ 1）
40. wrapper script 含 `sleep 10`（模拟 RestartSec=10 语义）（A4）
    （`grep -n 'sleep 10' scripts/lib/admin/platform/container.mjs` ≥ 1）
41. `maybeRespawnDaemon` 仅在 `process.platform !== 'linux'` 时 early-return（A4）
    — macOS 由 launchd 管，不走此路径

---

## 附录 B：从 v0.4 spec 引用的关键约定速查

| 约定 | 出处 | v0.5 沿用 |
|---|---|---|
| 同步 DatabaseSync API | v0.2 §0.2 | ✓ |
| `await callClaudeP` 不持锁 | v0.2 §7.4 | ✓（v0.5 无新 LLM 任务） |
| LLM 输出走 parseLlmJson + JSON schema | v0.2 §8.5 | ✓（无新 schema） |
| stdout/stderr 都进 LLM 上下文 | v0.1 R-4 / v0.2 §5.0.2 | ✓ |
| writeAudit helper | v0.1 §5.6.2 / v0.4 §6.5 强制统一 | ✓ |
| daemon 防递归 | v0.2 §4.0 / §7.4 | ✓ |
| task_runs lease 防重复 | v0.2 §八 | ✓ |
| Tier 1.5 lazy maintenance | v0.2 §8.4 | ✓（v0.5 不动） |
| daemon-optional 三档定位 | motivation §三 / v0.2 §1.2 | ✓ |
| migration 失败 hard-exit + 自动备份 | v0.2 §3.3 / S-3 | ✓ |
| Tier 3 quarantine 写入闸门 | v0.3 §五 | ✓（v0.5 不动） |
| Tier 1.5 step 8 安全簇兜底 | v0.3 §5.3 | ✓ |
| security_audit cron | v0.3 §6 | ✓ |
| cross_scope_alerts | v0.3 §6.5 | ✓ |
| revalidation_audit | v0.4 §6.1 | ✓（v0.5 不动算法） |
| metrics_daily_rollup | v0.4 §6.4 | ✓ |
| platform 抽象层 | v0.4 §6.6 | ✓（v0.5 加 status 字段不动接口） |

---

## 附录 C：未在 v0.5 实现但已埋设的钩子（for v0.6+）

| 钩子 | 已在 v0.5 准备 | v0.6+ 用途 |
|---|---|---|
| `daemon.self_restart_check_interval_ms` config 项 | ✓（但实际心跳间隔仍硬编码） | v0.6+ 可解耦让心跳间隔独立 |
| `daemon_self_restart` audit 含 `in_flight_task_*` 字段 | ✓ | v0.6+ 可在 diagnose 显示"哪类 task 经常拖延 restart"，反向优化 task 时长 |
| 不在 v0.5 实现的 Tier B 候选项（B1-B5） | 哨兵 / 默认 defer | 命中哨兵后开 sub-spec 决定进 v0.5 patch 还是 v0.6 |
| `cron.daily_at` / `cron.weekly_at` 已 wire-up（A3） | ✓ | v0.6+ 可考虑 `cron.daily_at` 支持多时间点（如 `"02:17,14:00"` 一天两次 daily） |
| `container.mjs` 6-verb 接口与 systemd 平齐（A4） | ✓ | v0.6+ 可考虑 health-check HTTP endpoint（容器编排用）；supervisor 级别的 restart backoff（当前固定 10s） |
| `maybeRespawnDaemon` 命令 prelude 检活（A4） | ✓ | v0.6+ 可考虑 macOS 也走此路径（当 launchd unit 被手动 unload 时自动修复） |

---

## 附录 D：dogfood 记录（待 dogfood 期填）

> 真实使用过程中发现的行为偏差、阈值不合理、误判等记录在这里。dogfood 期结束后用作 v0.6 spec 输入。

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| TBD | (待 dogfood 期填) | | |

---

**End of v0.5 spec.**
