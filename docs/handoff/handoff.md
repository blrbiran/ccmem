# ccmem —— Handoff

> Finding 15 的探针早已合并。**本轮给它加上了"只在实际使用 CC 时才采样"的活动闸门，已合并进 `main`**；
> 同时把 `admin daemon restart` 的假阴性诊断清楚并单独合入（**只有诊断，没有修**）。
> ⚠️ **但探针至今一条数据都没产出** —— 见 Ⅰ，这是当前唯一的活口，其它都是存量。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料、ledger 与提交信息里。
> **本文档不写任何 commit SHA**（提交本文档本身就会改变 HEAD）。用 `git log --oneline -20`，按**提交标题**找。

---

# 🚀 快速接手 —— 先读这 6 行

1. **第一条命令跑 `ccmem mode`。** 探针配置已正确（`enabled === true`、interval 300000、timeout 10000），四个闸门前置条件在 2026-08-05 22:18 全部实测为真，**却一条数据都没产生**。
2. 最可能的原因：**mode 为 `off` 时 `mainLoop` 直接睡，`scheduleCronTasks` 根本不被调用** —— 闸门再对也没用。
3. 探针文件里现在只有 **1 行**，是 2026-08-05 08:47 手工冒烟那次（`ms=733`）。**它不是闸门产出的**，别把它当成"链路已通"的证据。
4. 攒够数据后要回答的问题没变：**把超时从 800 抬到 ~1300，那 34% 里能捞回几次**（`P(ms≤1300) − P(ms≤800)`）。上界 ≲1360ms 由预算实测约束，不由分布决定。
5. **分位数对比不可作判据**，v0.14 已坐实，不要复活。
6. 硬性禁止：**不要 push**、**删分支/worktree 先问**、**不要把 plist 或配置内容打印/落盘**。

---

# Ⅰ. ⚠️ 唯一的活口：探针配置正确但零产出

## 已实测为真的（2026-08-05 22:18）

| 条件 | 值 |
|---|---|
| `cfg.embedding.latency_probe.enabled === true` | true |
| `MAX(session_context.updated_at) > lastProbeAtMs` | 活动在 39 秒前，daemon 启动在约 9 分钟前 |
| `nowMs - lastProbeAtMs >= interval_ms` | 577 秒 ≥ 300 秒 |
| tick 节奏 | `daemon.wake` 刚被 touch ⇒ `wakeRecently()` 真 ⇒ 30 秒一 tick |

**结论：全部成立，仍然 0 条 `tasks` 行、0 条新 jsonl 行。** 上一位 controller 明确预测"30 秒内会入队"，
**预测失败**，并当场定下判据"1 分钟后还是 1 行就是真有问题，不要再等"。**这个判据现在生效了。**

## 三个待排假设，按可能性排序

1. **`getMode(db) === 'off'`。** `scripts/daemon/loop.mjs:373` 在 mode 为 off 时 `await sleep(...)` 后 `continue`，
   **`scheduleCronTasks(db)` 在 :378，永远轮不到**。这能完美解释"闸门全对却什么都不发"。查：`ccmem mode`。
2. **daemon 反复重启。** 每次重启把 `lastProbeAtMs` 重置为启动时刻，5 分钟静默期跟着往后推；
   若有自重启在循环，探针永远等不到。查 `admin daemon status` 的 `uptime_sec` 是否总是小值。
3. **两个时间戳来自不同的库。** 闸门比的 `MAX(updated_at)` 与 `lastProbeAtMs` 由不同进程产生；
   上一轮验的是**我这个 CLI 进程**读到的值，没验 daemon 进程内读到的是同一个 `global.db`。

⚠️ **不要从"没数据"直接跳到"再等等"。** Ⅴ 列了八种 0 计数来源，这次很可能是第九种。

---

# Ⅱ. 本轮交付了什么

## 1. 探针活动闸门（已合并，标题 `Merge branch 'probe-activity-gate': ...`）

探针原本按 daemon 的 24/7 时钟入队。现在只在 `MAX(session_context.updated_at) > lastProbeAtMs`
且速率上限已过时才入队；`interval_ms` 语义从"采样周期"变成"两次探针的最小间隔"。

