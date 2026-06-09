# ccmem v0.5 dogfood / 验证清单

> v0.5 已实现并合并到 main（763/763 tests pass，9 个 v0.5 提交）。
> 这份文档记录"测试覆盖之外、需要靠真实使用验证"的事项。
>
> v0.5 范围较小（3 个 Tier A 项），但 A1（daemon self-restart）是运行时行为，
> 单测无法覆盖 launchd/systemd 真正拉起新进程的端到端路径。

---

## 〇、为什么 dogfood 不可替代

v0.5 的 9 个实施任务每个都有对应单测/集成测试，但有一类问题测试照不到：

- daemon self-restart 在**真实 launchd/systemd** 下的端到端行为（测试用 mock process.exit）
- CLI fresh-install 在**真实用户环境**下的首次体验（测试用 tmpDir 替代 `~/.claude/ccmem`）
- cron config 在**真实 daemon 运行周期**里是否按新时间触发（测试用 mock Date）
- 升级路径：v0.4 daemon（in-memory schema=5）检测到 DB schema=6 后是否真的自重启

---

## 一、高优先级：升级后必须立刻验证

升级当天 0-3 天内执行。失败 = 需紧急 patch。

| 项 | 怎么验 | 通过判据 | 失败处置 |
|---|---|---|---|
| **V1 — daemon self-restart 真触发** | 升级 v0.5 后，观察 v0.4 daemon 是否在 ≤ 30s 内自动重启。`sqlite3 ~/.claude/ccmem/global.db "SELECT ts, details FROM audit_log WHERE action='daemon_self_restart' ORDER BY id DESC LIMIT 1"` | 有 1 行 audit，`from_version=5, to_version=6`；`/ccmem:admin daemon status` 显示新 PID + `startup_schema v6` | 若无 audit 行：检查 daemon 是否在跑（`admin daemon status`）；检查 `self_restart_on_schema_mismatch` config 是否被关 |
| **V2 — CLI fresh-install 不 crash** | 在**新用户环境**（或 `CCMEM_TEST_MODE=1 CCMEM_TEST_DB_DIR=/tmp/fresh-v05`）跑 `ccmem list`，然后 `ccmem save "test" --scope global` | list 输出空表（不 crash）；save exit 0；再跑 list 显示 1 条 | 若 crash：检查 `ensureSchema` 是否在 cli.mjs switch 前 |
| **V3 — config version = 0.5** | `ccmem admin diagnose --key` 或 `grep version config.default.json` | version = "0.5" | 若还是 0.4：config.default.json 未更新 |
| **V4 — v0.4 全套验证项仍 OK** | 重跑 v0.4-dogfood §一 V1-V5（scan_patterns_version / lazy fast-skip / daemon restart 心跳） | 全部仍 PASS | 回归 |
| **V10 — Docker container daemon install** | Docker Ubuntu 内跑 `ccmem admin daemon install` | 输出 `ccmem: daemon installed (linux/container-fallback)`；`ccmem admin daemon status` 显示 alive=true source=container-fallback | 若仍报 "Failed to connect to bus"：probe 未生效，检查 `show-environment` 分支 |

---

## 二、中优先级：dogfood 1-2 周内自然会撞到

| 项 | 监测信号 | 通过/失败 判据 |
|---|---|---|
| **V5 — daily_maintenance 在 config 时间触发** | 用默认 config（02:17）：升级后第一个 02:17 UTC 后检查 `audit_log` 有 `daily_maintenance` task | task_runs 有今日 daily lease |
| **V6 — cron config 覆盖生效** | 改 `~/.claude/ccmem/config.json` 加 `"cron": {"daily_at": "04:00"}`，重启 daemon，观察下一个 02:17 **不触发** daily，04:00 **才触发** | task_runs.started_at 在 04:00 之后 |
| **V7 — diagnose --restart-history 有数据** | V1 验证后跑 `/ccmem:admin diagnose --restart-history` | 显示 ≥ 1 行自重启历史（v5 → v6） |
| **V8 — daemon status 显示 startup_schema** | `/ccmem:admin daemon status` | 输出含 `startup_schema v6` |
| **V9 — --help 不创建 DB** | 新用户环境：`ccmem --help` 后检查 DB 文件是否存在 | DB 文件不存在 |

---

## 三、Tier B 哨兵（沿用 v0.4 dogfood §三）

v0.4 dogfood 的 B1-B5 哨兵继续监控，命中后加入 v0.5 patch 或推 v0.6：

| # | 哨兵 | 状态 |
|---|---|---|
| B1 | `audit_log.ts` 秒精度 race（"我刚 keep 怎么又 flag"） | 继续监控 |
| B2 | systemd `start-limit-hit` | 继续监控 |
| B3 | tier15.mjs 注释跳号 | cosmetic, defer |
| B4 | `trend: NaN%` 输出 | 继续监控 |
| B5 | darwin plist 连体 string | cosmetic, defer |

---

## 四、长周期 / 自然事件驱动

