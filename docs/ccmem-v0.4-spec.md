# ccmem v0.4 实施 spec

> 这是 v0.4 的**实施 spec**（"现在要 build 什么"），与 [`ccmem-v0.1-spec.md`](./ccmem-v0.1-spec.md) /
> [`ccmem-v0.2-spec.md`](./ccmem-v0.2-spec.md) / [`ccmem-v0.3-spec.md`](./ccmem-v0.3-spec.md) 平级，
> 共享 [`ccmem-design.md`](./ccmem-design.md) 作为长期设计 SSOT。
>
> **核心目标**：v0.2 让"越用越懂你"动起来（学习闭环 / trust / 反馈）；v0.3 给它装上**安全闭环**
> （Tier 3 quarantine + security_audit + cross_scope_alerts）；v0.4 把它**带到用户的真实机器上**——
> patterns 升级能在已存 mem 上活起来（`revalidation_audit`）、Linux 用户也能跑 daemon（systemd-user
> 全套）、用户能看见系统在做什么并据此调旋钮（metrics_daily_rollup + diagnose --tuning/--metrics）。
>
> **本文档完全自包含**：所有 schema / 伪代码 / 命令格式直接内联，实施时不需要回翻 design.md。
> design.md 引用仅作为决策 rationale 的指针。
>
> **文档约定**：本文档中形如 `{PLUGIN_ROOT}` / `{DATA_ROOT}` / `{NODE_PATH}` 的写法是**模板占位符**，
> install 函数（`renderPlist` / `renderUnit`）字符串替换为绝对路径后落盘。**实际写到磁盘的
> `.plist` / `.service` 文件不含任何 `{...}`**。

> **⚠ 2026-06-02 build-time 修订**（实施时根据现有 v0.3 代码现状对 spec 的 7 处偏差，已落 feat/v0.4 分支）：
> - **§3.1 migration 文件名**：spec 写 `migrations/004_v04.sql`，但 `004_v03.sql` 已在 v0.3 占用
>   （v0.2 含一个 hotfix `003_v02_l4.sql` 把 v0.3 推到了 4）。production `runMigration` 按
>   `fileVersion > currentVersion` 跳过文件，所以 `004_v04` 永远不会被应用。**实际文件名 `005_v04.sql`**，
>   `schema_meta.version` 5。`migration-005.test.mjs` 加了一条 fileVersion 严格递增的回归断言。
> - **§6.5 writeAudit 统一时机**：spec 把 Task 19（writeAudit 统一）放在 Week 3，但 Week 1-2 的 v0.4
>   新代码必须先选一个 API。**实际**：Week 1-2 用了现有的 `logAudit(db, {action, affected_ids, details})`
>   形态（v0.3 主流），Week 3 Task 18 commit `c44d275` 把 7 个 v0.4 新文件批量迁移到 `writeAudit
>   (db, action, mem_id, details)` canonical 签名，logAudit 留作 thin adapter。CI inv #23 grep 已 pin。
> - **§6.5 logAudit 多 ID 路径**：spec 说"writeAudit 取代 logAudit"。实测 v0.2/v0.3 `weekly_synthesis`
>   等用到的多 `affected_ids` 数组路径（一个 audit_log 行包 JSON 数组）必须保留——v0.3 reader 依赖此 shape。
>   **实际**：logAudit 单 ID 路径转发 writeAudit；多 ID 路径独立保留。`audit-unify.test.mjs` round-trip
>   测试 pin 等价性。
> - **§4 / §5 / §6 / §7 测试 DI 接缝命名**：spec 大多没指定测试如何注入依赖。**实际**沿用 v0.3 的
>   underscore-prefix DI 模式（如 `cmdResurrectQuarantined({action})` 已有的 `_action`）扩展出：
>   `_revalidationFn` / `_rollupFn` / `_setInflightLazy` / `_setInflightDaily` / `_spawn` / `_fs` /
>   `_execPath` / `_fallback` / `_platform` / `_installer` / `_db` / `_now` / `_dataRoot`。生产代码默认
>   import 实参，仅测试注入。CI grep 无显式 invariant，但代码 review 应保持 `_` 前缀 = 测试专用 hook。
> - **§6.4 / §7.4 时窗边界半开区间不一致（by design）**：`writeMetricsDailyRollup` 内的 SQL 用
>   `>= dayStartMs AND < dayEndMs`（左闭右开，"这一天 0-24h"语义）；`renderMetricsView`
>   `fetchWindow` 用 `> startMs AND <= endMs`（左开右闭，"过去 N 天 inclusive of right now"语义）。
>   **不是 bug** — 两个函数解决不同问题（按日聚合 vs 按"过去 N 天"渲染），边界各自正确。代码注释已说明，
>   metrics-rollup.mjs / metrics-view.mjs 测试覆盖各自边界。
> - **§6.6.3 daemon.mjs 兼容性 re-export**：现存 `tests/unit/plist-render.test.mjs` 从
>   `scripts/lib/admin/daemon.mjs` import `renderPlist`，而 v0.4 把 renderPlist 实现搬到了
>   `platform/darwin.mjs`。为保持测试不动，`daemon.mjs` 加一行 `export { renderPlist } from './platform/darwin.mjs'`。
>   未来如果想清理，重命名/移动 plist-render 测试即可。
> - **§7.5 stats Tuning hint 命名宽度**：v0.3 已有 `Security :` / `Memories :` / `Trust    :` / `Feedback :`
>   等以 8-char 左对齐冒号开头。v0.4 加 `Tuning   :` 保持 8-char 对齐（3 空格补齐）。如未来引入更长的
>   名字，整体表格需重排。
>
> 详见 commit `cb859a6..7290275`（14 commits）。本文档其它内容仍为权威实施 spec，未来基于 spec 实施
> v0.5 时按上述修订替换原段落。

> **⚠ 2026-06-03 critic 复审修订**（v0.4 ship 前的 critic 子代理审查发现，已在 main 修复）：
> - **§3.2 audit_log.action 枚举缺 5 个 error/uncaught 值**：实施时 §6.3 daily-maintenance step 12/13
>   的 try/catch + §6.2 tier15 step 9 的 try/catch 都会写错误 audit，但 §3.2 enumeration 表只列了
>   "正常路径" 6 个。**新增** 5 个：`revalidation_lazy_error`（tier15 step 9 catch）/
>   `revalidation_daily_error`（daily step 12 catch）/ `revalidation_manual_error`
>   （daemon/tasks/revalidation-audit.mjs catch）/ `metrics_rollup_error`（daily step 13 catch）/
>   `daemon_task_uncaught_error`（daemon/loop.mjs mainLoop 顶层 catch — v0.2 已存在但未在 spec 表里
>   登记）。所有 5 个 details 字段统一：`{ error: String(e?.message).slice(0, 200) }`。
> - **§6.4 writeMetricsDailyRollup 时窗 = YESTERDAY**（S1，commit `5ad5b1d`）：spec 写"今天"，实施
>   后 critic 发现：daily 02:17 UTC 跑时，若 dayKey=today、window=[today_00:00, tomorrow_00:00)，
>   只能捕获 02:17 之前的当天活动（约 2 小时），昨天 21h43m 数据永久丢失（next day 用新 day_key
>   写新行）。**修正**：dayKey 后退 1 天，window=[yesterday_00:00, today_00:00) — 总是一个完整 24h
>   窗口。day_key 字段语义现在 = "被聚合的那一天"。
> - **§6.4 revalidation_audit_run 在 skip 路径也写**（S3，commit `3bda662`）：spec 没明确 skip
>   路径要不要 audit。实施 critic 发现：`lazy_enabled=false` / `daily_enabled=false` 时静默返回
>   `{skipped: ...}`，operator 无法在 audit_log 看到 revalidation 被 config-gated 关闭的诊断痕迹。
>   **修正**：skip 路径写 `revalidation_audit_run` 含 `skipped: 'lazy_disabled' | 'daily_disabled'`
>   + `duration_ms` + `pattern_version`。manual trigger 不受 gate 影响也不需要 skip audit。
> - **§6.1 revalidationAuditCore 单事务包 candidates 循环**（S4，commit `f95cbde`）：spec 没说事务
>   包裹。实施 critic 发现：batch_size=100 时 ~400 自动提交 INSERT/UPDATE，每个独立 fsync WAL，
>   v0.3→v0.4 升级日 100 mems 重 stamp 场景下风险 < 100ms 预算超标。**修正**：candidates 循环包
>   `BEGIN`/`COMMIT`，throw 时 `ROLLBACK` 整批（部分 stamp 会让 fast-skip 错过 retry，必须全部回滚）。
>   final `revalidation_audit_run` 在 COMMIT 之后；throw 路径不写 final（由 caller 的 error-audit
>   覆盖）。匹配 Tier 1.5 现有的 BEGIN/COMMIT 模式。
> - **§7.4 renderMetricsView "Memory pool" 标签含 day_key**（S6，commit `1acf2f2`）：spec 说
>   "Memory pool (end of day)"。critic 发现：daemon 宕机数天时，"end of day" 标签错觉式新鲜，用户
>   看到"quarantine: 8"以为是今天的数 实际可能是上周的。**修正**：标签改为 "Memory pool (end of
>   <last.day_key>)"，daemon gap 一眼可见。
> - **§7.3 / §7.4 diagnose --tuning + --metrics 加 maybeRunTier15 prelude**（M1，commit `dc0d015`）：
>   spec §7.7 prelude 表列了 list / show / stats / save / resurrect 但漏了 diagnose 命令。**修正**：
>   --tuning + --metrics 入口加 `try { maybeRunTier15(db); } catch { /* best-effort */ }`，与
>   spec §7.7 prelude convention 一致。
> - **§6.4 recordMetric `ts` 字段不可被 caller override**（S7，commit `5bd28b4`）：spec 里
>   `JSON.stringify({ts: Date.now(), ...data})` 让 caller 可以静默覆盖 `ts`。当前 caller 都不会，
>   但 aggregateHookLatencies 的 day-window 过滤完全信任 `ts`，一个错误值会把行放进错误的天。
>   **修正**：swap 顺序为 `{...data, ts: Date.now()}`，Date.now() 永远胜出。
> - **§7.3 tuning rule 5 把 user_action='quarantine' 计入 forget bucket**（S2，commit `43fd395`）：
>   spec rule 5 只算 'keep' 和 'forget'。实施 critic 发现：`/ccmem:resurrect --revalidation` 的 'q'
>   分支（quarantine）是比 forget 更强的 disagreement 信号，但被规则完全忽略。5 quarantines 单独
>   出现读作"insufficient data" → trust_threshold 在最该降的场景反而不动。**修正**：SQL `IN
>   ('forget', 'quarantine')` 把 quarantine 折进 forget bucket。两者方向相同，quarantine 只是更猛。
>
> critic 复审 verdict：0 critical, 7 significant, 6 minor。已 fix：S1-S4 + S6 + S7 + M1 + M2。
> 未 fix（defer 到 v0.5+）：
> - **S5 audit_log.ts 秒精度** — 实测下用户感知不到 intra-second race；v0.5 ts→ms 迁移时一起处理。
> - **M3** tier15.mjs 注释步骤号 6→8 跳号（无 step 7）。纯 cosmetic，生产代码对齐。
> - **M4** linux.mjs systemd 单元没显式 `RestartLimitBurst` / `StartLimitIntervalSec`。默认 5/10s
>   够用，未来 dogfood 撞到再加。
> - **M5** `trendArrow` 第二分支 NaN 传播 edge（已被 `>= 0.20` 守住，无害）。
> - **M6** darwin plist `<string>--experimental-sqlite</string><string>--no-warnings</string>` 同行
>   显示稍 misleading（launchd 解析无误）。
>
> 详见 commit `5bd28b4..43fd395`（8 commits）。

> **⚠ 2026-06-03 dogfood Day 1 修订**（v0.4 ship 后首日 dogfood 发现，详见 [`ccmem-v0.4-dogfood.md`](./ccmem-v0.4-dogfood.md) §九）：
> - **V18 cli.mjs wiring 漏**：`scripts/cli.mjs` dispatcher 只 wire 了 `--quarantined` / `--alerts` 分支，
>   缺 `--revalidation` → 落到 default `cmdResurrect`（grey-zone），输出错误文案 `no grey-zone memories`。
>   spec §7.1 命令矩阵和 §7.2 实现都完整，但 cli.mjs wiring 漏了。**已修复** commit `473ba4a`（+2 routing test，716/716 pass）。
> - **§八 config `cron.daily_at` / `cron.weekly_at` dead config**：spec §八 声明 `"daily_at": "02:17"` / `"weekly_at": "Sun 03:17"`，
>   但 `daemon/loop.mjs::scheduleCronTasks` hardcode `hours > 2 || (hours === 2 && minutes >= 17)`，不读 config。
>   用户改 config 不生效。v0.5 决策：读 config 还是删 dead config 字段。
> - **cli.mjs 0 处 ensureSchema**：所有 `openDb()` case 靠"production DB 已 init"；fresh DB 首次跑撞
>   `no such table: memories`。V18 修复过程中发现。v0.5 候选。

