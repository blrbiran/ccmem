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
| 套件 | `npm test`（= `scripts/run-tests.sh`：`/usr/local/bin/node --test`、隔离 data root、`-u CCMEM_CONFIG_PATH`、收尾删目录） | 最近记录 **968/968**（2026-10-27，`fix(cli): parse memory ids strictly…` 之上；**PATH 最前必须是一个能用的 nvm node**——当时是 22.13.1，2026-11-07 起 nvm default 是 22.23.4——否则 `bin ccmem` 的 `exec node` 撞坏的 homebrew node）。**不是稳定绿**，见 §4 |
| 单文件隔离跑 | `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>` | 两个变量缺一不可；**必须显式 `/usr/local/bin/node`** |
| 插件链接 | `ls -la ~/.claude/plugins/ \| grep ccmem` | 应指向 `/Users/biran/code/skills/orca/ccmem` |
| LLM 任务有没有在成功 | 只读 `~/.claude/ccmem/daemon-cost.jsonl`（`timed_out`、`exit_code`、`timeout_ms`、`monotonic_ms`） | **别直接数 `timed_out`**：机器睡眠会饿死定时器，产生 `1974s` 这种"超时" |
| `$TMPDIR` 泄漏 | 跑批前后各 `ls -A "$TMPDIR"` 一次，`comm -13` 取新增 | 套件本身看不见这类泄漏；`run-tests.sh` 已把 `TMPDIR` 放进自己的 data root（收尾即删），应为 0 |

**这台机器上的 node（别混用）**：`/usr/local/bin/node` v24.13.0（**有 fts5**；`npm test` 与 daemon 用它）；
nvm default 是 v22.23.4（**有 fts5**，ABI 127；人 2026-11-07 升级，Orca 会话 `b5e3c5a8` 现测），新终端里 `bin/ccmem` 的 `exec node` 解析到它；v22.13.1（**无 fts5**）仍装着，旧终端开的会话里它仍在 PATH 最前，`exec node` 照旧解析到它；`/opt/homebrew/bin/node` **坏的**（缺 libsimdjson，2026-10-13 实测，2026-11-07 复测仍坏）。
同一份代码在 v22／v24 下走不同分支，曾因此把活缺陷判成"潜伏"。

**本机工具坑**：`cp`／`mv`／`rm` 是 `-i` 别名（脚本里会挂到超时）⇒ 用 `/bin/cp -f` 等并 `shasum` 读回；
`/bin/bash` 是 3.2（无 `wait -n`、`declare -A`）⇒ 限并发用 `xargs -P`；`git show <sha>:<path>` 的冒号参数走 argv 数组；
`head -N file.jsonl | jq` 会误报，取数用 node 读；`rtk` 会重排部分命令输出，精确计数用 `node -e`；`StrategicCompact` 钩子按 200k 报警，在 1M 会话里百分比是错的。

---

## 1. 当前状态

> 2026-10-18（Orca 会话 `a3b2a7a7`）把 §1.0／§1.1 的分支与操作流水压成结论；过程原文在 git 历史（§7）。

### 1.000000000000000 2026-11-24 上午（Orca 会话续做，`221948a1` 之后）—— hook 全部超时的事故与修法：迁移只走 `ccmem admin migrate`

- **事故（现测）**：上一轮加了 019/020，但真实库还没升级。每次 `openDb()` 都先跑 `createMigrationBackup` ⇒ 对 1.73 GB 的库做 `VACUUM INTO`，实测 **12.04 s**；而三个 hook 的时限只有 2／5／3 s ⇒ hook 做到一半就被杀，迁移永远落不了库，下一次 hook 又从头再来。当天所有 Claude 会话都报 `UserPromptSubmit … timed out after 5s`。这类事故按 018、019、020 三次各发生过一次，`.partial` 的 mtime 分布与三次迁移的应用时间对得上。**最后是一次 CLI（`admin daemon status`，不受 5 s 时限）在 08:24:30 把库升到了 20**，hook 随之恢复。
- **清理**：先确认 226 个 `.global.db.backup-*.partial*`（131,532,564,480 B）没有进程打开（`lsof` 空），且最近 15 分钟内没有变动，然后 `trash` 进废纸篓（可还原；清空废纸篓归人）。另做一份维护备份 `global.db.bak.1795482388243`（`quick_check` ok，schema 20）。
- **修法**（主题行 `fix(db): only \`ccmem admin migrate\` upgrades an existing store; …`，已在本地 main，**未推**）：已有数据的旧库，`openDb()` 一律拒绝（`MigrationRequiredError`），并且在切 WAL 之前就拒、不改文件。hook 返回空上下文，stderr 写一行指路；CLI 与 daemon 以 exit 1 退出；`admin daemon stop` 在待迁移状态下仍可用。`ccmem admin migrate` 发现 daemon 还活着就拒绝；SQL 迁移先拿写锁再做快照，迁移过程中不删旧备份。空库仍会自动初始化。判据 `tests/integration/explicit-migration.test.mjs` 10 条，原 8 条先在基线上见红、审阅补的 2 条先在修前见红；全量 **1084/1084**。计划与审阅裁定在 `docs/superpowers/plans/2026-11-24-explicit-schema-migration.md`（As built 节）。
- **以后加迁移**：顺序是先 `admin daemon stop`，再 `admin migrate`，最后 `admin daemon start`，并且要写进 handoff。**不要再假设 hook 会帮你迁移。**
- **登记**：daily maintenance 仍按 `migration_backup.max_keep` 修剪备份（属于用户配置的保留策略，裁定保留）；全新空库被多进程同时首次初始化的竞态没修（§2.4 已有登记）。daemon pid 59824 是 08:24 起的旧代码进程，库已是 20，不需要重启。
- **#444 那 38 行不在本机**：本机 `tasks` 没有 CHECK 约束，相关行数为 0。那 38 行在测试者机器上（任务 42340–42343 等），修复步骤已交给人，转给测试者的 agent 执行。

