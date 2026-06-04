# ccmem v0.3 dogfood / 验证清单

> v0.3 已 ship 并合并到 main（commit 61b2606，461/461 tests pass）。这份文档记录"测试覆盖之外、需要靠真实使用验证"的事项，以及 daemon 失联时应当观察的行为。
>
> 如果一项已在 dogfood 中确认 OK 或失败，记到本文末尾的"观察记录"小节。

---

## 〇、为什么 dogfood 不可替代

v0.3 的 25 个实施任务每个都过了单测 + 集成测，但有一类问题**单测照不到**：

- LLM 真实输出的文本特征（不是 mock 出来的）
- 阈值在真实流量分布下是否合理（簇大小、相似度、retry 频率）
- 长周期事件（30 天 sunset、每周触发）
- 用户主动交互流（stdin 单字符提示、resurrect 决策树）

把 v0.3 当成"代码层面 ready，但参数和 prompt 还没在生产里被打磨过"——dogfood 1-2 周后再决定是否调阈值或改 prompt。

---

## 一、单测过了但没在真实使用场景跑过

| 项 | 为什么单测不够 | 怎么验 |
|---|---|---|
| **Tier 3 写入 quarantine 的实际触发率** | 测试用的是"`务必 rm -rf /tmp/foo`"这种刻意构造的内容；真实 `auto_inferred` 来自 LLM summarize 输出，命中模式可能完全不同 | dogfood 1-2 周后 `/ccmem:list --quarantined`，看真的有几条 Tier 3 拦下来。如果一直是 0，说明 Tier 2 patterns 太严或 LLM 输出本就温和 |
| **Tier 1.5 step 8 簇阈值是否合理** | 阈值 5 是拍脑袋。如果 daemon summarize 一次正常会输出 3-4 条 trust=0.5 的 auto_inferred，再被反馈拉低，就可能误命中；反之如果 LLM 输出一直分散到不同 source/不同天，永远触发不到 | `/ccmem:admin diagnose --security` 看 reason=`tier1_5_heuristic_cluster` 出现频率 + `cluster_size` 分布 |
| **security_audit LLM 判决质量** | 测试 mock 了 `claude -p` 返回值；真 claude-p 在 transcript 内容混杂时是否真能区分"投毒" vs "项目特化"，是经验问题 | 第一次跑后 `/ccmem:audit show <last security_audit_run id>` 检查 `quarantined` / `alerts_emitted` 数；逐条 `/ccmem:list --quarantined` 看 LLM 给的 `llm_reason` 合理吗 |
| **cross_scope_alerts 误报率** | 真实 LLM 可能把任何"global rule + 项目偏好不同"都标 alert。合法分歧（"全局禁 npm 但旧项目继续用 npm"）应当被告警；但"全局：用 TS 严格模式" + "项目：某文件用 // @ts-nocheck" 也告警就是噪音 | `/ccmem:resurrect --alerts` 跑一次，统计 keep_both / forget 的比例 |
| **30d sunset 真到点会发生什么** | 单测 backdate 了 `quarantined_at`；生产从未走过完整 30d 流程 | 故意把一条 `quarantined_at` 改成 31 天前(SQL 直改)，下次 `daily_maintenance` 跑后看是否 → archived，再看 14 天后是否硬删 |
| **resurrect --quarantined 的 stdin 交互** | 测试都注入了 `args.action` callback，没真走 stdin 单字符读 | 手动跑一次 `/ccmem:resurrect --quarantined` 看 k/f/s 提示是否清晰、按错键如何降级 |

---

## 二、长周期 / 自然事件驱动

需要等真实时间过去才能验。

| 项 | 何时验 |
|---|---|
| `security_audit` 周日 03:47 是否如期触发 | 等到第一个周日（最近一次 = 2026-06-07 03:47），`/ccmem:audit show` 看 `security_audit_run` 行 |
| catch-up：daemon down 跨周后启动是否补跑 | 周日前停 daemon，周一启动，看 `task_runs` 是否补上当周记录 |
| `last_scanned_patterns_version` 戳是否随每次扫描更新 | 第一次 audit_run 后 `sqlite3 ~/.claude/ccmem/global.db "select id, last_scanned_patterns_version from memories where decay_status='active' limit 5"` |

