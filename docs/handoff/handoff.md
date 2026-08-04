# ccmem —— Handoff

> v0.13 已发布并合并。此后完成第一轮 dogfood 与七波修复/取证，以 **Finding 10（plist 漂移）** 收口；
> 随后 **Finding 15（`openai_timeout_ms` 重新推导）的探针已实现、审查、合并进 `main`**。
> **当前没有在办的实现分支。** 下一步是 v0.14 分析线 —— 但它的闸门只被拆掉一半，见 Ⅰ。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料、ledger 与提交信息里。
> **本文档不写任何 commit SHA**（提交本文档本身就会改变这些数字）。用 `git log --oneline -25`，按**提交标题**找。

---

# 🚀 快速接手 —— 下一位 agent 先读这 8 行

1. **Finding 15 的探针已合并，但超时没被修。** `openai_timeout_ms: 800` 仍在生产跑，约 1/3 检索仍拿不到查询向量。
2. **探针默认关。** 不打开它就不会产生任何数据，v0.14 的闸门就不会真的拆掉。
3. **下一步 = 打开开关，跑 ≥3 天 / ≥300 样本，然后回答一个问题**：把超时从 800 抬到 ~1300，那 34% 里能捞回几次。
4. **取值上界是 ≲1360ms，由预算实测约束，不由分布决定**（`embed_timeout + 回落 max 638 < 2000`）。
5. **分位数对比不可作判据** —— v0.14 已坐实，不要复活。
6. 恢复地图是 ledger：`.superpowers/sdd/2026-08-04-finding15-embed-latency-probe/progress.md`。**信 ledger 和 `git log`，不信记忆。**
7. **本轮推翻了一条跨轮次的既定事实**（`task_runs` 其实有清理），见 Ⅱ —— 旧说法已在本文档作废，别再照它做决定。
8. 硬性禁止：**不要 push**、**删分支/worktree 先问**、**不要把 plist 或配置内容打印/落盘**。

---

# Ⅰ. Finding 15 —— 交付了什么，以及**没有**交付什么

## 一句话

`openai_timeout_ms: 800` 是 Finding 4 为当时 200ms 的内部预算选的。V8/Finding 13 之后 harness 给到 5s、
内部预算给到 2000ms，**这个常数从未被重新推导**。本轮**造出了重新推导它所需的尺子，但没有动那个常数**。

## 取证坐实的（冻结快照，窗口 = 熔断修复之后 → 2026-08-04 21:32）

- 193 条 `prompt_submit`；A 130（其中 25 次是查询向量缓存命中）/ `B-fail` 54 / `B-circuit` 8 / `B-off` 1。
- **真实 embed 尝试 159，54 次被 800ms 截断 ⇒ 截尾率 34.0%** ⇒ **800ms 约等于真实分布的 p66**，不是异常上界。
- 成功样本 n=105（min 322，仅 1 条超过 800ms：那条**至今未解释**的 948ms）。
- **真 p99 整个落在截尾区里，用现有数据算不出来** —— 这就是探针存在的理由。

## ⚠️ 合并了探针 ≠ 修了超时

生产超时仍是 800ms。**Ⅶ 里那条"约 1/3 检索拿不到查询向量"的样本偏差仍在持续产生。**
闸门要真正拆掉，必须：**打开探针 → 攒够样本 → 重新定值 → 改常数 → 用同一把尺子验证截尾率真的降了。**

## 打开探针要知道的事

- 配置在 `embedding.latency_probe.{enabled, interval_ms, timeout_ms, file}`，默认 `false / 300000 / 10000 / embed-latency-probe.jsonl`。
- **严格 `enabled === true` 才开**，两道闸门（`loop.mjs` 入队处 + 探针模块内部）都是这个语义。
- **它发真实的、要花钱的 API 请求。** 这是刻意默认关的原因。
- 结果文件在数据根下，**永不轮转**；`diagnose --feedback` 打印它的磁盘占用（刻意让成本可见，不要"优化"掉）。
- **开着的时候 `tasks` 表每天多 ~288 行，而全仓库没有任何地方删 `tasks`**（见 Ⅱ）。跑几天没问题，长期开着要有意识。