### 1.00000000000000 2026-11-24（Orca 会话 `221948a1`）—— 测试者 #444 #448 #447 #435 #451 #436 #446 P0；全量 1075/1075

- **#444（读数）**：成功路径原本写 `tasks.status='completed'`，而 v0.1 spec 的 `tasks` CHECK 只许 `'success'` —— 该约束**从未进过仓库的迁移**（`git log -S "CHECK (status"` 只命中 spec 文档），是早期库带进来的。在带该约束的库上 UPDATE 抛错、catch 把**跑成功**的任务记成 `failed`（本机 38 行 `error_excerpt LIKE 'CHECK%'`）。现在写 `'success'`；成功记账**移出** dispatch 的 try/catch（记账失败不会再被报成任务失败）；`cron list` 两种词都认。改写过的判据都带 `Ruling (#444)` 注释。
- **#448**：新 `scripts/daemon/failure-excerpt.mjs`。`claude -p` 写 stderr，`codex exec --json` 把错误全写 stdout 且 stderr 为 0 字节 ⇒ 摘录只有 `codex exec exit 1: `。stderr 为空时读 stdout，取 `turn.failed.error.message` / 最后一条 `error` item，而不是 900 字节 JSON 行。
- **#447**：`summarize_pending` 可人工跑（`admin cron run summarize_pending --session <id>`，payload 由 Stop hook 记下的 `session_context` 构造）；lease 无行时 `last=`/`--history`/`--issues` 回退读 task 行；`cron run` 入队后 `touchWakeFile()`；help 补齐 flag；未知子命令 exit 64 + usage。**改写两条既有判据**（`cmdAdminCron run` 与 CLI 各一条，`Ruling (#447)`）。
- **#435**：`semantic off`→`on` 抛 `TypeError … reading 'load'`：`resolveEnabled` 先读 config_kv，`off` 留下 `enabled=false` ⇒ `getProvider` 返 null。现在先写 kv 再解析，失败回滚两者；`<verb> --help` 不再执行该 verb。
- **#451**：`scripts/run-tests.sh` 解释器改为「`CCMEM_INSTALL_NODE_PATH` → 三个平台候选 → `PATH` → 具名报错 exit 127」；`package.json` 两个 threat 脚本同改。`CCMEM_STRICT_INTERPRETER=1` 强制走拒绝分支，好让这条在有任何回落的机器上也能钉住。宿主测试要删子进程的 `NODE_TEST_CONTEXT`，否则内层 `node --test` 不向 stdout 输出。
- **#436**：README 补 `ollama`（三个键）、`orca-outcome`/`orca-correction`/`list --json`、`npm test` 一节；`embedding.remote_host`/`remote_path_template`/`ollama_timeout_ms` 三个**代码读、两处配置都不声明**的键补进 `config.default.json` 与 `DEFAULT_CONFIG`（`v013-config-sync` 抓到了后一半）。
- **#446 P0（迁移 019、020）**：019 给 `session_context` 加 `transcript_path`（Stop 写入；也是 #447 人工跑 summarize 的 payload 来源）。020 给 `memories` 加 `session_id`/`transcript_path`（可空 + 部分索引），`insertMemory` 收可选 `provenance`，summarize 的写入点填它；抽取 schema 把 `learned` 列入 `required`，prompt 要求 `learned`/`investigated`。**存量行保持 NULL**；从 audit 回填是单独的可选步骤（会重写用户数据），归人。~~真实库未应用 019/020~~ **已过期**：019 于 11-24 00:56、020 于 08:24:30 由 CLI 进程应用（见上一节的事故）。
- **门（现测）**：`npm test` **1075/1075**；迁移相关 schema 断言与「降级到 v16 再升级」判据已按 019/020 更新。
- **登记**：`admin cron` 的 `--issues` 对 `summarize_pending` 仍只报 `failed`/`zombie`（现读得到 task 行，行为正确但未加判据）；`semantic off` 的 kv 行与 config 文件的优先级仍是既有设计，未改。

### 1.0000000000000 2026-11-23 深夜（会话 `ec9efff6` 续做）—— daemon 已重启到范围读代码；两处 worktree 已清

