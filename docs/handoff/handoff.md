# ccmem —— Handoff

> **本文是 2026-10-13 的压缩版**（Orca 会话 `808feb6a` 起草，人审后以提交 `docs(handoff): condense ccmem handoff` 落地）。
> 被压掉的是**过程**（逐轮调查记录、巡检流水、作废的推理链）；**结论、裁决、还在咬人的事实全部留在下面**。
> 旧全文怎么找回见 §7（被压掉的每一段都能从那里原样取回；删除逐条按 Orca Rule 13 的三条检验做过，记录未入库）。
>
> ⚠️ **本文不写任何活 SHA、不写 `HEAD`、不写领先远端几笔** —— 提交本文就会改掉它们。
> 提交一律**按标题找**（`git log --oneline --grep=<标题片段>`）；状态一律**现查**（§0.3）。
> ⚠️ **这台机器上会有别的会话同时改这个仓库**（实测过两次）。长任务跑完、动手写文件之前，先 `git log` 一次。

---

## 0. 入口

### 0.1 ccmem 是什么

Claude Code 的**跨会话记忆插件**：三个钩子（`SessionStart` / `UserPromptSubmit` / `Stop`）每次新起进程读写记忆；
一个**常驻 daemon**（launchd `com.ccmem.daemon`）跑全部 LLM 任务（`summarize_pending` 等 8 个调用方经 `claude -p`）、
embedding 回填、revalidation、每日维护。存储是 SQLite（`node:sqlite`，WAL）。
也是 Orca 的决策记忆层（只走 CLI/export 边界，见 §6.1）。

- 仓库：`/Users/biran/code/skills/orca/ccmem`（2026-10-13 起；旧路径 `/Users/biran/code/skills/ccmem` **已不存在**）
- 版本：`0.14.0`（`package.json` / `plugin.json`）、配置 `0.14`、tag `v0.14.0`（轻量 tag）。v0.15 范围**未定**，输入在 `docs/ccmem-v0.14-dogfood.md` §八。
- **用户数据在哪、怎么动：只看 `CLAUDE.md` Rule 13**（本文不复述）。一句话：`~/.claude/ccmem/**` 在仓库外，
  写之前先 `sqlite3 ".backup"` 到 `global.db.bak.<毫秒 epoch>`；开发中不连生产库写；删记忆走 `forget`／隔离。
- **plist 可能含凭据**（`DAEMON_ENV_PASSTHROUGH` 会在安装那一刻复制非空的 `ANTHROPIC_*`）⇒ **永不打印／落盘／写进文档**。
  `~/.claude/ccmem/config.json` 有明文第三方凭据（实测只覆盖 `embedding` 一个键）。

### 0.2 两条最容易栽的"生效"规则

1. **钩子路径改了下次会话就生效**：`~/.claude/plugins/ccmem` 是指向本工作树的符号链接，改 `scripts/handlers/**`、`hooks/**`
   就作用在**用户的每一个会话**上，与合不合并无关。
2. **daemon 路径改了不重启 = 没生效，而且看不出来**（`scripts/daemon/**`、`scripts/lib/config.mjs`、`config.default.json`
   以及 daemon 引用的任何 lib）。重启前：等 `running=none`、先备份；**重启不算验证** —— 要用行为判别式
   （看那份代码该改变的量，例如 cost 行的新字段／花费签名），别看 pid、别看"进程起来了"。
   花费签名：2026-09-06 从 20 次真实调用拟合的单价 cache_creation 10.00 / cache_read 0.50 / output 25.00 $/Mtok（残差 0%），
   花费是 `(cacheCr, cacheRd, out_tok)` 的线性函数，可按两份代码各自预测；**价格会变，用前重拟合**。

### 0.3 量，别信（每条都栽过）

| 查什么 | 怎么查 | 备注 |
|---|---|---|
| 工作区／分支／远端 | `git status -sb`、`git branch --list`、`git worktree list`、**裸** `/usr/bin/git ls-remote origin refs/heads/main` | "未 push"两个方向都错过：人会在提交后分钟到一小时内手推 |
| daemon 状态 | `/Users/biran/code/skills/orca/ccmem/bin/ccmem admin daemon status` **＋** `daemon_lock` 的 `holder_pid`／`heartbeat_at` 年龄（`sqlite3 "file:$HOME/.claude/ccmem/global.db?mode=ro"`） | 单次 CLI 读数在负载下有假阴性；`plist=in_sync` **只是报警轴，不等于字节相等**（§5.2）——差异的 key 名打在 stderr 那行 `plist differs …`（只打 key 名、不打值） |
| daemon 进程数 | `pgrep -f 'scripts/daemon/main.mjs'` | 🔴 **Claude Code 沙箱里 `ps -e` 是残的，会把泄漏数成 0**；`pgrep -f ccmem` 会把带 `--plugin-dir …/ccmem` 的会话数进来 |
| 机器忙不忙 | `uptime` **加** `top -l 1 \| grep "CPU usage"` | load average 残留极久，单看 load 会误判 |
| 套件 | `npm test`（= `scripts/run-tests.sh`：`/usr/local/bin/node --test`、隔离 data root、`-u CCMEM_CONFIG_PATH`、收尾删目录） | 最近记录 **968/968**（2026-10-27，`fix(cli): parse memory ids strictly…` 之上；**PATH 最前必须是 nvm 22.13.1**，否则 `bin ccmem` 的 `exec node` 撞坏的 homebrew node）。**不是稳定绿**，见 §4 |
| 单文件隔离跑 | `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>` | 两个变量缺一不可；**必须显式 `/usr/local/bin/node`** |
| 插件链接 | `ls -la ~/.claude/plugins/ \| grep ccmem` | 应指向 `/Users/biran/code/skills/orca/ccmem` |
| LLM 任务有没有在成功 | 只读 `~/.claude/ccmem/daemon-cost.jsonl`（`timed_out`、`exit_code`、`timeout_ms`、`monotonic_ms`） | **别直接数 `timed_out`**：机器睡眠会饿死定时器，产生 `1974s` 这种"超时" |
| `$TMPDIR` 泄漏 | 跑批前后各 `ls -A "$TMPDIR"` 一次，`comm -13` 取新增 | 套件本身看不见这类泄漏；`run-tests.sh` 已把 `TMPDIR` 放进自己的 data root（收尾即删），应为 0 |

**这台机器上的 node（别混用）**：`/usr/local/bin/node` v24.13.0（**有 fts5**；`npm test` 与 daemon 用它）；
PATH 上第一个是 nvm v22.13.1（**无 fts5**；`bin/ccmem` 的 `exec node` 解析到它）；`/opt/homebrew/bin/node` **坏的**（缺 libsimdjson，2026-10-13 实测）。
同一份代码在 v22／v24 下走不同分支，曾因此把活缺陷判成"潜伏"。