- 信号由三个 hook 自己写（`prompt-submit.mjs:33` / `session-start.mjs:40` / `stop.mjs:25`），
  **daemon 只读，hook 零变更** —— 裁决 #1 是字面保住的，不是靠论证。
- `lastProbeAtMs` 从 **daemon 启动时刻**起算（原本是 0）。代价：**重启后头 5 分钟一律不发探针**。
- **没有新增任何配置项**，也因此**没有退回 24/7 采样的开关**。这是刻意的。
- 预期产出 **≈44 样本/天**（对比无条件的 288），300 样本约 6.8 天。

| 材料 | 用途 |
|---|---|
| `docs/superpowers/specs/2026-08-05-probe-activity-gate-design.md` | 设计，含 5 条 review 修正、样本量推导、8 条已知局限 |
| `docs/superpowers/plans/2026-08-05-probe-activity-gate.md` | 两个 Task 的实现计划 |
| `.superpowers/sdd/2026-08-05-probe-activity-gate/progress.md` | **ledger**，全程取证与裁定 |

## 2. `admin daemon restart` 假阴性（**只诊断，未修**）

标题 `Merge branch 'daemon-restart-false-negative': ...`。**成功的重启会打印 `daemon restart failed` 并退出 1。**
本轮亲历两次。三个缺陷叠加，外加一个**没有替你定的判断题**（启动等待该改多少，还是不动超时只修消息）。

全部细节在 `docs/superpowers/specs/2026-08-05-daemon-restart-false-negative.md` 与 `.wolf/buglog.json` 的 `bug-063`。

> **实用判据：重启后不要看退出码，看 `admin daemon status`** —— `uptime_sec` 是小值 + `plist=in_sync` 就是成功了。

---

# Ⅲ. 本轮新踩到的坑（每条都真栽过）

1. **配置加了却完全不生效，且静默。** `latency_probe` 被加在 `config.json` **顶层**，而代码读的是
   `cfg.embedding?.latency_probe`。没有任何报错。
   ⇒ **判据不是看你关心的那个键，是看同块的其它键有没有回落到默认** ——
   `interval_ms` 显示 300000 就说明**整块没被读到**，而不只是某个键写错。
2. **计划里的枚举可能是错的，而实现者会照做。** 计划写"4 个 `_resetProbeSchedule()` 调用点"，实际 6 个
   （两个藏在 `captureStderr` 辅助函数下面）。**挡住它的唯一东西是 brief 里那句"若发现第五处，停下来报告"。**
   ⇒ **给 subagent 的 brief 里要写死"数目不符就停"，不要只给清单。**
3. **给既有测试加 fixture，会让它们的旧断言不再依赖旧守护。** 本轮给四个既有测试加了活动记录，
   结果**三个守护变得不可检测** —— 其中一个正是"默认关，因为它花钱"，把 `enabled === true` 改成恒真时 **87 个测试全绿**。
   ⇒ **改了既有测试之后，必须重跑那些测试原本守护的旧变异，不能只跑新变异。**
4. **同一个提交改了两行之下的句子，漏了这一句。** `loop.mjs` 的注释仍写着 288 行/天（无条件采样的数），
   而本分支自己的 spec 是 ≈44。**又一次 Ⅲ 类文档漂移。**
5. **`ps` 读不到时 `launchctl list` 能读到。** 本机 `ps -eo command | grep ccmem` 查不到 daemon，
   但 `launchctl list | grep ccmem` 给出 PID，再 `ps -p <pid>` 就正常。

---

# Ⅳ. 会咬人的既定事实（跨轮次长期有效）

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。
   只 unset 配置路径**不构成隔离** —— 配置回落会让测试读到真实的 `config.json`，**含 API key**。
2. **`npm test -- <文件>` 不隔离单文件**。跑单文件用：
   `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <文件>`，**两个变量缺一不可**。
3. **`loadConfig()` 无缓存、每次读盘，且 `mergeConfig` 是递归深合并**（`config.mjs:279`）。
   ⇒ 改配置**不需要重启 daemon**，且只需写你要改的那一个键。**但层级必须对**（见 Ⅲ.1）。