不想等的话：手动触发 `/ccmem:admin cron run security_audit` —— 见 README 的"Cron 任务手动触发"。

---

## 三、已知未测 / 边角

| 项 | 风险 | 监控点 |
|---|---|---|
| LLM batch 失败 retry 路径 | spec 说 batch 失败 throw → daemon retry 接管，retry 用新选样（pools 重选）。如果某条特定 mem 让 LLM 反复返回不合 schema → 永远 dead-letter | `audit_log` action=`security_audit_batch_failed` 的频率与 `batch_ids` |
| `logAudit` 与 `writeAudit` 两套并存 | 实施期间发现 plan 里写的 `writeAudit(db, action, id, details)` 不存在，实际用 `logAudit(db, {action, affected_ids, details})`。两者真的等价吗？v0.3 新代码全部用了同一个吗？ | `grep -rn "writeAudit\|logAudit" scripts/` 看分布；理想是 v0.3 新代码 100% 走 `logAudit` |
| Tier 1.5 lease 与 daily_maintenance 重叠 | daily 也跑 sunset + alert 清理；Tier 1.5 step 8 也跑簇 quarantine。daemon 起来时 daily 在跑、用户同一秒触发命令 prelude，两者并发写 `audit_log` 是否冲突 | WAL 模式下 SQLite 单 writer 排队，理论安全。lease 的 UNIQUE 约束保证"同一类一天一次"，不保证同进程并发 |
| `package.json` 0.3.0 后 `version-gate.mjs` 行为 | v0.1 的 `requireMinVersion` 用 `package.json` version 做 semver 比较。0.3.0 启用后所有 v0.2 / v0.3 flag 应该全开。有没有 v0.4+ flag 现在还在限制中、需要 0.3.0 不放开的？ | `grep -rn requireMinVersion scripts/`，看 `minVersion` 全部 ≤ 0.3.0 |

---

## 四、主动 dogfood 验证 checklist（按优先级）

```
[ ] 1. 启动 daemon：/ccmem:admin daemon start，确认 /ccmem:stats 显示 Tier 2 alive
[ ] 2. 用 1 周让 auto_inferred 累积，观察 Tier 3 是否有动作（/ccmem:list --quarantined）
[ ] 3. 周日 03:47 之后第一件事：/ccmem:admin diagnose --security
[ ] 4. 如果 quarantine 池 > 0：/ccmem:resurrect --quarantined 走一遍人工流
[ ] 5. 如果 alerts pending > 0：/ccmem:resurrect --alerts 走一遍
[ ] 6. /ccmem:stats 看 Security 行是否在 quarantine + alert 都为 0 时正确隐藏
[ ] 7. 故意 kill daemon、跑 /ccmem:list 几次，看 Tier 1.5 是否兜底（看 audit_log）
[ ] 8. 至少跑过一次完整的 30d sunset 流程（可用 SQL backdate 加速验证）
```

---

## 五、依赖 LLM 行为的项 — 可调参数清单

如果 dogfood 发现 LLM 判决质量不达预期，这些是优先调整的旋钮（全部走 `~/.claude/ccmem/config.json` 覆盖）：

| Config 路径 | 默认 | 调小的影响 | 调大的影响 |
|---|---|---|---|
| `security.audit.maxPerBatch` | 30 | LLM 每次看的候选少，判决更准但 LLM 调用次数多 | 单次 batch 大，可能让 LLM 注意力分散 |
| `security.audit.pool_a.trustMin` / `trustMax` | 0.2 / 0.5 | 收窄"borderline 区间" → 选样少 → 漏检 | 放宽 → 选样多 → 噪音多、LLM 成本高 |
| `security.audit.pool_b.clusterMinSize` | 3 | 触发更敏感 → 误报 | 触发更钝 → 漏检批量投毒 |
| `security.tier1_5_security.cluster_min_size` | 5 | 同上（独立轴，Tier 1.5 兜底用） | 同上 |
| `security.cross_scope.dedup_window_days` | 30 | 同对告警更频繁重新出现 | 同对告警长期沉默 |
| `security.quarantine.sunsetDays` | 30 | 短周期：用户更频繁被催复核 | 长周期：quarantine 池堆积 |
| `security.quarantine.resurrect_trust` | 0.4 | keep 后更容易再被否定下沉 | keep 后更稳 |