- **daemon 重启**（人授权）。备份 `~/.claude/ccmem/global.db.bak.1795444654000`（1.65 GB，`PRAGMA quick_check` = ok）。重启时**显式 unset 了 9 个 `ANTHROPIC_*`**（本 shell 有 6 个），否则会被复制进 plist。`admin daemon restart` 报 `start_timeout`——**这是超时不是失败**：sleep 5 后 `status` / `daemon_lock.holder_pid` / `pgrep` 三处都是 pid **19687**，一致。
- **行为验证（不看 pid）**：①`plutil -p` plist 里 `ANTHROPIC_*` 计数 **0**（凭据没被复制）；②重启后新入队的 `summarize_pending` 任务 `transcript_window` 与 `snapshot_observed_at` 都在；③重启之后有 `summarize_pending_applied` 审计行（ts 晚于 `acquired_at`），说明新 daemon 真的按记录范围读完了任务。**结论：范围读已生效**，`incomplete-snapshot` 审计为 0（没有短读/不完整快照被跳过）。
- **worktree 已清**：`ccmem/.worktrees/stop-tail-395-032cc670` 删除前先把未跟踪的 plan 文件提交并 cherry-pick 进 main（`docs(plan): the Stop tail-bound plan this round implemented`），再用不带 force 的 `git worktree remove` 移除。`ccloop/.worktrees/tester-issues-20261123` 的未提交 handoff 行（上一轮 `fc492f1b` 写的、内容已过期）存进 `ccloop` 的 `stash@{0}` 后移除，需要时可 `git stash show -p stash@{0}` 取回。

### 1.000000000000 2026-11-23（Orca 会话 `fc492f1b`）—— #395 第 2 条：Stop 尾部 2 MiB 窗口与摘要快照；全量 1038/1038

- **#395 第 2 条已实现**（提交主题行 `feat(transcript): bound Stop transcript window`、`fix(transcript): cap and report bounded reads`、`fix(summarize): consume Stop snapshot ranges`）：`parseTranscriptWindow` 只读末尾 ≤2 MiB（调用方给更大值会被夹到 2 MiB），从完整 JSONL 行开始、UTF-8 安全；`open` 遇 ENOENT 返回空快照，短读不把未读字节当成已覆盖。`handleStop` 的统计、两条推断、L2.5 探针与入队元数据共用这一次窗口读；任务带 `{startByte,endByte}`，`runSummarizePending` 只读该字节范围（Stop 之后追加的内容不进摘要），旧 payload 无范围时保持原全量路径。
- **窗口滑动的排序修正**：保留 entry 数可能随窗口前进而变小，因此摘要任务的新旧/取代不再按 `last_message_seq` 比较，改按单调 task 行 id。
- **⚠️ 更正（2026-11-23，Orca 会话 `ec9efff6`）—— 上面「旧 daemon 继续走旧全量路径，行为不坏」是错的，已修**（主题行 `fix(summarize): the window stays inside the Stop hook, and retries keep their snapshot`）：旧 daemon 不认识 `transcript_window`、会全量解析再 `slice(0, last_message_seq)`，而当时 `last_message_seq` 是**窗口内** entry 数 ⇒ 它摘要的是会话**开头**那几条，内容悄悄错掉。现在 `last_message_seq` 与 `session_context` 的两个计数**恢复「全文」含义**（新 `scanTranscript`：一次流式扫描，只数完整行，按各 agent 的归一化规则计数、不留正文），窗口只喂推断与入队元数据。同笔：重试走 `insertRetryTask`（同一 payload ⇒ 保留原 `snapshot_observed_at`；已陈旧则不入队，运行中的陈旧行标 superseded），Stop 自身不再 supersede（唯一索引照旧去重）。判据 `scanTranscript` 三 agent 等价 + 「剥掉 `transcript_window` 的 payload 仍摘要到最新一轮」（变异回窗口计数即红）。
- **诚实边界**：尾部窗口会丢掉超长会话最开头几轮的推断输入（推断只关心最后一条 assistant 消息）；`deps.parseTranscript` 测试注入路径不带快照元数据（生产路径不走它）；**daemon 未重启**——Stop hook 是每次新进程、已即时用新代码，`runSummarizePending` 在新旧 daemon 下**现在都对**（新 daemon 读记录的字节范围，旧 daemon 全量解析 + 全文 `last_message_seq`），所以重启只影响是否启用范围读，不影响正确性。
- **门**：全量 `npm test` **1,046/1,046**（2026-11-23 会话 `ec9efff6` 现测；本修正前 1,038）；包没有 `build` 脚本，用 `node --check` 校验改动文件。判据覆盖默认/恰好 2 MiB、UTF-8 切分、末行不完整、短读、ENOENT、追加后只读原范围、两次 Stop 的排序、重试继承快照、旧 daemon 兼容。
- 测试者 #416：仍等其在自己的 Codex `/hooks` 批准一次；#412–#415 的前置已在此前轮修完。

### 1.00000000000 2026-11-21（Orca 会话 `cf2d6dfd` 之后）—— #418 `orca-outcome`、#415 D／#416 可见性；全量 1028/1028