4. **`ps eww` 在这台机器上读不到进程环境。** 可靠替身：进程自己写出的签名验 daemon /
   `launchctl list` 拿 PID 再 `ps -p` / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
5. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）。
   **但 daemon 侧改动必须重启才进进程** —— 本轮就栽过：daemon 起于早上，闸门是晚上合并的，
   直接开 `enabled` 会得到 24/7 采样且不报错。**改完 daemon 代码，先确认 `uptime_sec` 晚于合并时间。**
6. **daemon `restart` 会在四道闸门全过时自动重写 plist**，但指向类 key（`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`）
   的改动会被拦下，仍需人工 `uninstall && install`。⚠️ **拦它的通常是 G1 而不是 G2。**
7. **坏配置会让 daemon 拒绝启动**（`ConfigError`）。刻意如此，**明确不回落 `DEFAULT_CONFIG`**。**hook 不受影响。**
8. **`task_runs` 有 30 天清理**（`tier15.mjs:62` 与 `:130`）；**没有清理的是 `tasks`** ——
   全仓库无 `DELETE FROM tasks`，且无 `(status, scheduled_for)` 索引，`mainLoop` 的 due 查询全表扫。
   活动闸门把探针的增量从 288 行/天降到 ≈44，但**问题本身还在**。
9. **被测二进制要显式跑目标 checkout 的 `./bin/ccmem`** —— PATH 上的 `ccmem` 走符号链接指向主仓库。
10. **`openaiConfigFrom` 里 `maxRetries: 0` 是硬编码的** ⇒「`new OpenAI({timeout})` 默认重试 2 次、最坏 timeout×3」
    这个陷阱**在本仓库不成立**。
11. **`mainLoop` 空闲时睡 300 秒、活跃时 30 秒**，由 `wakeRecently()` 决定，
    而**只有 `stop.mjs:74` 会 touch 那个 wake 文件**，且 `setTimeout` 叫不醒它。
    ⇒ 每个工作时段的**第一个样本可能比第一次 prompt 晚最多 5 分钟**。
12. **mode 为 `off` 时 `mainLoop` 在调用 `scheduleCronTasks` 之前就 `continue` 了**（`loop.mjs:373` vs `:378`）。
    ⇒ **任何 cron 类功能"配置全对却不工作"，先查 mode。**

---

# Ⅴ. 硬性纪律（每一条都是真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** **廉价红不算数**："函数不存在"不算，**"崩溃红"同样不算**。
  要**定向变异红**：红在被测断言自己命名的行为上，**且对照测试保持绿**。
- **改了既有测试，就要重跑它原本守护的旧变异**（Ⅲ.3 是本轮的新血教训）。
- **纯函数有测试 ≠ 接线有测试。** 回归测试要打在**进程边界**（退出码 + stderr）。
- **读码推出来的影响面必须实测复核。**
- **撤回一个说法时，要去原话所在的位置作废它**，不能只在发现问题的那一条里记。
- **0 计数 / 不动的数字，先解释来源再当结论。已出现九种来源**：分母为 0、进程比代码旧、链条死掉、
  幸存者偏差、查错字段名（`hook`≠`event`）、签名为 null 让 SQL 谓词恒不成立、分母只有 1、
  被测二进制解析到错的 checkout、**配置键嵌套层级错**。
- **写进文档的任何计数都必须来自单一冻结快照**（`metrics.jsonl` 是活文件）。
  **`jq -r 'select(...)'` 会把整个对象美化成多行** ⇒ 用 `jq -c` 或投影成标量。
- **描述"持续过程"的测量结论必须带日期**，且**建立在它之上前先用当前数据重新推导**。
- **反面的"什么都没发生"需要正面对照才可信**，且对照必须和目标同处一地。
- **恢复/写入类操作要用校验和或读回验证，不要信退出码。**
  ⚠️ **`mv`/`cp` 在本机是交互式别名**，会静默拒绝覆盖 ⇒ 用 `command mv` / `command cp -f` **并读回验证**。
