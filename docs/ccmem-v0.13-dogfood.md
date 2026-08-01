# ccmem v0.13 — Dogfood 计划与记录

> 目的：在真实使用中验证 v0.13 **实际交付的运行时行为**，而不是重跑测试套件。
> 套件（449/449）和不变量（16/16）已在合并时验证过，dogfood 要回答的是另一个问题：
> **这些代码路径在生产里到底有没有被执行过，执行结果是否符合预期。**
>
> 起始基线记录于 2026-08-01 09:35，v0.13 合并入 main 后约 7.7 小时。
> 本文档是活文档：计划在上半部分，观测记录按轮次追加在下半部分。

---

## 0. 首要发现（在写计划的过程中就已命中）

**运行中的 daemon 早于 v0.13 的代码，因此 daemon 侧的 v0.13 功能一次都没有执行过。**

| 事实 | 时间 |
|---|---|
| 当前 daemon 进程启动（pid 8813，uptime 24h23m） | 2026-07-31 09:12 |
| A2 质量门两条新规则首次提交（`d95f35b`） | 2026-07-31 22:34 |
| A2 脚本分档长度门修正（`4e7b931`） | 2026-07-31 23:02 |
| v0.13 合并进 main（`dfc7f93`） | 2026-08-01 01:49 |

daemon 在启动时 import 一次模块，之后持有内存里的那份代码。它比新规则早 **13.4 小时**，
所以 `admin diagnose --tuning` 里 `negative_assertion` / `env_failure` 计数为 0
**是被完全解释的，不是缺陷信号**。在重启 daemon 之前，任何针对 A2 的观测都无意义。

反过来，**A1 探针跑在 Stop hook 上**（每轮一个全新 node 进程，每次从磁盘读代码），
所以它确实在跑 v0.13 的代码 —— 证据是探针行里已经出现 `control: 'random'` 队列，
而那是最终 review 修复波才加的字段。这不是推断，是数据。

> **门禁 G0（需人类批准）**：重启 ccmem daemon。
> 不重启 ⇒ 本文档的 A2 与 B1 两条线全部无法开始。

---

## 1. v0.13 交付物 × 可 dogfood 性

| # | 功能 | 观测面 | 运行位置 | 可 dogfood？ |
|---|---|---|---|---|
| A1 | L2.5 观察型探针 | `l25-probe.jsonl` + `admin diagnose --feedback` | Stop hook | ✅ **已在跑**，389 行 |
| A1b | 决策流配置（`metrics.decision_data`，`retention_days: 0`） | 文件体积、tier15 清理 | Stop hook + tier15 | ✅ 观测磁盘增长 |
| A2 | 质量门新规则 `env_failure` + `negative_assertion` | `admin diagnose --tuning` 按 reason 拆分 | daemon `summarize-pending` | ⚠️ **被 G0 阻塞** |
| A2b | `quality_gate_reject` 按 reason 拆分展示（I5 修复） | `admin diagnose --tuning` | CLI | ✅ 今日已验证可用 |
| B1 | embedding 签名版本化（`embedding_sig`、迁移 016、检索/dedup/feedback 三处过滤、vec_backfill 重排队） | `admin semantic status`、`diagnose --retrieval` | daemon + hooks | ❌ **被 G1 阻塞**（见 §4） |
| B2 | `temporal_type` 回归测试 | — | — | ❌ 纯测试，无运行时变化（ledger T7：修复早于本分支） |
| B3 | recall-loop 不变量测试 | — | — | ❌ 纯测试 |
| — | 配置版本 0.13 + 递归同步测试 | `loadConfig().version` | 全局 | ✅ 一行核对 |
| — | `pruneDecisionMetrics` 原子化（I7） | — | — | ❌ 仅 `retention_days > 0` 时才走到，默认关闭 |

**dogfood 实际范围 = A1（继续并深化）、A2（解阻后测量）、B1（需先做一个有成本的决定）。**
B2/B3 没有可观测行为，不列入；把它们写进 dogfood 计划只会制造"覆盖了"的假象。

---

## 2. 基线快照（2026-08-01 09:35）

### A1 — L2.5 探针