- **#418 run/task 回写（ccmem 半边）**：新 verb `ccmem orca-outcome upsert`（stdin 一个 `orca-run-outcome-v1`，cwd 定项目键，`(project_key, run_id)` 唯一；同体 `unchanged`、异体 `refused` 且不覆盖；exit 0／64／1）与只读 `list [--project] [--since] [--json]`（按 `recorded_at` 过滤，选择已写在代码与帮助里）。迁移 018 新增 `orca_run_outcomes`（不改 export／retrieval／稳定段）；Phase 1 不动 trust。判据 `tests/integration/orca-outcome.test.mjs` 6 条先红后绿；trust 写入与覆盖两条变异见红。
- **#415 D／#416 可见性**：`admin diagnose` 新增 `Runtime` 行（node／SQLite／FTS5 状态与降级原因）和 `Codex` 行（hooks 已装、Codex 的 trust key 几条已批准；未装时点名 `ccmem install codex`）。只读 `config.toml` 的 key 名，从不读／打印 `trusted_hash` 的值。判据 `tests/integration/diagnose-runtime-codex-hooks.test.mjs` 4 条。
- **门**：全量 `npm test` **1028/1028**（另修 `self-restart` 的 schema 断言 17→18）。真实库**已由 hook 升到 18**（`orca_run_outcomes` 已存在）；备份 `~/.claude/ccmem/global.db.bak.1795271000180`（`quick_check ok`，备份时 schema 17）。**daemon 未重启**（新 verb 是一次性 CLI，不需要）。
- **登记**：`--since` 取 `recorded_at`（若本意是 run 的 `observed_at`，改一行）；真实库的 018 迁移只在临时库验过；Orca 的 outbox 用注入 runner 验过，未在真 ccmem + 真面板上跑过。

### 1.0000000000 2026-11-21（Orca 会话 `0677fe2a`）—— #413 真实 Ollama 链路、#395 stop 单次解析、#415 P3 optimize；全量 1018/1018

- **#413 已切真实配置**：`ollama pull bge-m3` 完成（467 MB、1024 维）；`~/.claude/ccmem/config.json` 改为 `embedding.provider=ollama`、`ollama_model=bge-m3`、`ollama_dim=1024`，**保留 openai 键**以便回滚；备份 `config.json.bak.1795194943994`、`global.db.bak.1795194943994`（`quick_check ok`）、plist `.bak.1795194943994`。daemon 重启为 pid 60721（重启前显式 unset 了 `ANTHROPIC_*`）；wide 门期间为降负载停过一次，门后重启为 pid 72748。`admin semantic status`：`reachable=true`、`health=http://localhost:11434 serves bge-m3`、`model=bge-m3 dim=1024`；签名从 `openai:…` 变为 `ollama:bge-m3:1024`，vec_backfill 正在重嵌（交接时 pending≈14k，每批 50；**未等到 pending=0**）。
- **#395（设计稿第 1 条）**：`scripts/handlers/stop.mjs` 现在只 `parseTranscript` 一次，stats／seq／`inferFromTranscript`／`inferL25FromTranscript`／`recordL25Probe` 都消费同一份 entries；`transcript.mjs` 拆出 `*Of(entries)`，`feedback.mjs` 的 helpers 加可选 `entries` 参数。判据 `tests/integration/stop-hook-parse-once.test.mjs`（注入 reader，断言只读一次且 `session_context` 行不变）；既有 stop／feedback／transcript 43/43。**未做**：设计稿第 2 条按字节尾部截断；prompt_submit 的 embedding 熔断本来就有（`B-circuit`）。
- **#415 P3**：`optimizeFts(db)` 在 daily maintenance 末尾执行 FTS5 `optimize`，只在索引缩小时写 `fts_optimized` 审计（不缩就不写，避免审计膨胀）。真实库备份实测 **26,136,576 B → 25,870,336 B**（−266 KB），`MATCH 'ccmem'` 20 次均值 **0.34 ms → 0.14 ms**，`quick_check ok`。判据 `tests/integration/fts-optimize.test.mjs`（2）＋`fts-daily-maintenance.test.mjs`（1，变异删掉调用见红）。**P2 external-content 未做**（要迁移用户库，单独裁）。
- 全量 `npm test` **1018/1018**（2026-11-21，`env -u CCMEM_CONFIG_PATH` 隔离跑）。

### 1.000000000 2026-11-20（Orca 会话 `cc03e171`）—— 原生 ollama provider（#413）、只读 JSON 读路径（#418）、#416 度量与两处省 context 改动