## 材料（动手前按顺序读）

| 材料 | 用途 |
|---|---|
| `docs/superpowers/specs/2026-08-04-finding15-embed-latency-probe-design.md` | **设计，整篇读。** 全部取证数字、五条人类裁决、隔离要求、已知局限 |
| `docs/superpowers/plans/2026-08-04-finding15-embed-latency-probe.md` | 四个 Task 的实现计划；**末尾「完成后的下一步」就是定值该怎么做** |
| `.superpowers/sdd/2026-08-04-finding15-embed-latency-probe/progress.md` | **ledger。** 每个 Task 的状态、fix 轮、延后的 minor、parked 裁决、事故记录 |
| 同目录下 `task-N-brief.md` / `task-N-report.md` / `final-fix-report.md` / `review-*.diff` | 派发、报告、全分支审查与 fix wave 的完整取证 |

（提交按标题找：`feat(metrics): record the embedded prompt length`、
`feat(daemon): measure embed latency without the timeout that censors it`、
`feat(daemon): schedule the latency probe on an interval, without a lease`、
`docs+diagnose: void a claim the data outlived, and keep the probe's cost visible`、
以及合并提交 `Merge branch 'finding15-embed-latency-probe': ...`。）

## 探针的六条裁决（不得静默推翻，理由全在设计文档与 ledger）

1. **daemon 侧带外探针**，不临时放大线上超时 —— hook 路径行为零变更。
2. **常驻仪器、速率可配**，非一次性战役 —— 修完要用同一把尺子验证截尾率真的降了。
3. **取本地记忆库的真实文本** —— 回填本就在把这些内容发给同一个 provider，不新增外发面。
4. **默认关，本机显式开** —— 它发真实 API 请求，不替别人做这个决定。
5. **顺手记 `prompt_chars`** —— 让探针取样长度日后能被校准。
6. **🆕 探针模块内部也要有 `enabled` 闸门**（本轮新增裁决）。入队处那道闸门盖不住一个窗口：
   开关从 true 改回 false 时，`tasks` 里已入队的行不会消失，仍会发一次真实请求。

## 探针的硬隔离（附录 A #144 守的就是它）

探针**不得**调用 `recordEmbedFailure`/`recordEmbedSuccess`、**不得**写 `query_embedding_cache`、
**不得**预检熔断状态、**不得**使用返回的向量。它直接 import `openaiEmbedding`，**绕开 `getProviderWithCircuit`** —— 隔离就是靠这条缝买来的。

> 理由：探针自己的超时若喂给熔断器，**测量工具就会制造被测现象** —— 它会去开真实检索的闸门。

## 读探针数据前要知道的三件事

1. **每行都带 `timeout_ms`** —— 上限是可配的，不把它记在行里，日后调过上限的样本就无法解释。
2. **`timed_out_at_probe_limit` 是墙钟启发式**（`!ok && ms >= timeoutMs`），不是对 abort 原因的检查；
   同行的 `error` 字符串可用于事后甄别边界样本。
3. **行里的 embedding 签名的 `dim` 取自配置声明（`openai_dim ?? 1536`），不是实测宽度。**
   用 `text-embedding-3-large` 时标签会写成 1536 而实际 3072 —— 模型名仍能区分，**但标签会撒谎**。

## 本轮 parked 的一条

`docs/ccmem-v0.13-dogfood.md:694` 写 `B-fail` 簇为 802–809ms，设计文档 `:41` 写 802–808ms，
**同一冻结快照差 1ms**。裁决：真实但不承重（没有任何结论依赖这个端点），
且重新推导就得再查一次活的 `metrics.jsonl` —— 那正是造成本轮 Critical 的动作。
**便宜的未来修法是在两处各加一行内联标注**，而不是重新取数。

---

# Ⅱ. 🆕 本轮推翻的既定事实 —— 旧说法在此作废

**旧说法（曾写在本文档 Ⅲ 节与设计文档 §3.1）：「`task_runs` 表没有任何清理逻辑」。这是错的。**

- `scripts/lib/tier15.mjs:62` 与 `:130` 各有一条 `DELETE FROM task_runs WHERE date_key < dayKeyDaysAgo(30)`，
  挂在每日 tier1.5 维护后面。**lease 的代价是 ~30 天有界**（约 8.6k 行），不是无上限。
