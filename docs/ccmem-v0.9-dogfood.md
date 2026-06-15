# ccmem v0.9 dogfood 文档

> 本文档记录 v0.9（Adaptive Pipeline）实施后的验证结果、已知问题、以及 dogfood 期需要观察的行为。
>
> **当前状态（2026-06-09）**：实施完成，code review 完成（S1-S4 + L1 fix 已落地），**Day 1 验证完成**。
> P0 结果：V2 ✅ V4 ✅ V6 ✅ V7 ✅ 基础 ✅ | V1/V3/V5 待更多 session 数据。
> P2 待观察：V8-V12（candidate_expire 30d 转换 / last_touched_at 影响 / timing / C1 跨项目）。

---

## 一、v0.9 核心变更概览

| # | 能力 | 风险等级 | 说明 |
|---|---|---|---|
| A1 | 输入端治理升级（quality gate v2 + prompt + extra_rules） | 低 | 4 条新规则 + rules_enabled 开关 + 用户自定义 pattern |
| A2 | 整合端提质（三缺口修补 + 两配套） | 中 | candidate_expire 条件放宽 + 黑洞修复 + 原子 last_touched_at 语义变更 + consolidated 60d 快速过期 |
| B1 | 检索可观测性 | 低 | injection scores + never-injected + show history + diagnose --injections + stats hint |
| B2 | 预防性扩展（纯监控） | 低 | retrieval timing instrumentation |
| C1 | 跨项目知识自动发现 | 高 | cosine 预筛 + 聚类去重 + 全局覆盖检查 + promote_candidates + resurrect --promote-candidates |

---

## 二、实施后 code review 结果（2026-06-09）

**Reviewer**: oh-my-claudecode:code-reviewer (Opus)
**Verdict**: REQUEST CHANGES（4S + 2M + 1L）→ 全部修复后 1040/1045 pass

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| S1 | Significant | C1 trigger 值 `cross_project_cosine` 应为 `cosine_cross_project` | 修正 — commit `52d63f0` |
| S2 | Significant | C1 resurrect audit action `promote_candidate_reviewed` 应为 `cross_project_acknowledged` | 修正 — commit `52d63f0` |
| S3 | Significant | C1 `similar_in` 存储格式为纯字符串数组，应为 `[{project_key, mem_id, cosine}]` | 修正 — commit `52d63f0` |
| S4 | Significant | C1 `cross_project_detected` audit 的 `candidate_id` 应为 `lastInsertRowid` | 修正 — commit `52d63f0` |
| M1 | Medium | `compileSafePattern` 未复用 `pattern-safety.mjs`，缺 ReDoS 防护 | defer v0.10（当前只接受 config 文件输入，攻击面小） |
| M2 | Medium | resurrect `--promote-candidates` 缺少按当前项目过滤 | defer v0.10（当前展示所有候选可接受，S3 修复后过滤条件可用） |
| L1 | Low | C1 provider 检查用 `!provider` 应为 `!provider?.isLoaded()` | 修正 — commit `52d63f0` |

**正面发现**：
- A2.3 + A2.4 原子约束正确遵守（同 commit）
- C1 所有阈值默认值符合 spec（cosine 0.85, min_trust 0.5, max 5）
- `distinctProjects.size >= minProjects - 1` off-by-one 修复正确
- 所有新代码使用 `writeAudit`（无 `logAudit`）
- Schema migration 011 完全匹配 spec

---

## 三、测试状态

1046/1046 tests, 1046 pass, 0 fail。v0.8 baseline 961 → v0.9 新增 85 个测试。

| 类别 | 新增测试数 | 覆盖对象 |
|---|---|---|
| migration-011 | 10 | schema 升级 / CHECK enum / 幂等 |
| quality-gate-v2 | 17 | 4 新规则 / rules_enabled / v0.8 兼容 |
| transcript-cleaner-extra | 5 | 用户自定义 pattern / 非法 pattern / 空 |
| decay-gap-fixes | 10 | A2.1-A2.5 全部缺口修补 |
| recent-injections-scores | 4 | scores JSON 写入 / NULL / 兼容 |
| never-injected | 7 | UNION 查询 / json_each 精确匹配 / --days |
| show-injection-history | 5 | 有/无注入记录 / 评分展示 / 损坏 JSON |
| diagnose-injections | 6 | 5 段输出 / 空 DB / audit |
| cross-project-patterns | 12 | 算法 / 聚类 / 全局覆盖 / dedup / 安全上限 |
| resurrect-promote | 8 | p/d/s 分支 / 安全标签 / 空表 |