```
l25-probe.jsonl: 228,090 bytes
samples: 389 total (365 turn-aligned, 24 random-control, 0 stale-injection, 0 unclassified)

Turn-aligned（信号组）
  non-CJK (n=266)  l25_cov p50=0.103 p75=0.176 p90=0.257 p95=0.318 max=0.520
                   l25_lcp p50=1 p90=2 max=3
  CJK     (n=99)   l25_cov p50=0.042 p75=0.125 p90=0.250 p95=0.333 max=0.375
                   l25_lcp p50=1 max=2

Random control（噪声底）
  non-CJK (n=21)   l25_cov p50=0.075 p75=0.133 p90=0.176 p95=0.364 max=0.548
  CJK     (n=3)    l25_cov p50=0.053 max=0.087

legacy hits: 0/389        id literal: 0/389
```

**与交接文档相比，核心情报已经翻转。** handoff 记录的是随机组 p50 ≈ 0.125 > 信号组 ≈ 0.103
（"噪声底高于信号"）。随机组从 n≈9 涨到 n=21 后，p50 落到 **0.075，低于信号**。

正确的读法不是"所以有信号了"，而是：**两次结论都是小样本抖动，p50 对比这个方法本身不可靠。**
n=21 时 p50 的置信区间宽到两组完全重叠。这条要带进 v0.14 —— 判据必须是分布级的
（AUC / Mann-Whitney U），不是分位数对比。dogfood 阶段的任务是**把样本量攒起来**，
并记录 p50 随 n 的漂移轨迹，用漂移本身证明"分位数对比不可用"。

### A2 — 质量门

```
Quality gate rejections (last 30 days): 146
  path_list      140
  too_specific     3
  test_count       2
  too_short        1
```

四种 reason 全部是 v0.13 之前就存在的规则。两条新规则 0 次 —— 已由 §0 解释（daemon 太老）。
按 reason 拆分这个展示本身是 I5 的修复产物，**它工作正常，这是 v0.13 第一个被真实数据确认可用的新功能**。

### B1 — embedding 签名

```
admin semantic status   : enabled=false loaded=false provider=transformers-local
                          embedded=0 pending=4093 model=Xenova/all-MiniLM-L6-v2 dim=384
admin diagnose --retrieval: Embedding: disabled / stale vectors: 0 / Circuit: CLOSED
```

**整条 B1 机制在本机从未执行过**：embedding 全局关闭，0 条记忆有向量。
`stale vectors: 0` 不是"健康"，是"分母为 0" —— 签名不匹配的行数当然是 0，因为一个向量都没有。

顺带澄清一个容易误判的点：`semantic status` 的 `pending=4093` 与 `diagnose --retrieval` 的
`stale vectors: 0` **不构成 review 里 I4 那种矛盾**。二者分母不同（前者是"无向量"，后者是
"有向量但签名过期"），在当前状态下两个数都对。follow-up 清单里那条
（`semantic.mjs` 强制 `enabled:true` 而 `diagnose.mjs` 用原始 cfg）**要等 embedding 打开后才可能显形**。

### 环境

```
main = origin/main = 3bd3092（已推送，handoff 里"未推送"已过时）
分支 v0.13-spec 仍在，未删
daemon: pid 8813, startup_schema=16, running=summarize_pending#40
loadConfig().version 期望 '0.13'
```

---

## 3. Dogfood 轮次设计

### 轮次 1 — A1 持续采集（不阻塞，现在就在跑）

- **做什么**：不改任何东西，让探针继续跑。每日快照一次 `admin diagnose --feedback`，追加到 §5。
- **成功判据**：随机对照非 CJK 样本 **n ≥ 60**（当前 21）。到这个量级 p50 才开始稳定。
- **同时要记的**：p50 随 n 的漂移轨迹。若 n 翻倍后 p50 仍在 ±0.03 内摆动，
  就已经证明了"分位数不可作为 v0.14 判据"，这是一条独立于阈值题的产出。
- **风险**：`l25_legacy_hit` 仍是 0/389，**没有任何正例标签**。
  采集再多也算不出 precision/recall。这条限制不由 dogfood 解决，属于 v0.14。
- **已知偏差，记入分析笔记不修**：随机组的排除范围只有 `recent_injections` 那么宽，
  而 tier15 把它裁到每会话 20 条，超长会话约 1.8% 污染率（k=3）。方向保守（抬高噪声底）。

### 轮次 2 — A2 质量门（需 G0：重启 daemon）

