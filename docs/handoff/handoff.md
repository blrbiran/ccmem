# ccmem —— Handoff

> v0.13 已发布并合并。此后完成第一轮 dogfood，2026-08-01 → 08-03 共七波修复/取证，
> 以 **Finding 10（plist 漂移）修复并合并**收口。
> **当前进行中：Finding 15（`openai_timeout_ms` 重新推导）—— 取证、设计、计划均已完成并提交，
> 四个实现 Task 已完成第 1 个。**
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料、ledger 与提交信息里。

---

# 🚀 Executive summary —— 下一位 agent 从这里开始

1. **在办的是 Finding 15**，它是 v0.14 分析线的闸门（约 1/3 检索至今拿不到查询向量，持续污染探针数据）。
2. **设计与计划都已写完并提交进 git**，见「材料」表。**Task 1/4 已完成并通过评审**；Task 2、3、4 待做。
3. 工作在分支 **`finding15-embed-latency-probe`** 与同名 worktree 里（从当时的 `main` HEAD 分叉，**不是**从 `origin`）。
4. 恢复地图是 ledger：`.superpowers/sdd/2026-08-04-finding15-embed-latency-probe/progress.md`。**信 ledger 和 `git log`，不要信记忆。**
5. 执行方式已定为 **subagent-driven**。计划里 Task 2–4 有完整代码，照着派发即可。
6. **本文档不写任何 commit SHA**（提交本文档就会改变这些数字）。自己 `git log --oneline -20`，按**提交标题**找。
7. 硬性禁止：**不要 push**、**删分支/worktree 必须先问**、**不要把 plist 或配置内容打印/落盘/写进文档**。
8. **成本警戒**：写下本文档时该会话已约 **$100**，跑完剩余 3 个 Task + 全分支审查预计再 **$80–150**。开工前先 `/compact`。

---

# Ⅰ. Finding 15 —— 当前这一轮

## 问题一句话

`openai_timeout_ms: 800` 是 Finding 4 为 hook 选的（当时内部预算 200ms）。
V8/Finding 13 之后 harness 给到 5s、内部预算给到 2000ms，**而这个常数从未被重新推导**。

## 本轮取证坐实的东西（比原 finding 精确得多）

在 `metrics.jsonl` 的**冻结快照**上（窗口 = 熔断修复之后 → 2026-08-04 21:32）：

- 193 条 `prompt_submit`；A 130（其中 **25 次是查询向量缓存命中**）/ `B-fail` 54 / `B-circuit` 8 / `B-off` 1。
- **真实 embed 尝试 159，其中 54 次被 800ms 截断 ⇒ 截尾率 34.0%。**
- ⇒ **800ms 大约就是真实延迟分布的第 66 百分位**，不是"只有异常才碰到的上界"。
- 成功样本 n=105（min 322 / p50 669 / p90 736），**超过 800ms 的只有 1 条（948ms，至今未解释）**。
- **真 p99 整个落在截尾区里，用现有数据算不出来** —— 这就是要做探针的原因。

## 决定取值区间的是预算，不是分布

超时之后还要跑 lexical 回落，两段之和必须留在 2000ms 预算内；超了会被 `withHookSafety`
掐断并**返回空上下文**，比今天的回落更差。

```
embed_timeout + 回落成本(实测 max 638) < 2000ms   ⇒   embed_timeout ≲ 1360ms
```

> **所以待答的问题不是"p99 是多少"，而是"从 800 抬到 ~1300 能捞回那 54 次里的几次"。**

## 材料（动手前按顺序读）

| 材料 | 用途 |
|---|---|
| `docs/superpowers/specs/2026-08-04-finding15-embed-latency-probe-design.md` | **设计，整篇读。** 含全部取证数字、五条人类裁决、隔离要求、三条已知局限 |
| `docs/superpowers/plans/2026-08-04-finding15-embed-latency-probe.md` | **四个 Task 的实现计划，含完整代码。** Task 1 已执行 |
| `.superpowers/sdd/2026-08-04-finding15-embed-latency-probe/progress.md` | **ledger —— 恢复地图。** 每个 Task 的状态、延后的 minor、事故记录 |
| 同目录下 `task-1-brief.md` / `task-1-report.md` / `review-*.diff` | Task 1 的派发、报告与评审 diff |

