# ccmem —— Handoff

> **bug-063（`admin daemon restart` 假阴性）已修完并合进 `main`**。
> ⚠️ **套件不是稳定绿的**：修复前 112 次全量跑 16% 会红；2026-08-09 又跑了 48 次，12.5% 会红（详见 Ⅹ）。
> "545 pass / 0 fail" 只是单次跑的结果，不是基线。
> 探针仍在积累：**2026-08-09 09:0x 干净快照 n=59**（目标 ~300；口径见 Ⅰ，2026-08-09 补严了窗口定义）。
> 🆕 **`pid=null` 的根因已确认并修复 —— 它是产品缺陷，不是测试抖动**（读撕裂，见 Ⅱ 末尾）。
> 🆕 **2026-08-09 又修掉一条产品缺陷（写事务用 deferred `BEGIN` ⇒ 517），但它在本机潜伏，
> 不解释任何一条已观测的红** —— 见 Ⅱ 末尾，**别把它当成 SQLITE_BUSY 那条抖动的答案**。
> **仍有未修的测试抖动**：`admin-daemon-command` 剩下的两种失败模式、`plist-drift`（见 Ⅹ）。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在材料、ledger 与提交信息里。
> **本文档不写任何 commit SHA，也不假设 HEAD 停在哪里** —— 提交本文档本身就会移动 HEAD。
> 用 `git log --oneline -20` 按**提交标题**找；文中**行号是写作当时的，会漂**，用符号名 grep 复核。
> ⚠️ **Ⅲ / Ⅴ / Ⅵ 里的"本轮"一律指"学到这条教训的那一轮"，不是你现在这一轮** —— 这些章节是跨轮累积的。
> 只有 Ⅱ 的小节标题带日期，那才是交付时间线。

---

# 🚀 快速接手 —— 先读这 7 行

1. **先跑 `git status` 和 `git log --oneline -15`，状态以你跑出来的为准。**
   ⚠️ **本文档刻意不写 `main` 与 `origin/main` 差几个提交** —— 提交本文档就会变，人类也会在任意时刻 push。
   **禁令不变：不要 push。** 分支 `daemon-restart-false-negative` 已合并但**未删除**（删分支要先问）。
2. **没有已知待修的产品 bug**（2026-08-09 修掉三条，都在 `main`：读撕裂、写事务的 517、以及 review 找出的
   两条收尾），但**有已定位、未修的测试抖动**。见 Ⅹ —— **接手前先读 Ⅹ**，它推翻了旧版"套件稳定绿"的说法。
3. ✅ **`load_1m` / `cpus` 链路已于 `08-09 10:26:58` 实测确认打通，这条不用再做。**
   证据：该样本 `ts` 晚于 daemon 启动时刻（`uptime_sec` 反推为 `10:17:25`），且 `load_1m=4.982 cpus=10`、
   `ms=409 ok=true` 照常产出 ⇒ 进程加载到了新代码、字段真的落盘、`ms` 测法未被改坏。
   **从此新样本按 `load_1m/cpus` 过滤，不要再手画污染窗口**（旧样本仍只能用 Ⅰ 的窗口表，两段分别报）。
4. **探针数据仍在积累**，n=59 / 目标 ~300（目标值本身建议按判据重推，见 Ⅶ）。取数方法见 Ⅰ 末尾。
   **除已裁决的 `load_1m`/`cpus` 外不要再改探针代码**（样本要同源）。
5. **⚠️ 探针数字每轮都要重算，不要照抄：** 差值**不再是 0**（当前 `3/59 = 5.1%`，Wilson `[1.7%, 13.9%]`），
   **尾巴仍然肥** —— 59 个样本里 **5 个超出 ~1360ms 预算上限**，预算内的超时救不回它们。
   🔴 **取数前先剔除被你自己的重活污染的时段**（曾差点因此读出 12.2% 的假信号）。见 Ⅰ，
   **那里记着已知的污染窗口清单，每轮取数前先对一遍。**
6. **分位数对比不可作判据**，v0.14 已坐实，不要复活。
7. 硬性禁止：**不要 push**、**删分支/worktree 先问**、**不要把 plist 或配置内容打印/落盘**。

---

# Ⅰ. 探针现状（2026-08-09 09:0x 单一冻结快照）

链路早已确认打通，**不要再去查它**。daemon 实测 `uptime_sec≈167356`（起于 08-05 22:08），一直活着。

**2026-08-09 09:0x 重新取数（干净快照，n=59）—— 结论与前四版一致：**

```
n = 59  (正常计时 58 + 截尾 1)     另有 1 个错误样本被排除并打印：'Connection error.'
P(ms≤800)  = 50/59 = 84.7%
P(ms≤1300) = 53/59 = 89.8%
DIFF P(800<ms≤1300) = 3/59 = 5.1%   Wilson 95% CI [1.7%, 13.9%]
>1360ms 预算上限: 5/59 = 8.5%
>>> n<300，数据不足，不要从区间里读点估计
```

（轨迹：`0/22` → `2/55 = 3.6%` → `3/58 = 5.2%` → `3/60 = 5.0%` → `3/59 = 5.1%`。**五版一致，只是慢慢在攒样本。**）

⚠️ **样本增速是个真问题：2026-08-09 一整天只多出 1 个干净样本**（09:0x 那个），因为这台机器几乎全天都在跑 ccmem 会话，
新样本要么被污染、要么曝露不明。**照这个速率 n=300 遥遥无期** —— 要不要换取样策略需要人类裁决，本文档不替你决定。

🔴 **取数时必须剔除被本机负载污染的时段，否则会读出假信号。已知污染窗口，每轮取数前对一遍：**

| 窗口（本地时间） | 来源 | 处理 |
|---|---|---|
| 08-07 21:00 – 08-07 **23:25** | 96 次全量套件（**收尾放宽 60s，见下**） | **必须剔除**，17 个样本 |
| 08-08 00:00 – **08-09 08:53** | 上一轮两次会话全程活跃（跑批 + 变异实验 + 取证） | **曝露不明，单列不并**，24 个样本 |
| 08-08 23:09:40 – 08-08 23:22:57 | 48 次全量套件（A 取证） | **必须剔除**（含在上一行区间内，单列出来是为了留住来源） |
| 08-09 00:45:36 – 08-09 00:45:52 | 修复后的单次全量 | **必须剔除**（同上） |
| **08-09 09:0x – 10:17** | 本轮会话活跃（3 次全量 + 多轮变异跑） | **曝露不明，单列不并**。⚠️ 09:0x 那个干净快照是**在这些重活之前**取的，它不受影响 |

🆕 **字段分界点：daemon 于 `08-09 10:17:23` 重启，之后写入的行才带 `load_1m` / `cpus`。**
在此之前的 109 行**全部没有该字段**，只能继续用这张窗口表判定；两段分别报，不要混算。

✅ **分界点后的第一个样本已落盘并实测确认（`08-09 10:26:58`，见快速接手 3）：**
`ms=409 ok=true load_1m=4.982 cpus=10`（`load/cpu≈0.50`，采样时本会话活跃）。
**带字段段当前 n=1** —— 远不够看 `load_1m/cpus` 与 `ms` 的关系，**阈值继续不要拍死**。

🔴 **2026-08-09 新增的一条定义缺陷 —— 旧版窗口按批次起止手写、没有收尾余量，而两个边界样本恰好都是带内样本：**

- `08-07 23:24:06 (1267ms)` 落在旧边界后 **6 秒** —— 6 秒小于那个手写边界本身的精度，它几乎肯定还在批次里。
- `08-08 23:23:55 (1153ms)` 落在旧版"曝露不明"窗口 22:00 收口之后的**空档**里，而那晚会话仍在跑批。

按旧口径重算会得到 `6/65 = 9.2%`，**看着像"信号翻倍"，实际全是窗口没盖严** —— 这是 12.2% 那次的更隐蔽版本。
⇒ **规则改为：窗口按"会话是否活跃"划，不按"批次是否在跑"划**；批次边界一律留至少 60s 收尾余量。
会话活跃时段可用 `git log --date=format:'%m-%d %H:%M:%S'` 的提交时间戳坐实，别靠回忆。

对照（这就是为什么必须剔）：

| 时段 | n | P(ms≤800) | 带内 800–1300 |
|---|---|---|---|
| 干净 | 59 | **84.7%** | **5.1%** |
| 已知污染 | 17 | **52.9%** | **35.3%** |
| 曝露不明 | 24 | 79.2% | 12.5% |