**本机工具坑**：`cp`／`mv`／`rm` 是 `-i` 别名（脚本里会挂到超时）⇒ 用 `/bin/cp -f` 等并 `shasum` 读回；
`/bin/bash` 是 3.2（无 `wait -n`、`declare -A`）⇒ 限并发用 `xargs -P`；`git show <sha>:<path>` 的冒号参数走 argv 数组；
`head -N file.jsonl | jq` 会误报，取数用 node 读；`rtk` 会重排部分命令输出，精确计数用 `node -e`；`StrategicCompact` 钩子按 200k 报警，在 1M 会话里百分比是错的。

---

## 1. 当前状态

> 2026-10-18（Orca 会话 `a3b2a7a7`）把 §1.0／§1.1 的分支与操作流水压成结论；过程原文在 git 历史（§7）。

### 1.00000 2026-10-27（Orca 会话 `7753e97d`）—— **先读这一节**

- **`forget` 改为归档**（人裁原话「forget 同意改成归档」；主题行 `fix(forget): archive the memory instead of deleting it, and audit it`，已在本地 main、**未推**）：不再 `DELETE`，改设 `decay_status='archived'`＋`updated_at`，写 `writeAudit(db,'forget',id,{user_action,scope,type,previous_decay_status})`，重建注入缓存；CLI 打印 `forgot memory #mN (…; archived, see ccmem audit show K)`。检索、注入缓存、export 只读 `active`/`probation` ⇒ 归档行不再出现。**不再写 trash 文件**（归档行就是备份；实现席判断，可逆）。⚠️ 实测：**代码里没有任何地方硬删归档行**（原以为维护会删），所以归档行永久保留；**没有 un-archive 的 CLI**，恢复＝按审计行的 `previous_decay_status` 手工 SQL。规格更正追加在 `docs/ccmem-v0.1-spec.md` 附录 F（§5.4 原文不动）。
- **id 严格解析**（主题行 `fix(cli): parse memory ids strictly and refuse malformed ones with exit 64`）：共用 `scripts/lib/memory-id.mjs` 的 `parseMemoryId`（只收 `123`／`m123`），替换 forget／pin／show／promote 四处 `parseInt`；CLI 在开库前拒坏 id、exit 64（原来 `forget 1abc` 会忘掉 #1）。
- 判据：`tests/integration/forget-pin-command.test.mjs` 两条改写（带 Ruling 行，人一揽子授权「这次批准改写所有必要的判据」）＋新增 5 条；变异 M1–M6 均红；全量 `npm test` **968/968**。只动 CLI 入口与 CLI-only 模块 ⇒ 钩子、daemon 都不需要重启。

### 1.0000 2026-10-26（Orca 会话 `ffec7b28` 收尾）—— 已被 1.00000 接手

- **已修：`forget`／`pin` 两个 verb 从未接线**（主题行 `fix(cli): wire the forget and pin verbs`，已在 main 并已推）：`scripts/lib/cmd/{forget,pin}.mjs` 与 `commands/{forget,pin}.md` 本来就有，但 `scripts/cli.mjs` 没 import、没进 verb 白名单、没 dispatch ⇒ 两条命令都只打帮助并以 64 退出。现在接线并补帮助行；两个模块接受其余 CLI 打印的 `m<id>`；记忆不存在时返回 not-found（CLI 报 `ccmem: memory not found`、exit 2），不再对缺行 `row.content` 崩（原实现会）。
- 判据：新增 `tests/integration/forget-pin-command.test.mjs` 7 条（模块层与 CLI 层、trash 副本、缺 id）；全量 `scripts/run-tests.sh` 963/963。**没改既有判据。**
- **生效面**：只动 CLI 入口与两个 CLI-only 模块（`grep` 现测只有 `scripts/cli.mjs` 引它们）⇒ 钩子与 daemon 都**不需要**重启；`~/.claude/plugins/ccmem` 仍是本工作树的软链。
- README 以英文重写并已推（主题行 `docs(readme): cover the config file, semantic search and maintenance`），只动文档；三仓 main 均已推（`ls-remote` 现测）。下面 §1.000 及更早的结论仍成立。

### 1.000 2026-10-21（Orca 会话 `9ec98639`）—— 先读 §1.0000 之后再看这节

- **已在 main（`--ff-only`，未推——以 `ls-remote` 现测）**，按主题行 `git log --grep` 取：
  - `fix(daemon): a locked database no longer kills the daemon`：新 `isDatabaseBusy`（`scripts/lib/db.mjs`，只看 `error.errcode` 5／261／517）；`runTask` 开头那条 `UPDATE … status='running'` 撞锁 ⇒ 任务留 `queued`、attempt 不变、下一轮再来；tick 的 `scheduleCronTasks` 与到期任务 `SELECT` 同样护住，忙的一轮后停 1 s。其它错误行为不变。
  - `fix(cli): restart/start check what launchd actually manages`：launchctl 启动后跑 `launchctl print gui/<uid>/com.ccmem.daemon`；没有 job 或 job 的 pid ≠ 锁持有者 ⇒ `start` 报 `started_unmanaged`（exit 1）、`restart` 以 phase=start 失败，都指向 `ccmem admin daemon install`；bootout 失败且无 job 时如实说没有 job。⚠️ `launchctl print` 的 pid 解析只对 fake 跑过。
  - `fix(daemon): …SIGTERM handler before the lock`（**超出人裁，待人审**）：原来先拿锁、后装 SIGTERM 处理，`stop` 落在间隙里 daemon 带着锁行死、`stop` 等满预算报 `stop_timeout`。探针：main 上 25/40 留锁行，修后 0/40；它让生命周期测试时红时绿。
  - **Orca 纠正导入**（spec `docs/superpowers/specs/2026-10-21-orca-correction-import-design.md`）：新 CLI `ccmem orca-correction upsert|withdraw`（cwd＝目标仓、stdin 一个 JSON v1、stdout 一个 JSON；退出码 0 完成／64 输入被拒不要重试／1 其它稍后重试）；幂等键＝项目＋tag `orca:correction:<id>`（一个 `BEGIN IMMEDIATE` 事务内判定），同内容 ⇒ `unchanged`，内容变 ⇒ 旧行归档（audit `orca_correction_superseded`）再插新行，撤回 ⇒ 归档（`orca_correction_withdrawn`），**从不删**。行：`source='external'`、`type='rule'`、trust 0.8、tags `orca-correction`／`orca:correction:<id>`／`retrieval_only`。**无 schema 迁移；export v0.7 不变**（Orca 读取端不用改）。`retrieval_only` 行不进注入缓存（会话开局稳定段的唯一来源，全局与项目都排除）、周汇总批次、跨项目提升输入；每次 prompt 的检索照常能取到（人裁「只在文档相关内容时才被检索出来」）。
  - npm test 最后一次 956/956；没改既有判据；变异 M1–M14（导入）、M1–M9（daemon，M3 挂死被 300 s 闹钟杀、没红在它自己的断言上）。