（提交按标题找：`docs(spec): design an out-of-band probe to un-censor the embed latency distribution`、
`docs(plan): break the latency probe into four testable tasks`、
`feat(metrics): record the embedded prompt length`。）

## 状态

| Task | 内容 | 状态 |
|---|---|---|
| 1 | `prompt_chars` 进 metrics 行 | ✅ 完成，spec ✅ / quality Approved，2 条 minor 已延后 |
| 2 | 探针模块 + 配置（默认关）+ 五条测试 | ⬜ 待做（**最大的一个**） |
| 3 | 接线：`dispatch.mjs` 注册 + `loop.mjs` 间隔调度 | ⬜ 待做 |
| 4 | `diagnose --feedback` 成本可见 + 文档回填 + 附录 A #144 | ⬜ 待做 |
| — | 全分支审查（**用最强模型**）+ 一轮 fix wave | ⬜ 待做 |

## 探针设计的五条不得静默推翻的裁决（2026-08-04，理由全在设计文档）

1. **daemon 侧带外探针**，不临时放大线上超时 —— hook 路径行为零变更。
2. **常驻仪器、速率可配**，非一次性战役 —— 修完要用同一把尺子验证超时率真的降了。
3. **取本地记忆库的真实文本** —— 回填本就在把这些内容发给同一个 provider，不新增外发面。
4. **默认关，本机显式开** —— 它发真实 API 请求，不替别人做这个决定。
5. **顺手记 `prompt_chars`** —— 真实 prompt 长度分布至今无记录，这是唯一能让取样长度日后被校准的办法。

## 探针的硬隔离（Task 2 的核心，附录 A #144 要守的就是它）

探针**不得**调用 `recordEmbedFailure`/`recordEmbedSuccess`、**不得**写 `query_embedding_cache`、
**不得**预检熔断状态、**不得**使用返回的向量。

> 理由：探针自己的超时若喂给熔断器，**测量工具就会制造被测现象** —— 它会去开真实检索的闸门。

## 计划里两处刻意的偏离与留白（不要当成缺陷"修掉"）

1. **调度不走 lease。** 其余八个任务都用 `tryClaimLease`，但 lease 就是 `task_runs` 表里的一行，
   而**全仓库没有任何地方清理 `task_runs`** —— 5 分钟一次的探针会变成 288 行/天、无上限。
   lease 的价值是跨进程幂等，探针只由 daemon 发起，用不上。**这是对 Rule 11 的有意偏离，已明说。**
2. **配置开关用 `enabled === true` 严格开**，与相邻 `recordDecisionMetric` 的 `enabled === false`
   才关（缺省开）**方向相反**。刻意如此：记录的缺省必须是"记"，发请求的缺省必须是"不发"。

## Task 2 那条不能省的验红步骤

隔离测试的第一次红是"模块不存在"，**那是廉价红、不算数**。必须补一次定向变异：
在 `catch` 里接上 `recordEmbedFailure` → 隔离测试**必须红在 `config_kv` 计数上**
→ **且其余测试保持绿**（证明变异是定向的）→ 撤销 → 全绿。

---

# Ⅱ. 本轮新踩到的坑（每条都真栽过）

1. **`mv` 和 `cp` 在本机都是交互式别名**，会静默拒绝覆盖（打印 `not overwritten`）而外层 `&&` 链照跑。
   写 `.wolf/buglog.json` 时中招，**是写后用 `jq length` 校验才发现的**。
   ⇒ 用 `command mv` / `command cp -f`，**并且写完必须读回验证内容，不要信退出码**。