- **测试隔离必须是模块级默认。** 本仓库曾有一条测试跑真 `launchctl` 并劫走本机 daemon 注册。
- **在 live 库的副本上验证**（`mode=ro`），**不要用 mtime/size 比对**（该判据已作废）。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。
- **subagent 的每条命令都要显式 `cd`** —— cwd 会在回合之间静默重置。
- **git-ignored 的账本只有主仓库那份算数**（`.wolf/buglog.json`、`.superpowers/`）；worktree 副本随 worktree 消失。
- **不要重做已完成的 Task。** 信 ledger 和 `git log`，不信对话摘要。

---

# Ⅵ. 人类裁决 —— 不得静默推翻

完整理由在各轮 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除**；**签名契约返回 `null`**，不是抛错。
3. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
4. **provider API key 不进 daemon 环境白名单。** `renderPlist()` 是唯一求值点。
5. **探针决策流文件无上限，`diagnose --feedback` 打印其磁盘占用** —— **刻意让成本可见，不要"优化"掉。**
6. **熔断容忍 2 次失败才开**（Finding 14 的行为变更是刻意的）。
7. **坏配置 = 响亮地死，daemon 不刷栈**，明确不回落 `DEFAULT_CONFIG`。
8. **`plist_rewrite` 被拦时必须打到 stderr。**
9. **红证据缺口用变异红补，不用廉价红。**
10. **SDD workspace 保留，不按 SDD 流程删。** 目前保留四个，均 gitignore。
11. **探针的六条**（daemon 侧带外、常驻仪器、取本地真实文本、默认关、记 `prompt_chars`、模块内部也要有 `enabled` 闸门）。
12. **🆕 活动闸门只放在入队处，不进探针模块内部。** #11 末条守的是**花钱**性质的闸门；
    活动不是安全属性，已入队的行最多晚一个 tick 执行。
13. **🆕 不新增配置项来控制活动闸门。** 依据是 Rule 2 与 `daemon.mjs:696` 自己写的
    「新增配置项就是新增一个可与代码分歧的面」。**代价是没有退回 24/7 采样的开关，这是刻意的。**
14. **🆕 速率上限保持 5 分钟默认。**

## 一条关于 plist 与凭据的、两个方向都错的说法

`DAEMON_ENV_PASSTHROUGH` 里有 `ANTHROPIC_*` 的 key，所以"plist 不含凭据"是错的；
但 passthrough **只在安装那一刻的 shell 里该变量确实非空时**才复制，而这些凭据平时活在 `config.json`，
所以"它们今天就明文写在 plist 里"同样是错的。**真实情况取决于安装时的 shell。**
**安全规则不因此放松：plist 可能含凭据，永远不打印/落盘/写进文档。**

---

# Ⅶ. 下一条线：v0.14

## 待办来源