把干净段与已知污染段合起来算会得到 `9/76 = 11.8%`，**看着像"抬超时能捞回的量级翻了一倍多"，实际全是测试负载**。
⇒ **跑全量套件（每次 17 秒满载 10 核）会污染同期探针样本。取数前先比对采样窗口与你自己的重活时段。**
⚠️ **"曝露不明"那一组不能反推**：它这一版长得比干净集差（12.5% vs 5.1%），上一版长得比干净集像 ——
**两次都不是证据，只是样本少。** 并进来是 `6/83 = 7.2%`，不改变任何结论 —— 所以**单列，不合并**。

## 三个跨版本仍然成立的结论

1. **差值不再是 0。** 轨迹：`0/22` → `2/55` → `3/58` → `3/60` → `3/59`。区间下界早已离开 0
   ⇒ **"抬超时能捞回一些"已有正证据**，只是量级仍不确定（当前 CI 宽达 `[1.7%, 13.9%]`）。
2. **尾巴肥。** 除了最早那个 `10003` 截尾，还有 `3635 / 5221 / 5285 / 5973`。
   ⇒ **59 个样本里 5 个（≈8.5%）超出 ~1360ms 的 prompt_submit 预算上限**，
   **任何预算内的超时都救不回它们。** 抬超时能救的只有中间那一段。
   ⚠️ 这条本身也才 5 个样本，**别把 9% 当成稳定估计**。
3. **🔴 每轮必须重算，且必须先排除自污染，还要检查窗口边界有没有留收尾余量。**
   见上面那张对照表 —— 合并污染时段会把 5.1% 读成 11.8%；边界少留 60 秒会把它读成 9.2%。

## 取数（只读，不入库）

**脚本没有提交进仓库**（Rule 2：一次性分析工具不进代码库），它只有十几行，按下面的定义重写即可：

- 逐行读 `~/.claude/ccmem/embed-latency-probe.jsonl`，**默认剔除 `ts === 1785890876078`**（08-05 08:47 手工冒烟）。
- 🆕 **2026-08-09 起每行带 `load_1m` 与 `cpus`**（人类裁决，见 Ⅵ.17）。**新样本一律按 `load_1m / cpus` 过滤，
  不要再手画时间窗口** —— 手画窗口盖不住并行跑的其他 Claude Code 实例，且边界差 6 秒就会读出假信号。
  ⚠️ **旧样本没有这个字段**，只能继续用下面那张窗口表，**两段不要混着算，分别报**。
  阈值先不要拍死：**攒够带字段的样本后，先看 `load_1m/cpus` 与 `ms` 的关系再定**，别照抄任何数字。
- 分三类，**任何一类都不许静默丢弃**：正常计时（`ok===true`）、**截尾**（`timed_out_at_probe_limit===true`，
  它是合法的"> 上限"观测，前提是 `timeout_ms > 1300`）、**失败**（报错，不是延迟观测，**报出来但不进分母**）。
- 输出 n、`P(ms≤800)`、`P(ms≤1300)`，以及**两者之差 + 95% Wilson 区间**。
  **关键简化：`P(≤1300) − P(≤800)` 就是 `P(800 < ms ≤ 1300)`，本身是单个二项比例**，Wilson 直接可用。
- **刻意不输出任何分位数** —— 见 Ⅶ。
- n < 300 时打印"数据不足"，**不要从区间里读点估计**。

**确认 `load_1m` 链路是否通（只读，一行）：**

```
node -e 'const L=require("fs").readFileSync(process.env.HOME+"/.claude/ccmem/embed-latency-probe.jsonl","utf8").trim().split("\n").map(JSON.parse); const t=L.at(-1); console.log(new Date(t.ts).toLocaleString("sv"), "load_1m="+(t.load_1m??"(无)"), "cpus="+(t.cpus??"(无)"))'
```

看到 `load_1m=<数字>` 即通。**若确实在用 CC 却仍是 `(无)`，说明 daemon 没加载到新代码，回 Ⅳ.5 排查**
（先确认 `uptime_sec` 对应的启动时刻晚于那次提交）。

## 关于"看到 0 先别慌"

闸门只在实际使用 CC 时采样。历史上出现过 7 小时零样本，原因是没人用 CC，daemon 一直好好的。
**看到 0 先查这段时间有没有人在用 CC。** 另见 Ⅴ 关于"等待期算错会把健康系统判成故障"那条。

---

# Ⅱ. 已交付（本节按时间累积，最后一小节是最新的）

## bug-063（`admin daemon restart` 假阴性）已修完并合并

**症状**：成功的 `ccmem admin daemon restart` 会打印 `daemon restart failed` 并退出 1。三个缺陷叠加。

| 缺陷 | 修法 | 提交标题（用 `git log --grep` 找） |
|---|---|---|
| 1. `restartDaemon` 展开顺序把自己刚设的 `restart_failed` 覆盖掉 | 展开放前面，与已正确的同胞返回对齐 | `fix(daemon): stop restartDaemon from overwriting its own failure status` |
| 2. CLI 没有对应分支，`phase`/`reason`/`previous_pid` 全丢 | 新增 `restart_failed` 与两个 timeout 分支 | `fix(cli): report the phase and reason behind a failed daemon restart` |
| 3. 启动等待 2000ms 短于实测冷启动 | 新增 `START_WAIT_TIMEOUT_MS = 5000` 只给 start 三个调用点，stop 仍 2000 | `fix(daemon): give the start path a 5s wait, leaving stop at 2s` |

收尾修复波（最终全分支审查提出）：`fix(daemon): surface restart's failed_status and stop advising a plist check that never applies`

- **新增 `failed_status` 字段**：`restartDaemon` 会把 `start_timeout` 改写成 `restart_failed`，
  导致 CLI 那条"超时不等于失败"的分支**对 restart 永远不可达** —— 而 restart 正是 bug 被报出来的动作。
  现在子状态被带出来，操作者分得清"我们等到放弃了"和"launchd 拒绝了"。
- **`plist=in_sync` 那句建议只对 `via=launchctl` 成立**，已加门；container-fallback 装法根本没有 plist，
  照着做会把 `plist=not_installed` 读成"启动失败" —— 与本分支要消灭的假阴性同一类。

计划与全部裁定：`docs/superpowers/plans/2026-08-06-daemon-restart-false-negative.md`、
`.superpowers/sdd/2026-08-06-daemon-restart-false-negative/progress.md`（**ledger，含四次尝试与每一条裁决**）。
诊断 spec：`docs/superpowers/specs/2026-08-05-daemon-restart-false-negative.md`。

## 另外修掉一条真实抖动（不是 bug-063 的一部分）

提交标题 `test(stop-daemon-flow): anchor the stale-retry ordering to a persisted value`。
`Date.now() - 1` 与 `handleStop()` 刚写进 seq=3 行的 `scheduled_for` 抢时钟，负载下超过 1ms 就翻转派发顺序，
seq=2 永不 supersede，`getLatestAudit()` 返回 undefined。改为锚定已持久化的值。
⚠️ **这条没有过 review subagent**，证据是前后失败率测量 + 断言未变、只让 setup 变确定。已在 ledger 如实标注。

🔴 **这一段当时写的"实测：未修 ~4/8，修后 0/8"是错的，两个数都不能用：**

- **"修后 0/8" 是假绿。** 该抖动真实频率约 **4.2%**（3/72 全量跑），8 次全绿的概率约 **59%** —— 掷一次就有一半机会得到 0/8。
- **它只修了 6 处同构副本中的 1 处。** 另外 5 处在 2026-08-08 才修完，提交标题
  `test(stop-daemon-flow): anchor the remaining five stale-retry variants too`。
- ⇒ **教训见 Ⅴ 新增的"确定性判据"那条。** 这是 Ⅲ.1（对间歇现象做小 n 判定）在自己的验收环节里复发了一次。

## 🆕 2026-08-09 交付：`pid=null` 读撕裂已确认并修复（**产品缺陷，不是测试抖动**）

提交标题 `fix(daemon): derive alive from the lock row the snapshot already read`。

**根因（实测抓到，不是推断）**：`loadDaemonStatus()` 先读 `daemon_lock` 行，再调 `isDaemonAlive(db)` **重读同一行**，
中间隔着 `readInstallState()` / `readWrapperPid()` / `isProcessAlive()` 三次 I/O。全量跑下那一行可能在窗口内被插入，
于是快照返回 `alive:true` 而 `pid/hostname/acquired_at/heartbeat_at` **全为 null**。
`startDaemon()` 的 wrapper 路径只等 `next.alive && next.wrapper_pid`、**从不等 `pid`**，就返回 `started`，
CLI 照着打 `ccmem: daemon started pid=null`。

仪器在 48 次全量里抓到 1 条（08-08 23:12:56，与那次红对得上）。**判读是预先登记的**（见旧版 Ⅹ）：