- **真正无人清理的是 `tasks` 表**：全仓库不存在 `DELETE FROM tasks`，且该表只有一条 summarize 专用唯一索引，
  没有 `(status, scheduled_for)` 索引。探针开着时每天往里加 ~288 行，`mainLoop` 的 due 查询全表扫。

**Finding 15 不走 `tryClaimLease` 的决定仍然成立** —— 但依据换了：lease 买的是跨进程幂等，
而探针只由 daemon 发起、daemon 锁只允许一个进程，**这份保证用不上**。
分支内的 `loop.mjs` 注释、`daemon-loop.test.mjs` 的断言消息、设计 §3.1 都已改正并披露了 `tasks` 的增长。

> **教训**：这条前提被写进 handoff、写进设计文档、写进代码注释、写进测试断言消息，跨了三轮无人复核。
> **一条被反复引用的"既定事实"，恰恰是最该被实测复核的那条。**

---

# Ⅲ. 本轮新踩到的坑（每条都真栽过）

1. **计划里给的测试 fixture 可能让断言根本无法失败。** Task 2 的 `freshDb()` 建的 `config_kv` 少了
   `set_at INTEGER NOT NULL`，与 `scripts/migrations/001_initial.sql:70` 不符 —— 真实的熔断写入会先抛异常，
   于是那条隔离断言**永远等不到被检验**，定向变异只得到"崩溃红"。
   ⇒ **测试 fixture 的 schema 必须与 migration 一致；否则它守的不变量是假的。**
2. **文档修正会引入它自己要消灭的缺陷。** Task 4 把新快照的计数写进表格，却把旧快照的延迟区间留在同一行 ——
   **由添加"单一冻结快照"纪律的那同一个提交犯下。**
   ⇒ 改一个数字时，**同一行、同一段、同一张表里的其它数字都要一起检查来源。**
3. **改一句话不等于改完一段。** 修 `spec.md` 时改了目标句，同一段两句之后的重述仍是错的。
   ⇒ **修文档要走完整段，并把"检查过但无需改动"的相邻句子也写进报告。**
4. **新仪器会污染既有的测量面。** 探针的 `tasks` 行被 `metrics-rollup.mjs` 的 `llm_calls` /
   `llm_total_duration_ms` / `llm_failures` 无过滤地统计，开启后 `llm_calls` 从个位数变 ~290/天，
   **且污染在 rollup 行里不可见**。已加 `AND type != 'embed_latency_probe'`。
   ⇒ **加任何新 daemon 任务前，先查谁在无过滤地聚合 `tasks`。**
5. **探针原本量的跨度比它要对比的量更大。** hook 在计时**之前**调 `provider.load()`，
   探针原来把 `load()`（含 `import('openai')` + `new OpenAI`）算在计时窗口里 ——
   两个数不可比，且加载失败会变成一条"近零延迟"的假样本。已把 `load()` 提到 `t0` 之上。
   ⇒ **要对比的两个耗时，必须确认它们的窗口边界一致。**
6. **subagent 的 cwd 会在回合之间静默重置。** 有 agent 因此把命令跑到了主 checkout（那是另一条分支）。
   ⇒ **派发时要求每条命令显式 `cd`，不要依赖一次 `cd` 的持久性。**
7. **gitignore 的文件在 worktree 里不存在。** `.wolf/buglog.json` 只在主 checkout 有，
   agent 在 worktree 里播了一份副本编辑，**权威那份仍是旧的**。
   ⇒ **git-ignored 的账本只有主仓库那份算数；worktree 副本随 worktree 一起消失。**

---

# Ⅳ. 会咬人的既定事实（跨轮次长期有效）

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。
   只 unset 配置路径**不构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **`npm test -- <文件>` 不隔离单文件**（npm 把参数追加到原有 glob 后面）。跑单文件用：
   `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <文件>`，**两个变量缺一不可**。
3. **默认目录以后迁走只需改 `scripts/lib/paths.mjs` 一处**。**不要再在别处解析数据根。**
4. **`ps eww` 在这台机器上读不到进程环境。** 可靠替身：`zsh -f -c 'echo $VAR'` 验继承 /
   进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
5. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）。
   daemon `restart` 时会在四道闸门全过时自动重写 plist（Finding 10，附录 A #143）
   —— **但指向类 key（`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`）的改动会被拦下**，仍需人工 `uninstall && install`。
   ⚠️ **拦它的通常是 G1 而不是 G2**（最常见情形是该 key 从新环境里消失，G1 先于 G2 触发）。
6. **「取副本前后比对 mtime/size 证明零写入」这条判据是坏的，已作废。**
   正确判据是连接开在 `mode=ro` **加一个正面对照**。
7. **坏配置会让 daemon 拒绝启动**（`ConfigError`）。这是刻意的：回落 `DEFAULT_CONFIG` 会用
   `transformers-local` 去查一库 openai 向量 ⇒ 静默重造 Finding 12。**hook 不受影响**。
8. **~~`task_runs` 表没有任何清理逻辑~~ —— 本条已被证伪并作废，替代说法见 Ⅱ。**
   要记的是：**`tasks` 表才是没有清理的那张**，且没有 `(status, scheduled_for)` 索引。
9. **被测二进制要显式跑目标 checkout 的 `./bin/ccmem`** —— PATH 上的 `ccmem` 走符号链接指向主仓库，
   在分支上验证时 `grep` 会必然返回 0 并"证明"修复无效。
10. **`openaiConfigFrom` 里 `maxRetries: 0` 是硬编码的**，不从配置读 —— 所以
    「`new OpenAI({ timeout })` 默认 `maxRetries: 2`、最坏是 timeout × 3」这个陷阱**在本仓库不成立**。
    客户端缓存键含 `timeoutMs`，所以探针用不同超时会触发一次客户端重建（仅对象构造，无正确性问题）。

---

# Ⅴ. 硬性纪律（每一条都是真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** 已栽三次。**不变量也一样**：附录 A 无 runner，
  加条目前必须镜像文件、单独回退对应修复、看它变红，**并把验红范围如实写在条目下方**（#143、#144 均为部分验红）。
- **廉价红不算数。** "函数/模块不存在"不构成证据；**"崩溃红"同样不算**（见 Ⅲ.1）。
  要的是**定向变异红**：红在被测断言自己命名的行为上，**且对照测试保持绿**。
- **纯函数有测试 ≠ 接线有测试。** Finding 5 的回归测试因此全部打在**进程边界**（退出码 + stderr）。
- **读码推出来的影响面必须实测复核。** 本轮又添一例：一条跨三轮的"既定事实"从没人查过（Ⅱ）。
- **撤回一个说法时，要去原话所在的位置作废它**，不能只在发现问题的那一条里记（本文档 Ⅳ.8 即为示范）。
- **0 计数 / 不动的数字，先解释来源再当结论。已出现八种来源**：分母为 0、进程比代码旧、链条死掉、
  幸存者偏差、查错字段名（`hook`≠`event`；`has_cjk`≠`is_cjk`）、签名为 null 让 SQL 谓词恒不成立、
  分母只有 1、被测二进制解析到错的 checkout。
- **写进文档的任何计数都必须来自单一冻结快照**（`metrics.jsonl` 是活文件）。
  **`jq -r 'select(...)'` 会把整个对象美化成多行**，管到 `wc -l` 数的是行数不是记录数 ⇒ 用 `jq -c` 或投影成标量。
- **描述"持续过程"的测量结论必须带日期**，且**建立在它之上前先用当前数据重新推导**。
- **反面的"什么都没发生"需要正面对照才可信 —— 而且对照必须和目标同处一地。**
- **恢复/写入类操作要用校验和或读回验证，不要信命令的退出码。**
  ⚠️ **`mv` 和 `cp` 在本机都是交互式别名**，会静默拒绝覆盖（打印 `not overwritten`）而外层 `&&` 链照跑 ⇒
  用 `command mv` / `command cp -f`，**并且写完必须读回验证内容**。