---

## 〇、与 v0.3 的关系与关键约定

### 0.1 v0.3 已实现的基线（不重复）

v0.3 已 ship 以下能力，v0.4 在其上叠加，**不重写**：

- Tier 3 quarantine 写入闸门（中间分数 + 非 user_explicit → quarantine）
- Tier 1.5 安全簇兜底（同 source 同日 ≥5 + trust<0.2 → 整簇 quarantine）
- `security_audit` weekly cron（错峰 03:47，三池启发式预筛 + LLM 复核）
- `cross_scope_alerts` 表（L-2 跨 scope 投毒告警，user-ack 模型）
- Quarantine 30d sunset → archived → 14d 后硬删
- 命令：`/ccmem:list --quarantined` / `/ccmem:resurrect --quarantined` / `--alerts` / `/ccmem:stats` Security 行 / `/ccmem:admin diagnose --security`
- `memories.last_scanned_patterns_version` 列由 security_audit 写入（v0.4 直接消费）

### 0.2 关键实现约定（沿用 v0.2 / v0.3）⚠ 重要

| 约定 | 说明 |
|---|---|
| **同步 DatabaseSync API** | 所有 SQL 用 `db.prepare(sql).run/get/all(...)`，不用 async `await db.run/get/all` |
| **`await callClaudeP` 不持锁** | 上下 5 行内不得持有 SQLite 事务。CI grep 检查。v0.4 `revalidation_audit` 不调 LLM，此约束本节零新增风险 |
| **daemon spawn `claude`** | 必带 env `CCMEM_INTERNAL: '1'` + session 黑名单防递归 |
| **LLM 输出走 `parseLlmJson` + JSON schema** | v0.4 不引入新 LLM 任务，约定无变化 |
| **stdout/stderr 都进 LLM 上下文** | 元数据走 `audit_log`，stderr ≤ 2 行 LLM-safe 指针。R-4 |
| **命令 prelude 调 `maybeRunTier15`** | list/show/stats/save/resurrect 等。v0.4 的 `--revalidation` / `--tuning` / `--metrics` 命令同样调 |
| **writeAudit 唯一签名（v0.4 强制）** | `writeAudit(db, action, mem_id, details)`，详见 §6.5。v0.4 新代码 100% 用 `writeAudit`，老 `logAudit` 保留 thin adapter 兼容 v0.2/v0.3 调用点 |
| **`{XXX}` 是模板占位符** | install 时由 `renderPlist` / `renderUnit` 替换为绝对路径。落盘的 `.plist` / `.service` 不含 `{...}` |

### 0.3 版本号

- `config.default.json` 的 `version` 从 `"0.3"` 升到 `"0.4"`
- schema `schema_meta.version` 从 `3` 升到 `4`（migration `004_v04.sql`）
- `config.default.json::security.scan_patterns_version` 从 `"2026.06"` bump 到 `"2026.07"`
  （让 v0.3 → v0.4 升级时全员触发一次 revalidation，验收 happy path）

### 0.4 v0.4 哪些**不变**

| 模块 | 变更 |
|---|---|
| Hook 行为（SessionStart / UserPromptSubmit / Stop） | **零变化**（§4 回归断言） |
| 写入闸门 Tier 1 / Tier 2 / Tier 2.5 / Tier 3 | **零变化**（§5） |
| Trust 系数 / 优先级公式 | 零变化 |
| L1/L2/L2.5/L4 反馈推断 | 零变化 |
| summarize_pending / weekly_synthesis / security_audit | 零变化 |
| daily_maintenance | **微增**（末尾追加 step 12 revalidation + step 13 rollup + step 14 90d 清理） |
| Tier 1.5 lazy maintenance | **微增**（末尾追加 step 9 revalidation lazy 路径） |
| `cross_scope_alerts` / `memories.quarantined_at` | 零变化 |

---

## 一、范围与时间预算

### 1.1 v0.4 做什么（M5，约 3 周）

| 能力 | 子项 |
|---|---|
| **A. `revalidation_audit`**<br>（纯 SQL，Tier 1.5 lazy + daily 双保险） | (1) `last_scanned_patterns_version != current` 检测；(2) Tier1 / secret / Tier2 重扫；(3) 不对称处置：低 trust + 非 pinned → 自动 quarantine，高 trust/pinned → audit_log flag；(4) `/ccmem:resurrect --revalidation` 复核分支（k/f/q/s） |
| **B. 可观测性收敛（B-medium）** | (1) `metrics_daily_rollup` 表（daily 写入，90d 保留）；(2) `/ccmem:admin diagnose --tuning`（基于过去 30d 数据，对 5 个旋钮给出"现状 + 建议"）；(3) `--metrics [--days N]`（hook 延迟 / LLM 调用 / pool flow 聚合）；(4) 3 个边角修：LLM batch dead-letter 检测、`writeAudit`/`logAudit` 统一、Tier 1.5 与 daily lease 内存级 inflight 防护 |
| **C. Linux systemd-user 全套** | (1) platform 抽象层 `lib/admin/platform/`（detectPlatform + installerFor）；(2) `darwin.mjs` 从 v0.2 §7.6 重构搬迁；(3) `linux.mjs` 新增（systemd-user unit 模板 + install/uninstall/status/start/stop/restart）；(4) 共享 Node 路径探测 helper（消化 dogfood §六.1.3 launchd PATH 教训） |

### 1.2 v0.4 不做什么（明确推迟）

| 功能 | 推迟到 | 理由 |
|---|---|---|
| 语义矛盾检测（跨记忆 LLM 比对） | v0.5+ | LLM 用量大；与 embedding gate 一起评估更经济 |
| `monthly_meta_synthesis`（W-4） | v0.5+ | consolidated 池在自用阶段没膨胀到需要月度元整合 |
| L1 中文正向关键词 | v0.5+ | "对/嗯/好"歧义未解；v0.4 正反馈仍靠 L2.5 + L4 |
| `project_key_alias` 漂移检测 | v0.5+ | 非核心闭环 |
| `/ccmem:admin import/export/migrate` | v0.5+ | sqlite3 CLI 替代已够 |
| Windows scheduled task | v0.5+ | 无 dogfood 设备；platform layer 已留 `'unsupported'` 出口 |
| 自动 nudge thresholds（B-wide 路径） | 永不/v0.6+ | turf war 与用户 config，错得难查 |
| revalidation 内的 LLM borderline 复核 | v0.5+ | v0.4 纯 SQL；patterns 真的复杂到需 LLM 时再开 |
| revalidation_audit 写新表 | 永不 | 复用 audit_log，避免表膨胀 |
| metrics_rollup 自动写入 metrics.jsonl | 永不 | metrics.jsonl 仍 append-only 不变；rollup 是消费层 |

### 1.3 完成判据（M5）

1. `revalidation_audit` 在 Tier 1.5 lazy + daily 两条路径都触发；`last_scanned_patterns_version != current` mismatch 检测的 SELECT < 5ms（1000 mem 下）；fast-skip 路径 audit 写 `fast_skip:true`
2. 不对称处置 + `--revalidation` resurrect 流走通：低 trust 非 pinned → 自动 quarantine；pinned/high-trust → flag；resurrect 的 k/f/q/s 四分支全测
3. `metrics_daily_rollup` daily 写入；表 90d 自动清理；同日多次写覆盖（INSERT OR REPLACE）
4. `/ccmem:admin diagnose --tuning` 输出至少 3 类建议（cluster_size / dedup_window / sunset）；< 7d 数据返回 `insufficient data`
5. Linux daemon 三层测试通过：(L1) renderUnit snapshot + spawnSync mock 单测 100% 通过；(L2) GitHub Actions `ubuntu-latest` VM 上 `loginctl enable-linger` + `systemctl --user enable --now` smoke 测试一次成功；(L3) 发版前 Arch + Fedora 手动 checklist 记录。Linux + macOS `/ccmem:admin daemon status` 返回结构一致
6. 三档 daemon-optional 状态在 Linux 上 `/ccmem:stats` 显示正确
7. v0.3 测试套全量回归 100% 通过

---

## 二、架构（v0.4 增量）

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Claude Code 会话                               │
├──────────────────────────────────────────────────────────────────────┤
│  hooks (SessionStart / UserPromptSubmit / Stop) — v0.4 零变化         │
├──────────────────────────────────────────────────────────────────────┤
│  写入闸门 (insertMemory) — v0.4 零变化                                 │
│    Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine               │
├──────────────────────────────────────────────────────────────────────┤
│  Tier 1.5 lazy maintenance (v0.4 增量末尾 step 9)                     │
│    现有 steps 1-8 (trust/灰区/14d 硬删/recent_inj/task_runs/cache/    │
│       inject_regen/安全簇兜底)                                         │
│    + step 9: revalidationAuditCore({trigger:'lazy'}) — 纯 SQL,无 LLM  │
│              内含 fast-skip:1 行 SELECT 检测无 work 即 exit            │
│    + 内存级 inflight 防护(同进程并发不重入,跨进程靠 lease)            │
├──────────────────────────────────────────────────────────────────────┤
│  Daemon (修订 cron + 新增调用)                                          │
│   ├ summarize_pending      (v0.2)                                     │
│   ├ daily_maintenance      (v0.3,v0.4 末尾追加:                       │
│   │                          step 12 revalidationAuditCore(daily)    │
│   │                          step 13 writeMetricsDailyRollup         │
│   │                          step 14 rollup 90d 清理                  │
│   │                          + 内存级 inflight 防护)                   │
│   ├ weekly_synthesis 03:17 (v0.2)                                    │
│   ├ security_audit  03:47  (v0.3)                                    │
│   └ revalidation_audit     (v0.4,无独立 schedule;                     │
│                              manual: /ccmem:admin cron run            │
│                              其它由 Tier 1.5 / daily 触发)             │
├──────────────────────────────────────────────────────────────────────┤
│  Platform layer (v0.4 新增 lib/admin/platform/)                       │
│   index.mjs       detectPlatform() → 'darwin'|'linux'|'unsupported'  │
│                   installerFor(platform) → { install, uninstall,     │
│                                              status, start, stop,    │
│                                              restart }                │
│   detect-node.mjs detectNodeAbsolute() — 三档探测:                    │
│                     process.execPath > which node > fallback paths    │
│   darwin.mjs      launchd plist (从 v0.2 §7.6 搬迁,+ 绝对 Node 路径)  │
│   linux.mjs       systemd-user unit (v0.4 新增)                       │
├──────────────────────────────────────────────────────────────────────┤
│  SQLite                                                               │
│   memories (v0.4 零字段变更; last_scanned_patterns_version 已 v0.3 写)│
│   metrics_daily_rollup       ← 新表 (B-medium)                        │
│   audit_log (action 新增 6 个: §3.2)                                   │
│   (其它 v0.3 表无变化; cross_scope_alerts 不动)                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 新增 / 修改模块清单

```
scripts/
├── daemon/
│   └── tasks/
│       ├── daily-maintenance.mjs       # 【改】末尾追加 steps 12-13
│       └── revalidation-audit.mjs      # 【新增】manual 触发的 daemon 任务 wrapper
├── lib/
│   ├── revalidation.mjs            # 【新增】revalidationAuditCore 核心
│   ├── metrics.mjs                 # 【微改】recordMetric 加 ts: Date.now() 字段
│   │                                #         (aggregateHookLatencies 按日窗过滤的前置条件)
│   ├── metrics-rollup.mjs          # 【新增】writeMetricsDailyRollup +
│   │                                #          detectLLMDeadLetters + 内部 90d cleanup
│   ├── tier15.mjs                  # 【改】末尾追加 step 9 +
│   │                                #        内存级 inflight 防护
│   ├── audit.mjs                   # 【改】统一 writeAudit;
│   │                                #        logAudit 转 adapter
│   ├── cmd/
│   │   ├── resurrect.mjs           # 【改】+ --revalidation 分支
│   │   └── stats.mjs               # 【改】+ Tuning hint 行(按需)
│   └── admin/
│       ├── daemon.mjs              # 【改】dispatch 到 platform 实现
│       ├── cron.mjs                # 【改】白名单加 'revalidation_audit'
│       ├── diagnose.mjs            # 【改】+ --tuning + --metrics
│       └── platform/
│           ├── index.mjs           # 【新增】detectPlatform + installerFor
│           ├── detect-node.mjs     # 【新增】Node 路径探测 helper
│           ├── darwin.mjs          # 【重构】v0.2 §7.6 搬迁 + Node 探测
│           └── linux.mjs           # 【新增】systemd-user unit + 全套动词
└── migrations/
    └── 004_v04.sql                 # 【新增】v0.4 schema
```

