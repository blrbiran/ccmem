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
| daemon 状态 | `/Users/biran/code/skills/orca/ccmem/bin/ccmem admin daemon status` **＋** `daemon_lock` 的 `holder_pid`／`heartbeat_at` 年龄（`sqlite3 "file:$HOME/.claude/ccmem/global.db?mode=ro"`） | 单次 CLI 读数在负载下有假阴性；`plist=in_sync` 有疑似误报（§5.2） |
| daemon 进程数 | `pgrep -f 'scripts/daemon/main.mjs'` | 🔴 **Claude Code 沙箱里 `ps -e` 是残的，会把泄漏数成 0**；`pgrep -f ccmem` 会把带 `--plugin-dir …/ccmem` 的会话数进来 |
| 机器忙不忙 | `uptime` **加** `top -l 1 \| grep "CPU usage"` | load average 残留极久，单看 load 会误判 |
| 套件 | `npm test`（= `scripts/run-tests.sh`：`/usr/local/bin/node --test`、隔离 data root、`-u CCMEM_CONFIG_PATH`、收尾删目录） | 最近记录 **760/760、0 skip**（2026-10-12，`fix(test): remove temporary data root after every suite` 之上，日志 `/private/tmp/ccmem-full-reviewed-final-20261012.log`）。**不是稳定绿**，见 §4 |
| 单文件隔离跑 | `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>` | 两个变量缺一不可；**必须显式 `/usr/local/bin/node`** |
| 插件链接 | `ls -la ~/.claude/plugins/ \| grep ccmem` | 应指向 `/Users/biran/code/skills/orca/ccmem` |
| LLM 任务有没有在成功 | 只读 `~/.claude/ccmem/daemon-cost.jsonl`（`timed_out`、`exit_code`、`timeout_ms`、`monotonic_ms`） | **别直接数 `timed_out`**：机器睡眠会饿死定时器，产生 `1974s` 这种"超时" |
| `$TMPDIR` 泄漏 | 跑批前后各数一次 `$TMPDIR/ccmem-*` 与 `$TMPDIR/tmp.*` | 套件本身看不见这类泄漏 |

**这台机器上的 node（别混用）**：`/usr/local/bin/node` v24.13.0（**有 fts5**；`npm test` 与 daemon 用它）；
PATH 上第一个是 nvm v22.13.1（**无 fts5**；`bin/ccmem` 的 `exec node` 解析到它）；`/opt/homebrew/bin/node` **坏的**（缺 libsimdjson，2026-10-13 实测）。
同一份代码在 v22／v24 下走不同分支，曾因此把活缺陷判成"潜伏"。

**本机工具坑**：`cp`／`mv`／`rm` 是 `-i` 别名（脚本里会挂到超时）⇒ 用 `/bin/cp -f` 等并 `shasum` 读回；
`/bin/bash` 是 3.2（无 `wait -n`、`declare -A`）⇒ 限并发用 `xargs -P`；`git show <sha>:<path>` 的冒号参数走 argv 数组；
`head -N file.jsonl | jq` 会误报，取数用 node 读；`rtk` 会重排部分命令输出，精确计数用 `node -e`；`StrategicCompact` 钩子按 200k 报警，在 1M 会话里百分比是错的。

---

## 1. 当前状态（2026-10-13）

- **main 已推送**：本地 `main` 与 `origin/main` 一致（会话 `808feb6a` 实测）。只剩 `main` 一个分支、主工作树一个 worktree（现查）。
  `config-value-parity` 已于 2026-10-10 经人授权合并（`Merge branch 'config-value-parity'`）并删除 ⇒ **旧禁令 1 已解除**。
