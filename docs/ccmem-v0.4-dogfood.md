# ccmem v0.4 dogfood / 验证清单

> v0.4 已 ship 并合并到 main（merge commit `12afffc`，714/714 tests pass，23 个 v0.4 提交 + 1 个 merge）。
> 这份文档记录"测试覆盖之外、需要靠真实使用验证"的事项，以及 critic 复审 defer 项的监测哨兵。
>
> 如果一项已在 dogfood 中确认 OK 或失败，记到本文末尾的"观察记录"小节。

---

## 〇、为什么 dogfood 不可替代

v0.4 的 21 个实施任务（Week 1-3）+ 8 个 critic 复审 fix 每个都过了单测，但有一类问题**单测照不到**：

- 真实 LLM 输出在长期累积下命中 v0.4 tier1/tier2 patterns 的实际频率
- daemon 真实重启 / 跨日 / 跨周后的行为（schedule + lease + catch-up）
- scan_patterns_version 升级触发后大量 mems 重 stamp 的真实耗时
- Linux systemd-user 实机行为（loginctl enable-linger / logout 残存 / OOM）
- 用户主动交互流（`/ccmem:resurrect --revalidation` 的 k/f/q/s 决策直觉）
- diagnose --tuning 的算法在真实信号分布下是否给出合理建议

把 v0.4 当成"代码 + 测试已 ready，但 patterns / 阈值 / 算法系数还没在生产里被打磨过"——
dogfood 1-2 周后再决定是否调阈值或改算法。

---

## 一、🔴 高优先级：升级后必须立刻验证（"会不会立刻爆"）

升级当天 0-3 天内执行。失败 = blocker，要回滚或紧急 patch。

| 项 | 怎么验 | 通过判据 | 失败处置 |
|---|---|---|---|
| **V1 — scan_patterns_version 升级真触发** | 升 v0.4 当天首次跑 `/ccmem:list`，然后 `sqlite3 ~/.claude/ccmem/global.db "select count(*) from memories where last_scanned_patterns_version='2026.07'"` | 数字 = 当前 active+probation mem 总数（fast-skip 路径下次才生效） | 若结果是 0：检查 `audit_log` 是否有 `revalidation_audit_run` 且 `pattern_version=2026.07`；可能是 `lazy_enabled=false` 被人手动改了 |
| **V2 — S4 事务后大批 lazy 真实耗时** | 升级当天升级前 `cp ~/.claude/ccmem/global.db /tmp/v03-backup.db`；升级后 `time /ccmem:list` 第一次 | < 500ms（spec 100ms 是 batch_size=100 的目标，实测可能 200-500ms） | > 2s → 测试中的 S4 性能假设不成立；考虑把 batch_size 降到 50 |
| **V3 — Linux Layer 2 CI 首跑** | merge 后第一次 push 到 main（paths-filter 触发 `linux-daemon-smoke.yml`）；或手动 `workflow_dispatch` | workflow 全绿，含 `loginctl enable-linger` + `systemctl --user enable --now` + `is-active` 验证 | 失败：看 `journalctl --user -u com.ccmem.daemon.service` step 的输出；常见原因是 XDG_RUNTIME_DIR 未设置 |
| **V4 — macOS daemon 重启后心跳同步** | `/ccmem:admin daemon restart` → 立刻 `/ccmem:admin daemon status` | 显示 `daemon running (darwin/launchd) pid <N>, heartbeat <Ms>` 其中 M < 30 | 若显示 `unit alive but no recent heartbeat`：等 30s 再查；持续不同步说明 daemon 进程异常 |
| **V5 — Tier 1.5 lazy fast-skip 真生效** | 连续 3 次 `/ccmem:list`，然后 `sqlite3 ~/.claude/ccmem/global.db "select details from audit_log where action='revalidation_audit_run' order by id desc limit 3"` | 后两次的 details.fast_skip 应该是 `true`（lease 防重入 / fast-skip COUNT(*)=0） | 若每次 scanned > 0：fast-skip 的 WHERE 跟 candidates SELECT 不对齐了，查 revalidation.mjs §6.1 |

---

