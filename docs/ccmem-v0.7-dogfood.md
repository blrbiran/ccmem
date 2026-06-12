# ccmem v0.7 dogfood 文档

> 本文档记录 v0.7（Semantic Leverage & Knowledge Maturity）实施后的验证结果、
> 已知问题、以及 dogfood 期需要观察的行为。
>
> **当前状态（2026-06-04）**：实施完成，code review 完成，待 dogfood。

---

## 一、v0.7 核心变更概览

| # | 能力 | 风险等级 | 说明 |
|---|---|---|---|
| 1 | CJK 分词改进（Intl.Segmenter） | 低 | tokenize() 对 CJK 段按词切分；零依赖 |
| 2 | 语义 dedup 升级（cosine+trigram 双路） | 中 | Tier 2.5 内部升级；embedding 关闭时降级 |
| 3 | L1+L2.5 per-session dedup | 低 | 同 mem 同 session 最多 +0.025 一次 |
| 4 | import embedding pending 提示 | 低 | 一行 stderr |
| 5 | --metrics embedding 进度 | 低 | 只读展示 |
| 6 | contradiction_audit 独立 cron | 高 | O(n²) cosine + LLM 调用；新表 + 新 audit actions |
| 7 | --tuning 2 条新规则 | 中 | embedding 权重 + L1 阈值建议 |
| 8 | project_key alias 命令 | 低 | 批量 UPDATE + verbatim 确认 |
| 9 | monthly_meta_synthesis | 高 | 新 LLM 任务；consolidated → meta-consolidated |
| 10 | 智能 weekly_synthesis clustering | 中 | clusterBatch 改变 LLM 输入分组 |

---

## 二、实施后 code review 结果（2026-06-04）

**Reviewer**: oh-my-claudecode:code-reviewer (Opus)
**Verdict**: COMMENT（2S + 1M，均已修复）

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| S1 | Significant | contradiction-audit batchPairIds 用单 ID 而非 pair-key → LLM 可构造跨 pair 矛盾 | 改为 pair-key Set (`"a_b"` / `"b_a"`) — commit `db60fd1` |
| S2 | Significant | metrics-rollup 未写 `vec_backfill_embedded` → 嵌入速率永远显示 0/day | 加 `vec_backfill_run` audit 聚合 + INSERT — commit `db60fd1` |
| M1 | Minor | feedback-stop.mjs 仍用 logAudit（pre-existing v0.2，非 v0.7 回归） | defer（不阻塞 v0.7） |

**正面发现**：
- 所有 critic C-1~C-4 / S-3 / S-5 修复验证正确
- async 安全：所有 `insertMemory` caller 正确 await
- LLM prompt 防注入：两个新 prompt 均含 S-4 defense
- 优雅降级：CJK / cosine dedup / clustering 各有 fallback

---

## 三、测试状态

857/857 pass，0 fail。v0.6 baseline 778 → v0.7 新增 79 个测试。

| 类别 | 新增测试数 | 覆盖对象 |
|---|---|---|
| migration-008 | 7 | schema 升级 / constraint / 幂等 |
| tokenize-cjk | 5 | Intl.Segmenter / 降级 / 过滤 |
| dedup-cosine | 7 | 双路评分 / 降级 / audit lane |
| per-session-dedup | 8 | json_each / L1+L2.5 协同 |
| contradiction-audit | 10 | cosine 预筛 / 30d 去重 / 越权防御 |
| resurrect-contradictions | 8 | a/b/B/s 分支 / ack / 空状态 |
| contradiction-e2e | 4 | 全管线 / 30d 去重 / 复活流 |
| cluster-batch | 8 | 聚类 / 降级 / 阈值 / misc 合并 |
| monthly-meta | 15 | 阈值 / depth / 截断 / camelCase / supersede |
| alias | 6 | UPDATE / 确认 / 0 matches / cache |
| tuning rules 6-7 | (existing test updated) | 7 条规则集成 |

---

## 四、dogfood 期需要验证的问题

### P0 — 必须在首日验证

#### V1: contradiction_audit 在真实会话中触发

**验证方法**：
1. 确认 daemon 在跑（`/ccmem:admin daemon status`）
2. 手动触发：`/ccmem:admin cron run contradiction_audit`
3. 检查 audit_log：`SELECT * FROM audit_log WHERE action='contradiction_audit_run' ORDER BY ts DESC LIMIT 1`
4. 如有矛盾对：`/ccmem:resurrect --contradictions` 流通

**关注点**：
- [ ] cosine 预筛是否产生合理数量的 candidate pairs
- [ ] LLM 判定结果是否准确（真矛盾 vs 误判互补）
- [ ] O(n²) 开销在当前 mem 数下是否可接受