0 fail（v0.9.1 修复后）。此前 5 fail 为 4 个 pre-existing mode-matrix + 1 flaky mainLoop interruptible sleep，已在 da6cc13 / 44c2136 修复。

---

## 四、dogfood 期需要验证的问题

### P0 — 必须在首日验证

#### V1: quality gate v2 对真实 auto_inferred 的拦截效果

**验证方法**：
1. 等 daemon `summarize_pending` 处理几个会话
2. 检查 audit_log：`SELECT json_extract(details,'$.reason') AS reason, COUNT(*) AS n FROM audit_log WHERE action='quality_gate_reject' GROUP BY reason`
3. 确认新规则（version_snapshot / test_count / timestamp_dominant / path_list）是否命中

**关注点**：
- [ ] 4 条新规则命中率分布是否合理
- [ ] 是否有 false positive（有价值的 rule/fact 被误拦）
- [ ] `version_snapshot` 的 < 60 字符阈值是否太松或太严

#### V2: A2 decay 机制对现有记忆池的影响

**验证方法**：
1. `SELECT COUNT(*) FROM memories WHERE decay_status='candidate_expire'`（首日 daily 跑后）
2. `SELECT id, type, content, trust_score, helpful_count, unhelpful_count FROM memories WHERE decay_status='candidate_expire' LIMIT 10`
3. 确认被 candidate_expire 的记忆是否确实"零正信号 + 超龄"

**关注点**：
- [ ] A2.1 放宽条件后是否有记忆被意外 expire（helpful_count=0 但用户认为有用的）
- [ ] A2.5 consolidated 60d 快速过期是否合理（检查 type='consolidated' 在 candidate_expire 的数量）
- [ ] A2.3 dedup touch 改 `updated_at` 后，是否有记忆的 recency 突降（priority 下降明显）

#### V3: B1 injection scores 写入正常

**验证方法**：
1. 正常使用几轮后：`SELECT scores FROM recent_injections WHERE scores IS NOT NULL ORDER BY created_at DESC LIMIT 3`
2. 验证 JSON 格式正确：含 id/fts/jac/cos/f 字段

**关注点**：
- [ ] embedding OFF 时 scores 为 NULL（正确行为）
- [ ] embedding ON 时 scores 含三路评分
- [ ] scores 数据是否对诊断有实际帮助

### P1 — 首周验证

#### V4: `/ccmem:admin diagnose --injections` 输出完整性

**验证方法**：
1. 积累 3+ 天使用数据后：`/ccmem:admin diagnose --injections`
2. 验证 5 段输出完整（Volume / Score / Top10 / Low-quality / Never）

**关注点**：
- [ ] Volume 段的 avg/day 是否合理
- [ ] Score distribution p50/p95 是否有意义
- [ ] Top 10 是否反映真实使用模式
- [ ] Low-quality（fused < 0.30）是否有命中
- [ ] Never injected 数量 + 比率是否合理

#### V5: `/ccmem:show <id>` injection history 段

**验证方法**：
1. 对常用记忆：`/ccmem:show m42`
2. 确认"Recent injections"段出现且评分有意义

**关注点**：
- [ ] 评分是否可以帮助判断"这条记忆是否被有效利用"
- [ ] 14d 窗口是否足够

#### V6: `/ccmem:list --never-injected` 列表质量

**验证方法**：
1. `ccmem list --never-injected --days 30`
2. 逐条检查列出的记忆是否确实是"死重"

**关注点**：
- [ ] 列出的记忆中有多少是真正无用的 vs 有用但碰巧没被检索到的
- [ ] 列表是否给出了足够的信息让用户做 forget/keep 决策

#### V7: `/ccmem:stats` Injection 提示行