- **代码在 main，已推**（人本轮 `allow-push`）：`3c8eac8`（ollama provider）、`35bd82c`（#413 review：观测维数胜配置、失败回滚 `active_provider`、status 重算 pending、latency probe 标签）、`a489916`（#418 `list/show --json`）、`788a450`（magpie 度量修正）、`301e37f`（渲染去掉 score 后缀）。全量 `npm test` **1014/1014**（2026-11-20）。
- **#413**：`embedding.provider: "ollama"`，键 `ollama_base_url`（默认 `http://localhost:11434`）、`ollama_model`（**无默认，必须给**，不在代码里 pin 模型）、`ollama_dim`（只是猜测，首次 `/api/embed` 后以响应维数为准）。`admin semantic on --provider ollama` 可用；`semantic status` 报 `reachable/health`；未装模型时报 `ollama pull <model>`；失败时回滚 `active_provider`。**本机 Ollama 当前 0 个模型（`ollama list` 空，`bge-m3` 不在）**，因此没有切换真实配置：`~/.claude/ccmem/config.json` 仍是 `provider=openai`＋真实 key。要用：`ollama pull bge-m3`，改 config 的 `provider/ollama_model/ollama_dim`，重启 daemon；签名会从 `openai:…` 变 `ollama:bge-m3:1024`，backfill 会重嵌。
- **#418**：`ccmem list [query] --json [--limit --offset --scope]` 与 `show <id> --json`；返回 export 行形状＋`score`，不跑 tier15 写维护；文本输出逐字未变。Orca 面板每次 list/search/get 只起一个 ccmem 进程，按 fused 排序；旧 ccmem（不认 `--json`）回退两次 export。**注意**：面板 search 现在走 ccmem 的语义检索，开了 embedding 时可能触发一次 provider 调用（查询缓存命中则不再调用），这是「与 agent 检索一致」的代价。
- **#416 度量（magpie 请求存档，2026-11-20 快照）**：存档只有 11-11／11-20 两天且在按 1 GiB 上限淘汰；claude×dfmodel／gpt-6-sol 的 ccmem 中位 **~1.2k tok / 0.4–0.6% prompt**，真实注入体（routing files 项）中位 **1214 tok**、最大 2715；**2367 对相邻请求里 `ccmem@diff=YES` 为 0**（注入从不打断缓存前缀）；`recent_injections` 相邻复用 16.1%、会话内复用 32.3%。**旧读数 opus 7.8% 是量具 bug**：`## ccmem context` 没有闭合 reminder，`ccmemSegment` 把后续用户正文算成 ccmem；`788a450` 已改为读指令止于首个空行、其余块 16 KiB 封顶。codex 仍 0 标记（存档当时未开，无法证实）。
- **省 context 的结论**：真实成本很小，ref+按需取回（P2）与摘要优先（P3）**不值得做**；去重门最多省 32% 槽位（~几百 tok），未实现。已做：渲染不再把 `score fused/fts/…` 给模型（`recent_injections` 已存分数）；曾试「retrieved 去重 stable」，因既有判据把「唯一命中也是 pinned」当 retrieved 块而回退，留作单独改动。
- **daemon 未因本轮代码重启**：改了 provider/status/latency probe（daemon 侧），但配置未切到 ollama，所以不急着重启；下次重启前照 Rule 13 备份。
- **给下一轮**：#416 的 P0（Codex 真接入与 A/B）仍需测试者在自己的 Codex `/hooks` 批准一次；`#416` 的 P1 去重门若要做的先读 `recent_injections` 现成字段；#413 的真实 Ollama 链路要先 `ollama pull bge-m3`。

### 1.00000000 2026-11-20（Orca 会话 `48bc4690`）—— #414 查询转义、#415 probe 改 temp、#420 测试 node；daemon 已重启（退避生效）

- **代码在 main 并已推**（人 `allow-push`）：
  - **#414**：`sanitizeFtsQuery` 不再把 prompt 原样交给 `MATCH`——token 去掉唯一能破坏引号字面量的 `"`、去掉首尾分隔标点，再逐 token 包成引号字面量（`+ - ^ : ( ) *` 都成字面量）；纯标点丢弃，内部标点保留（`C++`、`a:b`、`-bar` 仍指名）。`legacySubstringSearch` 改用新导出的 `ftsTokens`（不带引号）。判据 `tests/unit/fts-query-syntax.test.mjs` 三条，先红在 `fts5: syntax error near "+"`。
  - **#415**：可用性探针改在 `temp.ccmem_fts_probe` 建/删，主库 schema 不再每次短进程 +2；旧版本崩溃留下的主库 probe 表仍在缓存冷时清掉。判据两条（`fts-probe-temp`／`fts-probe-legacy`），前者用 cache-cold 的模块实例量 `PRAGMA schema_version`。**其余优化（FTS 重复存 content、无 optimize）未做**。
  - **#420**：rotate-log 测试的子进程改用 `process.execPath`。
  - 全量 `npm test` **1000/1000**。
- **daemon 已重启**（人本轮「这一轮可以做」）：重启前 `sqlite3 .backup` 到 `global.db.bak.1795183564694`（integrity ok）；plist 备份 `com.ccmem.daemon.plist.bak.20261120`。`admin daemon restart` 报 **G1 未重写 plist**（plist 有 `CCMEM_CONFIG_PATH`、会话 shell 没有）——plist 字节未动，只换了进程（pid 以 `admin daemon status` 现测，`running=vec_backfill`）。**行为判别**：`config_kv` 出现 `vec_backfill.consecutive_failures=1` 与 `next_attempt_at` ⇒ 429 退避已在跑。`status` 仍报 `plist=drifted`（只差 `CCMEM_CONFIG_PATH`，预期）。
- **未做**：**#413**（原生 ollama embedding provider；`openai`＋`openai_base_url`＋dummy key＋`openai_dim` 的兼容层仍可用，是否做归人裁）；**#416**（Codex 接入与省 context：其 P0 度量要先在该机器的 Codex `/hooks` 里人工批准一次，测试者自己未跑；依赖 #414/#415，两者已修）。
- **退避的第二个判别（现测）**：重启后 20 s 内 `daemon.err.log` 字节数 **delta=0**（5,945,218 → 5,945,218）；旧代码在同一时段每几秒写一行。
- **给下一轮**：若裁 #413，照 `scripts/lib/embedding/{jina,openai}.mjs` 的 provider 形状加一个 `/api/embed` 适配（无 key、维数取自响应），`embedding.provider` 增加 `ollama`。若做 #416 的 P1（去重/新颖度门），先读 `recent_injections` 的现有字段，别新造探针。