#### V2: CJK Jaccard 改进效果

**验证方法**：
1. `/ccmem:list "路由统一" --score` — 检查 Jaccard 列是否 > 0
2. `/ccmem:list "使用 TypeScript" --score` — 中英混合 Jaccard 区分度
3. 对比 v0.6 时的检索结果差异

**关注点**：
- [ ] CJK Jaccard 分数分布有梯度（非全 0 或全 1）
- [ ] 检索质量主观提升

#### V3: per-session dedup 防止 trust 误抬

**验证方法**：
1. 在会话中说"对，就这样"后查 `memory_feedback` 表
2. 同一会话再说"对" → 验证同 mem 不被再次 boost

**关注点**：
- [ ] `json_each` 精确匹配工作（低 ID mem 不被系统性去重阻断）

### P1 — 首周验证

#### V4: 语义 dedup 双路效果

**验证方法**：
1. 等 daemon `summarize_pending` 产出几条 `auto_inferred` 记忆
2. 检查 `audit_log WHERE action='summarize_skip_duplicate'` 的 `lane` 字段
3. 是否有 `lane='cosine'` 的命中（语义重复被 cosine 路径拦截）

**关注点**：
- [ ] cosine 0.85 阈值是否太严（近义重复没被拦） 或太松（不同事实被误判重复）

#### V5: weekly_synthesis clustering 效果

**验证方法**：
1. 等周日 03:17 weekly_synthesis 触发
2. 检查 `audit_log WHERE action='weekly_synthesis_run'` 的 `llm_calls` 字段
3. 多个 cluster → 多个 LLM calls（vs v0.6 每 scope 一次）

**关注点**：
- [ ] clustering 是否让 LLM 整合质量主观提升
- [ ] 无 embedding 的 mem 是否仍被正确 synthesize（misc cluster 兜底）

#### V6: monthly_meta_synthesis 触发条件

**验证方法**：
1. 检查当前 consolidated 数量：`SELECT COUNT(*) FROM memories WHERE type='consolidated' AND status='active'`
2. 如 < 30 → 需等 weekly_synthesis 积累足够 consolidated
3. 如 ≥ 30 → 每月 1 日检查 `task_runs WHERE type='monthly_meta_synthesis'`

**关注点**：
- [ ] 当前使用阶段 consolidated 数量是否会达到 30 的阈值
- [ ] 如阈值过高，考虑 dogfood 期临时降低

#### V7: admin alias 命令

**验证方法**：
1. 查看当前 project_key：`ccmem list --json | jq '.[0].project_key'`
2. 不真实使用（避免破坏数据），只验证 `ccmem admin alias --help` 输出正常

### P2 — dogfood 期持续观察

#### V8: contradiction_audit O(n²) 性能

**观察项**：
- [ ] `audit_log WHERE action='contradiction_audit_run'` 的 `duration_ms`
- [ ] 随 mem 数增长，duration 是否线性增长
- [ ] > 5K mems 时是否需要 ANN 优化（v0.8 决策点）

#### V9: tuning rules 6-7 信号积累

**观察项**：
- [ ] `cosine_contribution` 在 metrics.jsonl 中出现频率
- [ ] 30d 后 `--tuning` 是否能产出 embedding 权重建议
- [ ] `revalidation_resurrect` 数据是否足以触发 L1 阈值建议

#### V10: clusterBatch misc 合并行为

**观察项**：
- [ ] misc cluster 大小分布
- [ ] 是否有 mem 因为 misc 过大导致 LLM prompt 超长
- [ ] 无 embedding 比例对 clustering 效果的影响

---

## 五、已知限制（by design，非 bug）

| # | 限制 | 原因 | 后续 |
|---|---|---|---|
| 1 | contradiction_audit O(n²) | 个人用户 < 2K mems，~500ms 可接受 | v0.8 加 ANN 或分桶优化 |
| 2 | monthly_meta 阈值 30 可能在自用阶段不触发 | consolidated 池需要积累 | dogfood 期可临时降低 |
| 3 | CJK Segmenter 对纯中文无标点有效但粒度受 ICU 数据影响 | Intl.Segmenter 行为依赖 Node.js ICU 版本 | 可接受差异 |
| 4 | L1+L2.5 dedup 的 `json_each` 比 LIKE 稍慢 | 精确匹配换取正确性 | < 1ms，不影响预算 |
| 5 | contradiction_alerts 无 `merge` 选项 | 需额外 LLM 调用 | v0.8+ |

---

## 六、实施期间发现并修复的问题