- **测试隔离必须是模块级默认，不能靠下一个人记得调用某个 helper。** 失败是静默的：测试照样绿，
  同时动着真系统（本仓库曾有一条测试跑真 `launchctl` 并劫走本机 daemon 注册）。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`），**但不要用 mtime/size 比对**。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。
- **删任何目录前先 `git ls-files` 看一眼** —— `.superpowers/sdd/progress.md`（旧扁平路径）**是 git 跟踪的**。
- **不要重做已完成的 Task。** SDD 点名"controller 丢失位置后重复派发已完成任务"是代价最高的失败模式。

---

# Ⅵ. 人类裁决 —— 不得静默推翻

完整理由在各轮 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除** —— 签名机制已正确覆盖换模型。
3. **签名契约返回 `null`**，不是抛错。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
5. **provider API key 不进 daemon 环境白名单**（仅指 embedding provider 的 key）。
   `renderPlist()` 是 Finding 10 之后**唯一的求值点**。
6. **探针决策流 `l25-probe.jsonl` 无上限，`diagnose --feedback` 打印其磁盘占用** ——
   **刻意让运行时成本可见，不要"优化"掉。** Finding 15 的探针文件沿用同一政策与同一处打印。
7. **Finding 14 的行为变更是刻意的**：熔断容忍 2 次失败才开。
8. **坏配置 = 响亮地死，daemon 不刷栈**。**明确不回落 `DEFAULT_CONFIG`**。
9. **自由变 key 的差异一律不抬三态** —— 包括整个新增或整个消失。
10. **G2 必须包含 `CCMEM_DATA_ROOT`。**
11. **`plist_rewrite` 被拦时必须打到 stderr。**
12. **红证据缺口用变异红补，不用廉价红。**
13. **SDD workspace 保留，不按 SDD 流程删。** 移除 worktree 前**必须先把它那一半搬出来**。
14. **Finding 15 探针的六条**，见 Ⅰ。

## 一条关于 plist 与凭据的、两个方向都错的说法

`DAEMON_ENV_PASSTHROUGH` 里有 `ANTHROPIC_API_KEY` / `ANTHROPIC_FOUNDRY_API_KEY`，
所以"plist 不含凭据"是错的；但 `daemon.mjs` 的 passthrough **只在安装那一刻的 shell 里该变量确实非空时**
才会复制，而这些凭据平时活在 `config.json`、不是环境变量，所以"它们今天就明文写在 plist 里"同样是错的。
真实情况**取决于安装时的 shell**。**安全规则不因此放松：plist 可能含凭据，永远不打印/落盘/写进文档。**

---

# Ⅶ. 下一条线：v0.14

## 待办来源

`.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- **Finding 13 的深层解**：让预算对同步工作真正生效需把 hook 工作切段 —— **设计改动，需人类裁决**。
- **V5 取证出的三条**（均未修，见 dogfood Closure review 的 deferred 桶）。
- **回填失败的退避策略**：永久性失败（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**。真解是迁移到 `@huggingface/transformers`。
- 两个 daemon 测试抖动合并为一个 issue，不阻塞。
- **Finding 15 延后的 7 条 minor**：见该轮 ledger 的 `minor (deferred)` 行。
  全分支审查已逐条分诊，**结论均为"可以 ship"**，但其中两条值得顺手做：
  给 `prompt_chars` 那处的 `2000` 加一行注释指明 `retrieval.mjs:335` 是它的孪生；
  以及 Ⅰ 里那条 parked 的 1ms 差异加内联标注。
- **`tasks` 表没有清理逻辑**（Ⅱ）—— 探针长期开启会让它无界增长，值得单独立项。

## 核心问题：`l25_cov` 是否存在可行阈值

- 随机对照 **n 已达 399**（原判据 ≥60，达成）。
- **p50 漂移轨迹 `0.125 → 0.075 → 0.029`，跨度 0.096，远超 V2 自己设的 ±0.03 门限**
  ⇒ **「分位数对比不可作判据」已经坐实，不要再用它。**
- ⚠️ **信号(0.081) 高于噪声(0.029)，看起来"终于有信号了"。这正是 Finding 2 警告的读法，不要中招。**
- `l25_legacy_hit` 仍 **0/1666**，**无任何正例标签**，仍需人工标注约 50 个样本。