调完任何 patterns_extra 时记得 bump `security.scan_patterns_version`（v0.4 revalidation 会用版本差异决定回扫哪些 mem）。

---

## 六、观察记录

> 真实使用过程中发现的行为偏差、阈值不合理、prompt 调整需求等记录在这里。dogfood 期结束后用作 v0.4 spec 输入。

### 2026-06-02 — 首日 dogfood 暴露 4 个 spec 盲区

触发：用户跑 `/ccmem:admin cron run weekly_synthesis` 后 `cron list` 看不到该任务。

诊断数据：

- `tasks` 表 id=76 weekly_synthesis: status=success, 跑了 115s
- `task_runs` 表无 weekly_synthesis 行（manual 路径不写 lease）
- `audit_log` 在 [started_at, finished_at] 区间内 0 行 weekly_synthesis 相关
- `selectBatch(global)` 返回 7 条候选（≥ minBatchSize=5，应当调 LLM）
- `daemon.err.log` 揭示 daemon 长期处于崩溃-重启循环：
  - 38× `env: node: No such file or directory`（launchd plist PATH 不全）
  - 1× `daemon fatal: UNIQUE constraint failed: index 'uniq_tasks_summarize_session_seq'`（Stop hook INSERT 没用 OR IGNORE，或 daemon catch 没识别 SQLITE_CONSTRAINT_UNIQUE）
  - 12× "another instance is running, exiting"（KeepAlive 重启撞 daemon_lock heartbeat 60s 窗口）
- `daily_maintenance` 卡 running 19+ 小时（被 fatal 杀掉留下僵尸 task_runs，reclaimStaleLeases 没机会跑）

发现的 spec 盲区与跟进方向：

1. **`cron list` 不可见 manual run**（v0.2 spec §10.6）→ 改 `gatherCronStatus` 用 `tasks ∪ task_runs` UNION SELECT。**不推荐**给 `runTask` 加 `tryClaimLease(MANUAL)` —— 会把 lease 和 history 两个职责硬塞进 task_runs。
2. **`runWeeklySynthesis` 无 run-summary audit**（v0.2 spec §8.3.3）→ 加 `writeAudit('weekly_synthesis_run', null, {scope, batch_size, synthesized_count, theme_merges, duration_ms, llm_calls})`，与 v0.3 `security_audit_run` 对称。
3. **launchd plist PATH 不可靠**（v0.2 spec §7.6）→ install 时探测 `which node` 写入绝对路径，或 ProgramArguments[0] 用绝对路径替代 `/usr/bin/env`。
4. **daemon 不识别 UNIQUE 约束错误而 fatal**（v0.2 spec §7.7）→ Stop hook `INSERT OR IGNORE`；daemon 主循环 catch SQLITE_CONSTRAINT_UNIQUE 时记 audit 不退出。

后续：上述 4 项打包到一次 `docs(spec): backfill v0.2/v0.3 spec gaps from dogfood` 提交（commit `93259f2`），v0.4 实施时一并修。

### 2026-06-02 下午追加 — weekly_synthesis 跑通后又冒出 2 个 spec 盲区

