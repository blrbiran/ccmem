# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-06-03

## User Preferences

- **Conversation language**: Chinese (中文)
- **Documentation language** (`docs/**`): Chinese (中文,prose 与注释)
- **Code, comments, and git commit messages**: English
- **User-facing message strings in code output**: English. This includes:
  - stderr output (e.g., `process.stderr.write('ccmem: ...')`)
  - CLI command stdout / prompts / confirmation dialogs
  - Error messages thrown to user
  - Log messages
  - Audit log `reason` / `action` fields
  - Any string literal that may eventually be displayed to the user
  Even when these appear inside Chinese-language spec documents, the string
  literals must be English. Chinese is reserved for prose/descriptions around code.
- **Workflow**: docs-first then PoC. When user says "先 X 再 Y", execute
  sequentially — don't parallelize. The order implies "confirm step1 before step2".

## Key Learnings

- **Project:** ccmem — Claude Code 跨会话语义记忆插件
- **[2026-05-22] Hook 与 Daemon 的执行权分工**:hook 内仅允许 SQLite 同步 I/O +
  JSON 输出。任何 LLM 调用 / spawn / 网络请求必须在 daemon 中完成。
- **[2026-05-27] Claude Code `!bash` 双流均注入 LLM**:slash command 的 stdout 与
  stderr **都**进入 LLM 上下文(PoC 证实)。元数据走 audit_log + 指针,不直接打印。
- **[2026-05-27] Slash command 不继承 `CLAUDE_PLUGIN_ROOT`**:附录 E PoC 证实。
  Slash command 必须走 PATH 上的 `ccmem` CLI,hook 走 `${CLAUDE_PLUGIN_ROOT}`。
- **[2026-05-28] Schema/Code 一致性原则**:任何被代码引用的 column / table 必须
  在 schema 中显式声明。C-1 review 发现 6 处 column 引用但未定义、C-4 发现整张
  memory_feedback 表无 CREATE TABLE、C-3 发现 mode_state vs config_kv 矛盾。规范:
  PR 引入新 SQL 引用必须同步更新 schema 章节,grep checklist 加这一项。
- **[2026-05-30] 本机验证要显式用 `/usr/local/bin/node`**:默认 `node` 是 v20.19.5,
  但当前实现依赖 `node:sqlite`; `/usr/local/bin/node` 是 v24.13.0,可以稳定跑测试。
  在这个仓库里执行 sqlite 相关测试/脚本时,不要假设 PATH 上的 `node` 可用。
- **[2026-05-30] CLI 集成测试必须与测试进程共享 `CCMEM_DATA_ROOT`**:如果测试里先
  用库 API 写 SQLite,再起子进程跑 CLI,必须让当前进程和 CLI 进程指向同一个 data root;
  否则 CLI 会读到另一份 DB,表现为查询结果 `undefined`。
- **[2026-05-30] daemon 任务执行要先显式改 `tasks.status` 再 dispatch**:仅循环里直接
  `dispatch(task)` 会导致任务重复执行、没有 attempts/finished_at/error_excerpt 轨迹。最小闭环应是
  `queued -> running -> completed/failed`，并在进入运行时递增 attempts。
- **[2026-06-02] daemon loop 在同一批 due task 间也要检查 `shouldStop()`**:如果只在 while
  顶层检查 stop，而不在 `for (const task of due)` 内再检查，当前任务把 stop 置真后，循环仍会继续跑本批
  后续任务，导致多 dispatch 与测试/运行时语义偏差。
- **[2026-06-02] 集成测试要显式清空共享 SQLite 运行时表**:`CCMEM_DATA_ROOT` 在同一测试文件内共用时，
  `tasks`/`task_runs`/`audit_log`/`session_context` 等残留会互相污染，导致计数、审计断言和调度 lease 误判。
  daemon 集成测试开头应统一 reset runtime tables；如果测试还会改 `mode`，也必须一起清掉 `config_kv.key='mode'`，否则像 `mode=off` 这类状态会泄漏到后续用例并把整组 loop 测试误打成 timeout。
