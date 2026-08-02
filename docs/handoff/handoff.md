# ccmem v0.13 — Handoff

> v0.13 已发布并合并。此后完成 **第一轮 dogfood**，并在 2026-08-01 → 08-02 完成五波修复/取证：
> Finding 9/4 → Finding 12（配置回落）→ Finding 13（hook 超时）→ Finding 14（熔断阈值失效）
> → **本轮：文档回填收口 + Finding 15（embed 超时落在延迟分布中间）**。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料与提交信息里。

## 先读这些，按顺序

| 材料 | 为什么需要 |
|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **最重要，先读。** 15 条 finding、V1–V8 验证清单（**§五现已 V1–V8 全有条目**）、门禁。 |
| `git log`（近 ~17 个提交） | **每条修复的完整根因、证据、取舍都在提交信息里**，本文档刻意不重复。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger —— 每条人类裁决及理由、全部延期项。git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 末尾「NOT in this wave」= v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` | 附录 A 不变量现为 **120–141（22 行）**，136–141 覆盖 Finding 6/7/8/12/13/14，每条均已验红。**未修的 Finding 5/10/15 刻意无条目。** |

## Git 状态

**本文档不写 commit SHA，也不写"领先几个提交"** —— 提交这份文档本身就会改变这些数字。自己数：

```bash
git log --oneline -20
git rev-list --count origin/main..main    # 本地领先多少
git status --porcelain                    # 应为空
```

本轮落在 main 上的四个提交，**按标题找、不要按 SHA 找**：

- `docs(admin): list cross_project_patterns in the admin command surface`
- `docs(dogfood): record Finding 15 — the hook's embed timeout sits inside the latency distribution`
- `chore(cerebrum): retire the mtime check as proof that a probe wrote nothing`
- `docs(dogfood): backfill the statuses the G1 wave left stale, and fill in V1/V2/V6/V7`

需要知道的事实：

- 本地 `main` **领先 `origin/main`，尚未推送**。**人类自己处理所有 push —— 不要代为推送。**
- 分支 `v0.13-spec`、`v0.13-dogfood-fixes` 均未删除（**删分支必须先问**）。
- 套件 **2026-08-02 实测 477 pass / 0 fail**（`npm test`，exit 0，本次无抖动）。
  已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；不阻塞，但**红了要先确认是它**。
- 附录 A 不变量 **22/22**（21 行机械判定 + #127 人判）。附录 A **没有 runner**，是人工 checklist。

## ⚠️ 会咬人的既定事实

1. **`npm test` 现在同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**（脚本已改）。
   只 unset 配置路径**不再构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **默认目录以后迁到 `~/.ccmem/` 之类，只需改 `scripts/lib/paths.mjs` 一处** ——
   配置路径已跟着 `getDataRoot()` 走。**不要再在别处解析数据根。**
3. **`ps eww` 在这台机器上读不到进程环境。** 旧版曾把它写成「唯一验证手段」，那是错的。可靠替身：
   `zsh -f -c 'echo $VAR'` 验继承 / 进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
4. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）；
   **只有 daemon 需要 `uninstall && install`**（plist 冻结安装时的环境快照，`restart` 不重新生成）。
5. **🆕 「取副本前后比对 mtime/size 证明 live 库零写入」这条判据本身是坏的，本轮已作废。**
   daemon 与 hook 持续在写，写者的 auto-checkpoint 会改 `global.db` 的 mtime，而 WAL 停在高水位尺寸不变
   —— **我完全不操作时也观测到它自己变**。正确判据是：连接开在 `mode=ro`（VFS 层阻断写）
   **加一个正面对照**（`mode=ro` 的 SELECT 前后 mtime 不动）。已记入 `.wolf/cerebrum.md`。

## 已完成（不要重做）

| 项 | 状态 |
|---|---|
| **G1**：OpenAI 回填 + 消费端 | ✅ 达成，**口径已在文档里收窄**：达成的是"链路可用"，不是"链路始终在用" |
| **V1–V8** | ✅ 验证项全部做完；**§五 现已 V1–V8 全部有实测条目** |
| **Finding 12 / 13 / 14** | ✅ 均已修复并有回归测试 |
| **Finding 15** | ✅ 已取证成条，**未修**（属 v0.14） |
| **dogfood 7 处自相矛盾** | ✅ 本轮全部回填，**每处附证据或写明为何不勾** |
| **Closure checklist** | ✅ 5 项全勾（靠补 §五 V1/V2/V6/V7 + 修 `admin.md` 才真的成立） |
| **`commands/admin.md` 命令面** | ✅ 补上遗漏的 `cross_project_patterns`（v0.9 起就漏，中间改过 5 次都没跟上） |