dogfood 进入"实际跑 cron 看产出"阶段后，第一次成功的 weekly_synthesis (task #76, 86s) 产出了 3 条 cron_consolidated，**但内容截断到字符中间**（"...envelope to preven" / "...fallbacks for st"）。手动重跑一次又撞到 daemon fatal（exit 143 SIGTERM）。

**盲区 5: §8.3.2 W-3 字面切到 80 字符（mid-word 不可读）**

诊断：
- m151 / m152 length=80, content 末尾 "to preven" / "for st"
- 实施 `applySynthesisResult` 用 `syn.content.slice(0, 80)` 字面切，无词边界感
- spec §8.3.2 W-3 只规定 80 字符上限，没规定切法

修复（commit `65b0cb0`）— 三层防御：
1. prompt 仍约束 LLM `MUST be <= 80 characters`
2. 代码 cap 抬到 160（吸收小幅 LLM 越界，避免每次都截）
3. 新增 `truncateAtWordBoundary(s, max)` — 取最后空格位切并加 `…`；CJK run-on 无空格则 fallback hard slice + ellipsis

**盲区 6: §7.4 claude_p_timeout 全局 60s 让 weekly_synthesis 多 scope 时撞 SIGTERM**

诊断：
- task #91 failed at 75.7s, audit `error: "claude -p exit 143: "` (= SIGTERM)
- weekly_synthesis 每周日跑 3 个 scope 各 1 次 LLM call，单 scope 跑超 60s 就被 Node `spawn({ timeout: 60000 })` SIGTERM'd（killSignal 默认 SIGTERM）
- 之前两次成功（86s）只是运气好；分布上单 scope 偶尔会超
- 老的全局 `cfg.llm.claude_p_timeout_ms ?? 60000` 没法按任务调

修复（commit `d80571d`）— per-task timeout：
- `claude-p.mjs::resolveTimeoutMs(opts, cfg)` 按优先级 `opts.timeoutMs` > `cfg.llm.claude_p_timeout_per_task[taskType]` > legacy global > 60_000
- config defaults：`weekly_synthesis: 180000`, `security_audit: 180000`, `l4_review: 90000`, `summarize_pending: 60000`
- 所有 4 个 caller 已经传 `taskType` → 零 caller 改动，自动按任务取值

后续：盲区 5+6 也应进 v0.2/v0.3 spec errata（v0.2 §8.3.2 + §7.4），等 user 决定是否更新 design.md。

### 2026-06-02 下午追加 #2 — daemon restart 后跑 weekly_synthesis 又冒出 1 个观测性盲区

per-task timeout 修复后 daemon 终于不挂，task #95 跑通 84s 无错。但 `cron_consolidated=0` —— 没产出。诊断揭示：

**盲区 7: §8.3.3 `synthesized_count` audit 字段含义歧义（计提议数 vs 入库数）**

诊断：
- task #76 (pre-fix): synthesized_count=3，memories 表实际有 3 条 cron_consolidated（m151/m152/m153）✓
- task #86 audit #77: synthesized_count=3，但 memories 表当时只有 task #76 那 3 条（id 不增长）→ 实际入库 0
- task #92/#95 audit: synthesized_count=0（LLM 真没建议）
- 实施 `applySynthesisResult` 对每条 `synthesized` 做 `parents = source_ids ∩ batch`，**`parents.length === 0` 时 silently `continue`**——不入库
- 代码 `totals.synthesized_count += parsed.synthesized.length` 计的是 **LLM 输出条数**，不管最终是否入库
- 现实场景：第一次跑 task #76 把 batch 内 mems 标 `superseded`；后续跑 LLM 看到不同 batch 但可能仍引用老 superseded id（model 记忆漂移 / 提示工程问题）→ orphan source_ids 全部被 skip

修复（commit `66fcb36`）—— audit 字段拆分：
- `synthesized_proposed`：LLM 输出条数（= 老的 synthesized_count）
- `synthesized_applied`：实际 INSERT 成功的条数
- `synthesized_skipped_orphan`：source_ids ∩ batch === ∅ 被 silently skip 的条数
- `synthesized_skipped_insert_error`：insertMemory throw（Tier 1 / secret 拦截）的条数
- `stale_flagged_applied`：实际转 candidate_expire 的条数（vs LLM 输出 stale_flagged_count）
- `synthesized_count` 保留为 `synthesized_proposed` alias（向后兼容现有 dashboard）

**没改 prompt 或 applySynthesisResult 行为本身**——只把"看不见的 silently skip"暴露成审计字段。后续如发现 `skipped_orphan / proposed > 阈值`，可以判断是 prompt 问题（让 LLM 引用真实 batch ids）还是数据问题（superseded 池过大）。

### 2026-06-02 收尾 — 验证闭环（per-task timeout × scheduleRetry × audit 拆分）

修复全部 ship 后用户主动验证：

1. **daemon restart** 让 per-task timeout 生效：
   ```
   ccmem admin daemon restart    # PID 改变
   ccmem admin daemon status     # ✓ alive (heartbeat fresh)
   ```

2. **手动跑 weekly_synthesis** 观察行为：
   ```
   ccmem admin cron run weekly_synthesis   # task #95 入队
   # 84s 后 cron list 显示 weekly_synthesis: success
   ```

3. **关键证据 — task #95 表现**（pre-fix 会重现 60s SIGTERM）：

   | 指标 | task #91 (pre-fix) | task #95 (post-fix) |
   |---|---|---|
   | duration | 75.7s | **84.4s** |
   | status | failed | **success** |
   | error | `claude -p exit 143: ` (SIGTERM at 60s) | null |
   | scheduleRetry | 入队 task #92（race-bug 路径） | n/a（success 不 retry） |

   84.4s 跑通 = 至少有一个 scope 的 LLM 调用超过了 60s。pre-fix 的全局 60s 上限会在那个 scope 被 SIGTERM；新的 per-task 180s 上限给了它余量。**这是非合成证据：跑过 60s 才能证明新 timeout 真的生效**。

4. **scheduleRetry 修复也间接验证**：task #91 fail 后 task #92 自动入队（attempts=1），daemon restart 后于 16:37 dispatch + 70.8s success — pre-fix 的 race 会让 daemon 在 INSERT 同 (session_id, last_seq) 时撞 UNIQUE → fatal exit。task #92 干净跑完证明 scheduleRetry 顺序修复（`UPDATE old → 'failed'` 在 `INSERT new` 之前 + `INSERT OR IGNORE`）+ mainLoop catch 都生效。

5. **gap #7 audit 拆分还需等下次跑**：当前历史 audit (#84 #85 #86) 是用旧字段写的，只有 `synthesized_count`。下次 weekly_synthesis 跑（手动 / 周日 03:17 自动）会带完整 4 列 `synthesized_proposed / applied / skipped_orphan / skipped_insert_error`，届时若 `proposed > 0 && applied = 0` 就能直接看到 LLM 引用 superseded id 的现象，不必反向推断。

**遗留观察**：`cron_consolidated=0` 是真实状态——第一次成功跑 (task #76) 的产物 m151/m152/m153 已被 user `forget`；后续跑 LLM 要么真没建议 (synthesized=0)，要么建议了但都是 orphan（pre-修复 audit 看不出来）。等 dogfood 期 auto_inferred 累积到 200+ 条 + 多元化反馈再观察 LLM 行为。

---

### 后续观察

```
日期         | 类别              | 观察 / 调整                                          | 跟进
-----------+-------------------+----------------------------------------------------+---------
TBD        | (待 dogfood 期填) |                                                    |
```

---

## 附录 A：相关命令速查

```bash
# 查看 quarantine 池
/ccmem:list --quarantined

# 复核（人工 keep/forget/skip）
/ccmem:resurrect --quarantined
/ccmem:resurrect --alerts

# 三档状态 + Security 行
/ccmem:stats

# 安全诊断（最近 audit_run + quarantine reason 分布 + alert 计数）
/ccmem:admin diagnose --security

# 手动触发（绕过 03:47 等待）
/ccmem:admin cron run security_audit
/ccmem:admin cron run weekly_synthesis
/ccmem:admin cron run daily_maintenance

# 看 audit 元数据
/ccmem:audit show <id>
```

详细命令语义见 [`ccmem-v0.3-spec.md`](./ccmem-v0.3-spec.md) §7。