```
{"status":"started","via":"wrapper","alive":true,"pid":null,"hostname":null,
 "acquired_at":null,"heartbeat_at":null,"heartbeat_age_ms":null,"wrapper_pid":43382}
```

⚠️ 比判据要求的还硬两条：`heartbeat_age_ms` 也是 null（行若存在而 `holder_pid` 为 NULL，它会是 `Date.now()-null` 那个大数）；
且 `002_v02.sql` 里 `holder_pid INTEGER NOT NULL` ⇒ **写入侧不可能产生 NULL，方向只能是读取侧。**

**修法**：`isDaemonAlive(db)` 保留给 `cron.mjs`；陈旧判定抽成纯谓词 `isLockRowAlive(row)`。
**三处同构站点**改为用自己已读到的那一行算 alive：`admin/daemon.mjs`（`loadDaemonStatus`）、
`cmd/stats.mjs`（tier2）、`admin/diagnose.mjs`（daemon 段）。
⚠️ **只有第一处被实测观测到**，另两处是 grep 同构配对找出来的（Ⅴ"同一个 bug 只有一处是危险假设"）。
单次读取下 `alive:true` ⇒ 那一行当时在 ⇒ `holder_pid` 非空，**不变式由构造保证。**

**验收用确定性变异，不用自然频率**（该模式 48 次里才 1 次，频率毫无分辨力）：
新增 `tests/integration/daemon-status-consistency.test.mjs`，让**快照读（取 `holder_pid` 那次）落空、
存活读（只取 `heartbeat_at`）照常看见行**。修前 3/3 红在 `reported alive=true with pid=null`，修后 3/3 绿，全量 543 pass。

✅ **这条过了 review subagent（最强模型），Critical 0，Important 1 —— 已修**，提交标题
`test(daemon-status-consistency): make the torn-read seam prove it fired`。
Important 是：**seam 只在"SQL 同时含 `FROM daemon_lock` 和 `holder_pid`"时开火**，
一旦快照查询改成 `SELECT *` 或挪进 helper，仪器静默失效，而"不许 alive 配 null pid"这个否定式断言
**会被一个完全自洽的快照满足** ⇒ 测试失去分辨力却仍然绿。审查者实测确认了这一点。
现在 seam **自己数触发次数并断言 > 0**，断言也改成钉正面语义（`alive === false` 且 `pid === null`）。
两个方向都重验过：重新引入两次读取仍 3/3 红在原形态；把 seam 掐掉则红在"seam never fired"（加固前这里是绿的）。
审查另确认：**没有第四处同构站点**；`alive` 提前求值只会偏向"假的不活"，对三条 `waitFor` 都是安全方向。

## 🆕 2026-08-09 交付：写事务改用 `BEGIN IMMEDIATE`（**产品缺陷，但在本机潜伏**）

提交标题 `fix(db): start write transactions with BEGIN IMMEDIATE`。

**根因（实测，不是推断）**：`runInTransaction`（`db.mjs:166`）用裸 `BEGIN`（deferred）。它的 7 个调用点全是写事务
（各版本 migration + `reconcileFtsArtifacts`），而这些 work 都**先查 `sqlite_master`（读）再做 DDL（写）**。
别的连接一旦在这两步之间提交，SQLite 判定读快照失效，返回 **`errcode=517` SQLITE_BUSY_SNAPSHOT、报文 `database is locked`，
并且不调用 busy handler** ⇒ **`openDb()` 设的 `busy_timeout=5000` 对这一类失败完全无效，调用方 0ms 吃到一个抛错。**
台架实测：deferred 下 `THROW after 0ms errcode=517`；判别特征就是"0ms 还是 5000ms"。

**修法**：`BEGIN IMMEDIATE` —— 开始就取写锁 ⇒ 没有可失效的读快照 ⇒ 竞争回到 busy_timeout 管辖，变成"等一下"而不是"立刻炸"。

**验收用确定性变异**：新增 `tests/integration/db-write-transaction-busy.test.mjs`，用与 `daemon-status-consistency`
同一套代理式 seam，在 `ensureSchema()` **事务内第一次读之后**用另一条连接提交一次写。**两个方向都验过**：
修前红在 `errcode 517`（堆栈 `dropTriggerIfExists → runInTransaction → ensureSchema`），修后绿；
把 seam 掐掉则红在 `seam never fired`。全量 544 pass（543 + 新增 1）。

🔴 **这一段最初写的"缺陷在本机潜伏、不解释那次红"已在同日作废** —— 那个结论建立在"本机没有 fts5"之上，
而那是**用错 node 得出的**（裸 `node` 是 nvm v22.13.1；`npm test` 与 daemon 用的 `/usr/local/bin/node` v24.13.0
**支持 fts5**，见 Ⅳ.20）。**在出红的那个环境里这条缺陷是活的：**
`supportsFts()` 的探测（`CREATE VIRTUAL TABLE ccmem_fts_probe` + `DROP`）**是事务内的真实写**，
且它在**每个进程第一次 `openDb()` 时都会执行一次**（`cachedFtsSupport` 只在进程内缓存）——
而 `admin-daemon-command` 每条用例都 spawn 若干 CLI 子进程，同时有一个真 daemon 在写心跳。
⇒ **它现在是 `:686` 那条 SQLITE_BUSY 红的头号候选，但仍未证实**：要坐实必须拿到那次失败的 `errcode`
（**517 + ~0ms 才是它；5 + ~5000ms 是普通锁竞争**）。**那条抖动在拿到 errcode 之前仍然算开着。**
✅ **这条过了 review subagent（最强模型），Critical 2 + Important 2 —— 全部已修**，提交标题
`fix(db): close the remaining BEGIN sites and stop locking on read-only opens`。

- **Critical 1（我的锅）**：测试的自证开火只数了"注入跑过几次"。审查者实测把注入的目标表名改错一个字，
  **在修复被回退的情况下让测试变绿**。判据已改成钉注入的**结果**（对手写入必须以 `SQLITE_BUSY(5)` 失败）。
  **三个变异各自红在自己的断言上**：回退修复红在"对手成功提交"、表名写错红在"errcode 1 而非 5"、掐掉注入红在"从未开火"。
  教训见 Ⅴ 新增那条。
- **Critical 2**：`scripts/migrations/015_v012_repair.cjs` 有同构的 deferred `BEGIN` + 先读后 DDL，
  且它由 `runJsMigration` **直接调用、不经过 `runInTransaction`**，所以上一版没盖到。
  **全仓库 4 处 `BEGIN` 站点现已全部 IMMEDIATE**（另两处在 `vec-backfill.mjs` / `revalidation.mjs`，
  审查者核实它们事务内第一条就是写、本来不暴露，改成 IMMEDIATE 只为统一，免得下个人再推一遍）。
- **Important（也是我的锅）**：上一版让**每次 `openDb()` 都取一次写锁** —— `ensureSchema` 每次开库都调
  `reconcileFtsArtifacts`，而稳态下那段全是读。无条件 IMMEDIATE 会把所有 `openDb()` 串行化到彼此
  和 daemon 的写批次上，**而那正是 `errcode=5` 那条未解释抖动所在的路径**。现已改为**纯读的门控**
  （`ftsReconcileNeeded`）挡在事务外，进去之后再判一遍，稳态开库不再取锁。
- **Important**：测试不再按本机是否支持 fts5 分叉（那会留下一条谁都没跑过的分支），改为直接
  `CCMEM_DISABLE_FTS5=1` 走单一路径。

## 🆕 2026-08-09 交付：探针每行记录 `load_1m` / `cpus`（人类裁决，Ⅵ.17）

提交标题 `feat(probe): record machine load with every latency sample`。

**动机**：这台机器上**并行跑着别的 Claude Code 实例做别的项目**，它们的重活从 ccmem 的会话窗口里完全看不见
⇒ 手画污染窗口的做法不再成立。同日还实测到手画窗口本身有多脆：边界差 6 秒就把带内比例读成 9.2%（真值 5.1%）。

- **`ms` 的测法一个字未改**，只是加了两个字段，老样本仍可比（只是缺字段）。
- **采样点在往返之后**（请求期间才起的重活正是要抓的那类，`t0` 之前取样会漏掉）。
  负载读取做成可注入 dep，**该顺序有测试守着** —— 挪回 `t0` 之前会红在
  `the load sample was taken before the round trip finished`（已实测验过这条牙齿）。