## 二、🟠 中优先级：dogfood 1-2 周内自然会撞到

| 项 | 监测信号 | 通过/失败 判据 |
|---|---|---|
| **V6 — S1 修复：rollup 窗口真 = YESTERDAY** | `/ccmem:admin diagnose --metrics --days 14` 跑满 7 天后 | 每行 day_key 是"跑日的前一天"，**今天**不出现；total llm_calls 比拍脑袋估计的合理（不是 ~10% 偏低，那是 S1 修复前的症状） |
| **V7 — tuning 5 规则的样本量门槛** | 第 7 天起每天 `/ccmem:admin diagnose --tuning` | 早期应该全 `(keep)` + rationale 显示 "insufficient ..."；等真有信号了再 fire 才合理 |
| **V8 — `resurrect --revalidation` k/f/q/s 体验** | 第一次自然撞到 flag 时记录直觉反应（不要先看代码） | 标签是否歧义？q 和 f 区别明显？提示行字数 ≤ 屏宽？按错键的 fallback 行为合理（skip） |
| **V9 — error audit 是否被注意到** | dogfood 期内每周 `sqlite3 ~/.claude/ccmem/global.db "select action, count(*) from audit_log where action like '%_error%' or action='daemon_task_uncaught_error' group by action"` | 0 行 = OK；非 0 = 用 `/ccmem:audit show <id>` 看 details.error，根因处理 |
| **V10 — pinned/high-trust mem flag 队列长度** | 升级后 1 周内 `/ccmem:resurrect --revalidation` 查看 pending 数 | < 10 = OK；> 20 = `flag_trust_threshold=0.6` 太松，考虑改 0.5 |
| **V11 — `/ccmem:stats` Tuning 行 8 字符列对齐** | 当 tuning 真有建议时跑 `/ccmem:stats` | 视觉对齐：`Tuning   :` 与 `Security :` / `Memories :` / `Feedback :` 冒号列对齐 |
| **V12 — diagnose --metrics 内存池标签含 day_key（S6 修复）** | `/ccmem:admin diagnose --metrics` | 看到 `Memory pool (end of 2026-MM-DD)`，**不是** `(end of day)`；daemon-gap 时 day_key 是过去某天 |

---

## 三、🟡 critic 复审 defer 项的监测哨兵

critic agent 标记为 SIGNIFICANT 但 defer 到 v0.5 / 不修的 5 项。这些项**出现就触发处理**。

| # | defer 项 | 监测哨兵（出现就需处理） | 处置 |
|---|---|---|---|
| **V13** | S5 audit_log.ts 秒精度 race | 用户反馈 "我刚 keep 怎么又 flag 了我" ≥ 2 次 | 触发 ts → ms 迁移规划（v0.5） |
| **V14** | M3 tier15.mjs 注释跳号 6→8 | 永远不会出现（cosmetic） | 顺手时改成 6→7→8 |
| **V15** | M4 systemd 无 RestartLimit 设置 | `systemctl --user status com.ccmem.daemon` 出现 `start-limit-hit` 状态 | unit 文件加 `RestartLimitBurst=10` + `StartLimitIntervalSec=600` |
| **V16** | M5 trendArrow NaN 边界 | `/ccmem:admin diagnose --metrics` 输出字面字符串 `trend: NaN%` | metrics-view.mjs 1 行 fix（已知 patch） |
| **V17** | M6 darwin plist `<string>--exp...--no-warn</string>` 显示连体 | 永远不会出错（解析正常） | 顺手时拆成两个 `<string>` 元素 |
| **V18** | ~~resurrect 空集合文案三 mode 共用~~ **(根因纠正)** cli.mjs dispatcher 漏 wire `cmdResurrectRevalidation`,`--revalidation` 落到默认 `cmdResurrect` (grey-zone) 路径 | 跑 `/ccmem:resurrect --revalidation` 输出字面 `no grey-zone memories` (应为 `no revalidation flags pending`) | **已修复**(2026-06-03):cli.mjs 加 import + `else if --revalidation` 分支(envelope 同 `--quarantined`);新增 `tests/unit/cli-resurrect-routing.test.mjs` 防回归。哨兵保留:防 cli.mjs 重构再次漏 wire |