2. **`jq -r 'select(...)'` 对整个对象会美化输出成多行**，管到 `wc -l` 得到的是行数不是记录数
   —— 一个 109 行的桶数出了 441。⇒ 用 `jq -c`，或投影成标量。
   这是"0 计数先解释来源"那条纪律的**高位版本**。
3. **`metrics.jsonl` 是活文件，跨查询取数会得到自相矛盾的计数。** 设计文档初稿因此出现
   "总数 160/161、`B-fail` 43/44"的差一不一致。⇒ **任何要写进文档的计数都必须来自单一冻结快照。**
4. **dogfood 里有会过期的断言。** `docs/ccmem-v0.13-dogfood.md:725` 写「修复后零次熔断」，
   落笔时（08-02 12:20）为真，**当晚就开了 7 次**，2026-08-04 21:01:41 **又开了第 8 次**。
   ⇒ 描述"持续过程"的测量结论必须带日期，且**建立在它之上前先用当前数据重新推导**。
   已记 `bug-062`，修正属 Task 4。
5. **`rm -rf` worktree 的 `.superpowers` 会删掉一个 git 跟踪的文件。**
   `.superpowers/sdd/progress.md`（上一轮计划留下的旧扁平路径 ledger）**是受跟踪的**。
   已用单文件 `git checkout --` 恢复并核实两处都干净。⇒ 删任何目录前先 `git ls-files` 看一眼。
6. **SDD workspace 必须合并为一处。** `task-brief`/`review-package` 脚本按 cwd 解析工作区，
   在 worktree 里跑就会写进 worktree 自己的 `.superpowers`，而 ledger 在主仓库 ——
   **正是上一轮那个"对照放错目录、险些坐实造假指控"的陷阱。**
   本轮所有产物统一放在**主仓库**的 `.superpowers/sdd/2026-08-04-finding15-embed-latency-probe/`。

## 一条被本轮证伪的担心（不用再查了）

曾担心探针（10s 超时）与 `vec_backfill`（45s 超时）并发时会抢 `openai.mjs` 的模块级 client 单例、
拿到错的超时。**不成立** —— `loop.mjs` 是 `for (const task of due) { await runTask(...) }`，
**任务严格串行**。交替运行时各自重建一次 client，代价仅为对象构造，无正确性问题。

---

# Ⅲ. 会咬人的既定事实（跨轮次长期有效）

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。
   只 unset 配置路径**不构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **`npm test -- <文件>` 不隔离单文件**（npm 把参数追加到脚本原有 glob 后面）。跑单文件用：
   `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <文件>`，**两个变量缺一不可**。
3. **默认目录以后迁走只需改 `scripts/lib/paths.mjs` 一处**。**不要再在别处解析数据根。**
4. **`ps eww` 在这台机器上读不到进程环境。** 可靠替身：`zsh -f -c 'echo $VAR'` 验继承 /
   进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
5. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）。
   daemon 现在 `restart` 时会在字节不等、环境字典可解析、G1–G4 全过时自动重写 plist（Finding 10，附录 A #143）
   —— **但指向类 key（`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`）的改动会被拦下**，仍需人工 `uninstall && install`。
   ⚠️ **拦它的通常是 G1 而不是 G2**（最常见情形是该 key 从新环境里消失，G1 先于 G2 触发）。
6. **「取副本前后比对 mtime/size 证明零写入」这条判据是坏的，已作废。**
   正确判据是连接开在 `mode=ro` **加一个正面对照**。
7. **坏配置会让 daemon 拒绝启动**（`ConfigError`）。这是刻意的：回落 `DEFAULT_CONFIG` 会用
   `transformers-local` 去查一库 openai 向量 ⇒ 静默重造 Finding 12。**hook 不受影响**。
8. **`task_runs` 表没有任何清理逻辑。** 往里加高频 lease 前先想这一层（本轮 Task 3 因此绕开了 lease）。
9. **被测二进制要显式跑目标 checkout 的 `./bin/ccmem`** —— PATH 上的 `ccmem` 走符号链接指向主仓库，
   在分支上验证时 `grep` 会必然返回 0 并"证明"修复无效。