- **[2026-06-02] daemon `mode=off` 不只是跳过 dispatch，也不能先排 cron 再休眠**:主循环若先 `scheduleCronTasks()` 再检查 mode，会在 off 态下偷偷创建 `daily_maintenance` / `weekly_synthesis` 任务和 lease。正确语义是先看 `getMode(db)`；off 态直接按 wake/backoff 规则 sleep，既不 dispatch 已排队任务，也不新建 cron work。
- **[2026-06-02] daemon idle sleep 分支要同时锁长睡与短睡**:`mainLoop()` 空队列时不是固定 300000ms；若 `wakeRecently()` 命中，应该走 30000ms 短睡。补 loop 回归时至少各锁一条：默认长睡和 recent wake 短睡，避免后续改动只保住其中一边；`mode=off` 分支也要复用同一 wake/backoff 规则，不能在 off 态退回固定长睡。
- **[2026-06-02] `scheduleCronTasks()` 的时间门槛回归要用本地 wall-clock 构造 `Date`**:当前实现用 `getDay()` / `getHours()` / `getMinutes()` 按本地时区判断 daily/weekly cron；测试若写 `'2026-06-07T03:16:00.000Z'` 这类 UTC 时间戳，在非 UTC 环境会被解释成本地其它时刻，误把“边界未到”测成“边界已过”。锁 02:17 / 03:17 门槛时要用 `new Date(y, m, d, h, min)` 这类本地时间夹具。
- **[2026-06-02] weekly catch-up 的“未到点”分支也要单独锁 Monday 03:16 这类工作日边界**:周日 03:16 只能证明首个触发日未到 weekly 窗口，不能防住后续把 catch-up 条件误写成“工作日全天都补跑”。至少要补一条工作日 `03:16` 回归，确保 Monday 在 `03:17` 前仍只排 daily、不抢跑 weekly。
- **[2026-06-02] weekly catch-up 的 lease key 不能直接用“当前日期所在 ISO week”**:spec 要的是“周日 03:17 起 7 天窗口内最多补跑一次”，所以周一/周二 catch-up 仍应复用上一个周日窗口的 lease key。若调度端用 anchor-Sunday key，而 worker/test 仍用 `weekKey(new Date())`，就会出现重复周任务、完成态对不上 running lease 的问题。应抽出共享 `weeklyLeaseKey()`，由 scheduler / worker / test 共用。
- **[2026-06-02] cron/tier1.5 的 daily lease key 必须按本地 calendar day 算，不要用 UTC `toISOString().slice(0, 10)`**:02:17 这种本地凌晨触发点在东八区会落到前一 UTC 日期；如果 `dayKey()` 用 UTC slice，daemon `daily_maintenance` 与 Tier 1.5 `daily_maintenance`/`tier1_5_mini_prelude` 都会把 lease 记到前一天。daily dayKey 要用本地 `getFullYear()/getMonth()/getDate()` 组装，回归至少锁 daemon 02:17 和 Tier 1.5 早晨触发各一条。
- **[2026-06-02] cron 任务完成 lease 时不能按“完成时刻”重算 day/week key**:daily/weekly 任务若排队后跨天或跨周才执行完成，worker 再用 `new Date()` 计算 lease key 会把原来那条 running lease 留在未完成态。调度端应把 `lease_key` 随任务 payload 一起持久化；worker 完成时优先用 payload 里的 `lease_key`，缺省再回退到 `scheduled_for` 推导，而不是用完成时刻。
- **[2026-06-03] 凡是命令面/SessionStart 入口里先调 `maybeRunTier15()` 的路径，都要各自锁一条本地 02:17 lease 回归**:`cmdStats` 绿了不代表 `cmdSave`/`cmdList`/`cmdShow`/`cmdResurrect`/`handleSessionStart` 全都被覆盖；这些入口各自有不同的前置数据与清理路径，后续很容易只在某一条命令里漏掉 Tier 1.5。回归模式统一用冻结 `global.Date` 的本地 `new Date(y, m, d, 2, 17)`，断言对应 `daily_maintenance` 或 `tier1_5_mini_prelude` lease 的 `date_key` 落在本地日窗且状态为 completed。
- **[2026-06-03] `promote`/`pin`/`forget` 这类“修改已有 memory”的命令也必须跑 `maybeRunTier15()`**:不要只在 `save`/`list`/`show`/`stats`/`resurrect` 这类更显眼的入口上接 opportunistic maintenance；修改现有 memory 的命令同样是高频用户入口，如果漏掉，daily cleanup/lease 语义就会只在部分命令上成立。最小回归可直接锁命令执行后的 `daily_maintenance` local-day lease。
- **[2026-06-03] `admin cron run` 的 daily/weekly 手动触发也必须先 claim lease，再把同一个 `lease_key` 带进 queued task payload**:如果手动入队还是塞 `scheduled_for=0` 的裸任务，worker 侧虽然有 lease 完成逻辑，也无法知道这次运行属于哪个本地日/周窗口；重复手动触发还会在 CLI 上冒出 `task#null` 之类假成功。最小闭环是 `cmdAdminCron(run)` 对 daily/weekly 先 `tryClaimLease(..., RAN_BY.MANUAL)`，payload 写 `{ lease_key }`，CLI 在 duplicate lease 时明确输出 skipped。
- **[2026-06-03] `admin cron run summarize_pending` 应明确拒绝，而不是排一个空 payload 坏任务**:`summarize_pending` 运行依赖 `session_id` / `transcript_path` / `last_message_seq`，admin cron 没法凭空构造这组 payload；继续手动入队只会在 worker 里落到 `summarize_pending_bad_payload`。正确语义是 `cmdAdminCron(run)` 直接拒绝该 task，CLI 用 exit 64 明确报 `unsupported manual cron task: summarize_pending`，同时不写任何 task / lease。
- **[2026-06-03] `cli admin cron list --history --task <unsupported>` 也必须走 CLI 级 exit 64，而不是把 `cmdAdminCron()` 异常裸抛出来**:历史查询分支和 `admin cron run` 一样都会直达用户终端；如果少了 try/catch，unsupported task 会显示为未处理异常，破坏 CLI 错误语义一致性。最小回归是 `security_audit` 这类非法 task 在 `--history` 分支下 stderr 输出 `ccmem: unsupported cron task: ...` 且进程以 64 退出。
- **[2026-06-03] `stop` hook 的 `summarize_pending` 去重键是 `(session_id, last_message_seq)`，不是单纯按 session 去重**:同一 transcript seq 上重复触发 stop 只能保留一条 queued/running summarize 任务；但 transcript 继续增长后，新的 seq 必须允许再入队，否则后续 stop 永远不会触发新的总结。最小回归要成对出现：一条锁“同 seq 不重复入队”，一条锁“seq+1 后重新入队”。
- **[2026-06-03] `summarize_pending` 的去重只屏蔽 `queued/running`，不应阻止已完成同 seq 再次入队**:唯一索引 `uniq_tasks_summarize_session_seq` 明确只覆盖 `status IN ('queued', 'running')`；因此旧任务一旦 completed，同一 `(session_id, last_message_seq)` 的 stop 重试必须能重新排队。否则 stop 重放/重试会被历史 completed 任务永久吞掉。回归不要只停在 hook 入队层；至少要成对锁 worker dispatch 与 stop→daemon bridge e2e，证明 completed 后同 seq 既能再次 dispatch，也能再次 `summarize_pending_applied`。
- **[2026-06-03] `summarize_pending` 的同 seq 重试也不应被历史 failed 任务永久挡住**:partial unique index 只覆盖 `queued/running`，所以某个 summarize 任务若已经 `failed`，后续同一 `(session_id, last_message_seq)` 的 stop 重试必须允许重新入队；否则一次 bridge/LLM 暂时失败就会把该 seq 永久卡死。回归不要只锁 stop hook 入队；至少还要覆盖 worker dispatch 与 stop→daemon e2e，证明 failed 后同 seq 既能再次执行，也能随后 `summarize_pending_applied`。
- **[2026-06-03] `stop` hook 的 `summarize_pending` 去重粒度必须同时允许“旧 seq 仍 running、但新 seq 继续入队”**:唯一键是 `(type, session_id, last_message_seq)`，所以它只能拦住同一 seq 的 queued/running 重复 stop；当 transcript 增长到 seq+1 时，哪怕 seq 任务还在 running，也必须允许新的 queued summarize 任务生成。回归最好成对锁住：“running 的同 seq 不重复入队”和“running 的旧 seq 不阻塞新 seq 入队”。
- **[2026-06-03] `summarize_pending` 在 bridge/LLM 返回后必须再次检查是否已被新 seq 超车**:仅在进入 worker 时检查 newer task 不够；如果旧 seq 在等待 `claude -p` 期间被新的 stop 触发超车，旧任务恢复后仍可能把 stale transcript 提炼结果写进 memories。worker 在 bridge 返回后要再跑一次 supersede 检查；回归至少锁两层：daemon task 级别的 stale bridge supersede，以及 stop→daemon e2e 下“旧 seq superseded、新 seq 随后正常 applied”的闭环。
- **[2026-06-03] `summarize_pending` 的 queued retry 也不能绕过 supersede 语义**:旧 seq 第一次 bridge 失败后会排出一个带相同 payload 的 queued retry；如果 retry 真正执行前已经来了更新的 seq，这个旧 retry 必须在 worker 入口被标成 `superseded`，不能继续把 stale 结果写进 memories。最小回归先锁 daemon task 级别的“failed seq2 -> queued retry seq2 -> seq3 插队 -> retry seq2 superseded -> seq3 applied”闭环。
- **[2026-06-02] 直接测 daily/weekly task route 的 lease 完成态时要先 seed `task_runs`**:如果测试只调用
  `dispatchTask()`/`mainLoop()` 跑单个 `daily_maintenance` 或 `weekly_synthesis` 任务，而没有先经过 `scheduleCronTasks()`，
  则必须先 `tryClaimLease(..., RAN_BY.DAEMON)` 创建 running lease，之后再断言 `markLeaseComplete()` 把它收敛到 completed。