### 1.0000000 2026-11-20（Orca 会话 `c8fc876f`）—— 日志轮转、vec_backfill 退避（#396）、stop hook 单次解析的设计；**代码在 main、未推；daemon 未重启**

- **日志轮转（已生效，无需重启）**：新 CLI `ccmem admin daemon rotate-log [--keep-bytes N]`（默认保留 5 MiB）：把日志尾部复制到 `<path>.<epoch-ms>.tail`（0600、`wx` 不覆盖），再**原地 truncate**（不 rename——launchd 与 daemon 持有该 fd）；缺文件 exit 1。`admin daemon install` 在日志 >10 MiB 时打一行大小提示，**不自动轮转**（日志是人的数据）。**本轮已对真实日志执行一次**：616,109,244 B → 0 B，保留 5.0 MB 到 `daemon.err.log.1795142086727.tail`。
- **vec_backfill 429 退避（需重启 daemon 才生效）**：连续失败指数退避 30 s 起、翻倍、封顶 1 h，状态在 `config_kv`（`vec_backfill.consecutive_failures` / `next_attempt_at`），continuation 按 `now + delay` 排队；stderr 只记第一次与每第 10 次；成功一批清零。此前每个 429 都立即重排并各写一行 ⇒ 日志每几秒一条、一小时数十 MB。
- **判据**：`tests/integration/admin-daemon-rotate-log.test.mjs`（7）与 `tests/unit/v015-vec-backfill-backoff.test.mjs`（2，含第二次失败 +60 s 且不写 stderr、封顶）；全量 `npm test` **995/995**（2026-11-20）。两个新文件单独复跑 9/9。
- **等人**：`ccmem admin daemon restart` 让退避进运行中的 daemon（本轮没重启：daemon 活着 pid 67171、正在跑 vec_backfill；重启前按 Rule 13 先备份 1.6 GB 的 global.db，本轮没做）。推送归人／按 `allow-push` 可代推。
- **#395（hook 延迟）只到设计**：`.superpowers/sdd/plan/design-395-hooks.md`（在 Orca 仓）。要点：stop 目前把 transcript **解析 5 次**（stats、count、两条 infer、probe）；先「解析一次、entries 贯穿」，再考虑按字节截尾与 embedding 熔断时跳过网络。未改代码。

### 1.000000 2026-11-20（Orca 会话 `57896c64`；其后 `9299e610` 重启 daemon）—— #396 安装/重启校验、diagnose、崩溃退避（代码在 main 且已推；daemon 已重启）

- **2026-11-20 后续（会话 `9299e610`）**：daemon 已重启到含 `a9ba63e` 的代码（pid 67171）；plist 重写后带 `ThrottleInterval 60`；`admin diagnose` ok；旧 `daemon.err.log` 未轮转/截断（83MB 类现场仍在），需要时人工处理。

- 测试者 #396：plist 的 ProgramArguments 指向已搬走的仓库时，KeepAlive 每 ~30 s 重启并无限追加 `MODULE_NOT_FOUND`（报告里 83 MB；本机日志已 609 MB——测试者是另一台机器，本机 plist 与心跳都正常）。改动：install／restart 在写盘/加载前 `stat` 每个程序路径，缺失即 exit 1、点名路径并给迁移提示（不写 plist、不调 launchctl、不写 install-state）；`admin diagnose` 对「程序缺失」或「last exit code 非 0」报 FAIL 并 exit 1；新 plist 带 `ThrottleInterval 60`；`scripts/daemon/crash-guard.mjs` 在 1 小时内第 11 次启动时拒绝（状态在 `CCMEM_DATA_ROOT/daemon-start-history.json`，目录 0700／文件 0600，显式 install／restart 清空）。**用户日志一字未动，也没有轮转/截断。**
- 判据：新增 `tests/integration/daemon-hardening.test.mjs` 11 条；既有 `plist-drift.test.mjs` 的 fixture 默认 node 路径从写死的 `/usr/bin/node` 改为 `process.execPath`（新校验会先拦下它，注释说明）。全量 `npm test` **986/986**（2026-11-20）。
- ⚠️ **daemon 侧改动要重启才生效**（崩溃守卫在 `main.mjs`；ThrottleInterval 要重装 plist 才进旧 plist）。本轮没有重启 daemon：需要时在本人终端 `ccmem admin daemon restart`，或 `uninstall && install`。旧 plist 若程序已不存在，新代码根本没机会跑——只能靠 diagnose 的 FAIL 或 restart 的拒绝把人引到重装。