- **9-10 之后落地的三笔代码**（都在 main）：
  - `fix(project-key): follow a local-path origin instead of crashing on it` —— 本地路径 origin 不再让钩子／`export --scope project` 崩；最多沿 8 跳，失败回落 path 键，URL/scp 键不变。
  - `fix(db): publish validated WAL-safe migration backups` —— 迁移备份用 `VACUUM INTO` 把已提交 WAL 页纳入临时副本，完整性＋schema 检查、fsync 后原子发布；按内容散列复用，只轮换有效备份（原 Q6 关闭）。
  - `fix(test): remove temporary data root after every suite` —— `npm test` 改走 `scripts/run-tests.sh`，自己那个 data root 收尾即删（关闭了旧记录的"`npm test` 自漏 1／跑"）。
- **2026-10-13 仓库外修复**（人授权"三处都按你说的改"，会话 `808feb6a`）：
  1. `~/.claude/plugins/ccmem` 符号链接改指新路径（搬家后它悬空，**钩子一度没有代码可跑**）。
  2. `~/Library/LaunchAgents/com.ccmem.daemon.plist` 先备份为 `com.ccmem.daemon.plist.bak.20261013`，改两行：
     daemon main 路径 → 新仓库；`CCMEM_CLAUDE_P_COMMAND` → `/Users/biran/.nvm/versions/node/v22.13.1/bin/claude`
     （旧值是一个已不存在的 cmux 会话 shim ⇒ **daemon 的 `claude -p` 在此之前已经是坏的**）。
  3. 先 `sqlite3 .backup` 到 `~/.claude/ccmem/global.db.bak.1791853763689`（`integrity_check ok`），再 `launchctl bootout/bootstrap`。
     随后 `ccmem admin daemon status`：alive、新 pid、`startup_schema 16`、从新路径运行；旧进程已消失。
  ⇒ **生产 daemon 现在跑的是当前 main 的代码**（此前一直是 2026-09-08 启动的旧进程）。
  行为级复验见 §5.1（`summarize_pending` 已恢复；embedding 因账号无额度不可用）；迁移备份新代码在真实库上的行为**仍未验**。
- `daemon.err.log` 尾部有 `vec_backfill failed: 403 Country, region, or territory not supported` 与 `Connection error.`；
  **行不带时间戳，不知道是否早于重启**。更早还记过 `429 no credits` 让语义检索降级为 `B-fail`／`B-circuit`。⇒ embedding 通道现状未知（§5.1）。
- 本仓库**产品代码未随 Orca 的 OMP 工作改动**。

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

1. **那 7 个死键不删**（处置提案 `docs/superpowers/specs/2026-08-19-dead-key-disposition.md`，分三类，待人定）。
2. **不许改本机电源设置**（`pmset` 只可只读取证）。
3. **push 由人做**（Orca Tier 0 闸门现在会在 agent 会话里机械拦下 push／合并进 main／删分支或 worktree）。
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
| `$TMPDIR` 存量 | 新增已止住（每跑 24 → 0；`npm test` 自漏已由 `run-tests.sh` 修）。**存量未清**：旧记录 `ccmem-*` 7000+、`tmp.*` 605（2026-09-10 数，现查）——**删存量需人单独授权**。**无回归护栏**：套件永远看不见这类泄漏（变异实测：漏回 12，10 条测试照绿）；静态扫描器护栏有自带假阳性的风险，未做。 |
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
4. **7 个死键处置**（待人定，见 §2.3）。 5. **v0.15 范围**（未定；输入 `docs/ccmem-v0.14-dogfood.md` §八）。
6. **hook embed 冷启动（B 线）**：~220ms TLS 握手，只剩"走常驻 daemon"或"不做"两条路（TLS 会话恢复已排除）；spec `docs/superpowers/specs/2026-08-10-hook-embed-cold-start.md`；设计改动，需人裁决。
7. 登记未做：`tasks` 表清理；裸 `start`／`stop` 失败仍丢 `reason`（与 bug-063 同类）；回填永久性失败无退避；`@xenova/transformers` 已停维护（迁 `@huggingface/transformers`）；
   机器睡眠饿死定时器（现在只是可见，没修）；`8000` 档从未实测；Finding 13 深层解（hook 工作切段）；revalidation 覆盖索引（数已量好）。

### 5.2 2026-10-13 新发现、需要人看的