- ⚠️ **daemon 侧要重启才生效**（锁冲突护栏、SIGTERM 次序、`retrieval_only` 在 daemon 自己的缓存重建与汇总里被排除）。在人自己的终端：`cd /Users/biran/code/skills/orca/ccmem && /usr/local/bin/node --no-warnings --experimental-sqlite scripts/cli.mjs admin daemon restart`；判别：输出的 `daemon restarted pid=N` 与 `launchctl print gui/$(id -u)/com.ccmem.daemon` 的 pid 一致，`daemon_lock.acquired_at` 晚于重启。**Orca 那边开「纠正写回」必须在这次重启之后**（Orca 侧默认关）。CLI 与钩子路径已即时生效。
- **残余（登记未修）**：派活之后那几笔写入（标记 completed／failed）仍没护锁冲突，撞锁仍可能让 daemon 崩、行留 `running` 到下次启动回收；`scheduleCronTasks` 拿到租约后插入时库忙会丢这一期（main 上原来就如此）；两个并发 upsert 的事务保护没有测试；`contradiction-audit` 仍读这些行；有人手动 `promote` 一行的话，它照样不进稳定段；10-20 沙箱里 `restart` 打印「restarted」的确切原因仍未证成（新检查只盖住了症状）。
- `$TMPDIR` 存量 `ccmem-*` 2026-10-21 现数 753（删法见 §4）。

### 1.00 2026-10-20／21（Orca 会话 `308b874c`）—— 已被 1.000 接手

- **已在 main**（人已推）：`fix(daemon): keep the installed CCMEM_CLAUDE_P_COMMAND on plist rewrite`——调用方没显式设 `CCMEM_CLAUDE_P_COMMAND` 时，install／restart 重写 plist 沿用已装的值（cmux 终端里 `which claude` 是会话级 shim，曾把它写进 plist、终端一关 daemon 的 `claude -p` 就断）。走 CLI 路径，不需要重启 daemon。npm test 936/936。
- **生产 daemon（2026-10-20 现状）**：死键处置已生效（daemon 已重启）。过程：agent 在 Claude Code 沙箱里跑 `admin daemon restart` 报 `restarted pid=53925`，但 launchd 里已没有 job（agent 没核 `launchctl`——教训）；该进程 2 分钟后在 `scripts/daemon/loop.mjs:371` `runTask` 抛未捕获的 `database is locked` 退出，无人拉起；人随后在自己终端跑 `admin daemon install`（`restart` 因 job 不在而 `Boot-out failed: 5`）⇒ launchd 托管、心跳正常。plist 的 PATH 已去掉过期的 cmux 临时目录。重启前备份：`global.db.bak.1792499094655`（integrity ok）、`com.ccmem.daemon.plist.bak.20261020`。
- **人裁「要修」——已在会话 `9ec98639` 修完（§1.000）**；原文：① `runTask` 那条 `UPDATE … status='running'` 在 try 外，锁冲突让整个 daemon 崩（判别只用 `error.errcode` 5／261／517）；② 沙箱里 `restart` 拿不到 launchd 时退回分离进程仍报 `restarted`，job 不在时只报 I/O error——要如实报、并指向 `admin daemon install`。登记（只建议、未批）：plist PATH 也照抄调用方 PATH（含 cmux shim 目录），可类似地保留已装值或滤掉非持久目录。
- ⚠️ **在 Claude Code 沙箱里**：`ps`／`pgrep`／`launchctl` 看不全；判活看 `daemon_lock` 的心跳；要真 `launchctl` 的操作交人在自己终端跑。`daemon.err.log` 因 embedding 429 的 `vec_backfill` 刷屏已约 220 MB。

### 1.0 2026-10-18（Orca 会话 `a3b2a7a7`）—— 已合、仍成立

- **已在 main**（人已合推）：`fix(cli): name the keys behind an in_sync plist that still differs`（§5.2）；`fix(test): point TMPDIR under the suite's data root`（每跑漏 16 → 0，925/925）；handoff 两笔（含死键与 v0.15 的裁定）。
- **人的裁定**（原话「同意你上面所有的建议」，2026-10-18）：死键处置见 §2.3 第 1 条（**已实施**，2026-10-20）；v0.15 范围见 §5.1 第 5 条（**未实施**）。
- **付费对照 A**（人批「先跑 claude 和 omp」）：报告 `~/ccmem-compare-20261018.md`（五列等人填）。Claude 那份转录：claude 5 条、工具报 `$0.519852`；omp 10 条、in 3439／out 2964 token。Codex 那份 `short_session`、OMP 那份 `empty_after_clean` ⇒ **Codex／OMP 转录的整理质量仍未测**，要等有实质内容的会话（本机 10-12 有 2–17 MB 的 Codex 转录）。
- Orca 侧本会话的设计与本仓的关系：Codex 阶段派活**关掉 hooks**（含 ccmem 的），所以 Orca 派出去的 codex 阶段**不会**写 ccmem；Orca 的纠正写回 ccmem 是以后单独的一件（§6.2）。

### 1.1 Codex／OMP 适配（Orca 会话 `d0843ec0` 实施，2026-10-17 合推、已装）