- 消费方只有 `diagnose --feedback` 的 `statSync().size`，不解析行结构 ⇒ 加字段安全。
- **daemon 已于 `08-09 10:17:23` 重启并复核**（`uptime_sec` 对应的启动时刻晚于代码提交，`plist=in_sync` 未变）。
- ✅ **已闭环：`08-09 10:26:58` 落盘的样本带 `load_1m=4.982 cpus=10`，且 `ms=409 ok=true`**
  （`ts` 晚于 `uptime_sec` 反推的启动时刻 `10:17:25`）⇒ 进程、字段、`ms` 测法三者同时确认。**这条交付到此完整。**

---

# Ⅲ. 踩过的坑（每条都真栽过）

1. **🆕 对间歇性失败做 n=1 对照，等于没做对照。** 本轮先用"1 次失败 vs 1 次通过"就断定"是我的测试导致的"，
   补测到 n=8/arm 才发现结论反了。**间歇现象的每一个 arm 都要重复测量并计数。**
2. **🆕 被中断的 subagent 可能已经改了工作树。** 中断一次 Agent 派发后，它其实已经写入了文件；
   我把那处**未提交的工作树改动读成了仓库历史**，并在打了补丁的树上做测量，得出"没问题"的错误结论。
   ⇒ **中断 subagent 之后、以及对任何文件下结论之前，先 `git status` / `git diff`。**
3. **🆕 文件名在已知抖动清单上，不等于这次的红就是那个抖动。** 判据是必要不充分的。
   要么测失败率，要么找出机制 —— **"它在清单上"不是解释。**
4. **🆕 计划里的测试脚手架错三次都可能是同一个根因。** 本轮同一个 seam 连错三次
   （放在到不了的 `kickstart)`；后台子 shell 阻塞 `spawnSync` 的管道；子 shell 活过自己那条测试污染下一条）。
   共同点是**用"测试不拥有的机制"去模拟时序**。⇒ **能用测试自己拥有并能清理的定时器，就不要用外部进程。**
5. **🆕 变异仪器"按次序"下手会被嵌套调用偷偷耗掉引信，给出假绿。** 本轮验证读撕裂时，
   仪器最初写成"只撕每次调用里的**第一次** `daemon_lock` 读"，结果 `stats` 那条**直接绿了** ——
   不是 stats 没病，而是 `cmdStats → maybeRunTier15 → maybeRespawnContainerFallback → loadDaemonStatus`
   先读了一次锁，把引信提前用掉。改成**按查询形状撕**（取 `holder_pid` 的那次落空、只取 `heartbeat_at` 的照常）后三条全红。
   ⇒ **变异实验里出现的绿，和自然跑出来的绿一样，要先解释来源再当结论。**
6. **配置加了却完全不生效，且静默。** `latency_probe` 加在 `config.json` **顶层**，而代码读 `cfg.embedding?.latency_probe`。
   ⇒ **判据是看同块其它键有没有回落到默认**，不是看你关心的那个键。
7. **`head -1 <probe.jsonl> | jq` 会报 `Invalid numeric literal`**，而整块喂 `jq` 或用 node 读都正常。
   原因未查明。**不要用 `head -N | jq` 判断文件是否合法**，取探针数据请用 node 直接读。

---

# Ⅳ. 会咬人的既定事实（跨轮次长期有效）

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。只 unset 配置路径**不构成隔离** —— 会读到真实 `config.json`（**含 API key**）。
2. **`npm test -- <文件>` 不隔离单文件**。跑单文件用：
   `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>`，**两个变量缺一不可**。
   🔴 **必须显式写 `/usr/local/bin/node`**：`package.json` 的 `test` 脚本钉的是它，而 PATH 上的 `node` 是
   nvm 的 v22.13.1，**两者能力不同**（见 Ⅳ.20）。旧版这条写的是裸 `node`，**2026-08-09 因此得出过一个错误结论**。
3. **`npm test` 给整轮所有测试文件共用一个 data root**，而 `node --test` **并行跑文件**。
   ⇒ 跨文件干扰是真实存在的向量；但 `plist-drift.test.mjs` 在模块级把自己的 `CCMEM_DATA_ROOT` 改成独立目录。
4. **`loadConfig()` 无缓存、每次读盘，`mergeConfig` 递归深合并**。⇒ 改配置**不需要重启 daemon**，但**层级必须对**（Ⅲ.6）。
5. **hook 侧改动下次调用即生效**（`~/.claude/plugins/ccmem` 是符号链接）。
   **daemon 侧改动必须重启才进进程** ⇒ **改完 daemon 代码，先确认 `uptime_sec` 晚于合并时间。**
6. **`ps eww` 在这台机器上读不到进程环境**；`ps -eo command | grep ccmem` 也查不到 daemon，
   但 `launchctl list | grep ccmem` 给得出 PID，再 `ps -p <pid>` 正常。
7. **daemon `restart` 会在四道闸门全过时自动重写 plist**，但指向类 key 的改动会被拦下，仍需人工 `uninstall && install`。⚠️ **拦它的通常是 G1 而不是 G2。**
8. **坏配置会让 daemon 拒绝启动**（`ConfigError`），刻意如此，**明确不回落 `DEFAULT_CONFIG`**。**hook 不受影响。**
9. **`task_runs` 有 30 天清理；`tasks` 没有清理** —— 全仓库无 `DELETE FROM tasks`，且无 `(status, scheduled_for)` 索引，`mainLoop` 的 due 查询全表扫。活动闸门只降了增量，**问题还在**。
10. **`openaiConfigFrom` 里 `maxRetries: 0` 是硬编码的** ⇒「`new OpenAI({timeout})` 默认重试 2 次、最坏 timeout×3」**在本仓库不成立**。
11. **`mainLoop` 空闲睡 300 秒、活跃睡 30 秒**，由 `wakeRecently()` 决定，而**只有 `stop.mjs` 会 touch 那个 wake 文件**。
    ⇒ 每个工作时段的**第一个样本可能比第一次 prompt 晚最多 5 分钟**。
12. **mode 为 `off` 时 `mainLoop` 在调用 `scheduleCronTasks` 之前就 `continue`**。
    ⇒ **任何 cron 类功能"配置全对却不工作"，先查 mode。**（但它是排查顺位第一，不是默认答案。）
13. **被测二进制要显式跑目标 checkout 的 `./bin/ccmem`** —— PATH 上的 `ccmem` 指向主仓库。
14. **`restartDaemon` 没有导出**，只有 `cmdAdminDaemon(db, { verb })` 导出。要驱动它只能走这个入口。
15. **launchd 的 stop 路径根本不 `waitFor`** —— `bootoutDaemon()` 之后直接返回。
    ⇒ 谈"stop 等待"时先确认你说的是哪条安装路径。
16. **`runLaunchctl` 用 `spawnSync` 且 stdio 是 pipe** ⇒ 它会等到所有继承的管道描述符关闭才返回。
    **在 fake 里后台化子进程而不重定向 stdio，会让"异步"变成同步。**
17. **🆕 `daemon_lock.holder_pid` 是 `NOT NULL` 列**（`migrations/002_v02.sql`）⇒ **任何 `pid=null` 都不可能来自写入侧**，
    只能是读到了"行不存在"。同理 `heartbeat_age_ms` 为 null 也只在行不存在时出现（行在但列为 NULL 会得到 `Date.now()-null` 那个大数）。
    **这两条是判读锁相关空值的硬约束，别再从头推一遍。**
18. **🆕 `isDaemonAlive(db)`（读盘）与 `isLockRowAlive(row)`（纯谓词）并存**，陈旧阈值 60000ms 只在后者里出现一次。
    **要和 `pid` 一起报的地方必须用 `isLockRowAlive(自己已读到的行)`**，否则又是两次读取。`cron.mjs` 不配 pid，仍用前者。
19. **🆕 G4 闸门会在测试里真的 spawn `claude -p --help`。** `rewritePlistIfAllowed` → `evaluateGates` 的
    `probe` 参数是 `probeClaudeJsonSchemaSupport(command, env, 5000)`，只要 `newEnv.CCMEM_CLAUDE_P_COMMAND`
    非空就执行（在本机**确实非空**，已实测）。`withFakeLaunchctl` **只清 fake launchctl 的状态文件，不 fake 这个 probe**。
    实测空载耗时 **147–247ms**，距 5000ms 有 20–34 倍余量 ⇒ **单纯的"超时被负载打爆"解释基本不成立**（见 Ⅹ）。
    ⚠️ 但**这不等于 G4 与 `plist-drift` 抖动无关** —— 闸门失败还有 `spawnSync` 报错、非零退出等路径。