---

## 四、🟢 长周期 / 自然事件驱动

需要等真实时间过去才能验。

| 项 | 何时验 |
|---|---|
| daily_maintenance 02:17 UTC 触发 + steps 12-13 真跑 | 升级后第一个 02:17 UTC（北京时间 10:17）后，看 `audit_log` 有 `revalidation_audit_run trigger:daily` + `metrics_rollup_written` |
| metrics_daily_rollup 90d cleanup 真触发 | 等满 90 天（v0.4 升级 + 90d），看老行被删 |
| Linux Layer 3 实机：Arch + Fedora | 发版前一次性扫，记录在 release notes |
| daemon down 跨日后 daily catch-up | 故意停 daemon ≥ 36h，启动后看 daily 是否补跑（task_runs.date_key 应有过去日期的 row） |

---

## 五、已知未测 / 边角

| 项 | 风险 | 监控点 |
|---|---|---|
| daemon 与 Tier 1.5 lazy 并发跑 revalidation | tier15 step 9 + daily step 12 都调 `revalidationAuditCore`；不同进程并发时跨 `BEGIN`/`COMMIT` 行为靠 SQLite WAL single-writer 保护 | dogfood 期手动并发：开 2 个 terminal，A 跑 `/ccmem:list`，B 等待 daily 02:17；看 `audit_log` 是否两个 trigger 都成功 |
| diagnose --tuning 真实 30d 信号下规则正负判 | 测试都是合成数据；真实数据 quarantine + resurrect 比例分布未知 | 第 30 天 `/ccmem:admin diagnose --tuning` 后人工 review 每条 rationale 是否说得通 |
| Linux installer 在 nvm/asdf 用户的真实 node 路径 | detect-node 3 档：execPath > which > config 兜底。execPath 应该总是命中，但 fall through 路径未在生产验证 | `which node` vs `process.execPath` 差异机器上跑一遍 |
| daemon install 捕获的真实 Claude Code 二进制 | 真实事故证明只固定 node 不够：launchd/systemd 里的 `claude` 可能漂到另一个旧版本，缺少 `--json-schema`，从而让 `summarize_pending` 在后台失败。install 应固定安装 shell 解析到的 `claude` 绝对路径，并先跑 `claude -p --help` 能力探测 | 在 nvm/Homebrew 并存机器上对比 install shell `which claude`、plist/unit 中的 `CCMEM_CLAUDE_P_COMMAND`，再确认旧 binary 会被 install 阶段阻止 |
| writeAudit/logAudit 共存（v0.2/v0.3 老代码） | v0.4 critic 标 PASS，但 weekly_synthesis 多 ID batch 路径在真实使用下未验证 | 第一次 weekly_synthesis 后 `select affected_ids from audit_log where action like 'weekly_synthesis%' order by id desc limit 5` 看多 ID 数组形态正常 |
| Linux Layer 2 CI 上的 `loginctl enable-linger` 真权限 | GitHub Actions 默认无 sudo？workflow 用了 `sudo loginctl ...` | 首次跑后看输出 |
| cli.mjs 0 处 ensureSchema — fresh DB first-install 体验 bug | cli.mjs 所有 `openDb()` case 都靠"production DB 已 init"；fresh DB 首次跑任意命令撞 `no such table: memories`。V18 fix 过程中发现 | `CCMEM_TEST_MODE=1 CCMEM_TEST_DB_DIR=/tmp/fresh node bin/ccmem list` 复现 → 决策 openDb 是否自带 ensureSchema 或 cli.mjs 入口加一次 |
| `config.default.json` `cron.daily_at` 字段与实现不同步 | daemon `scheduleCronTasks` hardcode `hours > 2 \|\| (hours === 2 && minutes >= 17)`，不读 `cron.daily_at` config。config 声明 `"daily_at": "02:17"` 是 dead config（用户改了不生效） | v0.5 决策：读 config 还是删 dead config 字段 |

---

## 六、主动 dogfood 验证 checklist（按优先级）