- spec `docs/superpowers/specs/2026-10-17-codex-omp-adaptation-design.md`、计划 `docs/superpowers/plans/2026-10-17-codex-omp-adaptation.md`；台账（git-ignored，主仓）`.superpowers/sdd/2026-10-17-codex-omp-adaptation/progress.md`——**每条 `Ruling:` 与挂账 minor 都在里面**。
- 做成的：三家共用一份记忆（Codex 命令钩子 `$CODEX_HOME/hooks.json`，人在 Codex 里 `/hooks` 批准；OMP TS 扩展 `<agent dir>/extensions/ccmem.ts`；都可 `uninstall`，先备份、原子写）；开局注入只一句短说明、稳定规则进 `.ccmem/context-<sha256 前 16 位>.md`（有上限：稳定 4096 B、其中项目 2048 B、整文件 12288 B；**Claude 也改了**——旧做法塞进 SessionStart 会被 Claude Code 截到约 2 KB）；整理结果不再悄悄截断；迁移 017 `memories.origin_agent`（**export 不变**）；后台 LLM 可选 Claude／Codex／OMP，额度用完**先问人**（`ccmem admin llm status|approve|reject`）。
- ⚠️ **迁移 017 必须由 CLI 跑**（钩子跑会超时被杀、留约 440 MB `.partial`；回滚 SQL 在 `scripts/migrations/017_v015_agents.sql` 头注释）。真实库已于 2026-10-17 升到 schema 17（备份 `global.db.bak.1792245593182`）；迁移的备份轮换按设计删了三份 9 月旧备份。
- ⚠️ **安装命令必须这样跑**：主仓里 `/usr/local/bin/node --no-warnings --experimental-sqlite scripts/cli.mjs install codex|omp`（钩子命令写死 `process.execPath` 与 `REPO_ROOT`；`bin/ccmem` 的 `exec node` 是无 fts5 的 nvm v22；从工作树装则工作树一删就悬空）。已装：`~/.codex/hooks.json`（0600，三个钩子，`timeout: 5`）、`~/.omp/agent/extensions/ccmem.ts`、记录 `~/.claude/ccmem/installs/{codex,omp}.json`。
- **真 Codex 会话实测**（10-17）：SessionStart ✅、UserPromptSubmit ✅（走 B-circuit）、**Stop 未触发**（那一轮因模型额度报错终止；「出错的轮次不触发 Stop」是推断）。OMP 扩展的真加载未验。
- **其余付费验收没跑**（spec §7，人每次单独批准；命令在台账 Task 12 报告 §5）：codex 列整理质量、真 Codex／OMP 会话里模型确实读了 `.ccmem/…`（含 OMP `/new`）、cache 命中前后、真 Claude 额度用完的报错形状、Codex 严格 schema 是否接受 `maxLength`、OMP `session_stop` 时 `session_file` 是否已落盘。免费端到端：`scripts/acceptance/e2e-codex-omp.mjs`（51 ok）。
- ⚠️ 事故：Task 2 实现席第一次 RED 跑**真调了一次 `claude -p`**（旧 refiner 不认 mock，费用拿不到）⇒ `run-tests.sh` 在 PATH 最前放了只认 `-p --help` 的假 `claude`，并整套换临时 HOME。
- 登记未修：真实库 4,251 条活跃全局记忆（膨胀，与 L2.5 一起看）；一条记忆正文是原样 JSON 字符串（旧行没修）；`launchctl getenv CCMEM_CONFIG_PATH` 有值（默认路径，无害，但改道 data root 的跑都要 `env -u`）；`daemon-stop-wait-budget.test.mjs` 全量负载下偶发红、单跑 3/3；已发布 v0.7 spec 验收第 62 条 grep `slice(0, 80)` 本轮之后找不到（不改已发布 spec，此处记更正）；周汇总遇额度用完记 `weekly_synthesis_cluster_failed` 跳过、不重试。

### 1.2 仍成立的较早状态（2026-10-13）

- **生产 daemon 跑的是当前 main 的代码**（2026-10-13 起；此前一直是 09-08 启动的旧进程）。那次仓库外修复（人授权）：`~/.claude/plugins/ccmem` 软链改指新路径；`~/Library/LaunchAgents/com.ccmem.daemon.plist` 备份为 `.bak.20261013` 后改了 daemon main 路径与 `CCMEM_CLAUDE_P_COMMAND`（旧值是已不存在的 cmux shim）；改前 `sqlite3 .backup` 到 `global.db.bak.1791853763689`。重启后 `summarize_pending` 已恢复。
- 9-10 之后落地的三笔代码都在 main：本地路径 origin 不再崩（最多沿 8 跳）、迁移备份 WAL 安全（`VACUUM INTO`、校验、原子发布、只轮换有效备份）、`npm test` 走 `scripts/run-tests.sh`。迁移备份新代码在真实库上的行为**仍未单独验**。

---

## 2. 跨版本仍然成立的结论

### 2.1 测量与证据（这些是方法，换版本也不变）

1. **hook 一直在直接测自己的 embed 截尾率**：`metrics.jsonl` 每行 `prompt_submit` 的 `retrieval_path`（`A`／`B-fail`／`B-circuit`／`B-off`）。
   分母 = (`A` − 缓存命中 `retrieval_embed_ms===0`) + `B-fail`。**要尺子之前先 grep 现有数据的字段名**（曾为此白造一整套探针）。
2. **探针不能代表 hook**：daemon 常驻（热连接）vs hook 每 prompt 新进程，embedding 冷／热差约 **1.7×**（COLD p50 546 / WARM p50 322），
   差值几乎全在 TLS 握手（162–242ms）。跨进程比较延迟先问"两边都是新进程吗"。文本长度（≤2000 字符）几乎不影响延迟。
3. **`metrics.jsonl` 是全局文件、行不带项目归属**；本机常有别的仓库（尤其 ccloop）在跑测试、Claude Code 自己也会升级 ⇒ **外来负载是常态**。
   `load_1m` 分不开跑批与环境（只作协变量，不许当过滤判据）；**不要再找"更好的协变量"、不要换机器**（已否决）。
4. **分位数对比不可作判据**（v0.14 坐实，别复活）；**"0 fail" 不是基线**；**写进文档的计数必须来自单一冻结快照、带日期、带测量命令**。
5. **生产里是常量的量不含该变量的信息**；**花钱造对照前先查这个变量在生产里有没有已经变过**（变过就有免费、但通常是脏的对照，须点名同时变了什么）。
6. **花钱的批量跑：先验一次再放量，原始输出解析前先落盘**（`parseLlmJson()` 写死记忆 schema，对别的形状静默返回 `[]`，烧过 $2.94）。

### 2.2 产品层已定的事实与裁决（不得静默推翻）

- **`openai_timeout_ms` 800 → 1200 已生效，Task 5 读数判"达成"**（2026-08-26）：主臂 `61/295 = 20.68%` Wilson95 `[16.45%, 25.66%]`，
  敏感性臂 `50/273 = 18.32%`；基线 `48.5% [40.3%, 56.9%]`。判据 1 零命中、判据 2 未命中（p99 nearest-rank 1610ms）、
  **判据 3「不可操作化、未执行」——任何引用都必须写出这一句，不得说"三条都没命中"**。冻结快照已入库（`docs/superpowers/plans/2026-08-10-raise-openai-timeout-snapshot-20260826.jsonl`）。
  `A` 路径 `embedMs` n=234：p50 649 / p90 948 / max 2012，`P(800<ms≤1200)=23.5%`；1200 以上截尾，不许外推。