20. **🆕 这台机器上有两个 node，能力不同 —— 别混用：**
    | 二进制 | 版本 | fts5 |
    |---|---|---|
    | PATH 上的 `node`（nvm，`~/.nvm/versions/node/v22.13.1/bin/node`） | v22.13.1 | ❌ **不支持** |
    | **`/usr/local/bin/node`** | v24.13.0 | ✅ **支持** |

    **`npm test` 脚本、`admin-daemon-command.test.mjs:203` 的 `NODE`、以及实际在跑的 daemon（实测
    `ps -p <pid> -o comm=` 为 `/usr/local/bin/node`）用的都是后者** ⇒ **FTS 在生产与套件里都是活的，
    Ⅶ 里词法通道那条样本偏差不受影响。** 只有 PATH 上那个 nvm node 没有 fts5。
    🔴 **2026-08-09 曾因为用裸 `node` 跑单文件而得出"本机 FTS 分支是死的"这个错误结论**，并据此把一条
    真实缺陷误判为"潜伏、不解释观测"。⇒ **跑任何隔离验证都要显式用 `/usr/local/bin/node`（Ⅳ.2）。**
21. **🆕 `openDb()` 本来就设了 `PRAGMA journal_mode = WAL` 与 `PRAGMA busy_timeout = 5000`**（`db.mjs:564-565`）。
    ⇒ 见到 `database is locked` **不要再假设"缺 busy 重试"**。普通锁竞争会等满 5 秒；**0ms 立刻抛的那种是
    `errcode=517`（SQLITE_BUSY_SNAPSHOT），busy handler 压根不被调用**。**用"耗时≈0 还是≈5000ms"当判别特征。**
22. **🆕 `admin-daemon-command.test.mjs:192` 在模块级把 `CCMEM_DATA_ROOT` 改成自己的 mkdtemp 目录**
    （和 `plist-drift` 一样）⇒ **Ⅹ 里"7 个测试文件跨文件共享 `daemon_lock` 那一行"的解释对这个文件不成立**，
    它的竞争者只能是它自己 spawn 的 CLI 子进程与真正跑起来的 fallback daemon。

---

# Ⅴ. 硬性纪律（每一条都是真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** **廉价红不算数**："函数不存在"不算，**"崩溃红"同样不算**。
  要**定向变异红**：红在被测断言自己命名的行为上，**且对照测试保持绿**。
- **本来就绿的测试要用定向变异补红证据。** 本轮 CLI timeout 分支的测试写出来就是绿的（分支本来就工作），
  靠"把 CLI 条件改成不可达、看它红在 `/timed out/` 而 `exit code === 1` 仍然通过"来证明它**能**失败。
- **改了既有测试，就要重跑它原本守护的旧变异。**
- **纯函数有测试 ≠ 接线有测试。** 回归测试要打在**进程边界**（退出码 + stderr）。
- **退出码常常什么都证明不了。** 本轮通用兜底和正确分支都 `exit 1`，**只有 stderr 文本能区分**。
- **读码推出来的影响面必须实测复核。**
- **撤回一个说法时，要去原话所在的位置作废它。**
- **给"什么都没发生"立时限判据时，时限必须由该路径自己的最慢节奏推出，不能由最快节奏推。**
- **0 计数 / 不动的数字，先解释来源再当结论。已出现十种来源**：分母为 0、进程比代码旧、链条死掉、
  幸存者偏差、查错字段名、签名为 null 让 SQL 谓词恒不成立、分母只有 1、被测二进制解析到错的 checkout、
  配置键嵌套层级错、**在已被别人打过补丁的工作树上测量**（Ⅲ.2）。
- **写进文档的任何计数都必须来自单一冻结快照。**
- **描述"持续过程"的测量结论必须带日期**，且**建立在它之上前先用当前数据重新推导**。
- **反面的"什么都没发生"需要正面对照才可信**，且对照必须和目标同处一地。
- **恢复/写入类操作要用校验和或读回验证，不要信退出码。** ⚠️ **`mv`/`cp` 在本机是交互式别名** ⇒ 用 `command mv` / `command cp -f` **并读回验证**。
- **测试隔离必须是模块级默认。** 本仓库曾有一条测试跑真 `launchctl` 并劫走本机 daemon 注册。
- **在 live 库的副本上验证**（`mode=ro`），**不要用 mtime/size 比对**。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。
- **subagent 的每条命令都要显式 `cd`** —— cwd 会在回合之间静默重置。
- **git-ignored 的账本只有主仓库那份算数**；worktree 副本随 worktree 消失。
- **不要重做已完成的 Task。** 信 ledger 和 `git log`，不信对话摘要。
- **🆕 间歇性修复不许用自然频率验收，必须用确定性判据。** 跑 N 次全绿在低频现象上毫无分辨力
  （4.2% 的抖动，8 次全绿概率 59%）。正确做法：**先找到能强制它变红的变异**，
  用"**修复前该变异逼出红、修复后同一变异全绿**"作为判据 —— 它不受负载和运气影响。
  本轮实操：在 `handleStop()` 与取时钟之间插 10ms，修复前 5 条全红、修复后 0/8。
  ⚠️ 且**变异实验必须带正面对照**（证明变异手法真的生效），并**核对自然红与变异红的失败形态一致**，
  否则你验的可能是另一个东西。
- **🆕🔴 变异仪器要证明的是"条件被施加了"，不是"仪器跑过了"。计数器不够。**
  2026-08-09 的 review 实测演示：把注入写入的目标表名改错一个字，**修复被回退的情况下测试照样绿** ——
  注入回调确实跑了（计数 > 0），但那条 INSERT 当场抛 `errcode 1 (no such table)` 被 `catch {}` 吞掉，
  **对手根本没提交、条件从未成立**，缺陷代码就这么过了。
  ⇒ **把注入的"结果"分类并钉住它的成功特征**（本例：对手写入必须以 `SQLITE_BUSY(5)` 失败 ——
  只有我们的事务从 BEGIN 就持有写锁时才会这样）。判据要能把"仪器坏了"和"缺陷不在"分开。
  ⚠️ 这是上一轮"seam 必须自证开火"那条的**加强版**：上一轮修的是"仪器没跑"，这次栽在"仪器跑了但没用"。
- **🆕 变异仪器必须自证开火，否则它失效时你会读到假绿。** 光有"正面对照文件"不够 ——
  还要让**仪器自己数触发次数并断言 > 0**。尤其当断言是**否定式**（"不许出现 A 且 B"）时：
  仪器一失效，一个完全自洽的结果就能满足它，测试静默失去分辨力。
  ⇒ **否定式断言要配"我确实被施加了那个条件"的正面证据，并尽量改钉正面语义。**
  本轮 review 抓到的就是这一条（seam 只认某个 SQL 形状，查询改写就静默失效）。
- **🆕 确认了"机制类别"不等于解释了"那一次观测"。** 本轮实测确认了 517 升级死锁真实存在、报文与观测完全一致，
  差一点就当成结论；实际上本机缺 fts5 让那条路径稳态下**根本不写**，撞不到它。
  ⇒ **下结论前先问：这条路径在本机、在那次跑的条件下，真的会被执行吗？** 报文相同不等于成因相同。
- **🆕 隔离跑用的解释器必须和套件是同一个。** 本轮用裸 `node`（nvm v22.13.1，无 fts5）跑单文件，
  而 `npm test` 钉的是 `/usr/local/bin/node`（v24.13.0，有 fts5）。**同一份代码在两者下走不同分支** ——
  先害我写出一个"红在错误理由上"的测试，再害我把一条活的缺陷判成"潜伏、不解释观测"。
  ⇒ **跑任何隔离验证前，先确认解释器与 `package.json` 的 `test` 脚本一致**（Ⅳ.2 已改）。
  这是 Ⅳ.13"被测二进制要显式跑目标 checkout"的同族陷阱：**工具链的解析结果也要显式钉死。**
- **🆕 "同一个 bug 只有一处"是危险假设。** 上一轮修了 6 处同构副本中的 1 处就宣告完成。
  **修完一处，先 grep 同构模式数一遍总数。**
- **🆕 你自己的重活会污染正在采集的观测。** 本轮跑 96 次全量套件，把同期探针样本的 `P(ms≤800)`
  从 84.5% 压到 50%，带内比例从 5.2% 抬到 37.5% —— 差点被读成"信号变强了"。
  ⇒ **对任何持续采集的数据下结论前，先把采样窗口和自己的重活时段对一遍。**
  这是"0 计数/异常数字先解释来源"的镜像：**数字异常升高同样要先解释来源。**

---