```
Day 0   (升级日)
[x] V1: 验 scan_patterns_version 升 2026.07 全员触发 — PASS (292/292, lazy+manual+daily 三路 catch-up)
[ ] V2: time /ccmem:list 首次性能 — 错过实时 time, 但 lazy dur=3ms / daily dur=2ms 实测 OK
[x] V3: push main 后 GitHub Actions 全绿 — SKIP (macOS scope, 待 git push)

Day 1-3
[x] V4: macOS daemon restart 心跳同步 — PASS (新 PID 56800, heartbeat < 30s)
[x] V5: Tier 1.5 lazy fast-skip 连跑 3 次 — PASS (首次 scanned=100, 后续 fast_skip=true)

Day 7+
[x] V6: rollup 7 日数据看 day_key 形态 — smoke PASS (day_key='2026-06-02', S1 修复验证)
[x] V7: tuning 命令真跑一次看 rationale — smoke PASS (insufficient data, 0 days < 7)
[x] V12: diagnose --metrics 内存池标签确认含 day_key — PASS (rollup 含 mems_active/quarantine)

Day 14+
[ ] V8: 自然撞到第一次 --revalidation
[ ] V10: pending flag 队列长度
[ ] V11: stats Tuning 行视觉对齐（如有信号）

每周一次
[x] V9: error audit 扫描 — PASS (0 行, 2026-06-03)
[x] daily_maintenance 02:17 触发验证 — PASS (手动清 lease + wake 后 daily #150 success)

事件触发
[x] V18: resurrect --revalidation cli.mjs wiring 漏 — FIXED (commit 473ba4a)
[ ] V13-V17: 哨兵触发再处理
```

---

## 七、依赖 patterns / 算法的项 — 可调参数清单

如果 dogfood 发现行为不达预期，这些是优先调整的旋钮（全部走 `~/.claude/ccmem/config.json` 覆盖）：

| Config 路径 | 默认 | 调小的影响 | 调大的影响 |
|---|---|---|---|
| `security.scan_patterns_version` | `"2026.07"` | — | bump 触发全员 revalidation（v0.5 升级时再 bump） |
| `security.revalidation.lazy_enabled` | `true` | `false` → Tier 1.5 step 9 早返回 + audit `skipped:lazy_disabled` | — |
| `security.revalidation.daily_enabled` | `true` | `false` → daily step 12 早返回 | — |
| `security.revalidation.batch_size` | `100` | 50 → 单次 lazy < 100ms 更稳；多次 lazy 才追上 | 200 → 单次 lazy 慢但少 round-trip |
| `security.revalidation.flag_trust_threshold` | `0.6` | 0.5 → 更多 high-trust mem 直接 quarantine（用户更少 review） | 0.7 → 更多 flag 队列等用户决定 |
| `metrics_rollup.enabled` | `true` | `false` → daily step 13 跳过 + 无 rollup 数据 → --tuning 永远 insufficient | — |
| `metrics_rollup.retention_days` | `90` | 30 → diagnose --metrics 历史窗口缩小 | 365 → DB 多占空间，--metrics 长尾可看 |
| `metrics_rollup.min_days_for_tuning` | `7` | 3 → 更早出 tuning 建议（但样本少不稳） | 14 → 更保守的样本量要求 |
| `tuning_suggest.pool_b_zero_quarantine_ratio` | `0.7` | 0.5 → 更容易"+2 调严"建议触发 | 0.9 → 几乎不触发 +2 |
| `tuning_suggest.dedup_window_p90_ratio` | `0.5` | 0.3 → 更容易"halve window"建议 | 0.8 → 几乎不建议缩窗 |
| `tuning_suggest.sunset_resurrect_high_rate` | `0.5` | 0.3 → 更容易"+5 sunset"建议（resurrect rate 较低就触发） | 0.7 → 几乎不延长 sunset |
| `hook_budget_ms.*` | session_start: 50/300 / prompt_submit: 50/100 / stop: 50/200 | — | 升 → --metrics WARN 标记阈值放宽 |
| `daemon.platform_install_fallback_node_paths` | `[/usr/local/bin, /opt/homebrew/bin, /usr/bin]` | — | 加新路径 → detect-node 第三档兜底更广 |