---

## 三、Schema 迁移（v0.3 → v0.4）

### 3.1 迁移文件 `migrations/004_v04.sql`

v0.2 已实现 `ensureSchema → runMigration` 始终调用 + 失败 hard-exit + 自动备份。v0.4 只需新增
004 文件，daemon / hook / 命令首次运行时自动应用。

```sql
-- ============================================================
-- migrations/004_v04.sql — v0.4 schema (metrics rollup)
-- ============================================================

-- ---- 1. metrics_daily_rollup (B-medium) ----
-- 每日 daily_maintenance 调一次, 聚合 metrics.jsonl 当日数据 + audit_log 当日聚合;
-- 90d 保留, daily_maintenance 顺手清。
-- day_key 单 row, PRIMARY KEY 防重复; 同日多次写走 INSERT OR REPLACE。
CREATE TABLE metrics_daily_rollup (
  day_key                  TEXT PRIMARY KEY,        -- 'YYYY-MM-DD'
  -- hook 延迟 (ms, 聚合自 metrics.jsonl 当日行)
  hook_session_start_p50   REAL,
  hook_session_start_p95   REAL,
  hook_prompt_submit_p50   REAL,
  hook_prompt_submit_p95   REAL,
  hook_stop_p50            REAL,
  hook_stop_p95            REAL,
  -- LLM 调用 (聚合自 audit_log + tasks)
  llm_calls                INTEGER NOT NULL DEFAULT 0,
  llm_total_duration_ms    INTEGER NOT NULL DEFAULT 0,
  llm_failures             INTEGER NOT NULL DEFAULT 0,
  llm_dead_letters         INTEGER NOT NULL DEFAULT 0,
  -- security_audit 当日产出
  sec_quarantined          INTEGER NOT NULL DEFAULT 0,
  sec_alerts_emitted       INTEGER NOT NULL DEFAULT 0,
  -- revalidation 当日产出 (v0.4 新增)
  reval_quarantined        INTEGER NOT NULL DEFAULT 0,
  reval_flagged            INTEGER NOT NULL DEFAULT 0,
  reval_scanned            INTEGER NOT NULL DEFAULT 0,
  -- Tier 1.5 当日簇 quarantine
  tier15_clusters          INTEGER NOT NULL DEFAULT 0,
  -- 内存池快照 (day end)
  mems_active              INTEGER NOT NULL DEFAULT 0,
  mems_probation           INTEGER NOT NULL DEFAULT 0,
  mems_quarantine          INTEGER NOT NULL DEFAULT 0,
  mems_archived            INTEGER NOT NULL DEFAULT 0,
  written_at               INTEGER NOT NULL
);
CREATE INDEX idx_rollup_written ON metrics_daily_rollup(written_at);

-- ---- 2. schema 版本推进 ----
UPDATE schema_meta SET version = 4, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (3, 4, 'v0.4: metrics_daily_rollup + revalidation audit actions',
          strftime('%s','now') * 1000, 'ccmem-cli');
```

### 3.2 `audit_log.action` 新增值（无 schema 变更）

`audit_log.action` 是 TEXT 字段无 CHECK 约束，新增 6 个值：

| action | 写入时机 | mem_id | details JSON 关键字段 |
|---|---|---|---|
| `revalidation_audit_run` | `revalidationAuditCore` 每次跑完 | null | `{trigger:'lazy'\|'daily'\|'manual', scanned, quarantined, flagged, duration_ms, pattern_version, fast_skip:bool}` |
| `revalidation_quarantine_in` | 低 trust 非 pinned mem 命中 Tier1/secret/Tier2 自动 quarantine | quarantine 的 mem id | `{trigger_pattern, prev_trust, prev_decay_status, pattern_version}` |
| `revalidation_flagged` | 高 trust / pinned mem 命中但只 flag | flagged 的 mem id | `{trigger_pattern, reason:'pinned'\|'high_trust', prev_trust, pattern_version}` |
| `revalidation_resurrect` | `/ccmem:resurrect --revalidation` 用户决定 | 操作 mem id | `{user_action:'keep'\|'forget'\|'quarantine'}` |
| `metrics_rollup_written` | `daily_maintenance` 写一行 rollup | null | `{day_key}` |
| `tuning_suggestion_emitted` | `--tuning` 输出建议时调（仅记录 emit，不记建议内容） | null | `{suggestion_count, signals_window_days}` |

### 3.3 数据兼容

| 兼容点 | 处理 |
|---|---|
| v0.3 memories `last_scanned_patterns_version` 已写 | 直接消费；首次跑 revalidation 时与新 `scan_patterns_version="2026.07"` 比较，全员触发 |
| v0.3 老 memories `quarantined_at`、`cross_scope_alerts` 等 | 不动 |
| `metrics_daily_rollup` 表空 | `--tuning` 友好降级 `insufficient data (have 0 days, need ≥7)` |
| `audit_log` v0.3 老行 | 新建议算法只读最近 30d，老行不影响 |
| v0.1 / v0.2 / v0.3 升级链 | `runMigration` 按 fileVersion > currentVersion 依次应用 002 → 003 → 004 |

---

## 四、Hooks（v0.4 零变化）

`SessionStart` / `UserPromptSubmit` / `Stop` 实现**不动**。v0.4 测试包**回归断言**：复用 v0.3 测试套
（含黄金集插入 + 三 hook 输出哈希），输出应与 v0.3 一致。

**回归测试关键点**：
- SessionStart 注入文本字符级一致（含 marker `*`/`?`/`★`）
- UserPromptSubmit FTS5 检索结果集 id 列表一致
- Stop hook 入队的 `summarize_pending` task payload 一致
- `recent_injections` 写入字段一致
- 所有 hook 的 `additionalContext` 不出现 `revalidation_*` / `metrics_*` 字符串（v0.4 新代码绝不污染 hook 输出）

---

## 五、写入闸门（v0.4 零变化）

`insertMemory` 的 Tier 1 → Tier 2 → Tier 2.5 dedup → Tier 3 quarantine pipeline **不动**。
revalidation 走**读已存 mem + 重判**的路径，不经过写入闸门，零耦合。

回归测试断言：v0.3 evaluateTier3 真值表 + Tier 2.5 dedup 真值表 + Tier 1 / secret 真值表全套通过。

---

## 六、Daemon Cron 与平台层（v0.4 核心）

### 6.0 命名定位

| 时机 | 形态 | 触发源 | daemon-required? |
|---|---|---|---|
| Tier 3（写入时）| 规则评分 | hook 内 | ❌ |
| Tier 2.5（写入时） | dedup | hook 内 | ❌ |
| Tier 1.5 安全簇兜底 | 启发式聚簇 | 命令 prelude（lazy） | ❌ |
| **revalidation_audit** | **纯 SQL 重扫已存 mem** | **lazy + daily + manual** | **❌（lazy 路径）/ ✅（daily 路径）** |
| security_audit | 启发式预筛 + LLM 复核 | weekly cron | ✅ |
| daily_maintenance | 纯 SQL housekeeping | daily cron | ✅ |
| weekly_synthesis | LLM 整合 | weekly cron | ✅ |

revalidation 是 v0.4 的"半档"任务：lazy 路径 daemon-optional，daily 路径要 daemon 但不算 Tier 2 LLM
（纯 SQL，daemon 死时由 lazy 兜底）。

### 6.1 `revalidationAuditCore`（`lib/revalidation.mjs`）

被 Tier 1.5 + daily_maintenance + manual 三处调用。**纯 SQL + 正则，无 LLM**。

```javascript
// scripts/lib/revalidation.mjs
import { tier1Scan, secretScan, evaluateTier2 } from './threat-scan.mjs';
import { writeAudit } from './audit.mjs';
import { loadConfig } from './config.mjs';

export function revalidationAuditCore(db, { trigger /* 'lazy'|'daily'|'manual' */ }) {
  const t0 = Date.now();
  const cfg = loadConfig().security;
  const SCAN_PV = cfg.scan_patterns_version;
  const reval = cfg.revalidation ?? {};

  // 入口开关
  if (trigger === 'lazy' && reval.lazy_enabled === false) {
    return { skipped: 'lazy_disabled' };
  }
  if (trigger === 'daily' && reval.daily_enabled === false) {
    return { skipped: 'daily_disabled' };
  }

  // ─── Fast path: 一行 SELECT 检测是否有 work ────────────────────
  // 注: 包含 NULL — v0.2 老 mem 可能从未被 security_audit 扫过 stamp 为 NULL,
  //     这些也是 revalidation 的对象。WHERE 必须与下方 candidates SELECT 同义,
  //     否则 fast-skip 会撒谎让老 mem 永远漏扫。
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM memories
    WHERE (last_scanned_patterns_version IS NULL
           OR last_scanned_patterns_version != ?)
      AND decay_status IN ('active','probation')`).get(SCAN_PV);

  if (pending.n === 0) {
    writeAudit(db, 'revalidation_audit_run', null, {
      trigger, scanned: 0, quarantined: 0, flagged: 0,
      duration_ms: Date.now() - t0,
      pattern_version: SCAN_PV,
      fast_skip: true,
    });
    return { scanned: 0, quarantined: 0, flagged: 0, fast_skip: true };
  }

  // ─── 真扫: 批次取 batch_size, 防 lazy 路径长时阻塞命令 prelude ──
  // daemon-optional 兜底: 即使 1000+ pending, lazy 每次最多扫 batch_size,
  //                      多次 lazy + daily 兜底 catch up
  const BATCH = reval.batch_size ?? 100;
  const flagTrustThreshold = reval.flag_trust_threshold ?? 0.6;

  const candidates = db.prepare(`SELECT id, content, type, scope, source,
      trust_score, pinned, decay_status
    FROM memories
    WHERE (last_scanned_patterns_version IS NULL
           OR last_scanned_patterns_version != ?)
      AND decay_status IN ('active','probation')
    ORDER BY trust_score ASC, last_touched_at DESC
    LIMIT ?`).all(SCAN_PV, BATCH);

  const stampStmt = db.prepare(
    `UPDATE memories SET last_scanned_patterns_version=? WHERE id=?`);
  const quarantineStmt = db.prepare(`UPDATE memories
    SET decay_status='quarantine', quarantined_at=?, updated_at=?
    WHERE id=? AND decay_status != 'quarantine'`);

  let quarantined = 0, flagged = 0;

  for (const m of candidates) {
    const t1 = tier1Scan(m.content);
    const secrets = (m.scope === 'global') ? secretScan(m.content) : [];
    const t2 = evaluateTier2(m.content, m.source, m.type);

    const tier1Hit  = t1.matched;
    const secretHit = secrets.length > 0;
    const tier2Hit  = t2.action === 'force_demote';

    if (tier1Hit || secretHit || tier2Hit) {
      const triggerPattern = tier1Hit ? t1.pattern
                           : secretHit ? `secret:${secrets[0]}`
                           : `tier2:${t2.matched}`;

      // 不对称处置: 低 trust 且非 pinned → 自动 quarantine
      const shouldQuarantine = (m.trust_score < flagTrustThreshold)
                            && (m.pinned === 0);
      if (shouldQuarantine) {
        const r = quarantineStmt.run(Date.now(), Date.now(), m.id);
        if (r.changes > 0) {
          writeAudit(db, 'revalidation_quarantine_in', m.id, {
            trigger_pattern: triggerPattern,
            prev_trust: m.trust_score,
            prev_decay_status: m.decay_status,
            pattern_version: SCAN_PV,
          });
          quarantined++;
        }
      } else {
        writeAudit(db, 'revalidation_flagged', m.id, {
          trigger_pattern: triggerPattern,
          reason: m.pinned ? 'pinned' : 'high_trust',
          prev_trust: m.trust_score,
          pattern_version: SCAN_PV,
        });
        flagged++;
      }
    }

    // 总是 stamp, 即便没命中 — 下次同 pattern_version 不再重扫这条
    stampStmt.run(SCAN_PV, m.id);
  }

  writeAudit(db, 'revalidation_audit_run', null, {
    trigger,
    scanned: candidates.length,
    quarantined, flagged,
    duration_ms: Date.now() - t0,
    pattern_version: SCAN_PV,
    fast_skip: false,
  });
  return { scanned: candidates.length, quarantined, flagged };
}
```

**关键设计选择**：

| 决策 | 取值 | 理由 |
|---|---|---|
| 走 SQL 不调 LLM | `tier1Scan` / `secretScan` / `evaluateTier2` | 与 Tier 1 写入闸门 100% 同语义；daemon-optional 必备 |
| Fast path SELECT COUNT(*) | `WHERE last_scanned_patterns_version != ?` | 1000 mem 下 < 5ms；99% 日子直接 fast-skip |
| 批次 100 | `batch_size` config | lazy 路径 < 100ms（含 audit_log INSERT）；用户感知零卡顿 |
| 自动 quarantine 阈值 | `trust < 0.6 AND pinned = 0` | 与 Tier 3 写入闸门 evaluateTier3 行为对称；pinned 是用户显式背书，不该被"无声 hijack" |
| 总是 stamp | 命中与否都更新 `last_scanned_patterns_version` | 避免下次重扫同条；命中再次 audit 反而噪音 |
| 顺序 ORDER BY trust ASC | 低 trust 先扫 | 提高 batch 命中 quarantine 的概率，让用户更快看到回扫效果 |
| 配置 gate 单层 | `lazy_enabled` / `daily_enabled` 只在 `revalidationAuditCore` 入口判 | Fix #9: caller (tier15 / daily / manual) 不再重判；单点决策避免漂移 |

#### 6.1.1 manual 触发的 daemon wrapper（Fix #2）

`/ccmem:admin cron run revalidation_audit` 走 v0.2 §10.6 admin cron run 路径：
INSERT 一条 `tasks(type='revalidation_audit', scheduled_for=0, status='queued')`，
daemon 主循环拾起后调 `dispatch(task)` 路由到对应 runner。v0.4 新增 wrapper：

```javascript
// scripts/daemon/tasks/revalidation-audit.mjs
import { revalidationAuditCore } from '../../lib/revalidation.mjs';
import { writeAudit } from '../../lib/audit.mjs';