# Ⅵ. 人类裁决 —— 不得静默推翻

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除**；**签名契约返回 `null`**，不是抛错。
3. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
4. **provider API key 不进 daemon 环境白名单。** `renderPlist()` 是唯一求值点。
5. **探针决策流文件无上限，`diagnose --feedback` 打印其磁盘占用** —— **刻意让成本可见，不要"优化"掉。**
6. **熔断容忍 2 次失败才开。**
7. **坏配置 = 响亮地死，daemon 不刷栈。**
8. **`plist_rewrite` 被拦时必须打到 stderr。**
9. **红证据缺口用变异红补，不用廉价红。**
10. **SDD workspace 保留，不按 SDD 流程删。** 现有五个，均 gitignore。
    ⚠️ `superpowers:subagent-driven-development` 的最后一步会让你删掉 workspace，**本裁决优先，不要删。**
11. **探针的六条**（daemon 侧带外、常驻仪器、取本地真实文本、默认关、记 `prompt_chars`、模块内部也要有 `enabled` 闸门）。
12. **活动闸门只放在入队处，不进探针模块内部。**
13. **不新增配置项来控制活动闸门。** 代价是没有退回 24/7 采样的开关，这是刻意的。
14. **速率上限保持 5 分钟默认。**
15. **🆕 启动等待 5000ms、停止等待 2000ms，且不做成配置项。**
    理由：restart 是人为动作、**没有外部截止时间**，抬高的唯一代价是真失败时多等 3 秒；
    而 2000ms 不够一次冷启动，代价是把成功报成失败并诱使再重启一次。
    ⚠️ **5000 是判断不是测量** —— 唯一那次冷启动观测是截尾的（只知 >2000ms），热机器复现不了冷启动。
    **真正的安全网是可读的错误消息，不是这个数字。不要在没有测量的情况下重新翻这笔账。**
17. **🆕 探针每行记录 `load_1m` 与 `cpus`（2026-08-09）。** 理由：这台机器上并行跑着别的 Claude Code 实例
    做别的项目，它们的重活从 ccmem 的会话窗口里完全看不见 ⇒ **手画污染窗口的做法已经不成立**。
    ⚠️ **这是 Ⅵ.11 六条之外新增的第七条，`ms` 的测法一个字没改**，老样本只是缺字段。
    **采样点必须在往返之后**（请求期间才起的重活正是要抓的那类），该顺序有测试守着，挪到 t0 之前会红。
16. **🆕 fake `launchctl` 里不许有延迟写锁的 seam。** 慢启动只能用**测试自己拥有并在 `finally` 里清理的定时器**模拟。
    依据是连续三次 BLOCKED（见 Ⅲ.4）。

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
- **`tasks` 表没有清理逻辑**（Ⅳ.9），值得单独立项。
- **🆕 裸 `start` / `stop` 失败时仍然丢 `reason`** —— 与本轮为 `restart` 修好的是同一类缺陷，刻意没在本轮修。
  一并做的话还有两项：`stop_timeout` 那半个 CLI 条件零覆盖、`phase:'start'` 现在有了测试但 `stop_timeout` 没有。
  **三者共用一个 seam 和一条红，适合合成一个 issue。**
- **🆕 `stop-daemon-flow.test.mjs` 仍有一处负载敏感设计**：`Promise.race` 用 1000ms 硬上限去框住真实子进程工作，
  外加 50ms 的任务超时。本轮修的是另一处（时钟抢跑），**这处没动**。
- ~~抖动测试清单需要复核~~ **已于 2026-08-08 复核、2026-08-09 再取一批 48 次，结果见 Ⅹ。**
  **v0.14 剩下的抖动待办（`pid=null` 已不在其列，已修）：**
  1. **`waitForDaemonLock` 的 3s 上限**（`:621` 与 `:686` 共用这个 helper，本批 5/7 条红都来自它）。
     最自然的解释是全量负载下 fallback wrapper 冷启动超过 3s，**未取证**。
  2. **`readDaemonLock()` 抛 `database is locked`** —— 🔴 **旧版"测试侧缺 busy 重试"已作废**（Ⅳ.21）。
     2026-08-09 排除两条、修掉一条潜伏的产品缺陷，**机制仍未知**，详见 Ⅹ。
  3. **`plist-drift` T2/T13**，48 次仍未复现，取证方向见 Ⅹ（给 fork 压力而非 CPU 压力）。

## 核心问题：`l25_cov` 是否存在可行阈值

- 随机对照 n 已达 399。**p50 漂移轨迹 `0.125 → 0.075 → 0.029`，跨度远超 V2 自设的 ±0.03 门限**
  ⇒ **「分位数对比不可作判据」已坐实。**
- ⚠️ **信号(0.081) 高于噪声(0.029)，看起来"终于有信号了"。这正是 Finding 2 警告的读法，不要中招。**
- `l25_legacy_hit` 仍 **0/1666**，无任何正例标签，仍需人工标注约 50 个样本。

**三条已知样本偏差，做分布分析前必须先评估：**

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉 ⇒ 现有数据可能系统性缺失慢会话。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开 ⇒ 该时期通道统计偏向词法。
3. **超时未重新定值之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** —— 同样偏向词法。
   **⚠️ 这条至今仍在持续产生**；尺子已于 2026-08-05 22:21 开始量，**当前 60 个干净样本**
   （另有若干被本机测试负载污染或曝露不明，**污染窗口清单见 Ⅰ，每轮取数前对一遍**）。

## 🆕 目标 n 应由判据决定，不是拍脑袋的 300

在 p≈5% 附近，95% CI 半宽约为 `1.96·sqrt(p(1−p)/n)`：

| n | 半宽（约） |
|---|---|
| 59（现在） | ±5.6pp |
| 203 | ±3.0pp |
| 300 | ±2.5pp |
| 456 | ±2.0pp |

⇒ **先说清"带内比例达到多少才值得抬 `openai_timeout_ms`"，需要的 n 就出来了。**
门槛若是 3%，200 出头就够，比 300 早到一半时间。**这个门槛是人类裁决，本文档不替你定。**

## 分析阶段的方法要求（造好尺子不等于能下结论）

外推被截断的区间之前，**必须先检验探针能不能代表 hook**：拿探针 <800ms 的那部分对照 hook 已知的
105 条成功样本，并拿 `text_chars` 对 `prompt_chars` 校准（⚠️ `prompt_chars` 样本仍少）。
**对不上就是"不可判定"，不是硬外推。** 这**不是**复活作废的分位数判据 —— 那条作废的是拿分位数当阈值判据，
这里是对仪器有效性的检验，失败时输出"不可判定"。

**截尾样本必须进分母。** 规则：截尾计入 n、计为"> 阈值"，**只有真正报错的探针才排除**，且排除要打印出来。
本轮已经出现第一个错误样本（`Connection error.`），脚本按此规则处理了。

---

# Ⅷ. 建议使用的 skills

- **⚠️ 先问一句"现在还有 bug 吗"。** 接手时最像 bug 的那一条，可能只是上一轮的判据下早了。
  **在派 subagent、开分支、写 spec 之前，先花两分钟实测复核症状还在不在。**
- **`superpowers:systematic-debugging`** —— 看到"配置全对却不工作"从它开始。**先取证，再决定要不要改。**
  ⚠️ **抖动那轮它是唯一真正起作用的东西**，关键是守住它的 Iron Law：**没有根因就不许提修法**。
  实操上最有价值的两步：**(a) 找到能强制变红的定向变异**（把 4% 的抖动变成 8/8 红，修复验证才有判据）；
  **(b) 装仪器时永远配一个无条件的正面对照文件**，否则"空文件"分不清没复现和仪器失效。
  ⚠️ **变异实验必须复现目标的真实条件** —— 本轮两次"单跑变异 0/N"都因为缺少全量跑的并发维度而**无效**，
  白花了钱还差点得出错误的排除结论。
- **`superpowers:subagent-driven-development`** —— 本轮用它跑完 bug-063 全程。
  **把能力预算花在审查上**：实现用中档模型足够；**全分支审查务必用最强模型** ——
  本轮它抓出的那条 Important（"超时消息对 restart 永远不可达"）是 per-task 审查全部漏掉的，
  而那恰好是 bug 被报出来的那个动作。
  ⚠️ **它的最后一步会让你删 workspace，Ⅵ.10 裁决优先，不要删。**
- **`superpowers:writing-plans`** —— 改生产常数前必须先出计划。
  ⚠️ **计划里的测试脚手架也要经得起推敲**：本轮同一个 seam 错了三次（Ⅲ.4），每次都花掉一整轮派发。