| # | 问题 | 来源 | 修复 |
|---|---|---|---|
| 1 | `insertMemory` async 化级联 12 个文件 | Task 3 实施 | 所有 caller + tests 更新 |
| 2 | memory_feedback CHECK 约束缺 `helpful_implicit_partial` | Task 4 latent bug | 改用直接 UPDATE + adjustTrust |
| 3 | `.toLowerCase()` 导致 resurrect `B` (keep_both) 不可达 | Task 10 实施 | 改为 `.trim()` only |
| 4 | evidence JSON 格式不一致（字符串 vs JSON 对象） | Task 16 e2e 发现 | 统一为 `JSON.stringify({llm_reason: ...})` |
| 5 | batchPairIds 用单 ID 防御弱于 pair-key | code review S1 | 改为 pair-key Set |
| 6 | vec_backfill_embedded rollup 列未写入 | code review S2 | 加查询 + INSERT 列 |

---

## 七、commit 历史

```
db60fd1 fix(v0.7): pair-key defense + vec_backfill_embedded rollup
695bd50 docs: update admin.md for v0.7 commands
fdf5938 feat(weekly): add embedding clustering for topic-aware synthesis
c3dc8fd feat(daily): add step 18 monthly_meta_synthesis trigger
d9e64b2 feat(monthly): implement monthly_meta_synthesis core
07c0e8c feat(admin): add /ccmem:admin alias command
...     (+ task 7-11 commits)
05c6a6b feat(tokenize): add Intl.Segmenter CJK word segmentation
4c03897 feat(schema): add 008_v07.sql — contradiction_alerts + contra_detected
```

---

## 八、dogfood 观察记录（待 dogfood 期填）

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| 2026-06-04 | V1 | contradiction_audit 入队成功，但完整执行需 daemon + claude -p 环境 | 待 daemon 环境验证 |
| 2026-06-04 | V2 ✅ | CJK Jaccard 有梯度：Jaccard("路由统一","统一放在 /app/api/")=0.333 (v0.6 为 0)。"方法"被正确切分。 | PASS |
| 2026-06-04 | V3 ✅ | json_each 精确匹配：memId=1 vs [11,12,13]=false, memId=11=true, 跨 session=false | PASS |
| 2026-06-04 | V4 ✅ | dedup 双路：trigram 命中✅, cosine+FTS 重叠命中✅, 无 FTS 召回时 cosine 不检查(by design)✅ | PASS |
| 2026-06-04 | V5 ✅ | clusterBatch：2 similar→1 cluster, 1 different→standalone, 1 null→standalone。3 clusters 正确 | PASS |
| 2026-06-04 | V6 | consolidated=0，< 30 阈值，不触发 monthly_meta。需等 weekly_synthesis 积累 | 待积累 |
| 2026-06-04 | V7 ✅ | alias 命令正确：无参数时输出 usage；函数签名正确接受 oldKey/newKey | PASS |
| 2026-06-04 | 质量审计 | 428 条全 auto_inferred，170(40%)含版本/commit 关键词但仅 28(6%)是纯噪音。已批量清理 28 条。 | 完成 |
| 2026-06-04 | prompt优化 | summarize_pending prompt 加 "Do NOT extract" 约束（5 类噪音）。commit `596a9b0` | 完成 |
| 2026-06-04 | **BUG-1** | weekly_synthesis 521s / 7 LLM calls / synthesized=0。根因：ccmem 项目 35 条 mem 在同一 cluster，LLM 无法聚焦。 | fix `f4fe815` |
| 2026-06-04 | **BUG-2** | contradiction_audit fail "unknown task type"。根因：daemon 进程是 v0.7 dispatch 代码落地前启动的。手动 restart 修复。 | daemon restart |
| 2026-06-04 | **BUG-3** | daily_maintenance fail "Unexpected reserved word"。根因：async bug 修复前的 daemon 缓存（已在 v0.6 48d8fcb 修复，daemon 未重启）。 | daemon restart |
| 2026-06-04 | **BUG-4** | cron list SQL GROUP BY + MAX 反模式：status 来自任意行而非最新行；显示 started_at 而非 finished_at | fix `070ff12` |
| 2026-06-04 | **BUG-5** | cron list 显示 UTC 时间，用户需手动换算时区（CST = UTC+8） | fix `141be89` |
| 2026-06-04 | weekly_synthesis #2 | maxClusterSize=15 后重跑：749s / 10 LLM calls / synthesized=0。cluster 拆分生效但记忆碎片化导致 LLM 仍无法整合。待更多数据积累。 | 观察中 |

---

**End of v0.7 dogfood doc.**