/**
 * Daemon 任务 wrapper — 仅被 manual 路径触发(Tier 1.5 / daily 已在
 * tier15.mjs / daily-maintenance.mjs 直接调 revalidationAuditCore)。
 * dispatch 必须为 task.type === 'revalidation_audit' 路由到此函数。
 */
export function runRevalidationAudit(db, _task) {
  try {
    revalidationAuditCore(db, { trigger: 'manual' });
  } catch (e) {
    writeAudit(db, 'revalidation_manual_error', null, {
      error: String(e).slice(0, 200),
    });
    throw e;   // 让 daemon retry / dead-letter 接管 (v0.2 §7.7)
  }
}
```

`daemon/loop.mjs::dispatch` 需追加：

```javascript
case 'revalidation_audit':
  return runRevalidationAudit(db, task);
```

#### 6.1.2 不进 `scheduleCronTasks`（Fix #10）

revalidation_audit **没有独立 cron schedule**。daemon 主循环
`scheduleCronTasks`（v0.2 §8.0 / v0.3 §6.1）只为 `daily_maintenance` /
`weekly_synthesis` / `security_audit` 三种调度，**v0.4 不改它**。所有
revalidation 触发只走三条路径：

| 路径 | 调用点 | trigger 值 |
|---|---|---|
| lazy | `tier15.mjs` step 9（命令 prelude） | `'lazy'` |
| daily | `daily-maintenance.mjs` step 12（daily cron 内） | `'daily'` |
| manual | `admin cron run` → `tasks` → daemon `dispatch` → `runRevalidationAudit` | `'manual'` |

这保证 daemon 启动不会被 v0.4 错误地新增一个 cron 时点。

### 6.2 Tier 1.5 lazy 路径（`lib/tier15.mjs` 末尾 step 9）

```javascript
// scripts/lib/tier15.mjs (v0.4 增量)
import { revalidationAuditCore } from './revalidation.mjs';

let inflightLazy = false;   // 内存级 inflight 防护 (B-medium 边角修 #3)

export function maybeRunTier15(db) {
  if (inflightLazy) return { skipped: 'inflight' };
  inflightLazy = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (!tryClaimLease(db, {
      type: 'tier1_5_maintenance',
      date_key: today,
      ran_by: RAN_BY.OPPORTUNISTIC,
    })) {
      return { skipped: 'lease_taken' };
    }

    // ... v0.3 existing steps 1-8 ...

    // ─── v0.4 step 9: revalidation lazy 路径 ───
    // Fix #9: 不在此重判 lazy_enabled, 单一 gate 在 revalidationAuditCore 内部 —
    //         所有 caller (Tier 1.5 / daily / manual) 自动遵守同一开关语义
    try {
      revalidationAuditCore(db, { trigger: 'lazy' });
    } catch (e) {
      // revalidation 失败不阻塞 Tier 1.5 整体
      writeAudit(db, 'revalidation_lazy_error', null, {
        error: String(e).slice(0, 200),
      });
    }

    markLeaseComplete(db, 'tier1_5_maintenance', today);
    return { ran: true };
  } finally {
    inflightLazy = false;
  }
}
```

**inflight 防护**：dogfood §三发现 daemon 起来时 daily 在跑、用户同一秒命令触发 Tier 1.5，
两者并发写 `audit_log` 在 SQLite WAL 下虽然单 writer 排队 OK，但**同进程内**重入仍可能让用户
感知到双倍延迟。`inflightLazy` 模块级布尔在单进程内防重入；跨进程仍靠 lease（一天一次）。

### 6.3 daily_maintenance 增量（`daemon/tasks/daily-maintenance.mjs`）

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs (v0.4 增量)
import { revalidationAuditCore } from '../../lib/revalidation.mjs';
import { writeMetricsDailyRollup } from '../../lib/metrics-rollup.mjs';

let inflightDaily = false;   // 同 Tier 1.5 模式

export function runDailyMaintenance(db) {
  if (inflightDaily) return;
  inflightDaily = true;
  try {
    // ... v0.2 steps 1-9 (trust archive / 灰区 / 14d 硬删 / blacklist /
    //                     task_runs / recent_inj / inject_cache_regen /
    //                     session_context) ...
    // ... v0.3 steps 10-11 (quarantine sunset / cross_scope_alerts 60d) ...

    // ─── v0.4 增量 ───

    // 12. revalidation daily 兜底
    //     Fix #9: 不在此重判 daily_enabled, 单一 gate 在 revalidationAuditCore 内部
    try {
      revalidationAuditCore(db, { trigger: 'daily' });
    } catch (e) {
      writeAudit(db, 'revalidation_daily_error', null, {
        error: String(e).slice(0, 200),
      });
    }

    // 13. metrics_daily_rollup 写入 (内部含 90d cleanup, Fix #3)
    if (loadConfig().metrics_rollup?.enabled !== false) {
      try {
        writeMetricsDailyRollup(db);
      } catch (e) {
        writeAudit(db, 'metrics_rollup_error', null, {
          error: String(e).slice(0, 200),
        });
      }
    }
    // step 14 已合并入 writeMetricsDailyRollup 末尾
  } finally {
    inflightDaily = false;
  }
}
```

### 6.4 `writeMetricsDailyRollup`（`lib/metrics-rollup.mjs`）

**前置条件**：`lib/metrics.mjs::recordMetric` 必须在写入 metrics.jsonl 行时包含 `ts: Date.now()`
字段。若现行实现未包含（v0.1 §4.1 示例代码未明示），v0.4 必须先打这个补丁——单行改动，
不改 hook 行为，但让 `aggregateHookLatencies` 能按时间窗过滤。CI 测试加断言：每条
metrics.jsonl 行有 `ts` 数值字段。


```javascript
// scripts/lib/metrics-rollup.mjs
import fs from 'node:fs';
import readline from 'node:readline';
import { getDataRoot } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { loadConfig } from './config.mjs';

export function writeMetricsDailyRollup(db) {
  const dayKey = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const dayStartMs = new Date(dayKey + 'T00:00:00Z').getTime();
  const dayEndMs = dayStartMs + 86400000;
  // Fix #1: audit_log.ts 是秒, tasks.* 是毫秒 — 单位不一致是 v0.4 设计前 v0.1
  // 留下的历史 (writeAudit 用 Math.floor(Date.now()/1000))。查询前换算, 不改 writeAudit。
  const dayStartSec = Math.floor(dayStartMs / 1000);
  const dayEndSec   = Math.floor(dayEndMs   / 1000);

  // ─── 1. hook 延迟 (从 metrics.jsonl 当日行) ───
  const hookStats = aggregateHookLatencies(dayStartMs, dayEndMs);
  // hookStats = { session_start: {p50, p95}, prompt_submit: {p50, p95}, stop: {p50, p95} }

  // ─── 2. LLM 调用 (聚合 tasks — finished_at 是毫秒) ───
  const llmCalls = db.prepare(`SELECT COUNT(*) AS n FROM tasks
    WHERE finished_at BETWEEN ? AND ?`).get(dayStartMs, dayEndMs).n;
  const llmDuration = db.prepare(`SELECT COALESCE(SUM(finished_at - started_at), 0) AS d
    FROM tasks WHERE finished_at BETWEEN ? AND ? AND started_at IS NOT NULL`)
    .get(dayStartMs, dayEndMs).d;
  const llmFailures = db.prepare(`SELECT COUNT(*) AS n FROM tasks
    WHERE status='failed' AND finished_at BETWEEN ? AND ?`).get(dayStartMs, dayEndMs).n;
  const llmDeadLetters = detectLLMDeadLetters(db, dayStartMs, dayEndMs);

  // ─── 3. security_audit 当日产出 (audit_log.ts 是秒, 用 dayStart/EndSec) ───
  const secStats = db.prepare(`SELECT
    COALESCE(SUM(CAST(json_extract(details,'$.quarantined') AS INTEGER)), 0) AS q,
    COALESCE(SUM(CAST(json_extract(details,'$.alerts_emitted') AS INTEGER)), 0) AS a
    FROM audit_log WHERE action='security_audit_run' AND ts BETWEEN ? AND ?`)
    .get(dayStartSec, dayEndSec);

  // ─── 4. revalidation 当日产出 (audit_log.ts 是秒) ───
  const revalStats = db.prepare(`SELECT
    COALESCE(SUM(CAST(json_extract(details,'$.quarantined') AS INTEGER)), 0) AS q,
    COALESCE(SUM(CAST(json_extract(details,'$.flagged') AS INTEGER)), 0) AS f,
    COALESCE(SUM(CAST(json_extract(details,'$.scanned') AS INTEGER)), 0) AS s
    FROM audit_log WHERE action='revalidation_audit_run' AND ts BETWEEN ? AND ?`)
    .get(dayStartSec, dayEndSec);

  // ─── 5. Tier 1.5 簇 quarantine (audit_log.ts 是秒) ───
  const tier15Clusters = db.prepare(`SELECT COUNT(*) AS n FROM audit_log
    WHERE action='security_quarantine_in'
      AND json_extract(details,'$.reason')='tier1_5_heuristic_cluster'
      AND ts BETWEEN ? AND ?`).get(dayStartSec, dayEndSec).n;

  // ─── 6. 内存池快照 (day end) ───
  const memPool = db.prepare(`SELECT
    SUM(CASE WHEN decay_status='active' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN decay_status='probation' THEN 1 ELSE 0 END) AS probation,
    SUM(CASE WHEN decay_status='quarantine' THEN 1 ELSE 0 END) AS quarantine,
    SUM(CASE WHEN decay_status='archived' THEN 1 ELSE 0 END) AS archived
    FROM memories`).get();

  // ─── 7. INSERT OR REPLACE (同日多次写覆盖) ───
  db.prepare(`INSERT OR REPLACE INTO metrics_daily_rollup
    (day_key,
     hook_session_start_p50, hook_session_start_p95,
     hook_prompt_submit_p50, hook_prompt_submit_p95,
     hook_stop_p50, hook_stop_p95,
     llm_calls, llm_total_duration_ms, llm_failures, llm_dead_letters,
     sec_quarantined, sec_alerts_emitted,
     reval_quarantined, reval_flagged, reval_scanned,
     tier15_clusters,
     mems_active, mems_probation, mems_quarantine, mems_archived,
     written_at)
    VALUES (?, ?,?, ?,?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(dayKey,
      hookStats.session_start?.p50 ?? null,  hookStats.session_start?.p95 ?? null,
      hookStats.prompt_submit?.p50 ?? null,  hookStats.prompt_submit?.p95 ?? null,
      hookStats.stop?.p50 ?? null,           hookStats.stop?.p95 ?? null,
      llmCalls, llmDuration, llmFailures, llmDeadLetters,
      secStats.q, secStats.a,
      revalStats.q, revalStats.f, revalStats.s,
      tier15Clusters,
      memPool.active ?? 0, memPool.probation ?? 0,
      memPool.quarantine ?? 0, memPool.archived ?? 0,
      Date.now());

  // Fix #3: cleanup 90d 内置 — 维持 'metrics_daily_rollup 仅由本函数写' 不变量,
  //         daily_maintenance step 14 不再独立 DELETE。
  //         daemon 死时 lazy 路径不调本函数 → 自然不清, 可接受 (恢复 daemon 后追上)。
  const retentionDays = loadConfig().metrics_rollup?.retention_days ?? 90;
  db.prepare(`DELETE FROM metrics_daily_rollup
    WHERE day_key < date('now', '-' || ? || ' days')`).run(retentionDays);

  writeAudit(db, 'metrics_rollup_written', null, { day_key: dayKey });
}