- **前置**：重启 daemon，用 `admin daemon status` 确认 uptime 归零。
- **做什么**：正常使用 3–7 天，让 `summarize-pending` 自然处理真实待入库内容。
- **主要观测**：`admin diagnose --tuning` 里 `negative_assertion` / `env_failure` 的计数与占比。
- **真正要盯的风险是误杀，不是漏杀**（review I5）：
  - `"这个 API 不支持批量请求，需要逐条调用"` —— 有价值的 API 约束，会被 `negative_assertion` 拒
  - `"prettier is not installed globally; use npx prettier"` —— 51 字符，低于 Latin 的 120 门限，
    却正是提取提示词要求的 remedy 形式，会被 `env_failure` 拒
  - 判定手段：`/ccmem:audit` 读每条 `quality_gate_reject` 的 80 字符摘录，**人工判断是噪声还是合法约束**。
    这是本轮唯一需要人肉的环节，也是 A2 唯一能被证伪的地方。
- **计数为 0 时不要直接下结论 —— 存在规则遮蔽**：`quality-gate.mjs` 里 `env_failure`（:88）
  和 `negative_assertion`（:95）是 9 条规则里的第 8、9 条，命中即返回。
  一条同时像 path_list 又像 negative_assertion 的内容会被记成 `path_list`。
  所以 0 计数的含义是"没有内容先绕过前 7 条再命中这 2 条"，不是"这 2 条从未匹配"。
  若要区分，需要一次性把候选内容离线喂给 `checkQuality` 逐规则跑，而不是看线上计数。
- **成功判据**：≥ 20 条经由这两条规则的拒绝被人工判读，误杀率有一个数。
  误杀率本身高不高不是 dogfood 要裁决的 —— 拿到数字就算成功。

### 轮次 3 — B1 embedding 签名（需 G1：开启 embedding，有成本）

- **前置决定（见 §4）**：是否在真实库上打开 embedding。
- **一旦打开，被真实执行的是**：
  1. 迁移 016 之后 4093 行 `embedding_sig IS NULL` 的回填 —— 每次 50 条，
     **正好是 I3 修复的重排队逻辑的实战检验**（旧行为需 ~82 次 daemon 重启）。
  2. `retrieval.mjs` / `dedup.mjs` / `feedback.mjs` 三处签名过滤在非空向量集上首次生效。
  3. follow-up 里 `semantic.mjs` 与 `diagnose.mjs` 的 `enabled` 分歧才具备显形条件。
- **观测**：`admin semantic status` 的 `pending` 是否单调下降至 0 且无需人工干预；
  `diagnose --retrieval` 的 `stale vectors` 是否同步归零；期间检索是否退化为纯词法。
- **成功判据**：不做任何手工 `admin cron run vec_backfill` 的前提下 `pending` 归零。
  这是 I3 修复的全部意义。
- **风险**：4093 条本地 embedding 是一笔真实计算量，且会改变检索行为。
  这不是"观察型"改动，与 A1 性质不同。

---

## 4. 需要人类拍板的两个门禁

| 门禁 | 内容 | 不做的后果 | 成本/风险 |
|---|---|---|---|
| **G0** | 重启 ccmem daemon | A2、B1 两条线完全无法开始；`--tuning` 的 0 计数永远是假象 | 低。会中断当前 `summarize_pending#40`，任务队列设计上可重入 |
| **G1** | 在真实库上打开 embedding | B1（v0.13 三条主线之一）永远零执行，签名机制的正确性只有单测背书 | 中。4093 条本地 embedding 计算；检索行为改变，非观察型 |

我不会在未获批准前执行这两项。

---

## 5. 观测记录

按轮次追加，最新在下。每条记录必须带日期、命令、原始数字，不要只写结论。

### 2026-08-01 09:35 — 基线

见 §2。要点三条：
1. daemon 早于 v0.13 代码 13.4 小时 ⇒ A2/B1 零执行，需 G0。
2. A1 正常采集中（389 行）；随机组 p50 相对 handoff 已翻转（0.125 → 0.075），
   证明的是**方法不可靠**，不是"有信号"。
3. B1 完全休眠（embedded=0），`stale vectors: 0` 是分母为 0 而非健康。

---

## 6. 本文档的纪律

- **"跑了测试"不算 dogfood 证据。** 只接受生产路径上的真实计数与真实内容。
- **0 计数必须先解释来源再当结论。** 本文档开头那条就是反例：
  看到 `negative_assertion: 0` 的第一反应本该是"规则坏了"，实际是 daemon 太老。
- **数据翻转要如实记录，不要追认旧结论。** §2 里 p50 的翻转就是这么处理的。
- 与 v0.13 的八条人类裁决冲突时，裁决优先（见 `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md`）。
  最易误踩：探针读 `recent_injections` 不读 `memory_feedback`；
  `control` 是权威队列字段（`random` 才是噪声底，`stale_injection` 不是）。