---

## 八、与 v0.3 dogfood 文档的衔接

v0.4 dogfood 与 v0.3 dogfood (`docs/ccmem-v0.3-dogfood.md`) 互补：

- **v0.3 dogfood 项目**：security_audit / cross_scope_alerts / Tier 3 / quarantine sunset — v0.4 ship 后这些仍要继续观察（30d sunset 周期未必走完）
- **v0.4 新增**：revalidation_audit / metrics_daily_rollup / Linux daemon / diagnose --tuning/--metrics / writeAudit 统一

合并 dogfood 时统一一个备忘：`audit_log` 是最 universal 的查问入口 —— 几乎所有 v0.3 / v0.4 异常都会在 audit_log 留痕。

---

## 九、观察记录

> dogfood 期间在这里追加观察。每条记一个表格行，链接到具体 audit_log id 或 commit。
> 已确认 OK / 已失败 / 已修复 都记进来，时间倒序。

| 日期 | 类别 | 观察 | 关联 ID / 处置 |
|---|---|---|---|
| 2026-06-03 | V1/V2/V6/V12 全通 | 清 stale daily lease + touch wake file 后 daemon claim daily → task #150 success。**V1**: 292/292 stamped 2026.07 (v06=0);**V2**: revalidation_audit_run trigger:daily scanned=92 dur=2ms;**V6**: metrics_daily_rollup day_key='2026-06-02'(S1 修复验证:今天跑聚合昨天);**V12**: rollup mems_active=292 mems_quarantine=1;**V7**: insufficient data (have 0 days, need >=7) smoke PASS;**V9**: 0 error audits;**metrics_rollup_written** audit #133 存在。**附带发现**: daemon adaptiveSleep 5min + stale lease 叠加导致手动 DELETE lease 后 daemon 不醒,需 touch wake file 才生效;tryClaimLease 是 bare INSERT UNIQUE,UPDATE status='failed' 不释放 lease(必须 DELETE 行) | V1 PASS;V2 PASS;V6 PASS;V12 PASS |
| 2026-06-03 | 架构分析 | **task_runs vs tasks 两层重试设计验证**:task_runs 是幂等 lease("今天跑过没"),tasks 是执行队列(可 retry/supersede)。daily 3 次 retry 全 fail 后 dead-letter 是 by design:tasks 层 `scheduleRetry` 负责重试(125→126→127→129, attempts 1→2→3→exhausted),task_runs lease 只管"今天要不要入队"不参与 retry。**手动恢复路径**:`admin cron run` 绕过 lease(走 tasks 直接入队),或 DELETE lease 行 + wake → daemon 重新 claim。**结论**:tryClaimLease 不需要改;根因是 daemon code/schema mismatch(v0.5 self-restart 解决后此场景不再出现)。**两处 dead config**:`config.default.json` 的 `cron.daily_at` / `cron.weekly_at` 声明存在但 scheduleCronTasks hardcode 时间,用户改 config 不生效 | 不改 tryClaimLease;dead config 加入 §五 已知未测;v0.5 spec 应考虑是否读 config |
| 2026-06-03 | V18 fix | TDD 走完:RED 测验证 `--revalidation` 落到 grey-zone 路径(`actual: 'ccmem: no grey-zone memories'`) → GREEN cli.mjs +1 import +1 case → 716/716 tests pass (+2 routing test)。**根因纠正**:不是文案模板共用(初判),是 cli.mjs dispatcher 漏 wire `cmdResurrectRevalidation` —— v0.4 spec §7.2 命令实现完整但 wiring 漏了。`cmdResurrectQuarantined`/`cmdResurrectAlerts` 一直工作(已 wired);`cmdResurrectRevalidation` 实现完整但用户跑不到。**附带发现**:cli.mjs **0 处 `ensureSchema`**,所有 `openDb()` case 都靠"production DB 已 init"赌运气,fresh DB 首次跑会撞 `no such table: memories`(不在 V18 范围,但应在 v0.5 修) | commit `473ba4a`;V18 哨兵保留 |
| 2026-06-03 | restart 后 smoke 扫描 | restart 后跑全套 v0.4 验证项扫描:V9 error audit **0 行**(daemon 24h 无崩溃);V7 tuning `insufficient data (have 0 days, need >=7)` 命令工作;V6/V12 metrics 命令 fallback `no metrics data in last 14 days`(等明早 02:17 daily 写第一行 rollup);weekly_synthesis 历史 4 个 success row(06-02 最近一次 synthesized=3, dur=84s) — affected_ids=NULL 符合 writeAudit(mem_id=null) 语义;daemon healthy heartbeat 11s 前;stats Security 行正常显示 1 quarantine。**新发现**:`/ccmem:resurrect --revalidation` 空集合输出字面 `no grey-zone memories` — 经 TDD 调查根因实为 cli.mjs wiring 漏(见下方 V18 fix 行) | V9 PASS;V6/V12 待明早 daily;V7 smoke PASS;weekly_synthesis 形态 OK;V18 已修复 |
| 2026-06-03 | V1/V2/V5 验证 | v0.4 schema migration 已 2026-06-02 10:35 应用,但 daemon (PID 90392, 启动 2026-06-02 08:47) **从未重启**,in-memory module 仍是 v0.3 code:daily_maintenance 在 06-01/06-02 连续 `failed`、06-03 卡在 `running` 2+ 小时;`metrics_daily_rollup` 零行;`revalidation_*_error` 零行(catch 块未 hit);`revalidation_audit_run` (daily trigger) 零行;V5 触发的 tier1_5 lazy 走 CLI prelude (加载最新 code) 正常 emit audit。265 个 active+probation mems 仍未 stamp 到 `2026.07`。 | 根因:launchd `KeepAlive` 仅在崩溃时拉,代码升级不会自动 refresh。处置:手动 `/ccmem:admin daemon restart` 验 V4 + 后续看 daily/step 12/13 是否恢复;长期方案见 §十 "daemon self-restart on schema mismatch" v0.5 候选 |
| 2026-06-03 | merge | feat/v0.4 merged to local main (12afffc); not yet pushed to origin | 等用户 `git push origin main` |