function aggregateHookLatencies(startMs, endMs) {
  const path = `${getDataRoot()}/metrics.jsonl`;
  if (!fs.existsSync(path)) return {};
  const buckets = { session_start: [], prompt_submit: [], stop: [] };
  try {
    const lines = fs.readFileSync(path, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.ts !== 'number' || row.ts < startMs || row.ts >= endMs) continue;
      if (!buckets[row.hook] || typeof row.ms_total !== 'number') continue;
      buckets[row.hook].push(row.ms_total);
    }
  } catch { /* metrics.jsonl 损坏不阻塞 rollup */ }
  const out = {};
  for (const [hook, arr] of Object.entries(buckets)) {
    if (arr.length === 0) continue;
    arr.sort((a, b) => a - b);
    out[hook] = {
      p50: arr[Math.floor(arr.length * 0.5)],
      p95: arr[Math.floor(arr.length * 0.95)],
    };
  }
  return out;
}

// LLM dead-letter 检测 (B-medium 边角修 #1)
// 同 type 在 24h 内 attempts ≥ 3 且 status='failed' → 视为 dead-letter
// daemon 主循环 (v0.2 §7.7) 已有 retry 3 次 dead-letter; v0.4 加 audit 聚合 + diagnose 显示
export function detectLLMDeadLetters(db, startMs, endMs) {
  const rows = db.prepare(`SELECT type, COUNT(*) AS n FROM tasks
    WHERE status='failed' AND attempts >= 3
      AND finished_at BETWEEN ? AND ?
    GROUP BY type`).all(startMs, endMs);
  return rows.reduce((sum, r) => sum + r.n, 0);
}
```

### 6.5 `writeAudit` / `logAudit` 统一（B-medium 边角修 #2）

dogfood §三发现两套并存（spec 写 `writeAudit(db, action, mem_id, details)`，实施用了
`logAudit(db, {action, affected_ids, details})`）。v0.4 强制统一：

```javascript
// scripts/lib/audit.mjs (v0.4 修订)

/**
 * v0.1 §5.6.2 唯一签名。v0.4 起新代码 100% 用此 API。
 */
export function writeAudit(db, action, mem_id, details) {
  const ts = Math.floor(Date.now() / 1000);
  const affectedIds = mem_id == null ? null : JSON.stringify([mem_id]);
  const r = db.prepare(`INSERT INTO audit_log (ts, action, affected_ids, details)
    VALUES (?, ?, ?, ?)`).run(ts, action, affectedIds, JSON.stringify(details ?? {}));
  const audit_id = Number(r.lastInsertRowid);
  if (mem_id != null) {
    db.prepare(`INSERT INTO audit_log_targets (audit_id, mem_id) VALUES (?, ?)`)
      .run(audit_id, mem_id);
  }
  return audit_id;
}

/**
 * v0.2 / v0.3 已写代码用的旧形态。v0.4 起仅作 backward-compat adapter,
 * 内部 forward 到 writeAudit。新代码禁止调用（CI grep 检查）。
 */
export function logAudit(db, { action, affected_ids, details }) {
  const memIds = Array.isArray(affected_ids) ? affected_ids : [];
  if (memIds.length === 0) return writeAudit(db, action, null, details);
  // 多 mem 兼容: 逐个 writeAudit (现有代码极少 affected_ids.length > 1)
  let firstId = null;
  for (const id of memIds) {
    const aid = writeAudit(db, action, id, details);
    if (firstId == null) firstId = aid;
  }
  return firstId;
}
```

**CI grep 规则**（附录 A #23）：v0.4 新增文件不允许出现 `logAudit(`。审查时 `git diff` 看新加文件 grep 必须空。

### 6.6 平台抽象层（C 项）

```
scripts/lib/admin/
├── daemon.mjs              # 【改】dispatch 到 platform 实现
└── platform/
    ├── index.mjs           # 【新】detectPlatform + installerFor
    ├── detect-node.mjs     # 【新】Node 路径探测 helper (darwin/linux 共用)
    ├── darwin.mjs          # 【重构】v0.2 §7.6 launchd plist 搬到这
    └── linux.mjs           # 【新】systemd-user unit
```

#### 6.6.1 `lib/admin/platform/index.mjs`

```javascript
// scripts/lib/admin/platform/index.mjs
// 注: ESM 不支持 CommonJS require, 必须用静态 import。darwin / linux 两个模块
// 都会被 import (即便只在一个平台用) — 内部都是纯函数声明 + spawnSync 包装,
// 不在 top-level 执行任何平台特定调用, 跨平台 import 是安全的。
import * as darwinInstaller from './darwin.mjs';
import * as linuxInstaller  from './linux.mjs';

export function detectPlatform() {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'linux':  return 'linux';
    default:       return 'unsupported';   // win32, sunos, aix, freebsd...
  }
}

export function installerFor(platform) {
  switch (platform) {
    case 'darwin': return darwinInstaller;
    case 'linux':  return linuxInstaller;
    default:
      throw new UnsupportedPlatformError(process.platform);
  }
}

export class UnsupportedPlatformError extends Error {
  constructor(platform) {
    super(`ccmem daemon not supported on ${platform}`);
    this.code = 'UNSUPPORTED_PLATFORM';
  }
}
```

每个 installer 模块必须 export 统一接口：

```typescript
{
  install():   { ok: boolean, message?: string },
  uninstall(): { ok: boolean, message?: string },
  status():    { alive: boolean, pid?: number, since?: number, source: 'launchd'|'systemd' },
  start():     { ok: boolean, message?: string },
  stop():      { ok: boolean, message?: string },
  restart():   { ok: boolean, message?: string },
}
```

#### 6.6.2 `lib/admin/platform/detect-node.mjs`（共享 Node 路径探测）

dogfood §六.1.3 launchd PATH 教训：`/usr/bin/env node` 在 nvm / asdf / Volta 环境下找不到 node。
darwin 与 linux 都用绝对路径，install 时探测。
此外 install 不能只固定 node：daemon 还必须继承安装 shell 里解析到的 `claude` 二进制，并在 install 时做能力探测，确认 `claude -p --help` 暴露 `--json-schema`；否则要直接阻止安装，而不是写入一个会在后台静默失败的 daemon 环境。

```javascript
// scripts/lib/admin/platform/detect-node.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig } from '../../config.mjs';

/**
 * 三档探测:
 *   1. process.execPath — 当前 ccmem CLI 的 node, 最可靠
 *   2. which node — PATH 内第一个
 *   3. fallback 路径 (config 可配)
 * 都失败 → throw + 调用方 stderr LLM-safe warning
 */
export function detectNodeAbsolute() {
  // 1. process.execPath (运行 ccmem CLI 用的 node)
  if (process.execPath && fs.existsSync(process.execPath)) {
    return { fullPath: process.execPath, source: 'process.execPath' };
  }

  // 2. which node
  const which = spawnSync('which', ['node'], { encoding: 'utf8' });
  if (which.status === 0) {
    const p = which.stdout.trim();
    if (p && fs.existsSync(p)) {
      return { fullPath: p, source: 'which' };
    }
  }

  // 3. fallback paths (config)
  const cfg = loadConfig();
  const fallbacks = cfg.daemon?.platform_install_fallback_node_paths ?? [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      return { fullPath: p, source: 'fallback' };
    }
  }

  throw new NodeNotFoundError();
}

export class NodeNotFoundError extends Error {
  constructor() {
    super('Node binary not found via process.execPath, which, or fallback paths');
    this.code = 'NODE_NOT_FOUND';
  }
}
```

#### 6.6.3 `lib/admin/platform/darwin.mjs`（重构 v0.2 §7.6）

```javascript
// scripts/lib/admin/platform/darwin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataRoot } from '../../db.mjs';
import { detectNodeAbsolute, NodeNotFoundError } from './detect-node.mjs';

const PLIST_PATH = () => path.join(os.homedir(), 'Library/LaunchAgents/com.ccmem.daemon.plist');
const LABEL = 'com.ccmem.daemon';