### 1.000000 2026-11-07（Orca 会话 `b5e3c5a8`）—— 环境轮，代码无改动；代码状态仍看 §1.00000

- 人把 nvm default 升到 22.23.4。daemon 本身跑 `/usr/local/bin/node`，不受影响；但它 plist 里的 `CCMEM_CLAUDE_P_COMMAND` 仍指向 22.13.1 下的 claude。人让改配置后，在 agent 会话里跑了 `admin daemon restart` 重写 plist，过程：
  - 先等 `running=none`；备份 `global.db.bak.1793982395154`（integrity ok）与 `~/Library/LaunchAgents/com.ccmem.daemon.plist.bak.20261107`；
  - **显式 unset 了 shell 里的 `ANTHROPIC_*`**：agent 会话带着它自己的端点，不 unset 就会被复制进 plist（§0.1）或被 G2 拦下。
- 结果：
  - `CCMEM_CLAUDE_P_COMMAND`＝`~/.nvm/versions/node/v22.23.4/bin/claude`；`PATH` 里的 22.13.1 换成 22.23.4，并去掉了 cmux 的会话级 shim 目录；
  - plist 只剩 4 个键（`CCMEM_CLAUDE_P_COMMAND`、`CCMEM_CONFIG_PATH`、`CCMEM_DATA_ROOT`、`PATH`），`ProgramArguments` 未改。
- 判别：
  - launchd pid、锁行 holder 和重启输出三者一致；`acquired_at` 1793982432270 晚于备份；
  - **重启后 `daemon-cost.jsonl` 有 3 条 `summarize_pending`，都是 `exit_code=0`**（2026-11-06T16:29Z，按 `ts` 晚于 `acquired_at` 取），说明新 claude 的 `claude -p` 能用。
- ⚠️ 之后在任何带 `ANTHROPIC_*` 的 shell 里跑 `admin daemon status`，都会报 `plist=drifted`（`ANTHROPIC_BASE_URL` 与四个 model 键）：比的是 shell 和 plist，属预期，不要照着去同步。

### 1.00000 2026-10-27（Orca 会话 `7753e97d`）—— 代码状态**先读这一节**（上面 §1.000000 只是环境轮）

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
- ⚠️ **安装命令必须这样跑**：主仓里 `/usr/local/bin/node --no-warnings --experimental-sqlite scripts/cli.mjs install codex|omp`（钩子命令写死 `process.execPath` 与 `REPO_ROOT`；`bin/ccmem` 的 `exec node` 是无 fts5 的 nvm v22（2026-11-07 起新终端里是有 fts5 的 22.23.4，但钩子仍应和 daemon 一样写死 `/usr/local/bin/node`）；从工作树装则工作树一删就悬空）。已装：`~/.codex/hooks.json`（0600，三个钩子，`timeout: 5`）、`~/.omp/agent/extensions/ccmem.ts`、记录 `~/.claude/ccmem/installs/{codex,omp}.json`。
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

2026-11-24（本轮，Orca 会话 `221948a1`；本节原位滚动，上一版是 `ec9efff6`）：**export 契约（§6.1）不变**。本轮七件：#444（成功任务记成 failed 的根因是早期库的 `CHECK (status … 'success')`，现已写 `success` 且成功记账移出 dispatch 的 catch）、#448（失败摘录在 stderr 空时读 stdout 的结构化错误）、#447（`summarize_pending` 可人工按 `--session` 跑，lease 缺失时 `last=`/`--history`/`--issues` 回退读 task 行，`cron run` 唤醒 daemon，未知子命令 exit 64）、#435（`semantic off` 后 `on` 不再 TypeError；`<verb> --help` 不执行）、#451（`run-tests.sh` 解释器不再写死 `/usr/local/bin/node`）、#436（README 补 ollama/orca-outcome/orca-correction/list --json/npm test，三个只读未声明的 embedding 键进默认配置）、#446 P0（迁移 019 `session_context.transcript_path`、020 `memories.session_id`+`transcript_path`；抽取 schema 要求 `learned`）。全量 **1075/1075**。**真实库未应用 019/020，需先备份再由人跑**；**#446 存量行保持 NULL，audit 回填未做**。仍成立：§6.5 magpie 实验须在干净会话按步骤关存档；Orca 隔离测试显式 unset `ORCA_CCMEM_BIN`／`CCMEM_CONFIG_PATH`；付费真跑会写真 `~/.orca`，别和 Orca 的测试门同时跑；#418 的 `--since` 取 `recorded_at`；#415 P2 external-content **不排期**。

## 6.5 用 magpie 测 ccmem 的 context 占用与 cache 影响（方法论；2026-11-10，Orca 会话 `3153bf70` 起草）

**目的**：在不同 agent（claude／codex／omp）× model 下，粗估 ccmem 注入占多少 prompt、对 prompt cache 有什么影响，作为深层优化的尺子。**人裁（原话）**：「尽量对magpie的侵入修改越小越好，甚至只是留一个导出开关。后续的分析可以参考magpie的写法另写一个程序」「magpie 精度 没必要那么关心，有个粗估就好」。