- 🔴 **daemon 漂移检测疑似误报**：`ccmem admin daemon status` 打印 `plist=in_sync`，而磁盘上的 plist 与新 `renderPlist()` 不同（旧路径、旧 shim）。
  疑点在 `scripts/lib/admin/daemon.mjs` 的 `describePlistDrift`；**n=1，根因未查**。若属实，"`plist=in_sync`"这个读数不能当证据用（§0.3 已标注）。
  查它必须在隔离 data root／LaunchAgent 目录下做（§2.4 硬护栏），不碰真实 plist。
- **归人自己查**（旧 §15 转来）：本仓 handoff 本地提交曾用一次性 `hooksPath` 绕开既有 Qoder 外部 tracker（仓库 hook 配置未变）；
  共同 post-commit 混淆二进制有远端副作用疑点。
- 仓库外刻意保留的残留：`~/.ccmem-inspect-reminder.log`（"通知有没有送达"的唯一证据）与改名为 `.disabled-20260826` 的巡检提醒 plist。别当垃圾删。

### 5.3 人的下一个项目（未开始）

**把 ccmem 适配到 Codex 与 oh-my-pi（OMP）。** 人 2026-10-13 定为下一个项目，**尚未开始，没有 spec、没有分支**。
已知起点（供开题，不是设计）：ccmem 现在完全依赖 Claude Code 的三个钩子与 `claude -p`；daemon 的 LLM 任务经 `CCMEM_CLAUDE_P_COMMAND`；
Orca 侧已有 Codex 与 OMP 的 agent 适配经验（见 §6 指向的 Orca 文档）。开工先走 `superpowers:brainstorming`。

---

## 6. Orca 那条线

### 6.1 对外接口（Orca 依赖它；改了要先同步 Orca，结论保留）

- ccmem 是 Orca 的决策记忆层，**只走 CLI/DB 边界**，不 vendor、不 submodule；关联键 `projectKey + decisionId`，双方 `normalizeRemoteUrl` 口径必须同步。
- Orca 面板只调 `ccmem export --json --scope global` 再 `--scope project`（cwd 为目标仓库、env 透传、30s／64MiB）；不用 list/show/save，不直读 SQLite。
- export 顶层只认 `version`（0.7）／`exported_at`／`memories`；行字段 `id,scope,project_key,type,content,pinned,source,trust_score,tags,created_at,updated_at`；
  `type` ∈ rule/fact/episode/consolidated，`source` 六个既有值，`tags` 为字符串数组 JSON 文本或 null，时间为 0..8.64e15 整数毫秒，`project_key` 非空。
  **列／枚举／version／projectKey 规则一变，Orca 整区报 `ccmem-output-invalid`。**
- 已知缺口（登记，不立项）：export 不校验 scope；list/show 缺 json／project-key；无 remote 时 cwd 与 realpath 可能得到不同 path 键；Q7 不立项 ccmem→Orca 字段；
  Orca 自动 decision／correction 写回**未实现**（面板只读不代表自动记忆链已运行）。Orca 的真实 ccmem 测试必须去掉 `CCMEM_CONFIG_PATH` 并改道 HOME／data root。
  不关 auto memory 时，真 claude 启动可在真实 `~/.claude/projects` 下建空 memory。

### 6.2 Orca 滚动状态（**本小节每轮就地整段替换，不许增长；只放指针**）

2026-10-13（会话 `808feb6a`）：Orca 入口为 `/Users/biran/code/skills/orca/Orca/docs/handoff/handoff.md` §三（当前状态）与 §四（下一件事）。
OMP 集成与 OMP 技能注入在 Orca／ccloop 的本地分支上（Orca `codex/omp-integration`、`codex/omp-skills`；验收记录 `docs/handoff/2026-10-12-oh-my-pi-acceptance.md` 在这两支上），
待人按 Orca 文档里的顺序合并、推送、重钉 ccloop、从新路径重装面板服务。**本仓库产品未随这些改动。**

---

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