- **`summarize_pending`**：墙钟由**输出 token** 单独决定（r≈0.94–0.97），而输出 token 就是记忆本身 ⇒ **"消灭超时"这个目标是错的**，
  任何稳定压到 60s 以下的做法都是靠少抽。现配置：cap **120s**（不抬：生产真撞顶 0/60，最大完成 79.3s）、取窗 **4000** 字符（config 键，覆盖率 15%→47%、有效记忆 ×1.52、单价持平）、
  `--tools ""` 经 `llm.claude_p_extra_args_per_task` **按 taskType** 注入（成本 −58%；注入点 8 个调用方共用，**不能改默认值**）。
  **重开"抬 cap"的预登记条件**（满足任一）：`E3`（cap120/W4000）n≥100 且真撞顶 ≥2%；或完成调用 p90 >90s；或要上 **8000 档**——8000 必须与 cap 一起设计。
  统计这些条件时**必须剔除 `2026-09-07 23:12 → 09-08 07:05`（本地）**——那段 3 条"真撞顶"是 agent 自己造的负载。
  已否决：schema 加 `maxItems`、pin `--model`、`--effort low`（按有效条数是亏的）、`--disable-slash-commands`、debounce（在 tradeoff 曲线上，不免费）。
- **cost 行遥测**：`timeout_ms`、`stdout_chars`、`monotonic_ms` 可机械区分真撞顶／挂起／睡眠饿死。⚠️ **`stdout_chars` 在 json 路径上恒为 0**，别拿它估被砍调用烧掉的输出。
- **threat-scan**：`credential_assignment` 通用规则**已删**（`fix(threat-scan): drop credential_assignment`）——源码里那两个 `\b` 是字面 `0x08`，自 v0.4 起从未命中；
  "补 `\b`"实测 6 命中 6 假阳性且会自动隔离。接受的代价：`password: hunter2xyz` 不再被拦。保留 4 条具名规则。
  **`scan_patterns_version` 两处仍是 `2026.07` —— 裁决结果，不是漏做**（删规则只减命中，不需要重扫）。
  revalidation 全语料扫一遍 ≈ 一个 721ms 事务、零 LLM；`batch_size` 已按实测 100 → 5000。
- **W0–W4 全部在 main**：W0 `admin diagnose` 恒报 `config N non-default keys, M unknown keys`、**只报键路径、永不报值**；
  W1 `security.quarantine_all_sources_at_write`（默认 false；**本身被 `security.tier3.enabled` 门控**），删了死键 `block_user_explicit`；
  W3 威胁扫描绕过语料与加固（有意开着的口子：`synonym`、`disguised/03,04`、`intra_split/distance_*`、窗口 81–119 无守卫、提及／否定标记位置无关、`#6154` 既有误伤）；
  W4 `ccmem admin diagnose --cost`。
- **人类裁决（仍有效）**：OpenAI 是既定 embedding 方向；换模型检测器整体移除、签名契约返回 `null`；`CCMEM_CONFIG_PATH` 回落到数据根下 `config.json`；
  provider API key 不进 daemon 环境白名单（`renderPlist()` 唯一求值点）；熔断容忍 2 次失败；坏配置 = daemon 响亮地死、不回落默认（hook 不受影响）；
  `plist_rewrite` 被拦必须打到 stderr；启动等待 5000ms（判断不是测量，别无测量地重翻）；探针默认关、活动闸门只在入队处、不新增闸门配置项；
  **SDD workspace 保留**（SDD 流程最后一步让你删，本裁决优先）；**不在代码里 pin 任何模型 ID／别名**（可移植性）；
  fake `launchctl` 里不许有延迟写锁的 seam，慢启动只用测试自己拥有、在 `finally` 里清理的定时器。

### 2.3 仍有效的禁令（原 7 条去掉已解除的第 1 条，剩 6 条）

1. ~~那 7 个死键不删~~ **人已裁（2026-10-18，Orca 会话 `a3b2a7a7`）**：控制器按提案 `docs/superpowers/specs/2026-08-19-dead-key-disposition.md` 给了建议，人原话「同意你上面所有的建议」。建议原文：`security.quarantine.hard_delete_days` **删键、不接线**（接线＝批量不可逆删除；删除走 `forget`；要自动清理另开设计并带预演）；`retrieval.like_fallback.max_terms` **接线、默认值改 10**（与现行为一致，零行为变更）；`llm.claude_p_timeout_per_task.l4_review` 删；`security.cross_scope.similarity_min`、`consolidation.minBatchSize`、`inject.max_chars`、`cron.dead_letter_alert` 四个打包删。**已实施（2026-10-20，Orca 会话 `3d229487`）**：提交 `feat(retrieval): wire like_fallback.max_terms, default 10` 与 `chore(config): delete the six dead keys`，两侧同步；明细、判据与残余风险（拷过旧 `config.default.json` 的用户 `max_terms: 5` 会从死值变活值）见提案文末「🆕 2026-10-20 实施记录」。用户配置里的残留键无需迁移，`admin diagnose` 列为 unknown。生效：钩子即时生效；daemon 已于 2026-10-20 重启（§1.00），两边都在跑新代码（本机无行为差异：真实配置不含这 7 个键，且 10 即旧写死值）。
2. **不许改本机电源设置**（`pmset` 只可只读取证）。
3. **push 由人做**（人统一择时推，不要提醒）。合并已与 Orca 闸门对齐（人裁 2026-10-18，Orca 会话 `1710772d`，本仓 `CLAUDE.md` 证据纪律节）：`merge --ff-only` 合进 main、`branch -d`、不带 force 的 `worktree remove` agent 可以直接做；强制形式仍每次单独授权。
4. **Task 5 读数不许重跑**。 5. **不要再挂 cron、不要再做巡检**。 6. **不要在代码里 pin 模型**。

事故教训（不是编号禁令）：生产 daemon 常驻本机跑付费调用，曾有 92 个遗留忙循环 8 小时打瘫生产 ⇒ 别在这台机器上造 CPU 负载；清理后台进程用进程组，并用 `pgrep`／`ps` 谓词**确认为零**。

### 2.4 会咬人的代码事实