| 项 | 何时验 |
|---|---|
| daemon self-restart 在 v0.6 升级时自动触发（v6 → v7） | v0.6 ship 时 |
| cron config 改 weekly_at 后 weekly_synthesis 在新日期跑 | 手动验或等到下周 |
| Linux systemd 下 daemon self-restart 行为 | 下次有 Linux 设备时 |
| daemon mid-task 重启（task 完成后才 exit） | 等自然撞到或手动模拟：启动 `ccmem admin cron run weekly_synthesis`，趁跑时 `sqlite3 ... "UPDATE schema_meta SET version=999"` |

---

## 五、已知未测 / 边角

| 项 | 风险 | 监控点 |
|---|---|---|
| self-restart 与 adaptiveSleep 5min 窗口的交互 | 心跳 20s 但 adaptiveSleep 可达 5min；schema 变更在 idle sleep 期间不会被检测到直到 sleep 结束 | 最坏延迟 = 5min + 20s；实际用户不太在意这个延迟 |
| config_kv `daemon_startup_schema_version` 在 daemon 未启动时为空 | `admin daemon status` 正确处理（不显示字段） | 无风险 |
| parseDailyAt / parseWeeklyAt 对极端输入（`"99:99"` / `"Xxx 00:00"`） | defensive parsing fallback 到默认值 | 单测已覆盖，生产不太可能出现 |
| CLI ensureSchema 在 hook 也同时跑时的 migration 竞态 | SQLite WAL single-writer 保护；runMigration 是幂等的 | 无风险 |

---

## 六、主动 dogfood 验证 checklist

```
Day 0   (升级日 2026-06-03)
[x] V1: daemon self-restart — N/A for v0.4→v0.5 (bootstrapping: v0.4 code 无 check 逻辑)
        手动 restart 后新 daemon PID 66704, startup_schema v6。self-restart 从 v0.5→v0.6 起生效
[x] V2: CLI fresh-install 不 crash — PASS (ccmem list on empty DB → "no memories found", exit=0)
[x] V3: config version = 0.5 — PASS
[x] V4: v0.4 验证项仍 OK — PASS (292 stamped 2026.07, 0 error audits, heartbeat 7s fresh)

Day 1-3
[x] V7: diagnose --restart-history — "no self-restart history" (expected: 手动 restart 不写 audit)
[x] V8: daemon status 显示 startup_schema v6 — PASS
[x] V9: --help 不创建 DB — PASS

Day 7+
[ ] V5: daily_maintenance 按 config 时间触发
[ ] V6: cron config 覆盖验证（可选——需手动改 config）

每周一次
[x] error audit 扫描 — PASS (0 行, 2026-06-03)
```

---

## 七、可调参数清单

| Config 路径 | 默认 | 说明 |
|---|---|---|
| `daemon.self_restart_on_schema_mismatch` | `true` | 关闭后 daemon 不检测 schema 变更 |
| `daemon.self_restart_check_interval_ms` | `20000` | v0.5 实际不解耦（仍硬编码 20s 心跳），留位 |
| `cron.daily_at` | `"02:17"` | v0.5 新：daemon 读此字段决定 daily 触发时间 |
| `cron.weekly_at` | `"Sun 03:17"` | v0.5 新：daemon 读此字段决定 weekly 触发时间 |

---

## 八、观察记录

> dogfood 期间在这里追加观察。每条记一个表格行。时间倒序。

| 日期 | 类别 | 观察 | 关联 ID / 处置 |
|---|---|---|---|
| 2026-06-03 | V1 bootstrapping | v0.4→v0.5 升级时 daemon **不会自重启**（v0.4 code 无 `checkSchemaStaleness` 逻辑）。这是 bootstrapping 限制：self-restart 只在 v0.5 code 加载后生效。首次升级需手动 `ccmem admin daemon restart`。v0.5→v0.6 起自动生效。 | 手动 restart → PID 56800→66704；记入 spec §3.3 兼容说明 |
| 2026-06-03 | V2/V3/V8/V9 全通 | **V2**: fresh DB `ccmem list` → "no memories found" exit=0。**V3**: version=0.5。**V8**: `startup_schema v6` 显示正确。**V9**: `--help` 不创建 DB。**V4 回归**: 292 stamped 2026.07, 0 error audits, heartbeat 7s。**V7**: "no self-restart history"（expected — 手动 restart 不写 daemon_self_restart audit）。 | 全 PASS |
| 2026-06-03 | A4 Docker daemon | **问题**: Docker Ubuntu 下 `ccmem admin daemon install` 失败,`systemctl --user daemon-reload` exit 1 "Failed to connect to bus: No such file or directory"。容器无 systemd PID 1、无 D-Bus user session bus (`XDG_RUNTIME_DIR` 为空)。**设计**: probe `systemctl --user show-environment`(需 bus 连接)→ 失败自动 fallback 到 `container.mjs`(PID file + wrapper shell loop)。**首版 bug**: 初始 probe 用 `--version` 但该子命令不连接 bus(只打印版本号),Docker 内仍 exit 0 → 未触发 fallback。改用 `show-environment` 后修复。 | commits: db7300c (spec) + 22e70d8 (impl) + f0a2550 (rename) + 2f861e4 (probe fix) |