---

# Ⅳ. 硬性纪律（每一条都是真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** 已栽三次。**不变量也一样**：附录 A 无 runner，
  加条目前必须镜像文件、单独回退对应修复、看它变红，**并把验红范围如实写在条目下方**（#143 即为部分验红）。
- **廉价红不算数。** "函数/模块不存在"那种红不构成证据，要用**定向变异红**：
  关掉被测断言所守的那一段，看它红在自己命名的行为上，**且对照测试保持绿**。
- **纯函数有测试 ≠ 接线有测试。** Finding 5 的回归测试因此全部打在**进程边界**（退出码 + stderr）。
- **读码推出来的影响面必须实测复核。** Finding 5 被读码推断误判过两次。
- **撤回一个说法时，要去原话所在的位置作废它**，不能只在发现问题的那一条里记。
- **0 计数 / 不动的数字，先解释来源再当结论。已出现八种来源**：分母为 0、进程比代码旧、链条死掉、
  幸存者偏差、查错字段名（`hook`≠`event`；`has_cjk`≠`is_cjk`）、签名为 null 让 SQL 谓词恒不成立、
  分母只有 1、被测二进制解析到错的 checkout。**本轮新增高位版本见 Ⅱ.2。**
- **反面的"什么都没发生"需要正面对照才可信 —— 而且对照必须和目标同处一地。**
- **恢复/写入类操作要用校验和或读回验证，不要信命令的退出码**（见 Ⅱ.1）。
- **测试隔离必须是模块级默认，不能靠下一个人记得调用某个 helper。** 失败是静默的：测试照样绿，
  同时动着真系统（本仓库曾有一条测试跑真 `launchctl` 并劫走本机 daemon 注册）。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`），
  **但不要用 mtime/size 比对"证明"零写入**。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。
- **不要重做已完成的 Task。** SDD 点名"controller 丢失位置后重复派发已完成任务"是代价最高的失败模式。

---

# Ⅴ. 人类裁决 —— 不得静默推翻

完整理由在各轮 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除** —— 签名机制已正确覆盖换模型。
3. **签名契约返回 `null`**，不是抛错。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
5. **provider API key 不进 daemon 环境白名单**（仅指 embedding provider 的 key）。
   ⚠️ 该条原括号注解「`renderPlist()` 在生产代码里没有调用点」**已过期** ——
   Finding 10 的 Task 5 之后 **`renderPlist()` 正是唯一求值点**。
6. **探针决策流 `l25-probe.jsonl` 无上限，`diagnose --feedback` 打印其磁盘占用** ——
   **刻意让运行时成本可见，不要"优化"掉。**（Finding 15 的探针文件沿用同一政策与同一处打印。）
7. **Finding 14 的行为变更是刻意的**：熔断容忍 2 次失败才开。
8. **坏配置 = 响亮地死，daemon 不刷栈**。**明确不回落 `DEFAULT_CONFIG`**。
9. **自由变 key 的差异一律不抬三态** —— 包括整个新增或整个消失。
10. **G2 必须包含 `CCMEM_DATA_ROOT`。**
11. **`plist_rewrite` 被拦时必须打到 stderr。**
12. **红证据缺口用变异红补，不用"函数不存在"那种廉价红。**
13. **SDD workspace 保留，不按 SDD 流程删。** 移除 worktree 前**必须先把它那一半搬出来**。
14. **🆕 Finding 15 探针的五条**，见上方 Ⅰ 节。

## 一条关于 plist 与凭据的、两个方向都错的说法

`DAEMON_ENV_PASSTHROUGH` 里有 `ANTHROPIC_API_KEY` / `ANTHROPIC_FOUNDRY_API_KEY`，
所以"plist 不含凭据"是错的；但 `daemon.mjs` 的 passthrough **只在安装那一刻的 shell 里该变量确实非空时**
才会复制，而这些凭据平时活在 `config.json`、不是环境变量，所以"它们今天就明文写在 plist 里"同样是错的。
真实情况**取决于安装时的 shell**。**安全规则不因此放松：plist 可能含凭据，永远不打印/落盘/写进文档。**

---

# Ⅵ. Finding 15 之后：v0.14

## 待办来源

`.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- **Finding 13 的深层解**：让预算对同步工作真正生效需把 hook 工作切段 —— **设计改动，需人类裁决**。
- **V5 取证出的三条**（均未修，见 dogfood Closure review 的 deferred 桶）。
- **回填失败的退避策略**：永久性失败（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**。真解是迁移到 `@huggingface/transformers`。
- 两个 daemon 测试抖动合并为一个 issue，不阻塞。
- **本轮延后的 minor**：见 Finding 15 的 ledger（`Task N: minor (deferred)` 行）。

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
3. **Finding 15 未修之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** —— 同样偏向词法，
   且**这条偏差至今仍在持续产生**（2026-08-04 又开了一次熔断）。**这是 v0.14 分析线的闸门。**