`.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- **Finding 13 的深层解**：让预算对同步工作真正生效需把 hook 工作切段 —— **设计改动，需人类裁决**。
- **回填失败的退避策略**：永久性失败（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**，真解是迁移到 `@huggingface/transformers`。
- **`tasks` 表没有清理逻辑**（Ⅳ.8），值得单独立项。
- **🆕 `admin daemon restart` 的假阴性**（Ⅱ.2），spec 已就位，只差那个判断题。
- **🆕 抖动测试现在是三个文件**（见 Ⅷ），合并为一个 issue，不阻塞。
- **🆕 本轮延后的 minor**：见 `2026-08-05-probe-activity-gate/progress.md` 的 `minor (deferred)` 行
  （生产初值 `lastProbeAtMs = Date.now()` 无直接测试、spec §8b 的尾随界应是 `interval_ms + 一个 tick`、
  时钟回拨会压制探针）。全分支审查已逐条分诊为「可以 ship」。

## 核心问题：`l25_cov` 是否存在可行阈值

- 随机对照 n 已达 399。**p50 漂移轨迹 `0.125 → 0.075 → 0.029`，跨度远超 V2 自设的 ±0.03 门限**
  ⇒ **「分位数对比不可作判据」已坐实。**
- ⚠️ **信号(0.081) 高于噪声(0.029)，看起来"终于有信号了"。这正是 Finding 2 警告的读法，不要中招。**
- `l25_legacy_hit` 仍 **0/1666**，无任何正例标签，仍需人工标注约 50 个样本。

**三条已知样本偏差，做分布分析前必须先评估：**

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉 ⇒ 现有数据可能系统性缺失慢会话。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开 ⇒ 该时期通道统计偏向词法。
3. **超时未重新定值之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** —— 同样偏向词法。
   **⚠️ 这条至今仍在持续产生**，而且因为 Ⅰ 的问题，尺子还没开始量。

## 分析阶段的方法要求（造好尺子不等于能下结论）

外推被截断的区间之前，**必须先检验探针能不能代表 hook**：拿探针 <800ms 的那部分对照 hook 已知的
105 条成功样本，并拿 `text_chars` 对 `prompt_chars` 校准（⚠️ `prompt_chars` 目前样本极少，要等积累）。
**对不上就是"不可判定"，不是硬外推。** 这**不是**复活 Ⅶ 那条作废的分位数判据 ——
那条作废的是拿分位数当阈值判据，这里是对仪器有效性的检验，失败时输出"不可判定"。

---

# Ⅷ. 建议使用的 skills

- **`superpowers:systematic-debugging`** —— **下一轮开场就该用它查 Ⅰ。** 本项目所有修对了的东西都靠"先取证再改代码"。
- **`superpowers:subagent-driven-development`** —— 本轮用它跑完活动闸门全程。
  **经验重申并加强：把能力预算花在审查上。** 实现用中档模型足够；**全分支审查务必用最强模型** ——
  本轮它抓出 1 Critical + 3 Important，全部是"测试变得不可能失败"这一类，而 per-task 审查一条都看不到。
  **它是本轮唯一发现"默认关因为花钱"那条裁决当时零覆盖的环节。**
- **`superpowers:verification-before-completion`** —— 多次差点把"没验证"当"已完成"。
- **`superpowers:test-driven-development`** —— 要读到"接线也要测""崩溃红不算红"那一层。
- **`superpowers:writing-plans`** —— 改生产常数（`openai_timeout_ms`）那一步必须先出计划。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。
- **`superpowers:finishing-a-development-branch`** —— 分支收尾走它；它会先在**合并结果**上重跑全套。

---

# Ⅸ. 备注

- **不要 push**（人类自己做）。**删分支/worktree 必须先问。**
  现存分支：`main`、`v0.13-spec`、`v0.13-dogfood-fixes`、`ccmem-v012-finalization`。
  worktree：仅 `ccmem-v012-finalization`（与本线无关）。
  **本轮的 `probe-activity-gate` 与 `daemon-restart-false-negative` 已在人类授权下删除**
  （合并后 `-d`，两个都成功，内容全在 `main` 历史里）。
- **四个 SDD workspace 都刻意保留**（均 gitignore）。承载全部人类裁决及理由、实测取证、事故经过 ——
  **git 历史一条都不记。**
  ⚠️ `.superpowers/sdd/progress.md`（旧扁平路径）**是 git 跟踪的**，属更早的计划，别删。
- **套件基线 535 pass / 0 fail**（在合并结果上实测）。
  **已知抖动现在是三个文件**：`stop-daemon-flow.test.mjs`、`admin-cron-command.test.mjs`、
  以及**本轮新发现的** `admin-daemon-command.test.mjs`（3 次全量跑里红 1 次，单跑 3/3 绿）。
  **红了要先确认是这三个文件之一，再谈回归。**
- OpenWolf 记账：`.wolf/buglog.json`、`.wolf/memory.md` 已 gitignore；`.wolf/cerebrum.md` 入库。
  已记到 `bug-063`。**未修的 finding 不记 bug，只活在 dogfood/spec 文档里。**
- 附录 A 不变量现为 **120–144**，**没有 runner，是人工 checklist**。#143 与 #144 都是部分验红并已如实披露。
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 ~$60，文档回填 ~$45，10/11+附录 A+Finding 5 ~$80，
  Finding 10 修复 ~$140，Finding 15 取证+设计+Task 1 ~$100，Finding 15 Task 2–4+审查+合并 ~$66，
  **本轮（活动闸门设计+计划+SDD 两任务+全分支审查+修复波+合并+restart 诊断）~$195**。
  本轮**远超 CLAUDE.md Rule 6 的单会话 450k 预算**，成本主要在四次 subagent 派发与前期取证对话。
  **开新一轮前先 `/compact`。**
