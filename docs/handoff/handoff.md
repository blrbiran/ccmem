# ccmem v0.13 — Handoff

> v0.13 是 **已完成并合并** 状态。本文档面向接手 v0.14（或收尾 v0.13 残留事务）的 agent。
> 更新于 2026-08-01，最终全分支 review + 单轮修复波 + scoped re-review 全部结束之后。

## 先读这些，按顺序

| 材料 | 是什么 | 为什么需要 |
|---|---|---|
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger | **每一条人类裁决及其理由**，全部延期项，以及 7 次「计划本身有缺陷」的记录。这是唯一记录了「什么改变了计划」的地方，git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 最终 review 的完整发现清单 | 3 Critical + 10 Important 的原文、证据与修复要求，末尾附 **明确不在本次范围内的 follow-up 清单** —— 那就是 v0.14 的待办来源。 |
| `docs/ccmem-v0.13-spec.md` | v0.13 规范 | §0.4（live-DB 证据）与 §0.5（为什么 L2.5 的真修复被推迟）是承重的。 |
| `docs/superpowers/plans/2026-07-31-ccmem-v0.13.md` | 实施计划 | 已全部执行完。末尾 Final Verification 一节已按落地实际修正过（附录 A 不变量现为 120–135，共 16 条）。 |

本文档只做索引与提要，不要仅凭它重建状态。

## Git 状态

**不要相信本文档里出现的任何 commit SHA** —— 提交这份文档本身就会移动 HEAD。用 `git log --oneline` 确认真实位置，并与 ledger 中各 `Task N: complete (commits …)` 行交叉验证（那些范围记录的是任务关闭当时的状态）。

需要知道的事实，而非 SHA：

- v0.13 的全部工作 **已 fast-forward 合并进本地 `main`**，合并结果上重跑过完整套件。
- 本地 `main` **领先 `origin/main`，尚未推送**。人类自己处理所有 push —— 不要代为推送。
- 分支 `v0.13-spec` **未删除**（全局规则：删分支必须先问）。远程 `origin/v0.13-spec` 仍在，落后于本地。工作已在 `main` 上，删不删都不影响正确性。
- 工作区在交接时干净，没有未 review 的提交。

## v0.13 实际交付了什么

三条线：**A1** 观察型 L2.5 探针 + `admin diagnose --feedback`；**A2** 入库收紧（两条 quality-gate 规则）；**B1/B2/B3** embedding 签名版本化、`temporal_type` 回归测试、recall-loop 回归测试。

结项验证（可复跑）：完整套件 **449 通过 / 0 失败**；附录 A 不变量 **16/16**；live DB `SUM(trust_score)` 在真实使用前后**完全不变**（期间 hooks 实际运行并新增了 63 条探针行，因此这不是走过场）。

**v0.13 不改 trust 行为**，记忆库在本版仍会持续增长 —— 这是预期，不是回归。

## ⚠ 给 v0.14 的核心情报：第一批真实数据

这是本次发布存在的全部意义，也是你接手后最该先看的东西。跑 `node scripts/cli.mjs admin diagnose --feedback` 看当前值。交接时的首批结果：

- 信号组（turn-aligned, non-CJK）`l25_cov` p50 ≈ 0.103
- **随机对照组**（never-injected-this-session, non-CJK）`l25_cov` p50 ≈ 0.125

**噪声底可能高于信号本身。** 样本量还很小（随机组个位数），不能定论，但这正是 v0.14 必须回答的问题：*任何阈值是否可行*。在最终 review 的修复波补上随机对照组之前，这个问题根本无法提出。

同时注意：`l25_legacy_hit` 在全部已收集行中 **恒为 0**。旧匹配器确实几乎不触发（这印证了发布前提），但也意味着**没有任何正例标签**用于校准。

计划明确写了：**必须人工标注约 50 个样本**（"这条回复真的用到了这条记忆吗"）才能算 precision/recall，分布本身定不出阈值。探针行现在带 `reply_head` / `mem_head` / `transcript_path` 就是为此 —— 早期行没有这些字段，读取端会把它们归入 `unclassified`。

## 人类裁决 —— v0.14 同样受约束，不得静默推翻

完整理由在 ledger。最容易被误伤的：

1. **探针读 `recent_injections`，绝不读 `memory_feedback`。** 后者的 `outcome` 会被先于探针运行的反馈逻辑就地改写，读它会静默丢掉所有旧匹配器触发过的轮次。由不变量 #130/#131 守护。
2. **探针只标注，不抑制。** 无新注入的轮次仍然记录。此裁决有效。
   *经最终 review（C3）修正*：这些行曾被当作**负对照组**，但它们不是。ccmem 经 `additionalContext` 注入，内容会在该会话后续每一轮持续存在于模型上下文中，所以被重复测量的是**陈旧注入**而非"不在上下文里的记忆"；而且在 281 条真实行里它们触发了 **0 次**。现已标为 `control: 'stale_injection'`；真正的噪声底是独立队列：每轮随机抽取 K 条**本会话从未注入**的记忆对同一条回复打分，标为 `control: 'random'`。**`control` 是权威的队列字段**，`turn_aligned` 仅为兼容更早的行而保留。