---

# Ⅶ. 建议使用的 skills

- **`superpowers:subagent-driven-development`** —— **当前这一轮正在用它**，Task 2 起直接续用。
  它规定的 ledger、per-task 双验收（spec 合规 + 质量）、fix loop 五轮上限与 breaker，
  正是 `.superpowers/sdd/` 里那些记法的来源；不读它会看不懂 ledger。
  **本轮经验：把能力预算花在审查上** —— 实现用中档模型足够（计划里已有完整代码），
  **全分支审查务必用最强模型**（上一轮两轮 Opus 审查抓出了全部真正重要的缺陷）。
- **`superpowers:systematic-debugging`** —— 本项目所有修对了的东西都靠"先取证再改代码"。
- **`superpowers:test-driven-development`** —— 红-绿，且要读到"接线也要测"那一层。
- **`superpowers:verification-before-completion`** —— 多次差点把"没验证"当"已完成"。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。
- **`superpowers:finishing-a-development-branch`** —— Finding 15 四个 Task 全绿之后走它。

---

# Ⅷ. 备注

- **不要 push**（人类自己做）。**删分支/worktree 必须先问。**
  现存分支：`main`、`finding15-embed-latency-probe`（在办）、`v0.13-spec`、`v0.13-dogfood-fixes`（均未删）。
  worktree：`finding15-embed-latency-probe`（在办）、`ccmem-v012-finalization`（与本线无关）。
- **三个 SDD workspace 都刻意保留**（均 gitignore）：`2026-07-31-ccmem-v0.13/`、
  `2026-08-03-finding10-plist-drift/`（26 份）、**`2026-08-04-finding15-embed-latency-probe/`（在办）**。
  承载全部人类裁决及理由、实测取证、事故经过 —— **git 历史一条都不记。**
  ⚠️ `.superpowers/sdd/progress.md`（旧扁平路径）**是 git 跟踪的**，属更早的计划，别删。
- OpenWolf 记账：`.wolf/buglog.json`、`.wolf/memory.md` 已 gitignore；`.wolf/cerebrum.md` 入库。
  已记 `bug-058` ~ `bug-062`（**`bug-062` = dogfood 那条被数据证伪的熔断断言，其 `fix` 字段待 Task 4 更新**）。
  **未修的 finding 不记 bug，只活在 dogfood 文档里。**
- 附录 A 不变量现为 **120–143（24 行）**，**没有 runner，是人工 checklist**。
  Finding 15 的 **#144 属 Task 4**。
- 套件基线 **514 pass / 0 fail**（Finding 10 合并结果上实测）。Task 1 之后新增 1 条测试。
  已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；**红了要先确认是它**。
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 那轮 ~$60，文档回填那轮 ~$45，
  10/11 + 附录 A + Finding 5 那轮 ~$80，Finding 10 修复那轮 ~$140，
  **Finding 15 取证+设计+计划+Task 1 那轮（即本轮）~$100**。
  跨进程 / 跨数据源取证代价很高。**开新一轮前先 `/compact`。**