**做法：magpie 零改动，只读它已经写的文件。** magpie 是人用的本地模型代理（源码 `/Users/biran/code/skills/models/magpie`，`github.com/yetone/magpie`；`sourceget find magpie` 可找到；更新很频繁，所以不给它打补丁）。分析程序在本仓 `scripts/analysis/magpie-context.mjs`（主题行 `feat(analysis): estimate ccmem's prompt share and cache behaviour from magpie's logs`；判据 `tests/unit/magpie-context.test.mjs`），只读 `~/.config/magpie/` 下三类文件，按 route id 连起来：

| 文件 | 何时有 | 内容 |
|---|---|---|
| `usage.jsonl` | 一直写 | 每次调用的 in／out／cache_read／cache_write、`route_id`、`session`、`archive` 指针 |
| `routing/<本地日期>.jsonl[.gz]` | 一直写，留 30 天 | 每个请求的 prompt 分段 token 估算（system／tools／skills／memory／files／results／chat），**没有正文** |
| `request-archive/<UTC 日期>/<id>.json` | **只在人打开「请求存档」后** | 完整请求体与响应体（密钥已脱敏），1 GiB 上限、旧的先删 |

**导出开关就是 magpie 自带的「请求存档」**（2026-11-11 人已打开，本机目录，见 §6.2）：桌面版「用量」页，用量明细表头最右边的开关。⚠️ 它按有没有配 S3 同步 bucket 自动选去处（`internal/gui/archive.go:109-125`）：没配 ⇒ 写 `requestArchiveLocal`，存本机；**配了 ⇒ 写 `requestArchive`，上传到 bucket 且同步到所有机器**。开之前鼠标停在开关上看提示：提示里出现 bucket 名就不要开。存档里是对话与代码原文 ⇒ 实验期间才开，做完关掉并删 `~/.config/magpie/request-archive/`。

**三个子命令**（都支持 `--json`；默认只输出数字、id、名称，正文片段只在 `--show-text` 时给）：
- `requests`：逐请求 in／cache_read／cache_write／out、命中率 cache_read÷(in+cache_read+cache_write)、ccmem 估算占用与比例、magpie 的分段。
- `cache`：同一会话（含子 agent）相邻两次**已存档**请求的公共前缀长度、第一个不同点（`append`／`changed <tools[i]|system[i]|messages[m].content[j]>`／`shrunk`）、该块里有没有 ccmem 标记、`cache_control` 断点位置（比较前先剥掉 `cache_control`）。
- `summary`：按 agent × model × 有无 ccmem 标记汇总：条数、in 中位、prompt 中位与 p90、平均命中率、ccmem token 中位与占比。

**ccmem 怎么被认出来**：靠 ccmem 自己输出的文本标记（程序里的 `CCMEM_MARKERS`，只认行首）：`## ccmem context`、`=== ccmem: retrieved for current prompt ===`、`=== ccmem: stable context ===`、`<!-- content-hash: `、`<!-- ccmem: no relevant memories -->`；另外被 Read 读进来的 `.ccmem/context-*.md` 在 magpie 分段里按路径单列。估算用 magpie 同款粗规则（约 4 个 ASCII 字符／token、非 ASCII 每字 1 token），再按服务商报的 prompt 总数等比缩放。

**实验配方**
1. 人打开「请求存档」（先看提示，确认是本机）。记下开始时间。
2. 同一组脚本化任务，ccmem 开／关各跑若干轮；需要时在 codex、omp 下重复。真模型调用花钱 ⇒ 每次先问人。
3. `node scripts/analysis/magpie-context.mjs summary --since <开始时间>` 看整体占比与命中率；`… cache --since <开始> --agent claude-code` 看每轮检索注入后 `first diff` 是不是 `append`、`ccmem@diff` 是不是 `no`——是就说明注入没打断缓存前缀；`… requests --session <前缀>` 看逐条。
4. 关掉存档，删存档目录。

**要先验证的假设**：①每轮检索注入只改最新那条用户消息，不打断前面的缓存前缀；②开局那句说明只影响会话第一次缓存写入；③codex／omp 把注入放在哪——**还没拿真实存档核过**。

**粗估的边界（别把数当精确值）**
- 不分词：token 是按字符估、按总数缩放的，中文偏差大；只看趋势与 A/B 差值。要精确只能另调 `count_tokens`（同一请求体去掉 ccmem 段前后各算一次），目前不做。cache_read／cache_write 本身是服务商报的，准。
- Claude Code 里 magpie 把所有 system-reminder 合并成一项 `reminders`，程序把它单列为上界（`routeReminderTokens`），**不算作 ccmem**；没开存档时只能数到 `.ccmem/context-*.md` 文件项，漏掉内联注入。
- magpie 每个分段只留 24 项，其余并入 other。
- 协议被 magpie 转换时（`call.from ≠ call.to`），发往上游那份请求体不存，前缀比对看的是 agent 发出的那份；Responses／Chat 的前缀顺序（instructions、tools、input）是假设，Anthropic 是 tools → system → messages。
- 用户正文里恰好在行首出现标记会被误算。`--since` 给纯日期按 UTC 零点算。

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