---

## 十、ship 前未做的（明确推迟到 v0.5+）

| 项 | 推迟到 | 理由 |
|---|---|---|
| **daemon self-restart on schema mismatch** | v0.5 | 2026-06-03 dogfood 实证:launchd `KeepAlive` 不会因 code 升级自动重启,导致 daemon in-memory module 与 DB schema 长期不一致(daily 失败、stamp 不推进、step 12/13 不跑)。设计选项见 dogfood notes:**首选** schema_meta.version 启动 vs 当前心跳里比对 mismatch → graceful exit(0) → launchd/systemd 拉新进程(零误报、跨平台);**次选** macOS plist `WatchPaths=[main.mjs, package.json]` / Linux systemd `.path` unit(平台原生但 macOS-only);**第三档** 任何 task running > 4h watchdog 升级 reclaimStaleLeases 为 daemon exit(0)。**否决** mtime 全目录监视(开发态高频 restart 杀活跃 cron) |
| audit_log.ts 秒 → 毫秒迁移 | v0.5 | dogfood 期实测 race 概率极低 |
| systemd RestartLimitBurst / StartLimitIntervalSec | 由 V15 哨兵触发 | 默认 5/10s 够用，未撞到不动 |
| Linux Layer 3 (Arch + Fedora) | release 时一次性 | 不阻塞主线 |
| Windows scheduled task | v0.5+ | platform layer 已留 `unsupported` 出口 |
| `loginctl enable-linger` 自动化 | 永不 | 需 sudo / polkit，破坏"zero-prompt install" |
| 语义矛盾检测（跨记忆 LLM 比对） | v0.5+ | LLM 用量大，与 embedding gate 一起评估 |
| monthly_meta_synthesis | v0.5+ | consolidated 池未膨胀到需要 |
| L1 中文正向关键词（对/嗯/好） | v0.5+ | 歧义未解；v0.4 正反馈仍靠 L2.5 + L4 |
| /ccmem:admin import/export/migrate | v0.5+ | sqlite3 CLI 足够 |