**本轮最该记住的三条**：

- **Finding 15**：`openai_timeout_ms: 800` **落在真实查询嵌入延迟分布的中间** ——
  成功样本 384–796ms，失败样本 802–809ms（全是 `Request timed out.`），**两段之间没有间隙**。
  约 1/3 的 prompt_submit 丢掉语义通道。这个值是 Finding 4 按「hook 内部预算 200ms」选的，
  V8/Finding 13 把 harness 放到 5s、预算放到 2000ms 之后**从未重新推导**。
  **修它需要实测 p99，而现有数据是截尾的**（失败样本被 800 截断），取样会改变生产行为 ⇒ 需人类裁决。
- **Finding 14 的修复有生产活证据**：7 次 `B-circuit` **全部早于**该修复；
  修复后 6 次失败、**零次熔断**，含连续两次失败仍未开闸。
  **反过来说：修复前的任何 `B-fail`/`B-circuit` 比例都不能与修复后的数据混算。**
- **又栽了一次"查错字段名的 0"**：统计探针 CJK 分布时用了 `is_cjk`，全表恒 falsy，
  得出"444 条全是 non-CJK"的假结果；**真字段是 `has_cjk`**。
  与 `metrics.jsonl` 的键是 `hook` 不是 `event` 完全同型。已记入 dogfood §五 V2。

## 还欠什么（按建议顺序）

**验证项与文档回填都已收口。原列的三件本轮全部完成。**

1. ~~Finding 10 / 11 成条~~ → **✅ 已完成（2026-08-02，提交 `docs(dogfood): give Findings 10 and 11 their own entries`）**。
   两条均已按代码事实落笔，不是照抄转述：Finding 10 **未修**（已进 dogfood §四 的 v0.14 候选），
   Finding 11 **已确认修复**（提交 `fix(daemon): reclaim tasks left running by a dead daemon`，
   其两条回归测试本轮实测 2 pass / 0 fail）。同一提交顺带作废了 Finding 9 里那句过期的 `ps eww` 取证。

2. ~~附录 A 不变量~~ → **✅ 已完成（2026-08-02，提交 `docs(spec): add Appendix A invariants for the dogfood fixes`）**。
   新增 **136–141** 六条，覆盖 Finding 6/7/8/12/13/14；**每条都先被看着变红**
   （镜像五个文件到临时树、逐条单独回退一处修复；138 的两半分别回退各验一次）。
   **Finding 5 / 10 / 15 刻意无条目** —— 未修 ⇒ 没有可钉的行为，编出来必然恒绿。

3. ~~§一 的陈旧数字~~ → **✅ 已更新为实测值**：`npm test` **477 pass / 0 fail**（exit 0，本次无抖动），
   附录 A **22/22**（#127 为人判项，已人工核过）。header 里合并当时的 449/16 已标注为历史数字。

**⇒ 三件全部收口，v0.13 这条线上没有已知欠项了。** 下一步属于 v0.14（见下方两节）。

## 当前运行时状态（会漂移，用命令核对）

```bash
ccmem admin semantic status          # provider / embedded / pending
ccmem admin diagnose --retrieval     # stale vectors / Circuit
ccmem admin diagnose --feedback      # 探针队列 / l25-probe.jsonl 磁盘占用
tail ~/.claude/ccmem/daemon.err.log
```

本轮在 live 库的只读副本上量到的（**会漂移，只作量级参考**）：

- 签名分布：`openai:text-embedding-3-small:1536` **4696** / 无签名 468 / `transformers-local:...:384` **2**（均 quarantine）。
- **468 条无向量里 467 条不在回填 population 之外** ——
  `pendingEmbeddings` 只数 `status='active' AND decay_status IN ('active','probation')`，
  真正 pending 的**只有 1 条**。**看到大数先算 population，别当积压。**
- `vec_backfill` 只有三个入队点：daemon 启动、链式续排、**`daily_maintenance` 每天直接调一次**。
  ⇒ 新记忆最长要等到下一次 daily maintenance 才拿到向量。
  （`vec-backfill.mjs:26` 的注释仍写「on no recurring schedule」，与 daily maintenance 直调不符 —— 陈述性小瑕疵。）