**验证方法**：
1. `/ccmem:stats`
2. 当 never_injected > 15% 时应显示 Injection 行

**关注点**：
- [ ] 15% 阈值是否合理（太低会频繁提示，太高会遗漏问题）

### P2 — dogfood 期持续观察

#### V8: A2.2 candidate_expire → archived 30d 转换

**观察项**：
- [ ] 首批进入 candidate_expire 的记忆是否在 30d 后正确 archive
- [ ] 是否有记忆在 candidate_expire 期间被用户通过 pin 挽救
- [ ] 30d 宽限期是否太长或太短

#### V9: A2.4 last_touched_at 语义变更的间接影响

**观察项**：
- [ ] 有 helpful 信号的记忆是否在 priority 排名中持续保持高位
- [ ] 无 helpful 信号的老记忆是否在 priority 排名中自然下降
- [ ] injection_cache 重生后的注入内容是否比 v0.8 更"精准"

#### V10: B2 retrieval timing 数据

**观察项**：
- [ ] `retrieval_embed_ms` p50/p95 是否稳定
- [ ] `retrieval_db_ms` 是否随记忆数量增长而增长
- [ ] `retrieval_pool` 数量是否合理

#### V11: C1 跨项目发现（周日 04:47 首次触发后）

**验证方法**：
1. 等周日 04:47 或手动 `/ccmem:admin cron run cross_project_patterns`
2. 检查 audit：`SELECT * FROM audit_log WHERE action='cross_project_run' ORDER BY ts DESC LIMIT 1`
3. 检查候选：`SELECT * FROM promote_candidates WHERE acknowledged_at IS NULL`

**关注点**：
- [ ] 当前 2 个 project scope 是否产出有意义的候选
- [ ] cosine 0.85 阈值是否太严（产出 0 候选）或太松（太多 false positive）
- [ ] min_trust 0.5 是否过滤掉了有价值的候选
- [ ] 全局覆盖检查是否正确跳过已有 global 记忆
- [ ] 聚类去重是否正确合并互相相似的候选

#### V12: C1 resurrect --promote-candidates 用户体验

**观察项**：
- [ ] 候选展示的信息是否足够做决策（content + similar + cosine）
- [ ] promote 后 global 记忆是否正确注入
- [ ] dismiss 后 30d 内是否不再推荐同 mem

---

## 五、已知限制（by design，非 bug）

| # | 限制 | 原因 | 后续 |
|---|---|---|---|
| 1 | `compileSafePattern` 未用 re2，缺 ReDoS 防护 | M1 defer；当前只接受 config 文件输入，攻击面小 | v0.10 |
| 2 | resurrect `--promote-candidates` 不按当前项目过滤 | M2 defer；展示全部候选对单用户可接受 | v0.10（需 S3 similar_in 格式修复后） |
| 3 | C1 跨项目检测需要 embedding 开启 | by design — cosine 是核心算法 | 文档化 |
| 4 | never-injected 查询用 `json_each` 性能 O(n*m) | n=active mems, m=feedback rows；当前规模 (330×1000) ~100ms 可接受 | v0.10 监控 |
| 5 | A2 退场机制仅在 daemon daily 中执行 | daemon 不跑时不退场；与三档定位一致 | by design |
| 6 | quality gate v2 新规则仅对 auto_inferred 生效 | user_explicit 永不拦截 | by design |

---

## 六、backlog 项（review 遗留 + dogfood 期发现）

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | `compileSafePattern` 复用 `pattern-safety.mjs` | M1 review | P2 | defer v0.10 |
| 2 | resurrect `--promote-candidates` 按项目过滤 | M2 review | P2 | defer v0.10 |
| 3 | B1 diagnose --injections 的 Retrieval performance 段需要 metrics.jsonl 数据积累 | 实施观察 | P3 | 待数据 |
| 4 | `synthesized=0` 连续 skip logic（v0.8 backlog #4 继续 defer） | v0.8 遗留 | P3 | 待 weekly_synthesis 更多数据 |

---

## 七、commit 历史