- `npm test` 钉 `CCMEM_DATA_ROOT` 且 `-u CCMEM_CONFIG_PATH`；只 unset 配置路径**不构成隔离**（会读到真实 config 含 key）。人的 shell 曾把 `CCMEM_CONFIG_PATH` 指向真实 config。
- `node --test` 每文件一进程、跨文件并发、文件内串行。`plist-drift` 与 `admin-daemon-command` 在模块级自带 data root。
- `loadConfig()` 无缓存每次读盘、递归深合并 ⇒ 改配置**不用**重启，但**层级必须对**（判据：同块其它键有没有回落默认）。
- mode 为 `off` 时 `mainLoop` 在 `scheduleCronTasks` 前就 `continue`；`mainLoop` 空闲睡 300s／活跃 30s，只有 `stop.mjs` touch wake 文件。
- `openDb()`：先 `busy_timeout=5000` 再 `journal_mode=WAL`（次序本身曾是缺陷）。`database is locked` 唯一判别是 **`error.errcode`**（5／261／517），`.code` 恒为 `ERR_SQLITE_ERROR`，耗时不能区分。
- `daemon_lock.holder_pid` 是 `NOT NULL` ⇒ `pid=null` 只能是读到"行不存在"。要和 pid 一起报的地方用 `isLockRowAlive(自己已读到的行)`。
- `restartDaemon` 未导出，只能经 `cmdAdminDaemon(db,{verb})`；`restart` 在四道闸门全过时自动重写 plist，指向类 key 的改动会被拦（通常是 G1）。
  G4 会真的 spawn `claude -p --help`（探针结果：`G4` = 跑完了说不支持，`G4_INDETERMINATE` = 根本没跑成）。launchd 的 stop 路径不 `waitFor`。
- 🔴 **任何会调 `cmdAdminDaemon` 的一次性脚本，开头必须硬护栏**：缺 `CCMEM_DATA_ROOT`／`CCMEM_LAUNCHAGENT_DIR`／`CCMEM_LAUNCHCTL_BIN` 任一或指向真实位置就 `exit 2`
  （LaunchAgent 目录缺省回落 `~/Library/LaunchAgents`，曾对生产服务跑过真 `kickstart`，没出事是运气）。
- `task_runs` 只由有租约的任务写 ⇒ **`revalidation_audit` 永远没有行**，它的状态只在 `audit_log`（主键列 `affected_ids`）。手工触发后台任务走 `admin/cron.mjs` 的 `MANUAL_RUN_TYPES`，别自己写 SQL 入队。
- `tasks` 表**没有清理**、无 `(status, scheduled_for)` 索引；`task_runs` 有 30 天清理。`openaiConfigFrom` 的 `maxRetries: 0` 是硬编码。
- `withHookSafety` 的 2000ms 预算从未开火过（hook 大半同步）；**真正的外部硬限是 harness 的 5000ms**。
- `last_scanned_patterns_version` 有两个写入方（revalidation 与付费 security_audit）一个读者——方向安全，**登记不修**。一次 bump 会把 security-audit poolC 顶到 `LIMIT 50` 持续 7 天（付费路径）。
- 版本号 pin 会藏在正则转义里（`/"version": "0\.13"/`）——bump 时连转义形式一起搜。
- 多进程同时冷启动**全新空库**会撞并发 migration（`duplicate column name`）；套件先串行建库撞不到。未修、未立项。

---

## 3. 修过的缺陷与仍然约束人的教训（一行一条）

**已修的产品缺陷**（都在 main，按标题可找）：
- bug-063 `admin daemon restart` 假阴性（三笔 `fix(daemon)`/`fix(cli)` + `failed_status` 收尾）。
- `pid=null` 读撕裂（`fix(daemon): derive alive from the lock row the snapshot already read`）。
- 写事务 517（`fix(db): start write transactions with BEGIN IMMEDIATE` 及收尾，全仓 4 处 BEGIN 均 IMMEDIATE，稳态开库不取写锁）。
- `openDb()` pragma 次序（`fix(db): arm busy_timeout before opening the WAL, not after`）——`:686` `database is locked` 的根因。
- `claude-p.mjs` stdin EPIPE 杀死整个 daemon（解释了 6 条无主的 `daemon exited while this task was running`）。
- `stop_timeout` 假阴性：`STOP_WAIT_TIMEOUT_MS = DB_BUSY_TIMEOUT_MS + 1000`（`let stop wait out the lock release`、`the same wait budget`）。
- `secretScan` 的 `sk-` 缺词边界；`credential_assignment` 删除；`plugin.json` 版本漂移（测试只验形状）；本地 origin 崩溃；迁移备份 WAL 安全。

**测试侧修复**：stale-retry 6 处同构副本；T18 泄漏常驻 daemon（按 pid 收尾）；根级 `test.after` 在过滤跑里抢先（改 `process.on('exit')`）；
`v013-quality-gate-rejects` 顺序依赖；10 个文件 `mkdtempSync` 无清理（每跑漏 24 → 0）；`npm test` 自己的 data root（`run-tests.sh`）。

**仍然约束人的教训**：
1. 每个回归测试先亲眼看它**红在自己命名的行为上**；崩溃红、"函数不存在"红不算；本来就绿的用定向变异补红；改了旧测试要重跑它守的旧变异。
2. 间歇修复**不许用自然频率验收**（4.2% 的抖动 8 次全绿概率 59%），要"修前变异逼红、修后同一变异全绿"。
3. 变异仪器要证明**条件被施加了**，不只是"跑过了"（钉注入的结果）；否定式断言配正面证据；仪器自己数触发次数。
4. 条件式仪器（只在失败时输出）的零行**不含信息**；只有无条件仪器（绿的也写）的零行才是证据。
5. 写"❌ 排除"前问：台架施加的条件与现场是同一件吗？（并发写 ≠ 并发开库，曾把真根因排除了一整轮。）
6. 在这台机器上"余量 N 倍所以排除"**不作数**（30 倍余量被负载打爆过）——在真实负载下直接采样。
7. 打了桩的测试必须配一条走真实现的；手抄产品分支逻辑就是打桩。
8. 只断言"早于失败点算出来的字段"的测试对失败点是瞎的（T18 因此绿了一轮）。
9. `--test-name-pattern` 单跑会踩顺序依赖与钩子抢跑；根级 `test.after` 的暴露条件是 **`test(...)` 注册与顶层 `await` 交错**（光有根级 after 不构成暴露，43 文件普查零暴露）。
10. `PRAGMA database_list` 认不出"同路径不同 inode"——用 `lsof -p`；`spawnSync` 对事件循环是观测器安全的，`setTimeout`／`fs.watch` 不是。
11. "同一个 bug 只有一处"是危险假设——修完先 grep 同构模式数总数；爆炸半径按代码实际跑的**每个分支**量，跑前量、跑后复量。
12. 探测器判据要同时有**必抓**与**必不抓**两组样本；会改用户数据状态的探测器解冻前，先在真语料副本上量它会做什么。
13. 0／不动的数字和异常升高的数字，**先解释来源再当结论**（已见十种来源：进程比代码旧、查错字段、分母为 1、错的 checkout、配置层级错……）；不能解释就写"不可判定"。
14. 你自己的重活会污染正在采集的观测；跑批之后**数进程**，不只看 load（load 平稳曾掩盖 19→249 的单调漂移）。
15. 读码推出来的影响面必须实测复核；撤回一个说法要去**原话所在处**作废它（只加新节不改旧文 = 没改）。
16. 删任何 worktree 前先 `git -C <wt> status --porcelain -uall`（未跟踪文件是唯一副本）；变异实验前先提交或用 `git clone --local` 副本，**别用 `git checkout --` 收尾**。
17. 中断 subagent 后、对任何文件下结论前先 `git status`／`git diff`；subagent 报的"全绿"要抽验。
18. 预测写成"机制 + 前提"，别写成一个数。报"贵"之前先量单次成本（全量 ≈ 19s／次、零 API）。