- daemon 由 **launchd 托管**，plist 已重装并携带 `CCMEM_CONFIG_PATH`。
- embedding provider = **openai / text-embedding-3-small / 1536**；配置在 `~/.claude/ccmem/config.json`
  （仓库外，含 API key，**从未进入仓库或本文档**）。
- 探针：`l25-probe.jsonl` 已 2.6 MB / 1666 行（`retention_days: 0`，永不自动删）。

## 硬性纪律（每一条都是这几轮真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** 已栽三次：
  ① 表名写错（`task_runs` 与 `tasks` **两个表都存在**，别想当然）；
  ② dedup 探针挑错记忆（`candidateRows()` 取"最近 touch 的 20 条"，不是 FTS 捞的）；
  ③ 测试里的 stdout 桩没回调 `resolve`，把 `withHookSafety` 的 await 挂死。
- **纯函数有测试 ≠ 接线有测试。** 回填超时的第一版提交实际什么都没改变。
- **0 计数 / 不动的数字，先解释来源再当结论。已出现七种来源**：
  分母为 0（Finding 3）、进程比代码旧（Finding 1）、链条死掉（Finding 4/11）、
  幸存者偏差（V8/Finding 13：被杀的那次来不及写行）、**查错字段名**（`hook`≠`event`；`has_cjk`≠`is_cjk`，**本轮又中一次**）、
  签名为 null 让 SQL 谓词恒不成立（V5）、**分母只有 1**（本轮 dedup 的"无新增"）。