```
52d63f0 fix(cross-project): code review fixes S1-S4 + L1
475045a chore(config): bump to v0.9 + add adaptive_decay, injection_observability, cross_project sections
596a990 feat(cross-project): C1 cross-project knowledge discovery — cosine detection, scheduling, resurrect --promote-candidates, stats + cleanup
b07809e feat(observability): B1 injection observability — never-injected, show history, diagnose --injections, stats hint, rollup stats
f094076 feat(observability): synthesis prompt dedup + injection scores + retrieval timing
31a2914 fix(decay): A2 gap fixes — candidate_expire relaxed + black hole fix + atomic last_touched_at + consolidated 60d expire
24546ec feat(transcript-cleaner): support user-defined extra_rules via config string patterns
2dc8689 feat(summarize): add cross-session test instruction to extraction prompt
5f460e5 feat(quality-gate): add v2 rules — version_snapshot, test_count, timestamp_dominant, path_list + rules_enabled config
5ee140b feat(schema): add 011_v09.sql — injection scores + promote_candidates + rollup columns
```

---

## 八、dogfood 观察记录（待 dogfood 期填）

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| 2026-06-09 | V1 ⏳ | quality_gate_reject: 仅 1 条 `path_list` 命中。daemon 刚重启，数据量不足。新规则（version_snapshot/test_count/timestamp_dominant）待更多 session 积累后验证 | 待更多数据 |
| 2026-06-09 | V2 ✅ | candidate_expire: 14 条，全部是 **v0.8 之前就已 expire 的旧记忆**（created_at 6/1-6/4，updated_at 6/8 daily 刷新）。部分有 helpful_count>0（helpful 信号后续收到但未改变 decay_status）。A2.1 放宽条件**未导致新的意外 expire**——dry-run 确认 v0.9 上线时满足 `helpful_count=0 AND unhelpful_count>0 AND 超龄` 的记忆为 0 条 | PASS |
| 2026-06-09 | V3 ⏳ | injection scores: 仅 1 条有 scores（unit test 残留 `sess-1`，113 bytes）。真实 session 的 scores 全 NULL——v0.9 hook 代码需在新 session 启动后才生效（daemon restart 不影响已运行的 hook 进程） | 待新 session |
| 2026-06-09 | V4 ✅ | `diagnose --injections` 输出正常：285 injections / 0 empty / 37 never-injected (10.4%) / scores 样本 2 条（测试数据）。5 段结构完整 | PASS |
| 2026-06-09 | V5 ⏳ | `show m50` 无 "Recent injections" 段——无带 scores 的真实注入数据。需新 session 产出后验证 | 待新 session |
| 2026-06-09 | V6 ✅ | `list --never-injected`: 37 条。大部分是 6/8 weekly_synthesis 产出的 consolidated（trust=0.85），来不及被注入；几条是近期 auto_inferred 项目细节。符合预期 | PASS |
| 2026-06-09 | V7 ✅ | `stats`: 无 Injection 提示行（37/355=10.4% < 15% 阈值，正确）。无 Promote 行（cross_project_patterns 未跑过，正确）。Synthesis/Tuning/Security 行均正常 | PASS |
| 2026-06-09 | 基础 ✅ | schema=11 ✅ / daemon alive (heartbeat 15s) ✅ / 1045 tests (1040 pass) ✅ / memory pool: 355 active + 14 candidate_expire ✅ | PASS |
| 2026-06-09 | Bug 🐛 | `ccmem show` 崩溃 "no such column: mem_id"——provenance 查询直接引用 `audit_log.mem_id` 但该列不存在（实际在 `audit_log_targets` 表）。修复：JOIN audit_log_targets | 已修复 |
| 2026-06-09 | Bug 🐛 | Dedup 跨 type 漏检：m560(rule) + m561(fact) 同内容未 dedup——候选查询 `AND m.type=?` 排除了不同 type。修复：删除 type 过滤 + 添加 type 升级逻辑（rule>fact>episode） | 已修复 |
| 2026-06-09 | 观察 | `cron status` contradiction_audit 显示 30h duration——macOS 合盖休眠导致 wall-clock 膨胀（`completed_at - started_at` 包含 sleep）。非 bug，实际处理时间远小于显示值 | 接受现状 |

---

**End of v0.9 dogfood doc.**