function renderPlist({ NODE_PATH, PLUGIN_ROOT, DATA_ROOT }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>--experimental-sqlite</string>
    <string>${PLUGIN_ROOT}/scripts/daemon/main.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${DATA_ROOT}/daemon.err.log</string>
  <key>StandardOutPath</key><string>${DATA_ROOT}/daemon.out.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict></plist>`;
}

export function install() {
  let node;
  try { node = detectNodeAbsolute(); }
  catch (e) {
    return { ok: false, message:
      `Node binary not found. Set daemon.platform_install_fallback_node_paths in config.` };
  }
  const plist = renderPlist({
    NODE_PATH: node.fullPath,
    PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    DATA_ROOT: getDataRoot(),
  });
  fs.writeFileSync(PLIST_PATH(), plist);
  const r = spawnSync('launchctl',
    ['bootstrap', `gui/${process.getuid()}`, PLIST_PATH()],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, message: `launchctl bootstrap exit ${r.status}: ${r.stderr?.slice(0, 200)}` };
  }
  return { ok: true };
}

export function uninstall() {
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
  try { fs.unlinkSync(PLIST_PATH()); } catch {}
  return { ok: true };
}

export function status() {
  const r = spawnSync('launchctl', ['list', LABEL], { encoding: 'utf8' });
  if (r.status !== 0) return { alive: false, source: 'launchd' };
  const m = r.stdout.match(/"PID"\s*=\s*(\d+);/);
  return {
    alive: !!m,
    pid: m ? parseInt(m[1], 10) : undefined,
    source: 'launchd',
  };
}

export function start() {
  const r = spawnSync('launchctl',
    ['kickstart', `gui/${process.getuid()}/${LABEL}`],
    { encoding: 'utf8' });
  return { ok: r.status === 0, message: r.stderr };
}

export function stop() {
  const r = spawnSync('launchctl',
    ['bootout', `gui/${process.getuid()}/${LABEL}`],
    { encoding: 'utf8' });
  return { ok: r.status === 0, message: r.stderr };
}

export function restart() {
  stop();
  return start();
}
```

#### 6.6.4 `lib/admin/platform/linux.mjs`（v0.4 新增）

```javascript
// scripts/lib/admin/platform/linux.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataRoot } from '../../db.mjs';
import { detectNodeAbsolute, NodeNotFoundError } from './detect-node.mjs';

const UNIT_NAME = 'com.ccmem.daemon.service';
const UNIT_PATH = () => path.join(os.homedir(), '.config/systemd/user', UNIT_NAME);

function renderUnit({ NODE_PATH, PLUGIN_ROOT, DATA_ROOT }) {
  return `[Unit]
Description=ccmem daemon
After=default.target

[Service]
Type=simple
ExecStart=${NODE_PATH} --experimental-sqlite ${PLUGIN_ROOT}/scripts/daemon/main.mjs
Restart=always
RestartSec=10
StandardOutput=append:${DATA_ROOT}/daemon.out.log
StandardError=append:${DATA_ROOT}/daemon.err.log
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

function systemctlUser(...args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
}

export function install() {
  let node;
  try { node = detectNodeAbsolute(); }
  catch (e) {
    return { ok: false, message:
      `Node binary not found. Set daemon.platform_install_fallback_node_paths in config.` };
  }
  fs.mkdirSync(path.dirname(UNIT_PATH()), { recursive: true });
  const unit = renderUnit({
    NODE_PATH: node.fullPath,
    PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    DATA_ROOT: getDataRoot(),
  });
  fs.writeFileSync(UNIT_PATH(), unit);

  const reload = systemctlUser('daemon-reload');
  if (reload.status !== 0) {
    return { ok: false, message: `systemctl daemon-reload exit ${reload.status}: ${reload.stderr?.slice(0, 200)}` };
  }
  const enable = systemctlUser('enable', '--now', UNIT_NAME);
  if (enable.status !== 0) {
    return { ok: false, message: `systemctl enable exit ${enable.status}: ${enable.stderr?.slice(0, 200)}` };
  }
  return { ok: true };
}

export function uninstall() {
  systemctlUser('disable', '--now', UNIT_NAME);
  try { fs.unlinkSync(UNIT_PATH()); } catch {}
  systemctlUser('daemon-reload');
  return { ok: true };
}

export function status() {
  const isActive = systemctlUser('is-active', UNIT_NAME);
  const alive = isActive.stdout?.trim() === 'active';
  if (!alive) return { alive: false, source: 'systemd' };

  // 取 PID + 启动时间
  const show = systemctlUser('show', UNIT_NAME, '--property=MainPID,ActiveEnterTimestampMonotonic');
  const pidMatch = show.stdout?.match(/MainPID=(\d+)/);
  return {
    alive: true,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
    source: 'systemd',
  };
}

export function start() {
  const r = systemctlUser('start', UNIT_NAME);
  return { ok: r.status === 0, message: r.stderr };
}

export function stop() {
  const r = systemctlUser('stop', UNIT_NAME);
  return { ok: r.status === 0, message: r.stderr };
}

export function restart() {
  const r = systemctlUser('restart', UNIT_NAME);
  return { ok: r.status === 0, message: r.stderr };
}
```

**用户运行时提示（install 末尾）**：systemd-user 默认在用户**注销时关闭**所有 user
services。如果用户通过 SSH 安装 ccmem 后断开连接，daemon 会跟着挂。`install()`
成功后 stderr 打印一行（LLM-safe）：

```
ccmem: daemon installed. To survive logout, run:
       loginctl enable-linger $USER
```

不替用户自动执行（`enable-linger` 是 system-level 操作，可能需要 sudo / polkit
弹窗，破坏 install 的"零交互"承诺）。文档化即可。同样的提示也写进 README 的
Linux 安装段。CI Layer 2 必须先跑这条命令再做 smoke 测试。

### 6.7 daemon 缺席降级表（v0.4 更新）

| daemon 状态 | revalidation lazy | revalidation daily | metrics_rollup | Tier 1.5 安全簇 | Tier 3 写入 | security_audit |
|---|---|---|---|---|---|---|
| ✅ 跑 | ✓ 命令 prelude 跑 | ✓ daily 跑 | ✓ daily 写入 | ✓ 命令 prelude 跑 | ✓ hook 内 | ✓ 周跑 |
| ❌ 不跑 | ✓ 命令 prelude 跑 | ✗ 跳过；下次 daemon 起来跑 | ✗ 跳过；rollup 表"今天"无行；`--tuning` 仍读历史 | ✓ 命令 prelude 跑 | ✓ hook 内 | ✗ 跳过 |

motivation §六.7 一致：「Tier 1 + Tier 1.5 仍正常工作」——v0.4 把 revalidation 主路径（lazy）
和 metrics rollup 也清楚归入降级矩阵。`/ccmem:stats` 三档显示和 v0.3 一致。

---

## 七、命令延伸

所有命令遵守 v0.1 R-4 原则：**stdout/stderr 都进 LLM 上下文**，元数据走 audit_log，stderr ≤ 2 行
LLM-safe 指针。命令 prelude 调 `maybeRunTier15`（list/show/stats/save/resurrect/diagnose）。

### 7.1 命令矩阵（v0.4 新增 / 扩展）

| Slash | CLI | 实现 | 类型 |
|---|---|---|---|
| `/ccmem:resurrect --revalidation [--limit N]` | 同 | `lib/cmd/resurrect.mjs` 增分支 | 扩展 |
| `/ccmem:admin diagnose --tuning` | 同 | `lib/admin/diagnose.mjs` 增 flag | 扩展 |
| `/ccmem:admin diagnose --metrics [--days N]` | 同 | 同上 | 扩展 |
| `/ccmem:admin cron run revalidation_audit` | 同 | `lib/admin/cron.mjs` 白名单加 | 扩展 |
| `/ccmem:admin daemon <verb>` | 同 | `lib/admin/daemon.mjs` dispatch 到 platform 层 | 重构 |
| `/ccmem:stats` | 同 | `lib/cmd/stats.mjs` 加 Tuning hint | 扩展 |

### 7.2 `/ccmem:resurrect --revalidation`

只显示 `audit_log.action='revalidation_flagged'` 且对应 mem **仍未** quarantine / archive，
且最近 flag 在最近一次用户 resurrect 之后（"keep 后 30d 不再出现" 机制）。

**Fix #4**：`flag_ts > resurrect_ts` 过滤直接放进 SQL `WHERE` —— 避免 JS
侧 LIMIT 失真（fetch N 行后再 filter 可能只剩 < N）。所有筛选在 SQL 一次完成，
`LIMIT ?` 语义准确。

```sql
WITH latest_flag AS (
  SELECT t.mem_id, MAX(a.ts) AS flag_ts
  FROM audit_log a JOIN audit_log_targets t ON t.audit_id=a.id
  WHERE a.action='revalidation_flagged' AND a.ts > ?   -- :cutoff_ts (秒, 30d ago)
  GROUP BY t.mem_id
),
latest_resurrect AS (
  SELECT t.mem_id, MAX(a.ts) AS resurrect_ts
  FROM audit_log a JOIN audit_log_targets t ON t.audit_id=a.id
  WHERE a.action='revalidation_resurrect'
  GROUP BY t.mem_id
)
SELECT m.id, m.type, m.scope, m.content, m.trust_score, m.pinned,
       lf.flag_ts,
       lr.resurrect_ts,
       (SELECT json_extract(a.details, '$.trigger_pattern')
        FROM audit_log a JOIN audit_log_targets t ON t.audit_id=a.id
        WHERE t.mem_id=m.id AND a.action='revalidation_flagged'
        ORDER BY a.ts DESC LIMIT 1) AS trigger_pattern,
       (SELECT json_extract(a.details, '$.reason')
        FROM audit_log a JOIN audit_log_targets t ON t.audit_id=a.id
        WHERE t.mem_id=m.id AND a.action='revalidation_flagged'
        ORDER BY a.ts DESC LIMIT 1) AS flag_reason
FROM memories m
JOIN latest_flag lf ON lf.mem_id = m.id
LEFT JOIN latest_resurrect lr ON lr.mem_id = m.id
WHERE m.decay_status IN ('active','probation')
  AND (m.scope='global' OR m.project_key = ?)
  AND lf.flag_ts > COALESCE(lr.resurrect_ts, 0)        -- "keep 后 30d 不再出现" 核心
ORDER BY m.trust_score ASC
LIMIT ?;
```

参数顺序：`cutoff_ts`（秒，`Math.floor((Date.now()-30*86400_000)/1000)`），`projectKey`，`limit`。

**注**：audit_log.ts 是**秒**（同 Fix #1）；JS 侧调用前把窗口边界换算到秒。返回行数 ≤ limit 是准确的——所有筛选已在 SQL 完成。

交互（stdin 单字符，复用 v0.3 resurrect 模式）：

```
$ /ccmem:resurrect --revalidation
[m42] rule|global trust=0.92 ★pinned
  flagged 3d ago — new tier1 pattern: /ignore previous instructions/i
  flag reason: pinned
  content: 用户偏好简洁直接的回答风格
  [k]eep / [f]orget / [q]uarantine / [s]kip:
```

| 选择 | 行为 |
|---|---|
| `k` keep | `UPDATE memories SET last_touched_at=now WHERE id=?`；audit `revalidation_resurrect` action='keep'。flag 视作已处理（30d 内不再出现） |
| `f` forget | `UPDATE memories SET decay_status='archived' WHERE id=?`；audit action='forget' |
| `q` quarantine | `UPDATE memories SET decay_status='quarantine', quarantined_at=now WHERE id=?`；audit action='quarantine'（用户认可新 patterns，主动隔离） |
| `s` skip | 不动；下次跑 `--revalidation` 仍出现 |

### 7.3 `/ccmem:admin diagnose --tuning`

```javascript
// scripts/lib/admin/diagnose.mjs (--tuning 路径)
export function cmdDiagnoseTuning(db) {
  const cfg = loadConfig();
  const minDays = cfg.metrics_rollup?.min_days_for_tuning ?? 7;
  const days = db.prepare(`SELECT COUNT(*) AS n FROM metrics_daily_rollup`).get().n;
  if (days < minDays) {
    process.stdout.write(`ccmem: insufficient data (have ${days} days, need >=${minDays})\n`);
    return;
  }
  const suggestions = computeTuningSuggestions(db, cfg);
  printTuningTable(suggestions);
  writeAudit(db, 'tuning_suggestion_emitted', null, {
    suggestion_count: suggestions.filter(s => s.action !== 'keep').length,
    signals_window_days: 30,
  });
}
```

5 个旋钮的建议算法（`computeTuningSuggestions`）：

| 旋钮 | 输入信号 (近 30d) | 建议规则 |
|---|---|---|
| `security.audit.pool_b.clusterMinSize` | **Fix #5**: 读 `security_audit_run.details.pool_b` 候选数 N (v0.3 §6.2 已写入) + `audit_log` 中由 pool_b 推到 quarantine 的条数 X (按 audit_log_targets JOIN security_quarantine_in 的 mem_id ∩ pool_b 候选集) | N ≥ 10 且 X/N < `pool_b_zero_quarantine_ratio` 反值 (0.3) → 建议 +2；X/N > 0.7 → -1；N < 10 → "keep" (信号不足) |
| `security.cross_scope.dedup_window_days` | `security_alert_acknowledged` 的 ack 时间分布 p90 | ack 样本 ≥ 5 且 p90 < 当前 window × `dedup_window_p90_ratio`(0.5) → 减半；样本不足 → "keep" |
| `security.quarantine.sunsetDays` | quarantine 平均存活时间 + resurrect rate | quarantine 样本 ≥ 5 且 resurrect rate > `sunset_resurrect_high_rate`(0.5) → 建议 +5；avg 存活 < sunset/2 → 建议 -5；样本不足 → "keep" |
| `security.tier1_5_security.cluster_min_size` | **Fix #5**: 读 `security_quarantine_in` 中 `reason='tier1_5_heuristic_cluster'` 的 `cluster_size` 直方图（不是 pool_b 总数）—— Tier 1.5 没有 pool 概念 | 30d 簇事件 ≥ 5 且 cluster_size p50 ≥ 当前阈值 × 1.5 → 建议 +2 (阈值太松，常态簇都比它大)；p50 < 当前阈值 → -1 (阈值太严，刚刚卡线); 事件 < 5 → "keep" |
| `security.revalidation.flag_trust_threshold` | `revalidation_resurrect` 中 `user_action='forget'` vs `'keep'` 计数 | **Fix #6 ratio 守卫**：keep+forget ≥ 5 (整体样本) 且 keep ≥ 1 才计算 forget/keep；> 2 → -0.1；< 0.5 → +0.1。keep=0 时改用 `(forget - keep) / (forget + keep + 1)` smoothed —— > 0.6 → -0.1，否则 "keep"。样本 < 5 → "keep" |

**通用样本量守卫**：所有规则统一要求 30d 信号 ≥ 5 才出建议，否则 "keep"。原因：少样本下任意比例都不稳定，避免一次性事件触发用户改 config。

输出例：

```
$ /ccmem:admin diagnose --tuning
Tuning suggestions (based on last 30 days, 23 days of data)

  security.audit.pool_b.clusterMinSize      current: 3   suggest: 5
    rationale: 12 audit_runs triggered, 11 returned 0 quarantine
    impact:    expect -8 LLM calls / month, 0 missed quarantine (last 30d)

  security.cross_scope.dedup_window_days    current: 30  suggest: 14
    rationale: 4 alerts acknowledged, all within 7d of detection
    impact:    same alerts surface 2x faster after similar drift

  security.quarantine.sunsetDays            current: 30  suggest: 30 (keep)
    rationale: 2 sunsets observed, both ran without user resurrect
    impact:    healthy default

  security.tier1_5_security.cluster_min_size   current: 5   suggest: 5 (keep)
  security.revalidation.flag_trust_threshold   current: 0.6 suggest: 0.5
    rationale: 3 flag→forget vs 1 flag→keep (ratio 3.0)
    impact:    more high-trust hits auto-quarantine; fewer manual reviews

(use /ccmem:audit show <tuning_suggestion_emitted_id> for full signal breakdown)
```

**只建议不自动改**。用户改 config 后下次 reload 生效。audit `tuning_suggestion_emitted` 仅记
emit 次数 + 信号窗口（不记建议本身，避免 audit_log 噪音）。

### 7.4 `/ccmem:admin diagnose --metrics [--days N]`

读 `metrics_daily_rollup` 最近 N 天（默认 14）+ 计算与"前 N 天"的 trend：

```
$ /ccmem:admin diagnose --metrics --days 7
Metrics (last 7 days)

  Hook latency (ms, p50 / p95)
    SessionStart     12 / 47    (budget: 50/300)  OK
    UserPromptSubmit 38 / 89    (budget: 50/100)  OK
    Stop             52 / 121   (budget: 50/200)  WARN p50
                                                  ↑ trend: +18ms vs prior 7d

  LLM calls
    total:        47        (avg 6.7/day)
    duration:    8.3 min total (avg 10.6s/call)
    failures:     2         (4.3%)
    dead-letters: 0         OK

  Pool flow
    Tier 1.5 clusters quarantined: 4
    security_audit quarantined:    1
    revalidation quarantined:      0   flagged: 2
    cross-scope alerts emitted:    1   acknowledged: 1

  Memory pool (end of day)
    active: 142  probation: 18  quarantine: 8  archived: 31
```

数据均来自 rollup 表，毫秒级查询。`WARN p50` / trend 标记规则：
- budget 见配置（沿用 v0.1 §4.1/§4.2）
- trend `↑/↓` 阈值：p50 ±15%、p95 ±20%

### 7.5 `/ccmem:stats` 增量

仅在 `--tuning` 有 ≥1 条非 "keep" 建议时加一行：

```
Tuning  : 2 suggestions available — run /ccmem:admin diagnose --tuning
```

数据源：`computeTuningSuggestions(db, cfg).filter(s => s.action !== 'keep').length`。
零建议时不打印（省 LLM token，沿用 v0.3 Security 行模式）。

### 7.6 `/ccmem:admin daemon <verb>` 重构

```javascript
// scripts/lib/admin/daemon.mjs (v0.4 重构)
import { installerFor, detectPlatform, UnsupportedPlatformError } from './platform/index.mjs';

const ALLOWED_VERBS = ['install', 'uninstall', 'status', 'start', 'stop', 'restart'];

export function cmdAdminDaemon(verb) {
  if (!ALLOWED_VERBS.includes(verb)) {
    process.stderr.write(`ccmem: unknown daemon verb '${verb}' (allowed: ${ALLOWED_VERBS.join('/')})\n`);
    process.exit(64);
  }
  const platform = detectPlatform();
  if (platform === 'unsupported') {
    process.stderr.write(
      `ccmem: daemon not supported on ${process.platform}\n` +
      `       Tier 1 + Tier 1.5 still work; Tier 2 (summarize / synthesis / L4 / audit) unavailable.\n`
    );
    process.exit(78);
  }
  const installer = installerFor(platform);
  const r = installer[verb]();
  if (verb === 'status') {
    // status 输出固定结构, /ccmem:stats 三档行复用
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (r.ok === false) {
    process.stderr.write(`ccmem: ${verb} failed — ${r.message ?? 'unknown'}\n`);
    process.exit(1);
  }
  process.stdout.write(`ccmem: ${verb} succeeded\n`);
}
```

`/ccmem:stats` 三档 tier 行的 daemon 部分调 `installerFor(detectPlatform()).status()`，
返回 `{ alive, pid, since, source }` 统一字段；不再有 `if (platform === 'darwin') ...` 分支。

### 7.7 命令 prelude 调用

| 命令 | prelude 调用 | 理由 |
|---|---|---|
| `/ccmem:resurrect --revalidation` | `maybeRunTier15(db)` | 列前先跑 lazy revalidation，可能新增 flag/quarantine |
| `/ccmem:admin diagnose --tuning` | `maybeRunTier15(db)` | 看 metrics 前顺手维护一次 |
| `/ccmem:admin diagnose --metrics` | `maybeRunTier15(db)` | 同上 |
| `/ccmem:stats` | `maybeRunTier15(db)`（v0.2 已调） | Tuning hint 需要最新 rollup |

### 7.8 输出契约（R-4 LLM-safe）

- **stdout** 是结果事实，机器格式
- **stderr** ≤ 2 行 LLM-safe 指针，**不写**推断模板、shell 模板、if-then 结构
- **元解释**（如建议算法的完整信号链）走 `audit_log`，用户主动 `ccmem audit show <id>` 查
- resurrect 交互**走 stdin**（k/f/q/s 单字符），不走 AskUserQuestion

---

## 八、配置（v0.4 增量）

`config.default.json` 升到 `"version": "0.4"`。新增 / 修改如下：

```jsonc
{
  "version": "0.4",
  "security": {
    // v0.1/v0.2/v0.3 已有 (不重复)
    "scan_patterns_version": "2026.07",   // v0.4 bump (从 "2026.06")
                                          // 触发 v0.3 → v0.4 升级时全员 revalidation
    "revalidation": {                     // v0.4 新增
      "lazy_enabled": true,
      "daily_enabled": true,
      "batch_size": 100,
      "flag_trust_threshold": 0.6
    }
  },
  "metrics_rollup": {                     // v0.4 新增
    "enabled": true,
    "retention_days": 90,
    "min_days_for_tuning": 7
  },
  "tuning_suggest": {                     // v0.4 新增 — --tuning 算法系数
    "pool_b_zero_quarantine_ratio": 0.7,
    "dedup_window_p90_ratio": 0.5,
    "sunset_resurrect_high_rate": 0.5
  },
  "daemon": {                             // v0.4 新增
    "platform_install_fallback_node_paths": [
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/bin/node"
    ]
  }
}
```

4 层合并（default < user < project < env）沿用 v0.2，项目级仍只认 `project_key` /
`project_key_remote_priority`（B5）。**`security.revalidation.*` 不接受项目级覆盖**——
避免单项目关全局 patterns 回扫。`tuning_suggest.*` 同。

---

## 九、测试策略

| 类别 | 覆盖对象 | 关键断言 |
|---|---|---|
| **Schema migration** | `004_v04.sql` 幂等；v0.3 DB(version=3) 升 4 | `metrics_daily_rollup` + 索引建成；老数据 `last_scanned_patterns_version` 保留；002 / 003 已应用的 DB 跳过 |
| **Unit: revalidationAuditCore** | trigger='lazy'/'daily'/'manual' / 不对称处置 / pinned 路径 / 高 trust 路径 / fast-skip / 批次上限 / 三种 trigger 各走一遍 | 低 trust+非 pinned → quarantine；pinned → flag；high-trust (>=0.6) → flag；fast-skip 写 audit `fast_skip:true`；batch_size 100 截止；stamp 总是发生（命中与否）；`last_scanned_patterns_version IS NULL` 也参与扫描 |
| **Unit: revalidation 配置开关** | `lazy_enabled=false` / `daily_enabled=false` | 各自 trigger 入口直接 return `{skipped: ...}` |
| **Unit: Tier 1.5 step 9 调用** | revalidation lazy 在 step 8 之后跑；inflight 防护 | 同进程重入 return `{skipped:'inflight'}`；revalidation throw 不阻塞 Tier 1.5 整体；audit `revalidation_lazy_error` 写入 |
| **Unit: daily_maintenance v0.4 增量** | step 12 revalidation + step 13 rollup + step 14 清理 90d；inflight | 三步均执行；rollup throw 不阻塞清理 |
| **Unit: writeMetricsDailyRollup** | metrics.jsonl 当日行 p50/p95 计算 / audit_log 聚合 (含 **Fix #1 秒/毫秒换算回归**：注入 audit_log.ts 秒 + tasks.ts 毫秒混合数据,断言两边都被正确分桶) / mems 快照 / 同日多次写覆盖 / **内部 90d cleanup**（Fix #3） | 空 metrics.jsonl 不抛；损坏行 skip；INSERT OR REPLACE 覆盖；字段齐全；DELETE 90d 在同一函数内执行 |
| **Unit: aggregateHookLatencies** | metrics.jsonl 跨日行 / 缺 ms_total 行 / 损坏 JSON 行 / 缺 ts 字段行 | 仅当日窗口；缺 ts 行 skip 不抛；坏行不抛 |
| **Unit: detectLLMDeadLetters** | tasks attempts ≥3 全 fail 在 24h 内 → 计 dead-letter | 跨日不计；attempts<3 不计 |
| **Unit: lib/metrics.mjs ts 字段** | 每次 `recordMetric` 写入的 metrics.jsonl 行 | JSON.parse(行).ts 是数值且与 Date.now() 差 < 1s（Fix #8 前置） |
| **Unit: tuning suggest 5 规则** | 各规则边界 / "keep" 决策 / `insufficient data` 兜底 / **Fix #6 ratio 守卫**：keep=0 走 smoothed 路径 / **Fix #5 pool_b 信号专属**：注入 pool_a quarantine 不污染 pool_b 建议 / **样本量守卫**：每条规则 30d 信号 < 5 时返回 "keep" | < 7d 数据返回 insufficient；逐规则真值表（pool_b、dedup、sunset、tier1.5、reval flag）；smoothed (forget-keep)/(forget+keep+1) > 0.6 触发 -0.1 |
| **Unit: revalidation manual dispatch wrapper**（Fix #2） | `daemon/tasks/revalidation-audit.mjs::runRevalidationAudit` 调 revalidationAuditCore({trigger:'manual'}) | 失败时 audit `revalidation_manual_error` 写入且 throw 让 daemon retry 接管 |
| **Integration: admin cron run revalidation_audit**（Fix #2） | INSERT tasks(type='revalidation_audit') → daemon dispatch 路由 → 跑通 | audit 写入含 `trigger:'manual'`；tasks.status='success' |
| **Unit: resurrect --revalidation SQL CTE**（Fix #4） | latest_flag / latest_resurrect CTE + WHERE flag_ts > COALESCE(resurrect_ts,0) | flag 在 keep 之前的 mem 被 SQL 过滤掉；返回行数 ≤ LIMIT 准确；audit_log.ts 秒/毫秒换算正确 |
| **Unit: detectPlatform / installerFor** | darwin / linux / win32 / sunos | darwin/linux dispatch 正常；win32 → `UnsupportedPlatformError` |
| **Unit: detectNodeAbsolute** | process.execPath / which / fallback 三档；都失败 throw | 探测顺序正确；返回 `source` 字段标识来源 |
| **Unit: renderPlist / renderUnit** | 模板字符串无 `{...}` 残留；NODE_PATH 绝对；空格路径处理 | 落盘文件可被 launchctl/systemctl 解析 |
| **Unit: resurrect --revalidation 行为分支** | k / f / q / s 四分支 audit_log.action='revalidation_resurrect' 写入正确；q 路径走 quarantine | user_action 字段对应；quarantined_at 在 q 时被 set |
| **Unit: writeAudit / logAudit adapter** | 老 logAudit 调用走 adapter；多 affected_ids 走多 writeAudit | adapter 行为与老一致；audit_log_targets 关联正确 |
| **Integration: revalidation 端到端 (lazy)** | bump `scan_patterns_version` → 跑 `/ccmem:list` 触发 lazy → 验 quarantine + flag + stamp 全部生效 | fast-skip 第二次跑；新 pattern 加进 `tier1_patterns_extra` 也能触发 |
| **Integration: revalidation 端到端 (daily)** | daemon 在跑 → 等 02:17 → daily_maintenance 跑 step 12 → 验产出 | metrics_rollup 同时写入；audit `revalidation_audit_run` + `metrics_rollup_written` |
| **Integration: revalidation 端到端 (manual)** | `/ccmem:admin cron run revalidation_audit` → 入队 → daemon 跑 | tasks 表 success；audit `revalidation_audit_run` trigger='manual' |
| **Integration: --tuning 端到端** | 注入 30d 模拟数据 → 跑 `--tuning` → 验 ≥3 类建议 | 输出含 rationale / impact / current / suggest；audit `tuning_suggestion_emitted` |
| **Integration: --metrics 端到端** | 注入 14d rollup 数据 → 跑 `--metrics --days 7` → 验输出 | trend +/− 计算正确；budget WARN 标识 |
| **Linux daemon — Layer 1（unit + spawn 必测）** | renderUnit 输出 snapshot；spawnSync mock 断言 argv 正确（`['systemctl','--user','enable','--now',UNIT_NAME]` 等）；installer.{install,uninstall,status,start,stop,restart} 各动词的错误码处理 | 100% CI 稳定；覆盖 ~95% bug |
| **Linux daemon — Layer 2（systemd 兼容 smoke，必测一次）** | GitHub Actions `ubuntu-latest` **VM**（不是 container）：`loginctl enable-linger $USER` + `export XDG_RUNTIME_DIR=/run/user/$(id -u)` → 跑 install → status → stop → uninstall 一遍 | 每步 exit 0；仅验 "systemd 真的接受我们的 unit 文件" |
| **Linux daemon — Layer 3（发版前手测 checklist）** | Arch Linux + Fedora 40+：install / status / restart / uninstall 各一遍 | 不阻塞 CI；记录在 release notes |
| **Integration: 跨平台 daemon status** | macOS + Linux 调 `/ccmem:admin daemon status` 返回结构一致 | 字段 `alive` / `pid` / `source` 一致 |
| **Mode 矩阵** | shadow/off 下 revalidation + Tier 1.5 step 9 + diagnose --tuning | off → revalidation 不跑（commands prelude skip）；shadow → Tier 1.5 跑但 audit 不写 non-error；diagnose 不受 mode 影响 |
| **平台 fallback** | Windows 上 `/ccmem:admin daemon install` | exit 78 + LLM-safe 消息 + 不写 plist/unit |
| **回归：v0.3 全套** | 复用 v0.3 测试套不改 | v0.4 增量不破坏 v0.3 黄金路径（hooks 输出 / Tier 3 / security_audit / resurrect --quarantined / --alerts / stats Security 行） |

**强制门禁**：
- schema migration + revalidation unit + Tier 1.5 step 9 unit 通过
- Linux daemon integration（CI Linux container 跑）通过
- `--tuning` insufficient data 兜底通过
- v0.3 全量回归 100% 通过
- 防递归 e2e 通过（platform refactor 不破坏 CCMEM_INTERNAL 注入）

---

## 十、实施顺序（3 周 / M5）

### Week 1 — schema + revalidation 核心

1. `migrations/004_v04.sql`（runMigration 复用 v0.3 §3.3 自动备份/hard-exit）
2. Schema migration 测试（v0.3 → v0.4 升级 + 幂等 + 全员 stamp 触发验证）
3. `lib/metrics.mjs::recordMetric` 加 `ts: Date.now()` 字段（**Fix #8 前置**，写完 step 12 才能按时间窗聚合）+ 单测断言每行有 `ts`
4. `lib/revalidation.mjs::revalidationAuditCore`（核心算法）+ unit（含 fast-path NULL 包含、单层 gate）
5. `lib/tier15.mjs` 加 step 9（lazy 路径）+ inflight 防护 + unit（不重判 lazy_enabled，依赖 core）
6. `lib/cmd/resurrect.mjs` 加 `--revalidation` 分支（k/f/q/s）+ SQL CTE 测试（Fix #4: WHERE 内含 flag_ts > resurrect_ts）+ unit
7. `daemon/tasks/revalidation-audit.mjs` wrapper + `daemon/loop.mjs::dispatch` 加 `revalidation_audit` case（**Fix #2**）+ unit
8. `lib/admin/cron.mjs` 白名单加 `revalidation_audit` + manual 路径 e2e（INSERT task → daemon dispatch → revalidationAuditCore({trigger:'manual'}) → audit row 有 `trigger:'manual'`）

### Week 2 — 平台层 + metrics rollup

9. `lib/admin/platform/index.mjs`（detectPlatform / installerFor）+ unit
10. `lib/admin/platform/detect-node.mjs`（共享 Node 路径探测）+ unit
11. `lib/admin/platform/darwin.mjs`（从 v0.2 §7.6 搬迁 + Node 路径探测 + renderPlist 占位符化）+ 回归测试
12. `lib/admin/platform/linux.mjs`（systemd-user unit + renderUnit + 全套动词）
    + Layer 1 测试（renderUnit snapshot + spawnSync mock）
13. Linux daemon Layer 2 smoke：GitHub Actions `ubuntu-latest` **VM**
    workflow（含 `loginctl enable-linger $USER` + `XDG_RUNTIME_DIR` 注入）
    跑 install→status→stop→uninstall 一遍
14. `lib/metrics-rollup.mjs::writeMetricsDailyRollup` + `aggregateHookLatencies` + `detectLLMDeadLetters` + **内部 90d cleanup**（Fix #3）+ **audit_log.ts 秒/毫秒换算**（Fix #1）+ unit
15. `daemon/tasks/daily-maintenance.mjs` 加 steps 12-13（revalidation + rollup，**step 14 已合并入 rollup 函数**）+ inflight 防护 + unit

### Week 3 — diagnose 命令 + writeAudit 统一 + 集成

16. `lib/admin/diagnose.mjs` 加 `--tuning`（5 个规则 + insufficient data 兜底 + **样本量守卫**（Fix #5/#6）+ **pool_b/tier1.5 各自专属信号**（Fix #5））+ `computeTuningSuggestions` 真值表 + unit
17. `lib/admin/diagnose.mjs` 加 `--metrics [--days N]` + budget WARN / trend ± 计算 + unit
18. `lib/cmd/stats.mjs` 加 Tuning hint 行（按需显示）+ unit
19. `writeAudit` / `logAudit` 统一：rename + adapter + CI grep 加规则；新代码全用 `writeAudit`
20. Tier 1.5 + daily inflight 防护单测 + 端到端并发 race 测试
21. `config.default.json` bump 到 0.4，`scan_patterns_version` bump 到 "2026.07"
22. 端到端 v0.3 → v0.4 升级测试：DB 升级 + 首次 lazy 触发全员 stamp + fast-skip 第二次跑
23. mode 矩阵测试（shadow/off 下 revalidation + Tier 1.5 step 9 + diagnose）
24. v0.3 回归套全量跑
25. `commands/*.md` 更新（resurrect / stats / admin 描述）
26. **M5 验收**（§1.3 完成判据 7 条）

### 依赖关系

```
004 schema → revalidationAuditCore → Tier 1.5 step 9
                ↓                         ↓
              resurrect --revalidation   daily_maintenance step 12
                                            ↓
                                         metrics-rollup → diagnose --tuning / --metrics
                                                            ↓
                                                       stats Tuning hint
platform layer → daemon.mjs dispatch → Linux CI integration → stats 三档行(平台无关)
detect-node.mjs (darwin/linux 共享)
writeAudit 统一 (横穿 Week 3)
```

每个 milestone 完成判据未达不进下一阶段（design.md §17 失败回退原则）。

---

## 附录 A：v0.4 不变量 checklist（CI grep）

沿用 v0.3 附录 A 全部 18 条，新增 v0.4 专属：

19. `revalidationAuditCore` 不调 LLM
    （`grep -n 'callClaudeP\|claude -p' scripts/lib/revalidation.mjs` 应为空）
20. revalidation 路径不动 hooks / 写入闸门
    （`grep -rn 'revalidationAuditCore' scripts/handlers/ scripts/lib/cmd/save.mjs` 应为空）
21. `metrics_daily_rollup` 的所有写入（INSERT / UPDATE / DELETE）仅在 `writeMetricsDailyRollup` 函数内（Fix #3 cleanup 内置后该规则更强）
    （`grep -rnE "(INTO|UPDATE|DELETE FROM) metrics_daily_rollup" scripts/` 仅 metrics-rollup.mjs）
22. 平台层只在 `lib/admin/platform/` 内有 `process.platform` 分支
    （`grep -rn 'process.platform' scripts/` 命中应只在该目录）
23. **v0.4 新增文件 100% 用 `writeAudit`**，禁用 `logAudit`
    （`grep -rn 'logAudit(' scripts/lib/revalidation.mjs scripts/lib/metrics-rollup.mjs scripts/lib/admin/platform/ scripts/lib/admin/diagnose.mjs` 应为空）
24. `scan_patterns_version` 升级触发首次 revalidation 全员 stamp
    （v0.3 → v0.4 升级 integration test 断言：升级后跑一次 lazy → 全员 `last_scanned_patterns_version='2026.07'`）
25. Node 路径写入 unit/plist 前必绝对
    （`grep -n '/usr/bin/env node' scripts/lib/admin/platform/` 应为空——只能在 fallback 数组或注释里）
26. revalidation lazy 路径 fast-skip 必走（`grep -n 'fast_skip' scripts/lib/revalidation.mjs` 至少 1 处真值赋值 + 1 处 audit 写入）
27. Tier 1.5 + daily inflight 防护
    （`grep -n 'inflight' scripts/lib/tier15.mjs scripts/daemon/tasks/daily-maintenance.mjs` 各 ≥ 1）

---

## 附录 B：从 v0.3 spec 引用的关键约定速查

| 约定 | 出处 | v0.4 沿用 |
|---|---|---|
| 同步 DatabaseSync API | v0.2 §0.2 | ✓ |
| `await callClaudeP` 不持锁 | v0.2 §7.4 关键不变量 | ✓（v0.4 无新 LLM 任务） |
| LLM 输出走 parseLlmJson + JSON schema | v0.2 §8.5 | ✓（v0.4 无新 schema） |
| stdout/stderr 都进 LLM 上下文，元数据走 audit_log | v0.1 R-4 / v0.2 §5.0.2 | ✓ |
| writeAudit helper | v0.1 §5.6.2 | ✓（v0.4 强制统一） |
| daemon 防递归（CCMEM_INTERNAL + blacklist） | v0.2 §4.0 / §7.4 | ✓（platform refactor 不破坏） |
| task_runs lease 防重复 | v0.2 §八 + RAN_BY 常量 | ✓ |
| Tier 1.5 lazy maintenance 框架 | v0.2 §8.4 | ✓（v0.4 末尾追加 step 9） |
| daemon-optional 三档定位 | motivation §三 / v0.2 §1.2 | ✓（v0.4 把 revalidation 显式归类） |
| migration 失败 hard-exit + 自动备份 | v0.2 §3.3 / S-3 | ✓ |
| Tier 3 quarantine 写入闸门 | v0.3 §五 | ✓（v0.4 不动） |
| Tier 1.5 step 8 安全簇兜底 | v0.3 §5.3 | ✓（v0.4 在其后加 step 9） |
| security_audit cron | v0.3 §6 | ✓（v0.4 不动） |
| cross_scope_alerts 30d / 60d | v0.3 §6.5 / §6.6 | ✓ |

---

## 附录 C：未在 v0.4 实现但已埋设的钩子（for v0.5+）

| 钩子 | 已在 v0.4 准备 | v0.5+ 用途 |
|---|---|---|
| `metrics_daily_rollup` 表 schema | ✓ | embedding 模型上线后加 `vec_cache_hit_rate` / `vec_search_p95` 列 |
| `tuning_suggest` config 段 | ✓ | 后续加 embedding 阈值建议（语义相似度 cutoff） |
| `daemon.platform_install_fallback_node_paths` | ✓ | Windows scheduled task 实施时复用（路径列表加 Windows node 位置） |
| `lib/admin/platform/` 抽象层 | ✓ | Windows installer 加为 `windows.mjs`，不影响 darwin / linux |
| `audit_log` action 命名约定 `<entity>_run` | ✓（v0.3 security_audit_run + v0.4 revalidation_audit_run） | 新 cron 任务沿用此规范 |
| LLM dead-letter 检测 | ✓ | 未来 cron 任务的 LLM 调用自动纳入 |
| `--tuning` 算法可插拔 | ✓（5 个独立规则，可加可减） | 加新旋钮时只需追加一个规则函数 |

---

## 附录 D：dogfood 记录（待 dogfood 期填）

> 真实使用过程中发现的行为偏差、阈值不合理、prompt 调整需求等记录在这里。dogfood 期结束后用作 v0.5 spec 输入。

### 后续观察

```
日期         | 类别              | 观察 / 调整                                          | 跟进
-----------+-------------------+----------------------------------------------------+---------
TBD        | (待 dogfood 期填) |                                                    |
```

---

**End of v0.4 spec.**