- **`superpowers:requesting-code-review`** —— **别省这一步，它连续三轮都抓到了自查漏掉的东西。**
  🆕 2026-08-09 写事务那轮它抓到 **Critical 2 + Important 2**，其中两条是我根本看不到的：
  **(a)** 它**实测**把注入写入的目标表名改错一个字，就让"修复被回退"的测试变绿 —— 证明我的自证开火是假的；
  **(b)** 它指出我的修法让**每次 `openDb()` 都取写锁**，而那正是未解释抖动所在的路径。
  ⇒ **提示里要明确要求它"自己动手验证作者的每一条声称"，不要只读 diff。** 它建的 worktree 记得问过人类再删。
  ⚠️ **也要核它的事实前提**：那轮它有一条论据建立在我给的错误简报上（fts5），**结论对但理由要换**。
  2026-08-09 那轮它抓到的 Important 是：**否定式断言配上一个会静默失效的变异 seam，会以错误理由变绿**
  （详见 Ⅱ 末尾与 Ⅴ 对应那条）。⇒ **审查用最强模型，并在提示里明确要求它挑战"这个测试会不会因错误理由通过"。**
- **`superpowers:verification-before-completion`** —— 多次差点把"没验证"当"已完成"。
- **`superpowers:test-driven-development`** —— 要读到"接线也要测""崩溃红不算红"那一层。
- **`superpowers:finishing-a-development-branch`** —— 分支收尾走它；它会先在**合并结果**上重跑全套。

---

# Ⅸ. 备注

- **不要 push**（人类自己做）。⚠️ **本文档不记录 `main` 与 `origin/main` 的相对位置** —— 它每次提交都在变，
  且人类会在任意时刻 push。**自己跑一次 `git status` 确认，别引用任何写死的数字。**
  **删分支/worktree 必须先问。**
  现存分支：`main`、`daemon-restart-false-negative`（**已合并未删**）、`v0.13-spec`、`v0.13-dogfood-fixes`、`ccmem-v012-finalization`。
  worktree：仅 `ccmem-v012-finalization`（与本线无关）。
- **五个 SDD workspace 都刻意保留**（均 gitignore）。承载全部人类裁决及理由、实测取证、事故经过 —— **git 历史一条都不记。**
  ⚠️ `.superpowers/sdd/progress.md`（旧扁平路径）**是 git 跟踪的**，属更早的计划，别删。
- ⚠️ **套件基线不是"稳定绿"。** 单次跑现在是 545 tests（含 2026-08-09 新增的 3 + 1 + 1 条）；
  但 **112 次全量跑里 18/112 ≈ 16% 会红**，另一批 48 次是 **6/48 = 12.5%**。
  🔴 **旧版"全部来自测试抖动、非产品缺陷"已作废** —— 其中 `pid=null` 是产品缺陷，已修（Ⅱ 末尾）。
  **旧版写的"连续 8 次全量跑绿"是样本不足的假绿，不要引用。** 完整抖动谱见 Ⅹ。
- OpenWolf 记账：`.wolf/buglog.json`、`.wolf/memory.md` 已 gitignore；`.wolf/cerebrum.md` 入库。已记到 `bug-063`。
  **未修的 finding 不记 bug，只活在 dogfood/spec 文档里。**
- 附录 A 不变量现为 **120–144**，**没有 runner，是人工 checklist**。
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
- **成本提示**：纯取证轮 ~$19；实现轮 $60–195；bug-063 那轮 ~$160；抖动复核那轮 ~$127；
  **2026-08-09 读撕裂这轮 ~$60**（48 次全量取证 + TDD 修复 + review + 文档，**相对便宜是因为直接用了 Ⅹ 里现成的仪器设计**）；
  **2026-08-09 写事务这轮 ~$113**（没跑批，钱全花在"假说被连续证伪"上：三条排除、一次测试红在错误理由上重写、
  一次 review 打回重做），全都远超 CLAUDE.md Rule 6 的单会话 450k 预算。
  ⚠️ **这轮的教训是：不跑批也可能很贵。** 便宜的做法是**尽早取一次决定性证据**，而不是连着提三个假说逐个证伪。
  ⚠️ **抖动这轮的成本几乎全在"跑 112 次全量套件 + 三轮变异实验"上，不在思考上。**
  ⇒ **先用 Ⅹ 里已有的结论，别重跑已经跑过的东西**；真要取证就一次跑够（32–48 次），别 8 次一批反复试。
  **开新一轮前先 `/compact`。**

---

# Ⅹ. 测试抖动谱（两个冻结快照：112 次 + 48 次全量 `npm test`）

**这一章推翻了旧版"套件稳定绿"的说法。接手前先读这里。**

同一台机器、同一 checkout，**单一冻结快照**，分四批共 112 次：
修复前 72 次 + `stop-daemon-flow` 修复后 24 次 + 带 CLI 仪器 16 次。

| 测试 | 红次数 | 频率 | 状态 |
|---|---|---|---|
| `admin-daemon-command.test.mjs:686` fallback stop/start/restart | 12/112 | ~11% | 🔴 **未修，多模态，见下** |
| `admin-daemon-command.test.mjs:621` install falls back | 2/112 | ~2% | 🔴 **未修，机制未知** |
| `stop-daemon-flow.test.mjs` stale-retry supersede ×5 变体 | 3/72 → **0/40** | 4.2% → 0 | ✅ **2026-08-08 修完** |
| `plist-drift.test.mjs` T2 + T13（同时红） | 1/112 | ~1% | 🔴 **未修，取证未完成** |
| `admin-cron-command.test.mjs` | **0/112** | — | ⚪ 112 次未复现（Wilson 上界 ~3.3%）。**"未复现"不是"不抖"。** |

**整体 18/112 ≈ 16% 的全量跑会红。**
🔴 **这里原写的"全部是测试抖动，没有一条指向产品缺陷"已作废** —— `:686` 的 `pid=null` 模式在
2026-08-09 被确认为**产品缺陷**（读撕裂，见 Ⅱ 末尾），已修。其余模式仍是测试侧。

## 🆕 第二个冻结快照：2026-08-09 的 48 次全量（修复**前**的代码）

窗口 `08-08 23:09:40 – 23:22:57`（**这段时间的探针样本已污染，见 Ⅰ**）。**6/48 = 12.5% 会红，共 7 条红测试。**
⚠️ **这批是逐条分类失败模式后计数的**，不是按"文件:行号"归并 —— 上一版就栽在那上面：

| 测试 | 失败模式 | 本批次数 | 状态 |
|---|---|---|---|
| `:621` install falls back | `waitForDaemonLock(true)` **3s 超时** → `typeof holder_pid === 'undefined'` | 4 | 🔴 **未修**（本批最高频，非 `:686`） |
| `:686` fallback stop/start/restart | **`pid=null`** | 1 | ✅ **2026-08-09 已修**（根因见 Ⅱ 末尾） |
| `:686` | `waitForDaemonLock(false)` 3s 超时（`actual:false`） | 1 | 🔴 **未修** |
| `:686` | 🆕 **`database is locked`**（抛在测试自己的 `readDaemonLock` 里） | 1 | 🔴 **未修，机制未知（2026-08-09 排除了两条）** |
| `plist-drift` T2/T13 | —— | **0** | ⚪ **48 次未复现**。~1% 频率下不中的概率就有 62%，**这不是排除** |

**新增认知：**

- **`:686` 的第三种模式是 `database is locked`** —— 测试的 `readDaemonLock()` 里 `openDb()` 直接抛。
  旧版那"未分类 2"很可能就是它。
  🔴 **旧版这里写的"这是测试侧缺 busy 重试，不是产品问题"已于 2026-08-09 作废** —— `openDb()` 本来就设了
  `busy_timeout=5000`（Ⅳ.21），加重试是照着症状打。**2026-08-09 排除了两条、留下一条真缺陷，但都不解释这次的红：**
  - ❌ **排除**：`PRAGMA journal_mode = WAL` 跑在 `busy_timeout` 之前所以容忍度为 0 —— 台架实测，
    库已是 WAL 时那句是 no-op，持有写事务下全过。
  - ❌ **排除**：轮询开销吃掉预算 —— 稳态 `openDb()` 实测 **~1ms**（首次 18ms），对 3000ms 余量 3000 倍。
  - ✅ **确认、且在出红的环境里是活的**：`runInTransaction` 的 deferred `BEGIN` 会撞 517（已修，见 Ⅱ 末尾）。
    `supportsFts()` 的探测是事务内的真实写，**每个进程第一次 `openDb()` 都跑一次**，而本测试每条用例都 spawn
    多个 CLI 子进程、同时有真 daemon 在写心跳。⚠️ **曾一度被误判为"潜伏、不相干"，那是用错 node 的结果**（Ⅳ.20）。
  ⇒ **它是头号候选但仍未证实。** 下一步装带 `errcode` + 堆栈的仪器，跟 A 一起跑 32–48 次全量把它钉死。
  **判别特征已经现成：`errcode=5` 且等满 ~5000ms 是普通锁竞争；`errcode=517` 且 ~0ms 是升级死锁；两者报文相同。**