- **单面的绿在同签名库上恒真**；构造异签名必须**同维不同模型**（维度不同会被长度检查安全挡掉）。
- **反面的"什么都没发生"需要正面对照才可信**（V5 的 B 组、mtime 那次的 ro-SELECT 对照）。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`）。
  **但不要再用 mtime/size 比对来"证明"零写入 —— 见既定事实 5。**
- **不要从缺失下结论。** 先找到写入点，再解释为什么没有行（Finding 14 的 audit 是不可达，不是没写）。
- **不能解释的 0 就写"不可判定"，不要写成结论。** 本轮 `feedback.mjs` 的 0 即按此处理。

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除**（不是只删 `active_model` 键）—— 签名机制已正确覆盖换模型。
3. **签名契约返回 `null`**，不是抛错。**注意**：正是这个 `null` 让 V5 的分歧表现为静默的 0。
   契约本身没错，错的是 `diagnose` 在 embedding 关闭时仍去构造并展示一个由此得来的计数。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖（2026-08-02 裁决）。
5. **provider API key 不进 daemon 环境白名单** —— `renderPlist` 会把环境字典明文写进 `~/Library/LaunchAgents`。
6. 探针决策流 `l25-probe.jsonl` 无上限（`retention_days: 0`），`diagnose --feedback` 打印其磁盘占用 ——
   **刻意让运行时成本可见，不要"优化"掉**。
7. **Finding 14 的行为变更是刻意的**：熔断现在容忍 2 次失败才开。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- ~~dogfood Finding 5~~ → **✅ 已修复（2026-08-02）**，裁决是**响亮地死 + daemon 不刷栈**，
  明确**不**回落 `DEFAULT_CONFIG`。附录 A 新增 **#142**，已记 `bug-061`，套件 **480 pass / 0 fail**。
  **hook 一行未改** —— 实测它们已经正确降级。下面这段是当时的分析，保留作为"读码推断被实测推翻"的记录：
  1. **影响面在 Finding 12 之后被抬高了，dogfood 里标的 P1 是旧口径。**
     修复前：没有 `CCMEM_CONFIG_PATH` 的进程直接返回 `DEFAULT_CONFIG`，**根本不 parse 那个文件**。
     修复后：**每个进程都 parse 它**。
     **⚠️ 我先前在这里写过"同时打死三个 hook 和 daemon" —— 已实测证伪，那是读码推的，不是量的。**
     实测（见 dogfood Finding 5 的实测表）：**三个 hook 都 exit 0**，`withHookSafety` 兜住并降级为空上下文；
     **真正会死的是 daemon（启动即死，launchd 下反复失败 ⇒ 回填与 daily maintenance 全停）与 CLI**。
     另有一条新的：**合法 JSON 但形状不对（如顶层是字符串）会静默等同于没有配置** —— 无任何报错，
     今天就已成立。**先按实测重算影响面，不要沿用 P1，也不要沿用我那句错话。**
  2. **⚠️ 最容易踩的坑：`catch` 里回落到 `DEFAULT_CONFIG` 会原样重造 Finding 12。**
     `DEFAULT_CONFIG.embedding.provider` 是 `transformers-local`，而库里的向量是
     `openai:text-embedding-3-small:1536` ⇒ 签名不匹配 ⇒ 检索静默退化成词法，**一条报错都没有**。
     "解析失败该响亮地死，还是该带着错误的 provider 静默活下去"**是设计问题，可能需要人类裁决**，
     不要顺手 catch 了事。
  3. **红测必须打在接线上，不是纯函数上。** 项目已栽过一次（回填超时第一版提交实际什么都没改变）。
     要证明的是**真实 hook / daemon 进程**在坏配置下的行为，不是 `loadConfig()` 单测会抛。
  4. 附录 A 若为它加条目，**先按 136–141 的做法验红**（镜像树 + 单独回退），未修之前不加。
- **Finding 10**（plist 冻结环境快照，`restart` 不重生成且无任何提示）——
  **已成条、未修**，是 v0.13 这条线上唯一新增的 v0.14 候选。
  （**Finding 11 已确认修复，不属 v0.14**。）
- **Finding 13 的深层解**：让预算对同步工作真正生效需把 hook 工作切段 —— **设计改动，需人类裁决**。
- **🆕 Finding 15**：重新推导 `openai_timeout_ms`。**判据是实测 p99，而现有数据截尾** ——
  取无截断样本会改变生产行为，需人类裁决取样方式。
- **V5 取证出的三条**（均未修，见 dogfood Closure review 的 deferred 桶）。
- **回填失败的退避策略**：永久性失败（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**。真解是迁移到 `@huggingface/transformers`。
- 两个 daemon 测试抖动合并为一个 issue，不阻塞。

## v0.14 的核心问题：`l25_cov` 是否存在可行阈值

**本轮把这个问题往前推了一步，但方向是"更难"而不是"更容易"**：

- 随机对照 **n 已达 399**（原判据 ≥60，达成）。
- **p50 漂移轨迹 `0.125 → 0.075 → 0.029`，跨度 0.096，远超 V2 自己设的 ±0.03 门限**
  ⇒ **「分位数对比不可作判据」这个结论已经坐实**，不要再用它。
- ⚠️ **现在信号(0.081) 高于噪声(0.029)，看起来"终于有信号了"。这正是 Finding 2 警告的读法，不要中招。**
  噪声底随 n 单调下降本身说明小 n 的 p50 不稳，且总体随时间变化未被排除。
- `l25_legacy_hit` 仍 **0/1666**，**无任何正例标签**，仍需人工标注约 50 个样本。

**三条已知的样本偏差，做分布分析前必须先评估**：

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉，而 stop hook 正是写探针行的地方
   ⇒ 现有探针数据集可能系统性缺失慢会话/长会话。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开
   ⇒ 该时期任何"检索是否走了语义通道"的统计都偏向词法。
3. **🆕 Finding 15 未修之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** ——
   同样偏向词法，且**这条偏差至今仍在持续产生**。

## 建议使用的 skills

- **`superpowers:systematic-debugging`** —— Finding 12/13/14/15 都是靠"先取证再改代码"才没修错地方。
  尤其记住反面教材：`ps eww` 那次测量失效、从缺失下结论那次、**本轮 mtime 判据与 `is_cjk` 字段名两次测量失效**。
- **`superpowers:test-driven-development`** —— 项目硬性纪律就是红-绿，**且要读到"接线也要测"那一层**。
  做附录 A 那轮**必须**用它：不变量要先被证明能变红。
- **`superpowers:verification-before-completion`** —— 本轮多次差点把"没验证"当"已完成"。
- **`superpowers:writing-plans`** —— 若开附录 A 不变量那一轮。**新计划里的测试代码要当草稿而非圣经**。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`）已 gitignore；`.wolf/cerebrum.md` 入库。
  已记 `bug-058`（hook 配置分歧）、`bug-059`（hook 超时三层根因）、`bug-060`（熔断阈值失效）。
  **Finding 15 未修，故未记 bug-061** —— 与 Finding 5/8/10 同样处理（未修的 finding 只活在 dogfood 文档里）。
- SDD workspace **刻意保留**：承载全部人类裁决及理由、final review findings、8 份任务报告。
- 本次运行的所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 那轮 ~$60，**本轮 ~$45**。
  跨进程 / 跨数据源取证代价很高。剩余工作里 Finding 10/11 成条应当很便宜（读码 + 查 git 历史），
  **附录 A 那轮建议单开、并在开始时就 `/compact`**。