3. **`metrics.decision_data.enabled` 控制的是持久性，不是存在性。** 为 false 时探针行回落到 `metrics.jsonl`，绝不丢弃。
4. **`retention_days: 0` 表示永不自动删除** —— 刻意与运行时清理语义相反，因为 ccmem 自己的 14 天 `recent_injections` 保留策略已经销毁过本次发布最需要的数据一次。
5. **清理逻辑放 `scripts/lib/tier15.mjs`，不放 `daily-maintenance.mjs`** —— ccmem 的 daemon 是可选的。
6. **`scripts/lib/config.mjs` 里的 `DEFAULT_CONFIG` 是权威配置源**，`config.default.json` 是由测试保持同步的面向用户的镜像，`loadConfig()` 从不读它。新增配置键**两边都要加**（同步测试是递归全深度比较）。
7. **`diagnose --feedback` 不跑 tier-1.5 前奏**（与其兄弟子命令不同），以保证"v0.13 不写 decay 状态"对它字面成立。
8. **`env_failure` 长度门限按脚本分档**（含 CJK 用 50，其余 120）—— `.length` 把一个汉字与一个拉丁字母同等计数，单一阈值无法同时服务两者。

## v0.14 的待办来源

`final-review-findings.md` 末尾的「NOT in this wave」清单是权威版本。其中两条建议优先：

- `semantic.mjs` 强制 `enabled: true` 构造签名配置，而 `diagnose.mjs` 用原始 cfg —— 当「配置文件禁用 embedding 且 `config_kv` 未设」时，`admin semantic status` 与 `admin diagnose --retrieval` 仍会给出互相矛盾的答案（这是最终 review I4 修掉的那类问题的残留窄化版本）。
- 随机对照组的排除范围只有 `recent_injections` 那么宽，而 tier15 会把它裁到每会话 20 条 —— 超长会话有约 1.8% 的污染率（k=3）。误差方向保守（会抬高噪声底），但应记入分析笔记。

另有两个 daemon 测试抖动（`stop-daemon-flow`、`admin-daemon-command`）多次复现、每次隔离运行均通过、确认早于本分支 —— 建议合并为一个 issue 跟进，不阻塞。

## 这套流程为什么值得继续用

八个任务里有五个需要 fix round，失败形态高度一致：**代码能跑、测试全绿、缺陷只表现为悄悄错掉的数据**。**七次**问题根源在规范/计划/review 本身而非实现（包括最终 review 自己有一条发现是错的，被修复者成功反驳）。

两条实践几乎抓住了全部：

- **每轮 fix 之后做 scoped re-review** —— 不是重跑任务 review，而是只针对修复 diff 对每条发现判定 ADDRESSED / NOT ADDRESSED。
- **每个回归测试都必须先被亲眼看着变红才接受。** 破坏行为 → 确认红 → 还原 → 记录证据。仅此一条就抓出了多个恒绿无效测试，最终 review 中还有两条发现（I1、I6）的存在原因正是「测试根本不可能失败」。

不要让实现者的自评替代任务 review，也不要把"测试通过"当成"测试能失败"的证据。

## 建议使用的 skills

- **`superpowers:brainstorming`** —— v0.14 要先定"阈值是否可行"的判定方法，属于设计问题，先发散。
- **`superpowers:writing-plans`** —— 定下方向之后。v0.13 的计划本身被证明有 4 处缺陷，新计划里的测试代码要当作草稿而非圣经。
- **`superpowers:subagent-driven-development`** —— 有计划之后的执行工作流。ledger 中带 `Task N: complete` 的不要重派。
- **`superpowers:systematic-debugging`** —— 若从"噪声底 ≥ 信号"这个现象入手排查。

v0.13 的 spec 与 plan 都已履行完毕，不需要再读作待办。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`、`.wolf/anatomy.md`）已 gitignore，单独维护。**bug-052（L2.5 匹配器）按设计保持 open** —— v0.13 只做了插桩，真修复是 v0.14 且依赖本版收集的数据。bug-053/054 已标记修复。
- SDD workspace 被**刻意保留**而非按工作流默认删除：它承载全部人类裁决及理由、最终 review findings、8 份任务报告，git 历史一条都不记录，而 v0.14 直接依赖这些决策。
- 探针决策流 `l25-probe.jsonl` 无上限设计（`retention_days: 0`），单行约 1.3 KB，每个 turn-aligned 轮次最多 11 行。`diagnose --feedback` 会打印其磁盘占用 —— 这是刻意让运行时成本可见，不要"优化"掉。
- 本次运行的所有产物中不含任何凭据或个人数据。