**三条已知的样本偏差，做分布分析前必须先评估**：

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉，而 stop hook 正是写探针行的地方
   ⇒ 现有探针数据集可能系统性缺失慢会话/长会话。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开 ⇒ 该时期的通道统计偏向词法。
3. **超时未重新定值之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** —— 同样偏向词法。
   **⚠️ 这条至今仍在持续产生。造出尺子不等于修好 —— 见 Ⅰ。**

---

# Ⅷ. 建议使用的 skills

- **`superpowers:subagent-driven-development`** —— 上一轮用它跑完 Finding 15 全程。
  它规定的 ledger、per-task 双验收（spec 合规 + 质量）、fix loop 五轮上限与 breaker、
  以及"最后一轮 fix wave 只有一次"，正是 `.superpowers/sdd/` 里那些记法的来源；不读它会看不懂 ledger。
  **本轮经验：把能力预算花在审查上。** 实现用中档模型足够；**全分支审查务必用最强模型** ——
  本轮它抓出了 1 条 Critical、4 条 Important，并推翻了 Ⅱ 那条跨三轮的错误前提，
  而这些per-task 审查一条都看不到（它们看不见跨任务的接缝与仓库级前提）。
- **`superpowers:systematic-debugging`** —— 本项目所有修对了的东西都靠"先取证再改代码"。
- **`superpowers:test-driven-development`** —— 红-绿，且要读到"接线也要测""崩溃红不算红"那一层。
- **`superpowers:verification-before-completion`** —— 多次差点把"没验证"当"已完成"。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。
- **`superpowers:writing-plans`** —— 定值那一步若要改生产常数，先出计划再动手。
- **`superpowers:finishing-a-development-branch`** —— 分支收尾走它；它会先在**合并结果**上重跑全套。

---

# Ⅸ. 备注

- **不要 push**（人类自己做）。**删分支/worktree 必须先问。**
  现存分支：`main`、`v0.13-spec`、`v0.13-dogfood-fixes`、`ccmem-v012-finalization`。
  worktree：`ccmem-v012-finalization`（与本线无关）。
  **`finding15-embed-latency-probe` 的分支与 worktree 已在人类授权下删除**（合并后 `-d`，内容全在 `main` 历史里）。
- **三个 SDD workspace 都刻意保留**（均 gitignore）：`2026-07-31-ccmem-v0.13/`、
  `2026-08-03-finding10-plist-drift/`、`2026-08-04-finding15-embed-latency-probe/`（18 份）。
  承载全部人类裁决及理由、实测取证、事故经过 —— **git 历史一条都不记。**
  ⚠️ `.superpowers/sdd/progress.md`（旧扁平路径）**是 git 跟踪的**，属更早的计划，别删。
- OpenWolf 记账：`.wolf/buglog.json`、`.wolf/memory.md` 已 gitignore；`.wolf/cerebrum.md` 入库
  （Finding 15 全分支审查确立的四条已写入）。已记 `bug-058` ~ `bug-062`，**`bug-062` 的 `fix` 字段已回填**。
  **未修的 finding 不记 bug，只活在 dogfood 文档里。**
- 附录 A 不变量现为 **120–144**，**没有 runner，是人工 checklist**。**#143 与 #144 都是部分验红并已如实披露。**
- 套件基线 **532 pass / 0 fail**（在合并结果上实测）。
  已知抖动两处：`stop-daemon-flow.test.mjs`（偶发红 ≤2 条）、`admin-cron-command.test.mjs`（偶发红 1 条），
  重跑即绿；**红了要先确认是这两个文件之一，再谈回归。**
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 那轮 ~$60，文档回填那轮 ~$45，
  10/11 + 附录 A + Finding 5 那轮 ~$80，Finding 10 修复那轮 ~$140，
  Finding 15 取证+设计+计划+Task 1 那轮 ~$100，**Finding 15 Task 2–4 + 全分支审查 + fix wave + 合并那轮 ~$66**。
  最后这一轮约 1.47M subagent token，**超出 CLAUDE.md Rule 6 的单会话 450k 预算三倍有余** ——
  成本主要在两次 opus 派发上，而它们正是抓出全部要害的那两次。**开新一轮前先 `/compact`。**