- **`waitForDaemonLock` 的 3s 上限是本批最主要的红源（5/7 条）**，`:621`、`:686` 共用这个 helper。
  全量负载下 container-fallback wrapper 冷启动超过 3s 是最自然的解释，**但尚未取证，别当已确认。**
- ⚠️ **修完 `pid=null` 后不要指望用跑批验证**：它本来就只占 1/48，红率从 12.5% 掉到约 10%，
  **这个降幅小到测不出来。** 判据是那条确定性变异（Ⅱ 末尾），不是频率。

## 未修条目的已有取证 —— 别从头再查一遍

### `admin-daemon-command`（头号抖动源，两条不同测试）

```
:686  expected /ccmem: daemon started pid=\d+/
      actual   'ccmem: daemon started pid=null\n'
:621  cli admin daemon install falls back when launchctl bus is unavailable
```

⚠️ **`pid=null` 与 bug-063 是同族症状**（成功的动作被报成缺失），走的是 container-fallback 路径而非 launchctl 路径。
✅ **2026-08-09：根因已确认（读撕裂）并修复，见 Ⅱ 末尾。** 下面这些取证保留下来是因为它们**导出了那个结论**，
不是待办；**别再重查**。⚠️ 但 `:686` 的另外两种模式（3s 超时、SQLITE_BUSY）**仍未修**，`:621` 也是。

- `startDaemon` 三条路径的等待条件**不一致**：`spawn` 路径等 `next.pid === child.pid`，
  而 **`wrapper`（本测试走这条）只等 `next.alive && next.wrapper_pid`、`launchctl` 只等 `next.alive`**
  ⇒ 后两条**不保证 `pid` 非空**就返回 `started`。这是事实，不是假说。
- `isDaemonAlive()` **只看 `heartbeat_at`，完全不看 `holder_pid`**；而 `pid` 取自 `lock?.holder_pid ?? null`。
  ⇒ 两者**可以脱钩**。
- `loadDaemonStatus()` 里 `lock` 在函数开头查、`alive: isDaemonAlive(db)` 在 return 时才查，
  中间夹着 `readInstallState()` / `readWrapperPid()` / `isProcessAlive()` 三次 I/O ⇒ 存在**读撕裂窗口**。
- ✅ **"读撕裂"假说已于 2026-08-09 确认**（仪器抓到 `alive:true` 而四个 lock 字段全 null，见 Ⅱ 末尾）。
  ⚠️ **注意当时那个"把窗口拉大到 15ms、单跑 0/8"的实验读出了错误方向** —— 它无效，因为读撕裂需要
  窗口内**有并发写**，单跑时没有别的进程动那一行。**幸好没把它当成排除**。这是"变异实验必须复现目标真实条件"的又一例。
- `acquireDaemonLock` 的 INSERT/UPDATE 是**单条语句同时写** `holder_pid` 与 `heartbeat_at`
  ⇒ **NULL 不可能来自写入侧**，方向应朝读取侧或第三方路径找。

**🔴 `:686` 是多模态的 —— 不要按"一个抖动"处理。** 跨 112 次全量跑的 12 条红，实际分布：

| 失败模式 | 次数 | 判别特征 |
|---|---|---|
| `daemon started pid=null` | 8 | stdout 正则不匹配 |
| `waitForDaemonLock` 超时 | 2 | `actual: false`（`assert.equal(..., true)`），耗时 ~3200ms |
| 未分类 | 2 | 日志没匹配上，**如实计入** |

⚠️ **教训：前一版把 11/96 整个当成 "pid=null 的频率"，是只查了前 3 条详情就按"文件:行号"归并的结果**
—— 即 Ⅲ.3 那条（"它在清单上"不是解释）在统计口径上的翻版。**按行号计数前先逐条分类失败模式。**

**为什么单跑复现不了**：🔴 **下面这段的前提已于 2026-08-09 作废** —— `admin-daemon-command.test.mjs:192`
**模块级自带 `CCMEM_DATA_ROOT`**（Ⅳ.22），所以对**这个文件**而言那一行不是跨文件共享的，
竞争者只能是它自己 spawn 的 CLI 子进程与 fallback daemon。**结论（单跑说明不了问题）仍然成立，但理由要换。**
以下保留原文，因为它对**其余那几个不改 data root 的文件**依然有效：
`npm test` 全轮共用一个 `CCMEM_DATA_ROOT`（Ⅳ.3），而**有 7 个测试文件都碰 `daemon_lock`**
（`admin-daemon-command` / `stop-daemon-flow` / `admin-cron-command` / `admin-diagnose-command` / `stats-command` /
`save-list-session-start` / `plist-drift`），`node --test` 又并行跑文件 ⇒ **那一行是跨文件共享的**。
`daemon.mjs:687` 还有一句**无条件** `DELETE FROM daemon_lock WHERE id = 1`（stop 路径遇 ESRCH 时清陈旧锁）。
⇒ **单跑 0/8 说明不了任何事，必须在全量下取证。**

**下次直接用这个仪器（已验证可用，别重新设计）**：在 `scripts/cli.mjs` 的 `result.status === 'started'` 分支里，
`result.pid == null` 时把整个 `result` JSON 追加落盘；**同时无条件往另一个文件写一行作正面对照**
（否则空文件分不清"没复现"和"仪器静默失效"）。**一锤定音的判据**：

- `hostname` / `acquired_at` / `heartbeat_at` **全 null 而 `alive:true`** ⇒ **读撕裂确认**
  （它们与 `pid` 同出一个 `lock` 对象，全 null 意味着 `lock` 查询时行不存在，而 `alive` 查询时已存在）。
- `heartbeat_at` **非 null 而只有 `pid` 为 null** ⇒ `holder_pid` 列真是 NULL，**上面整条推理作废**，换方向。

✅ **这套仪器 2026-08-09 用了第二轮，48 次全量抓到 1 条，判据直接落在"读撕裂确认"那一侧。**
（第一轮 16 次没抓到；控制文件当时 31 行、这轮 94 行，两轮都证明路径通着。）
⇒ **仪器写法是对的，别重新设计**；真要再用，**一次跑 32–48 次**，别 8 次一批。

### `plist-drift.test.mjs` T2/T13

两条**总是同时红**，同一条断言 `a PATH refresh must reach the installed plist`，即 `plist_rewrite.written === false`。

**已排除 / 已确认：**

- `written:false` 只有 5 条返回路径，其中"闸门拦下"最可疑（Ⅳ.7：**通常是 G1 而不是 G2**）。
- **G4 确实会执行**（`CCMEM_CLAUDE_P_COMMAND` 非空已实测），它真的 spawn `claude -p --help`（见 Ⅳ.19）。
- ❌ **"G4 的 5000ms 超时被负载打爆"基本可排除**：空载 147–247ms，**余量 20–34 倍**（这条是硬证据）。
  另有"纯 CPU 负载下单跑 0/12 复现不出"（9 个 busy 进程 / 10 核机器）—— ⚠️ **但这半条证据弱**，
  和 A 那个失败的实验同病：**单跑缺少全量跑的并发/fork 维度**。可排除主要靠余量，不靠这 0/12。
- ⚠️ **尚存但未证的假说**：`spawnSync` 在高 fork 压力下失败（`EAGAIN`/非零退出）—— 全量跑有十几个测试文件并发 spawn 子进程，
  这是纯 CPU 负载**没有**复现出来的那一维。
- 🔴 **`blocked_by` 至今未被观测到。** 48 次带诊断仪器的全量跑**零命中**（频率只有 ~1%）。

**下次取证的建议**：不要再靠碰运气跑全量。要么给 fork 压力而非 CPU 压力，要么把 `blocked_by` 直接接到一个独立的复现脚本上。
临时仪器的写法：把断言消息改成带 `JSON.stringify(result.plist_rewrite)`（**用完必须还原**）。

## 复现与取数方法（脚本刻意不入库，Rule 2）

- **单文件隔离跑**：`env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <文件>`（Ⅳ.2，两个变量缺一不可）。
- **只跑某几条**：加 `--test-name-pattern="<子串>"`。**务必核对日志里的 `tests N`** —— pattern 没匹配上会得到"0 fail"的假绿。
- ⚠️ **抖动只在全量 `npm test` 下才有代表性**（并行 + 子进程压力）。单文件孤立跑几乎全绿，**与历史基线不可比**。
- 单次全量约 **17 秒**，24 次约 7 分钟 —— 便宜，**没有理由再用 n=8 下判断**。