- **[2026-06-02] CLI 集成测试不要断言 macOS tmp 路径的字面形式**:同一个临时目录在测试进程里可能表现为 `/tmp/...`，但子进程/CLI 输出里会变成 `/private/tmp/...`。对 tmp 路径应断言形状或规范化后的等价关系，不要用硬编码字符串比较。
- **[2026-06-02] `injection_cache` 的 SSOT 是 `scope -> rendered_text/member_ids`，不是拆列 project_key/topk_json**:`rebuildInjectionCache()` 只写两类 key：`global` 和 `project:${projectKey}`。给 promote/pin/forget 之类命令补缓存测试时，要按真实 schema 断言 `rendered_text/member_ids`，不要假设旧式 cache columns。
- **[2026-06-02] 返回对象展开顺序会吞掉后写状态字段**:像 `{ status: 'restarted', ...started }` 这种写法会被 `started.status` 覆盖，导致 helper/CLI 明明走了 restart 路径却向外表现成 started。组装状态对象时要把最终状态字段放在 spread 之后，尤其是 admin command 这种直接驱动 CLI 文案的返回值。
- **[2026-06-02] `admin diagnose --sessions` 的有效回归要走真实 hooks 产物，不要只 seed DB**:手填 `session_context`/`recent_injections` 只能验证 diagnose 聚合；要证明整条 v0.2 链路闭环，至少要补一条 `handleSessionStart()` + `handlePromptSubmit()` 产出后再跑 diagnose 的 e2e 覆盖。
- **[2026-06-02] hook 的 `shadow` gate 必须在任何持久化/注入之前早返回**:`session-start`/`prompt-submit`/`stop` 在 shadow 模式下只能输出空 `additionalContext` + stderr 诊断提示，不能写 `recent_injections`、`memory_feedback`、`session_context`、`tasks`，也不能下调 trust。回归要同时断言“无写入”和“有 notice”。
- **[2026-06-02] 同一测试文件里复用按天 lease 时，要显式清空 `task_runs` 或切换 date_key**:`tier1_5_mini_prelude`/`daily_maintenance` 这类一天一次 lease 会让后续测试误命中“已跑过”分支；如果同文件多条用例都想覆盖执行路径，先 reset `task_runs`，不要把失败误判成实现 bug。
- **[2026-06-02] Node ESM 集成测试里不要把 `existsSync` 挂在 `path` 上，也不要混入裸 `require()`**:当前仓库测试默认是 ESM；文件存在性断言应直接 `import { existsSync } from 'node:fs'`。像 `path.existsSync` 或 CommonJS `require('node:fs')` 这类写法会让回归在实现正确时也因测试自身报错。
- **[2026-06-02] daemon 调度 due task 要包含 `scheduled_for == now` 的边界**:`mainLoop()` 查询若用 `scheduled_for < Date.now()`，stop hook 刚 enqueue 的任务在同一毫秒内可能不被视为 due，随后因为 wake file 命中短睡眠分支而在测试/运行时表现成“明明已唤醒却没立刻 dispatch”。对“立即可跑”任务应使用 `<=`，并用精确边界回归锁住。
- **[2026-06-02] rate-limit 错误即使没给 `retry-after` 也要回退到默认 60s**:`claude-p.mjs` 只要 stderr 命中 `429`/`rate limit` 就应视为可重试；若缺少明确 `retry-after`，当前约定回退到 60_000ms。回归不要只停在“排了 retry 任务”；至少要补 worker 和 stop→daemon 各一条“queued retry 后续再次 dispatch 并最终成功 `summarize_pending_applied`”的闭环。
- **[2026-06-02] `retry-after` 的秒单位要在 bridge 层统一换算成毫秒**:daemon loop 只消费 `error.retryAfter` 数值，不关心原始文本单位；因此 `claude-p.mjs` 解析到 `retry-after: 2s` 这类 stderr 时必须先转成 `2000` 再抛给 loop。回归最好在 `summarize_pending` 与 `weekly_synthesis` 两条 LLM 路径各锁一条，避免只在单一路径上成立。
- **[2026-06-02] `retry-after` 的分钟单位也要在 bridge 层先归一成毫秒**:像 `retry-after: 2m` 这种 stderr 文本不应把单位换算责任留给 daemon loop；bridge 层应直接抛 `error.retryAfter = 120_000`。桥接层至少要有一条分钟单位回归，任务层再补一条端到端回归会更稳。
- **[2026-06-03] `retry-after` 的秒/分钟单位不要只锁“排出 queued retry”，还要锁 retry 后续真正成功的闭环**:如果回归只断言 `scheduled_for - enqueued_at`，后续仍可能在 retry task 再次 dispatch、same-seq 重跑或 `summarize_pending_applied` 上退化。对 `summarize_pending` 至少要补 worker 与 stop→daemon 两层的 `retry-after -> queued retry -> rerun -> applied` 闭环，分别覆盖 seconds/minutes 单位。
- **[2026-06-03] `weekly_synthesis` 的 `retry-after` 秒/分钟单位也要锁到 retry rerun 后 lease 真正 completed**:只测 `scheduled_for - enqueued_at` 仍会漏掉 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计与 `task_runs` lease 收敛退化。最小回归应覆盖 `retry-after -> queued retry -> rerun -> weekly_synthesis_stub -> lease completed`，至少各补 seconds/minutes 一条 worker 闭环。
- **[2026-06-03] `weekly_synthesis` 的默认 60s rate-limit / `too many requests` fallback 也不能只锁 queued retry**:和 `summarize_pending` 一样，默认 fallback 只断言 `60_000ms` 会漏掉 rerun 后 audit/lease 不再收敛的退化。回归至少要补 worker 级 `default rate-limit -> retry -> weekly_synthesis_stub -> lease completed` 与 `too many requests -> retry -> weekly_synthesis_stub -> lease completed` 两条闭环。
- **[2026-06-03] `weekly_synthesis` 的显式毫秒 `retry-after` 也要锁到 retry rerun 后 lease completed**:像 `retry-after: 1234ms` 这种路径如果只断言 `scheduled_for - enqueued_at === 1234`，仍会漏掉 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计与 `task_runs` lease 收敛退化。最小回归应补 `429 rate limit; retry-after: 1234ms -> retry -> weekly_synthesis_stub -> lease completed` 闭环。
- **[2026-06-03] `weekly_synthesis` 的 timeout retry 也不能只锁“排出 queued retry”**:只断言首次 timeout 后补出 `queued` 重试任务，会漏掉 rerun 后 `weekly_synthesis_stub` 审计和 `task_runs` lease 不再 completed 的退化。最小回归应补 `timeout -> queued retry -> rerun -> weekly_synthesis_stub -> lease completed` 闭环。
- **[2026-06-03] `admin cron run weekly_synthesis` 的 manual lease 路径也要锁 timeout retry→completion 闭环**:只测 `cmdAdminCron(run)` 成功入队或一次 dispatch completed，不足以防住 manual lease 上的 timeout retry 退化；若只补 daemon worker 回归，手动入口仍可能在 retry rerun、`weekly_synthesis_stub` 审计或 `task_runs.ran_by='manual'` lease 收敛上回退。最小回归应覆盖 `manual run -> timeout -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-03] `admin cron run weekly_synthesis` 的显式毫秒 `retry-after` 路径也要锁 retry→completion 闭环**:只测 manual enqueue 或 daemon worker 的 `retry-after: 1234ms` 闭环，不足以防住 manual lease 路径上的 rerun 退化；手动入口仍可能在 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计或 `task_runs.ran_by='manual'` lease 收敛上回退。最小回归应覆盖 `manual run -> 429 rate limit; retry-after: 1234ms -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-03] `admin cron run weekly_synthesis` 的默认 rate-limit fallback 路径也要锁 retry→completion 闭环**:只测 daemon worker 的默认 `429 rate limit -> 60_000ms` fallback 闭环，不足以防住 manual lease 路径上的 rerun 退化；手动入口仍可能在 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计或 `task_runs.ran_by='manual'` lease 收敛上回退。最小回归应覆盖 `manual run -> 429 rate limit -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-03] `admin cron run weekly_synthesis` 的 `too many requests` fallback 路径也要锁 retry→completion 闭环**:只测 worker 级 `too many requests` 闭环或 manual 的默认 `429 rate limit` fallback，不足以防住 manual lease 路径上的 `too many requests` 退化；手动入口仍可能在 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计或 `task_runs.ran_by='manual'` lease 收敛上回退。最小回归应覆盖 `manual run -> too many requests -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-03] `admin cron run weekly_synthesis` 的秒级 `retry-after` 路径也要锁 retry→completion 闭环**:只测 worker 级 `retry-after: 2s` 闭环，或只在 manual 路径上断言 `scheduled_for - enqueued_at === 2000`，仍会漏掉 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计和 `task_runs.ran_by='manual'` lease 收敛退化。最小回归应覆盖 `manual run -> 429 rate limit; retry-after: 2s -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-03] `admin cron run weekly_synthesis` 的分钟级 `retry-after` 路径也要锁 retry→completion 闭环**:只测 worker 级 `retry-after: 2m` 闭环，或只在 manual 路径上断言 `scheduled_for - enqueued_at === 120000`，仍会漏掉 queued retry 再次 dispatch、`weekly_synthesis_stub` 审计和 `task_runs.ran_by='manual'` lease 收敛退化。最小回归应覆盖 `manual run -> 429 rate limit; retry-after: 2m -> queued retry -> rerun -> weekly_synthesis_stub -> manual lease completed`。
- **[2026-06-02] daily_maintenance 也要清理过期 `ccmem_blacklisted_sessions`**:防递归 blacklist 不是一次性测试夹具，而是有 TTL 的运行时表；如果 daily maintenance 不清理过期行，黑名单会无限堆积并让“30 分钟兜底”失真。维护回归应同时断言“过期行被删、未过期行保留”。
- **[2026-06-02] daemon bridge 必须在缺省情况下自行生成并注入 `CLAUDE_CODE_SESSION_ID`，再先写 blacklist 再 spawn**:`CCMEM_INTERNAL=1` 只覆盖 env 直接透传的路径；要让 hook 侧 blacklist 兜底真正可用，`claude-p.mjs` 在 `opts.env?.CLAUDE_CODE_SESSION_ID` 缺失时也要先生成 child session id、写入 `ccmem_blacklisted_sessions`，再把同一个 id 注入子进程环境。回归至少要覆盖 `summarize_pending`、`weekly_synthesis` 两条生产桥接路径，以及 stop/session-start/prompt-submit 三个 hook 读端都能用该 id 早退的连通用例。
- **[2026-05-28] 冗余字段反 SSOT**:数据已有 single source of truth 时不应在其它
  位置冗余存储(易失同步)。C-2:`parent_ids` 应是纯整数数组而非 `[{id, depth}]`,
  depth 由 `consolidation_depth` 列承担,不再 JSON 内嵌。
- **[2026-05-28] 命令面合并优于并存**:list / search 重叠功能("看记忆")应合一,
  不同心智(浏览/检索)通过"是否带 query"区分。C-6 把 search 合入 list,命令
  面减一,tab 补全更高效。
- **[2026-05-28] 缓存失效要 daemon + Tier 1.5 双兜底**:I-1 injection_cache 不会
  随 trust / consolidation 自动重生 → 长期失真。daily_maintenance + Tier 1.5
  共享 lease 双兜底,任一活的都保证 ≤ 24h 窗口。
- **[2026-05-28] 反馈推断 4 层非全在 daemon**:I-2 澄清 — L1/L2/L2.5 都在 hook
  同步跑(无 LLM),只 L4 在 daemon。daemon 死时实时反馈仍工作,影响远小于直觉。
- **[2026-05-28] floor 0.2 是减轻而非解决死锁**:I-3 — 灰区记忆即便 floor 后仍
  几乎不可能进 top-K。真正的出路是用户主动 resurrect 或 14d 自动 archive(给
  懒用户的 default)。代码里的 floor 不能让读者误以为问题已解决,文档必须明示。
- **[2026-05-28] LIKE fallback 必须覆盖中英文短词**:I-4 — trigram 对 < 3 字符
  query 召回 0,中文 1-2 字 + 英文 2-3 字符缩写(QA/DB/API)都是盲区。dogfood
  期撞到任一即证伪假设,v0.1 必须双语兜底,词边界限制(空格 boundary)防 substring 误命中。
- **[2026-05-29] 经验值阈值必须配 config + metrics**:M-3-A — 凭直觉选的魔数
  (3 token / 30% ratio 等)文档里要明示"first guess",config 暴露调优 hook,
  metrics 追踪 false-positive / false-negative rate 让 dogfood 期能调。
- **[2026-05-29] LLM 无法遵守它拿不到的约束**:M-3-B — prompt 里写 "depth span ≤ 2"
  但 LLM 看不到 source depth → 伪约束。硬边界(容量/深度/batch size)是代码职责,
  prompt 只承担语义工作,把硬约束描述为"已保证的输入条件"而非"你必须遵守"。
- **[2026-05-29] 相似度量必须 mode-aware + 阈值配套**:M-3-C — trigram(lexical)
  与 embedding(semantic)是不同尺度,阈值不能直接复用。trigram 召回更严需降阈值
  (0.5 vs 0.8)。提供 `similarityMode()` 切换,各调用点用 mode-aware 默认值。
- **[2026-05-29] enum 命名按"触发源"语义,不按实现位置**:M-3-D — `RAN_BY` 三档
  应是 DAEMON(定时)/ OPPORTUNISTIC(机会)/ MANUAL(显式)。原 HOOK_LAZY 既不
  hook 也不 lazy,误导新读者。命名是文档化的一部分,错误命名比错误代码更难发现。
- **[2026-05-29] 实施 spec 引用设计 SSOT**:M-4-A — v0.x-spec 不应复制 design.md
  的实现代码,改为 ALGORITHM 引用 + 不做清单。两份独立维护 = 高发漂移源。
- **[2026-05-29] slash command 入口统一 `cmd<Verb>` 前缀**:M-4-E — 与文件结构
  `lib/cmd/<verb>.mjs` 对齐;前缀使 IDE tab 补全聚类。内部 helper 用职责命名
  (`promoteToGlobal` 而非 `promoteGlobalCommand`)。
- **[2026-05-29] design.md 代码片段默认 v0.2+ 完整版,v0.1 实现按白名单跳过**:
  M-4-C — design.md 是"长期能成为什么",其代码示例是 v0.2+ 完整版;v0.1 实现的
  边界由 v0.1-spec §4.6 hook 白名单严格 enforce。关键 v0.2+ 行加 `⚠ v0.2+ ONLY`
  显眼标注。
- **[2026-05-29] 不在版本未到时定型 schema**:M-4-D — v0.5+ 引入的 `vec_*` 表
  schema 应推迟到实施期定型(届时需结合 sqlite-vec / embedding 模型选型一并设计)。
  当前完成判据写"逻辑约束 + SQL 通配"而非具体表名,是有意为之的设计延迟。

## Do-Not-Repeat

- **[2026-06-02]** 不要让 daily lease key 用 UTC `toISOString().slice(0, 10)`。本地凌晨 02:17 这类触发点在非 UTC 时区会回落到前一 UTC 日期，daemon `daily_maintenance` 和 Tier 1.5 lease 都会记错天。统一用本地 `getFullYear()/getMonth()/getDate()` 组装 dayKey，并补 daemon + Tier 1.5 早晨回归。
- **[2026-06-02]** 不要让 cron worker 在完成时用 `new Date()` 重算 daily/weekly lease key。任务可能跨天或跨周才完成；若完成键跟着 finish time 走，原始 running lease 会永远收不拢。把 `lease_key` 写进 task payload，完成时优先用 payload；没有 payload 再按 `scheduled_for` 推导。
- **[2026-06-02]** 不要让 weekly catch-up 的 scheduler / worker / test 各自算不同的 lease key。周一/周二补跑仍属于上一个周日 03:17 打开的周窗口；若一边用 anchor-Sunday key、另一边用 `weekKey(new Date())`，会平白多出 queued weekly 任务，并让 completed/running 断言错位。统一走共享 `weeklyLeaseKey()` helper。
- **[2026-06-02]** 不要用带 `Z` 的 ISO 时间串测试 `scheduleCronTasks()` 的 02:17 / 03:17 门槛。该函数当前按本地时区读取 `getDay()` / `getHours()` / `getMinutes()`；回归要用 `new Date(y, m, d, h, min)` 这类本地 wall-clock 夹具，否则在非 UTC 环境会把未到点误测成已到点。
- **[2026-06-02]** 不要把 hook 子进程的 `stderr` 断言成空字符串。当前仓库用 `/usr/local/bin/node` 跑集成测试时，`node:sqlite` 的 ExperimentalWarning 可能写到 `stderr`；对 `mode=off`/黑名单早退这类用例，应断言“不出现 `ccmem:` 业务 notice”与“无持久化写入”，不要把 Node 自身 warning 误判成实现失败。
- **[2026-06-02]** 不要对大段测试块做脆弱的整块编辑/结构化替换后直接提交。一次 malformed tool/edit payload 曾把 assistant 元文本写进 `tests/integration/daemon-loop.test.mjs`，造成语法错误并污染测试文件。先缩小替换范围；若文件已受损，优先按精确行或最小唯一片段修复，再立即跑受影响测试确认恢复。
- **[2026-05-27]** 不要凭记忆回答 spec 内容。任何关于 spec 的事实陈述必须 grep
  当前文件验证。spec 在迭代,印象停留在旧版本。

## Decision Log

决策完整 rationale 见 [ccmem-design-revisions.md](../docs/ccmem-design-revisions.md)。
以下按主题分组,每条只保留结论与指针。

### 主题 1: 安全与防御

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| L-1 | 用户自定义 pattern 防 ReDoS:v0.1 禁用 extra patterns;v0.2 加载时 fuzz test + 50ms 超时,纯 Node RegExp 零依赖(**否决 re2 npm**) | design.md §10.2.1, revisions §七 U-9 |
| L-2 | scope 是安全边界:security_audit 按 scope 分轮,不跨 scope 自动调 trust;跨 scope 高相似度写只读 `cross_scope_alerts` | design.md §8.2, motivation §核心理念 5 |
| S-3 | 数据安全 > 用户便利:migration 失败 hard exit + backup + bypass env,不开 safe mode | v0.1-spec §7.4.1 |
| S-4 | 防御纵深覆盖反向数据流:transcript-read 路径也 strip critical patterns + 角色固定 + JSON schema 验证 | design.md §10.3 |
| U-9b | 非 git 目录强制 `--scope`(exit 64),防 /tmp 随手 save 污染全局 | v0.1-spec §5.2 |

**泛化**: 写入闸门 ≠ 全部防御 — 任何"读已有数据 → 喂 LLM"的反向路径都是独立攻击面。

### 主题 2: 性能与架构

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| U-PERF | 分层 SLO:ms_business(代码可控)+ ms_total(含 Node 冷启动)独立报警 | v0.1-spec §4.1/§4.2 |
| U-DEPS | Node ≥22.5 + 内置 `node:sqlite`,零运行时依赖。hook 带 `--experimental-sqlite` | v0.1-spec §4.3 |
| T-5+U-1 | daemon-optional 三档:Tier 1(注入/命令)不依赖 daemon;Tier 1.5(lazy SQL maintenance)用户命令 prelude 跑;Tier 2(LLM)daemon 才跑 | motivation §daemon-optional, v0.1-spec §4.1 |
| P-1 | daemon_lock(进程锁)与 task_runs(幂等 lease)职责分离,不互相替代 | design.md §7.8/§O-1 |
| ECC-R2 | UserPromptSubmit 超长 prompt 截断 2000 字符再检索 | v0.1-spec §4.2 |
| ECC-R3 | trash 文件 atomic write(tmp+rename);metrics appendFile POSIX < PIPE_BUF 原子 | v0.1-spec §5.4/§8.2 |

**泛化**: 性能 SLO 拆"我能控制的"与"我控制不了的"两条线。优先用平台内置,零依赖 > 用最好的库。

### 主题 3: 命令与交互设计

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| R-4 | stdout/stderr 都进 LLM → 元数据走 audit_log + stderr ≤ 2 行 LLM-safe 指针 | v0.1-spec §5.0.2, 附录 D |
| ECC-R1 | slash command 用 `command:true` + `disable-model-invocation:true`(直执行,省 LLM round-trip) | v0.1-spec 附录 B |
| P-4 | 版本门控统一:FeatureNotAvailableError + exit 78 + workaround 提示 | v0.1-spec §5.0/§5.0.1 |
| S-5 | 输出格式按内容性质(表格/时间线/bullets)选,不按命令归类;TTY 降级强制 | design.md §12.6 |
| Q-2 | friction 按 authorship:save(用户=作者)无确认;promote(用户=接收者)需 verbatim | design.md §12.3 |
| T-9 | 命令矩阵精简:admin 命令面扩张优先 flag 不开新 verb | revisions §五 T-9 |

**泛化**: LLM 可见输出必须 LLM-safe(不含推断模板/shell 模板/if-then 结构)。friction 看"谁是作者"不看"会发生什么"。

### 主题 4: 记忆生命周期与 Trust

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| I-3→T-4 | trust 死锁防护:floor 0.2 保留;月度强制曝光**删除**,改 opt-in `/ccmem:resurrect` | revisions §五 T-4 |
| T-3 | L2.5 transcript 引用扫描:Stop hook 检测 assistant 引用了 mem → helpful +0.025 trust。补足正反馈源 | revisions §五 T-3 |
| U-5 | trust 上限统一 1.0(所有 source);差异化只在初始值与观察期 | revisions §七 U-5 |
| U-7 | 排序公式 5 项→4 项:删 probation_boost | revisions §七 U-7 |
| 2026-05-22 | 类型 5→4:删 skill,合入 rule+tags | design.md §4.1 |
| W-1 | weekly_synthesis 按语义主题分组 + 与现有 consolidated 做 thematic merge,不只按时间窗口 | revisions §十四 W-1 |
| W-2 | synthesis 双产出:consolidated(摘要)+ rule(泛化原则);rule 是最高行动价值产出 | revisions §十四 W-2 |
| W-3 | consolidated content ≤ 80 字符(索引+结论);详情走 parent_ids 追溯 | revisions §十四 W-3 |
| W-4 | 月度 meta_synthesis 防 consolidated 膨胀:同主题 ≥ 3 条 → merge 为 depth+1 | revisions §十四 W-4 |

**泛化**: 沉默不算 helpful。正反馈源必须显式。trust 复活机制必须 user-in-the-loop。整合最有价值的产出是泛化原则(rule),不是事实归档(consolidated)。

### 主题 5: Schema 与数据模型

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| R-5 | migration 事务化:`runMigration()` helper + schema_migrations 历史表 v0.1 即建 | v0.1-spec §7.4 |
| Q-4 | CHECK enum 扩展走 rename→recreate→copy→drop recipe。枚举稳定(< 6 值)用 CHECK,不稳定才用字典表+FK | v0.1-spec §3.1 |
| N-1+Q-1 | v0.x 边界三重防漏:schema 注释 `reserved` + §4.6 白名单 + grep checklist。白名单是快照,随 spec 显式演进 | v0.1-spec §4.6 |
| P-2 | metrics.jsonl(可观测/可共享/可丢失)与 recent_injections(可查询/含 PII/不可丢)严格分离 | design.md §13.1 |
| 2026-05-22 | project_key: registry 归一(GitHub/GitLab/Gitee/Bitbucket/codeup) + manual alias + SHA256 fallback | design.md §8.1, v0.1-spec §10 |
| S-1 | 经验值参数必须文档化推算来源 + 用户视角命名 | design.md §7.3.1 |

**泛化**: "用于分析"与"用于查询"是两类数据,默认独立存储。schema 演进是一等公民。

### 主题 6: Plugin Packaging

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| V-1 | hook command 用 `${CLAUDE_PLUGIN_ROOT}`;slash command 走 PATH 上的 ccmem CLI | v0.1-spec §4.3, 附录 E |
| V-2 | plugin.json 5 条硬约束:version 必填 / commands 必须 array / 无 agents / 无 hooks / mcpServers:{} | v0.1-spec §11.0 |
| ECC-R1 | command .md 用 `command:true` + `disable-model-invocation:true` 直执行 | v0.1-spec 附录 B |

**泛化**: plugin packaging 约束是隐性的、validator 不友好的。用已验证实现的 NOTES 作输入,不依赖官方文档。ship 前必有 manifest regression test。

### Config 设计(补充)

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| 2026-05-22 | 4 层优先级:defaults < user < project < runtime。null=delete deep merge | design.md §14 |
| B5 | 项目级 config 只认 `project_key` / `project_key_remote_priority` 两个 key | v0.1-spec §7.1 |
| U-6 | shadow 三档清晰边界:active(全功能) / shadow(read-only diagnostic) / off(early-exit) | v0.1-spec §5.6 |

### 主题 7: 实施策略

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| 2026-05-30 | v0.1 + v0.2 作为一个交付实现；实施顺序采用 vertical slicing；运行时通过 capability gate 保留 Tier 退化语义 | docs/superpowers/specs/2026-05-30-ccmem-v01-v02-implementation-design.md |