**来自 Orca 跨仓轮的教训（压缩，约束仍有效）**：环境改道要有真实目录快照护栏，`mode=ro` 仍可能写 SHM、不能当零触碰证明；
shell 正则遇 NUL 可截成空模式；跑过扫描器 ≠ 有效检查，恒返回 0 的扫描器给同样输出；快照含目录 mtime；grep 曾静默漏行，清点用逐行实读；
测试调用 ≠ 生产链调用；仓库外缺省路径走传入 env 而非 `os.homedir`；fake 会漏真实 API 约束、>16KiB stdout 异步退出丢数据、跨块多字节解码；
后台通知可能报最后一条命令的 RC；子 agent 不得替人署名、不杀非己进程。

---

## 4. 已登记的抖动与泄漏（还开着的）

| 条目 | 状态 |
|---|---|
| **T13**（`plist-drift.test.mjs`，与 T2 同时红在 `plist_rewrite.written === false`） | 🔴 **未闭合、无候选机制**。历史只红过 1 次（1/112，2026-08-07）；之后 0/48、0/48、0/230（无条件仪器、输入零方差）⇒ 95% 上界 ~1.3%，方向指向**机器状态**而非被测代码。**三条作废路线别再走**：① 仪器改打 `reason`（原仪器本就含 reason，零行由"事件没发生"解释）② 并发／fork 压力（230 次串行零方差、进程上限 6 倍余量）③ cmux 替换 wrapper 窗口（shim 有兜底；cmux 唯二两次安装在 08-29，不在任何观测窗口内）。建议先问"值不值得继续查"；**等它下次自己红**——`G4` 与 `G4_INDETERMINATE` 已可区分。⚠️ 2026-10-13 起生产 plist 的 `CCMEM_CLAUDE_P_COMMAND` 已不再是 cmux shim，旧记录里"探针链是 shim→wrapper→node"只对历史成立。 |
| `admin-daemon-command` `stop_timeout`（ⅩⅩⅩⅧ 那 2/230，run 8／39） | 机制已修（stop 预算），但**"那两次就是这么红的"仍未证**；残余：SIGTERM 到达时 daemon 卡在另一条被挡语句上，两段 busy 等待串起来仍会超预算，两条 stop 测试都不覆盖 |
| `:621` install falls back（`waitForDaemonLock` 3s） | 修后 432 次等待零超时，但三条锁修复同期落地、**归因未分离**；不算已解决 |
| `daemon-loop.test.mjs` 一次整文件红（2026-08-09，5333ms） | n=1，之后 0/48，**不可判定**，别当已知抖动 |
| `daemon status`／`restart` 负载敏感假阴性 | 未修、未开单 |
| `$TMPDIR` 存量 | 回归已修（`fix(test): point TMPDIR under the suite's data root`，在 main：每跑 16 → 0，且以后漏的测试也落在被删的 data root 里）。**存量待人删**：人同意「只删 `ccmem-*`、`tmp.*` 不动」，命令 `find "$TMPDIR" -maxdepth 1 -name 'ccmem-*' -mmin +60 -exec rm -rf {} +`（2026-10-18 现数 577）。旧记录：套件看不见这类泄漏（变异实测：漏回 12，10 条测试照绿）。 |
| `stop-daemon-flow.test.mjs` 的 `Promise.race` | 1000ms 硬上限框真实子进程工作 + 50ms 任务超时，负载敏感；登记"没动"，无修复证据 |
| 扫描器盲区 | 根钩子普查的扫描器只认行首 `test(`；循环／缩进里注册的测试它看不见（43 文件里没遇到 ≠ 不可能） |

抖动只在全量 `npm test` 下有代表性；按行号计数前先**逐条分类失败模式**；复现前确认命令与 `npm test` 同形；真要跑批一次跑够（32–48 次以上），并排时段避开 daemon 的付费调用。

---

## 5. 待办 / 等人

### 5.1 ccmem 自己的

1. ~~daemon 重启后的行为复验~~ **已做**（Orca 会话 `6b7843ec`，2026-10-13，只读 `daemon-cost.jsonl`；重启时刻取备份文件名的毫秒 epoch 1791853763689）：重启后 `summarize_pending` 11 次，10 次 `exit_code=0`、1 次 1 ⇒ daemon 的 `claude -p` 已恢复。
2. **embedding 通道：坏在账号额度**（同一会话现测）：`daemon.err.log` 里的 403／`Connection error.` 全部**早于重启**（plist 的 StandardErrorPath 就是它，mtime 2026-09-08，重启后零新行）；
   但 `metrics.jsonl` 里重启后 9 次 `prompt_submit` 全是 `B-fail`／`B-circuit`，`retrieval_embed_error` 为 `429 You have no credits remaining` ×3、`Request timed out.` ×3 ⇒ **语义检索当前不可用，要人给 embedding 账号充值或换 key**（agent 不改凭据）。
3. **迁移备份新代码在真实库上**：代码已就绪且全量门过，但真实库**不作**修复后的迁移判据；下一次真实升级前仍须：先备份、只在副本演练、写清回退。
4. **7 个死键处置**：已实施并生效（§2.3 第 1 条、§1.00）。 5. **v0.15 范围**：人 2026-10-18 同意控制器建议（同上原话）——**先做 `summarize_pending` 超时**（32–47% 会话没被整理＝记忆在丢）**和 L2.5 引用检测**（trust 正反馈主来源、命中 0.1%；v0.13 spec §0.5）；`credential_assignment`、revalidation 排水往后；记忆膨胀（4,251 条活跃全局）与 L2.5 一起看。`$TMPDIR` 存量见 §4。
6. **hook embed 冷启动（B 线）**：~220ms TLS 握手，只剩"走常驻 daemon"或"不做"两条路（TLS 会话恢复已排除）；spec `docs/superpowers/specs/2026-08-10-hook-embed-cold-start.md`；设计改动，需人裁决。
7. 登记未做：`tasks` 表清理；裸 `start`／`stop` 失败仍丢 `reason`（与 bug-063 同类）；回填永久性失败无退避；`@xenova/transformers` 已停维护（迁 `@huggingface/transformers`）；
   机器睡眠饿死定时器（现在只是可见，没修）；`8000` 档从未实测；Finding 13 深层解（hook 工作切段）；revalidation 覆盖索引（数已量好）。

### 5.2 2026-10-13 新发现、需要人看的

- ✅ **「漂移检测误报」不是检测 bug**（2026-10-18）：spec `2026-08-02-finding10-plist-drift-design.md` §五 把 `status` 定义为**报警轴**——自由变 key（`PATH`、`CCMEM_CLAUDE_P_COMMAND` 等）与模板（`ProgramArguments`）的差异按设计判 `in_sync`、只单列在 `benign_changed`／`template_changed`。真缺口是 CLI 不打这两个列表，已修（`fix(cli): name the keys behind an in_sync plist that still differs`，在 main：stderr 打 key 名、不打值）。注意 `renderPlist()` 用**调用者 shell 的环境**，换个 shell 列表会变。
- ✅ Qoder `post-commit`／`post-checkout` 钩子已备份后删除（2026-10-15，人授权；Qoder 应用再启动可能重写）；`core.hooksPath` 已 unset（现用默认 `.git/hooks`）。
- 🔴 **`UserPromptSubmit` 钩子 5 s 超时**（人 2026-10-15 在两个 Claude Code 窗口里看到 `timed out after 5s — output discarded`）。Orca 会话 `026d10e3` 只读 `~/.claude/ccmem/metrics.jsonl` 量过：本仓代码 2026-10-12 后无改动（只有 handoff 提交），不是代码回归。`B-circuit` 路径（不调 embedding）中位耗时 10-06～10-12 为 68 ms、10-13 起 328 ms，最大 4301 ms；`B-fail` 路径（embedding 回 `429 You have no credits remaining`）中位 1232 → 1457 ms、p90 2812、最大 4821 ms；被杀的调用不留行 ⇒ 尾部被低估。成因：embedding 账号无额度（每次熔断关着就多一次被拒的 embed 调用）＋本机负载（42 users、load 18–44）。建议的临时办法 `embedding.enabled=false`（走 `B-off`，历史 27 ms，n＝1）**人决定先不改**，在处理额度／换 key。
- 🔴 **embedding 账号无额度**（§5.1 第 2 条，2026-10-13 现测）：hook 语义检索全落 `B-fail`／`B-circuit`，要人充值或换 key；agent 不碰凭据。
- 仓库外刻意保留的残留：`~/.ccmem-inspect-reminder.log`（"通知有没有送达"的唯一证据）与改名为 `.disabled-20260826` 的巡检提醒 plist。别当垃圾删。

### 5.3 Codex／OMP 适配（已合并、已安装，付费验收只跑了 A 的 claude＋omp）

见 §1.0。付费验收清单在那里，每一次人单独批准；Codex 钩子等人 `/hooks` 批准。

---

## 6. Orca 那条线

### 6.1 对外接口（Orca 依赖它；改了要先同步 Orca，结论保留）

- ccmem 是 Orca 的决策记忆层，**只走 CLI/DB 边界**，不 vendor、不 submodule；关联键 `projectKey + decisionId`，双方 `normalizeRemoteUrl` 口径必须同步。
- Orca 面板只调 `ccmem export --json --scope global` 再 `--scope project`（cwd 为目标仓库、env 透传、30s／64MiB）；不用 list/show/save，不直读 SQLite。
- export 顶层只认 `version`（0.7）／`exported_at`／`memories`；行字段 `id,scope,project_key,type,content,pinned,source,trust_score,tags,created_at,updated_at`；
  `type` ∈ rule/fact/episode/consolidated，`source` 六个既有值，`tags` 为字符串数组 JSON 文本或 null，时间为 0..8.64e15 整数毫秒，`project_key` 非空。
  **列／枚举／version／projectKey 规则一变，Orca 整区报 `ccmem-output-invalid`。**
- 已知缺口（登记，不立项）：export 不校验 scope；list/show 缺 json／project-key；无 remote 时 cwd 与 realpath 可能得到不同 path 键；Q7 不立项 ccmem→Orca 字段；
  Orca 自动 decision 写回**未实现**；correction 写回已实现但**默认关**（§6.2，会话 `9ec98639`；面板只读不代表自动记忆链已运行）。Orca 的真实 ccmem 测试必须去掉 `CCMEM_CONFIG_PATH` 并改道 HOME／data root。
  不关 auto memory 时，真 claude 启动可在真实 `~/.claude/projects` 下建空 memory。

### 6.2 Orca 滚动状态（**本小节每轮就地整段替换，不许增长；只放指针**）

2026-10-28（Orca 会话 `e236bbe4`：拆 import 环、#62 的 m5 判据、面板组件重做＋六个候选主题、「待测试的功能」走查与三处小修；**本仓无改动、§6.1 契约不变**）。入口 `/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md` §3 最新一节、§4。本仓最近一次代码改动仍是 §1.00000（`forget` 归档、id 严格解析），Orca 读取端不用改。仍成立：普通目录项目的纠正 `projectKey = dir:<project id>`，Orca 导出按前缀跳过、不送进本仓（要送先改 §6.1 契约，Rule 16）；dir 项目的决定留在 Orca 的 vault；Orca 侧纠正写回仍**默认关**（面板 flag `--ccmem-corrections`）；embedding 额度（429）仍等人。

## 7. 怎么找回旧全文

本文落地前的全文（约 7700 行，含 Ⅰ–ⅩⅬⅡ 全部过程记录、巡检流水、逐轮"怎么自己查状态"表）：

```sh
c=$(git -C /Users/biran/code/skills/orca/ccmem log --format=%H -n1 \
      --grep='docs(handoff): condense ccmem handoff' -- docs/handoff/handoff.md)
git -C /Users/biran/code/skills/orca/ccmem show "$c^:docs/handoff/handoff.md"
```

旧全文里的路径是搬家前的（`/Users/biran/code/skills/ccmem`、`/Users/biran/code/skills/loop/Orca`）；节号（Ⅹ、ⅩⅩⅩⅧ.5.4 等）只在旧全文里有意义。
其余长期材料仍在仓库里：`docs/superpowers/{specs,plans}/`（含预登记、补遗、冻结读数脚本与快照、死键清单与处置提案、W0–W3 设计与计划）、
`docs/ccmem-v0.14-spec.md`、`docs/ccmem-v0.14-dogfood.md`；`.superpowers/sdd/**` 被 gitignore、只主仓库那份算数、按裁决保留。
OpenWolf 记账（旧文记载，现状未核）：`.wolf/buglog.json`、`.wolf/memory.md` gitignore，`.wolf/cerebrum.md` 入库；未修的 finding 不记 bug。
附录 A 不变量（旧文记载 120–144）没有 runner，是人工 checklist。
