# ccmem v0.13 — Handoff

> v0.13 已发布并合并。此后完成 **第一轮 dogfood**，并在 2026-08-01 下午完成 **Finding 9 + Finding 4 的修复波**。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料里。

## 先读这些，按顺序

| 材料 | 为什么需要 |
|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **最重要，先读。** 9 条 finding、V1–V8 验证清单、门禁。**Finding 4 与 Finding 9 已按实测重写，可信；但 §三/§四/§五 的状态栏仍停留在 G1 之前，见下方「文档内部矛盾」。** |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger —— 每条人类裁决及理由、全部延期项。git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 末尾「NOT in this wave」= v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` | 附录 A 不变量 **仍未涵盖 dogfood 的任何修复**。 |

## Git 状态

**不要相信本文档里的任何 commit SHA** —— 提交这份文档本身就会移动 HEAD。用 `git log --oneline` 确认。

需要知道的事实：

- 本轮新增 **6 个修复提交 + 3 个文档提交**（修复：daemon 环境、换模型检测器、签名契约、回填超时、回填接线、孤儿任务回收），全部在本地 `main` 上。
- **2026-08-01 深夜追加 3 个文档提交**（Finding 12、V4 实测记录、本文档同步）。
- 本地 `main` **领先 `origin/main`，尚未推送**。人类自己处理所有 push —— 不要代为推送。
  （`origin/main` 上次核对时在 `3dc7951`；**别信这个 SHA，用 `git rev-list --count origin/main..main` 自己数。**）
- 分支 `v0.13-spec`、`v0.13-dogfood-fixes` 均未删除（删分支必须先问）。
- 当前套件：**466 pass / 0 fail**。跑测试用 `npm test`（脚本已内置 `env -u CCMEM_CONFIG_PATH`）。

## ✅ G1 达成（含消费端）：回填跑通，且检索确实在用这些向量

**`pending = 0`，`semantic status` 为 `active`。**

**Finding 12 已修复（2026-08-02）**：`loadConfig()` 原先在 `CCMEM_CONFIG_PATH` 未设时直接返回
`DEFAULT_CONFIG`（`transformers-local`），于是没有该变量的 hook 进程用 MiniLM 嵌入查询，
签名与库里 4454 条 openai 向量无一匹配 —— 检索静默退化为纯词法，`retrieval_path` 却仍报 `'A'`。
**这是 Finding 9 的同一种病换了当事人**（那次 daemon，这次 hook）。
现改为回落到 `getDataRoot()/config.json`，该变量降级为覆盖。
端到端实测：`retrieval_pool` 0 → 1360、`stale` 4449 → 0、`cosine_contribution` 0 → 0.967。

**两条随之改变的事实，别踩**：
- **`npm test` 现在必须钉 `CCMEM_DATA_ROOT`**（脚本已改）。只 `env -u CCMEM_CONFIG_PATH` 不再够 ——
  回落会让测试读到真实配置文件，**含 API key**。
- **默认目录以后要迁到 `~/.ccmem/` 之类，只需改 `scripts/lib/paths.mjs` 一处** ——
  配置路径已经跟着 `getDataRoot()` 走，不再有第二份写死的路径。

| 指标 | 值 |
|---|---|
| `openai:text-embedding-3-small:1536` | 4367 |
| `transformers-local:...:384` 残留 | 2（均为 `decay_status='quarantine'`，**落在回填 population 之外**，故两个计数为 0 是对的，不是分母为 0） |
| `diagnose --retrieval` | `stale vectors: 0`，Circuit **CLOSED** |
| 修复后超时次数 | **0** |
| 孤儿 `running` 任务 | 0（daemon 启动时打印 `reclaimed 6 task(s)`） |

**dogfood 文档 §三 V3 的 OpenAI 清单可以据此回填**，V4/V5 仍待做。

## 本轮修复波（已提交）

| 修复 | 一句话 |
|---|---|
| daemon 环境 | `buildDaemonEnv` 的白名单补 `CCMEM_CONFIG_PATH` —— **Finding 9 的真正根因** |
| 换模型检测器 | 移除 `semantic on` 里那段 `UPDATE memories SET embedding = NULL` |
| 签名契约 | 无 provider 即无签名，返回 `null`（不再伪造 `dim:0`） |
| 回填超时 | 新增 `embedding.backfill_timeout_ms`（默认 30000），hook 路径保持 800ms |
| 回填接线 | override 必须传给 `load()`/`embed()`，只传给 `getProvider()` 不生效 |
| 孤儿任务回收 | daemon 启动时把 owner 已死的 `running` 任务标记 `failed`（Finding 11） |

每条的完整根因、证据、取舍在**提交信息里**，不在这里重复。`git log` 读它们。

## 文档状态：改完了什么，还欠什么

**已完成（本轮）**：dogfood 文档的 **Finding 4 与 Finding 9 已按实测整条重写**，提交信息里写明了为什么原记述是错的。
两条都在开头用引用块标注了"原记述已被推翻，不要照着修"。**这两条现在可信。**

**还欠的文书工作，按优先级**：

1. **Finding 10 与 Finding 11 还没有自己的条目** —— 目前只在 Finding 9 里以交叉引用形式各提了一句。
   - **Finding 10：launchd plist 冻结环境快照。** `admin daemon restart` **不重新生成 plist**，
     所以任何环境相关修复对已安装用户都不会自动生效，且无任何提示。必须 `admin daemon uninstall && install`。
     影响面比 Finding 9 更广 —— 它让「改了代码就该生效」这个心智模型整体失效。
     **⚠️ 更正：本文档原先写「验证手段只有一个：`ps eww -p <pid>`」——
     这台机器上 `ps eww` 根本读不到进程环境**（对自己的 shell 执行都查不到明明存在的变量），
     用它得出的"没有该变量"全是测量失效。可靠替身：`zsh -f -c 'echo $VAR'` 验继承、
     进程自己写出的签名验 daemon、`memory_feedback.session_id` + 时间戳验 hook 归属哪个会话。
     顺带：`~/.claude/plugins/ccmem` 是指向本仓库的符号链接，**hook 侧的代码改动下次调用即生效**；
     需要 uninstall/install 的只有 daemon（plist 冻结环境快照）。
   - **Finding 11：孤儿 `running` 任务堵死链条（已修复）。** 两个各自正确的 guard 合成死锁：
     `enqueueContinuation` 只数 `queued`（刻意），`daemon/main.mjs` 数 `queued` 或 `running`。
     owner 已死的 `running` 行两边都不动 ⇒ 链条永久停摆且无信号。实测冻结 12 分钟、1159 条待办。
     修复：`acquireDaemonLock` 保证单实例，故启动时任何 `running` 行必然是孤儿，统一标记 `failed`。
     **这是 tasks 表层面的属性** —— 当时库里还躺着 5 行孤儿 `summarize_pending`。

2. **dogfood 文档现在自相矛盾** —— Finding 4/9 说"已修复、G1 已达成"，但下列位置仍停在 G1 之前。
   这些是纯回填，彼此独立，很适合小步做：

   | 位置 | 现状 | 应改为 |
   |---|---|---|
   | Finding 3 验证状态 | `⏳ 待 G1` | 已解除 |
   | §三 V3「OpenAI provider」整份清单 | 全未勾 | 已跑通，`pending=0`，可逐条回填 |
   | §四 门禁表 G1 | `⏳ 方案已定，待执行` | ✅ 已达成 |
   | §四 优先级第 2 条 | `⏳ 待执行：G1` | 已完成 |
   | §五 实测结果 | `⏳ 待回填。V3–V5 待 G1` | V3 可写，V4/V5 现在才第一次具备条件 |
   | §三 V8「关注 Finding 4：熔断打开时应快速失败」 | —— | **熔断至今一次都没打开过，未检验，要如实标注** |

3. **附录 A 不变量仍欠** Finding 6/7/8 + 本轮全部修复的对应条目。
   **加之前必须先验证 grep 在破坏代码时真能变红**，否则重蹈 final review I9 的空不变量。

4. ~~**V4/V5 现在第一次具备验证条件**~~ —— **V4 已于 2026-08-01 深夜完成，三个消费点全部两面验证通过**
   （证据在 dogfood §五 V4，方法是在 live 库的 `VACUUM INTO` 副本上跑真实代码路径 + 真实 1536 维向量，
   live 库零写入；`feedback.mjs` 另做了代码突变确认过滤是承重的）。
   **V4 仍欠的只有生产计数** —— 而它被 Finding 12 压着，修好之前拿不到。
   **V5 尚未做**（`semantic status` 与 `diagnose --retrieval` 的口径一致性），现在仍具备条件。

## 当前运行时状态（会变，用命令核对）

- daemon 由 **launchd 托管**，plist 已重装并携带 `CCMEM_CONFIG_PATH`。
- embedding provider = **openai / text-embedding-3-small / 1536**，配置来自 `~/.claude/ccmem/config.json`（仓库外，含 API key，**从未进入仓库或本文档**）。
- 回填已完成：`openai:...:1536` 4367 条，`pending=0`。
- `config_kv` 里 `embedding.active_model` 那行还在，但已**无害** —— 唯一读它的代码已删。

核对命令：`ccmem admin semantic status`、`tail ~/.claude/ccmem/daemon.err.log`、查 `tasks` 表。

## 硬性纪律（本轮两次栽在这上面）

- **每个回归测试必须先被亲眼看着变红才接受。** 本轮有一个测试的"红"是**因为写错了表名**（`task_runs` 实为 `tasks`）——那种红不算数，后来用突变验证重做（破坏修复→红→还原→绿）。
- **纯函数有测试不等于接线有测试。** 回填超时的第一版提交**实际上什么都没改变**：override 只传给了 `getProvider()`，而 `load()`/`embed()` 各自回到 `loadConfig()` 把超时又拿了回来。这正是 Finding 7 记过的「包装器有测试、接线只靠人看」。
- **0 计数 / 不动的数字，先解释来源再当结论。** 本轮 `pending` 两次停滞：一次是超时杀死链条，一次是孤儿 `running` 行。两次都不是"再等等就好"。
- **查证要查对表。** 我在 live 库上一度查了 `task_runs`（实为 `tasks`），结论侥幸没错但证据是错的。
- **单面的绿在同签名库上恒真。** 库里 4454 条全是一个签名，签名过滤在这样的库上是 no-op ——
  只做正面等于 Finding 3 的分母为 0。V4 的每一项都必须构造异签名（**同维不同模型**，
  维度不同会被长度检查安全挡掉）再看观测量是否移动。
- **反面的"什么都没发生"需要正面对照才可信** —— 否则可能只是探针本身坏了。
- **V4 又栽了一次红错**：dedup 探针首版 `duplicate=false` 看着像反面成立，实为挑错了记忆
  （`candidateRows()` 取"最近 touch 的 20 条"，不是 FTS 捞的）。

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易误伤的几条见 ledger 与上一版 handoff 的同名章节；本轮新增三条：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除**（不是只删 `active_model` 键）—— 签名机制已正确覆盖换模型，检测器唯一的独特效果是数据丢失。
3. **签名契约改为返回 `null`**，不是 dogfood 文档写的「抛错」—— 抛错会打断 daemon 主循环（`daemon/main.mjs:40` 与 `vec-backfill.mjs:59` 都合法地传 null provider）。

安全取舍（本轮定的）：**provider API key 不进 daemon 环境白名单** —— `renderPlist` 会把环境字典明文写进 `~/Library/LaunchAgents`。daemon 靠读配置文件拿 key。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- dogfood **Finding 5**（`loadConfig()` 的 `JSON.parse` 无 try/catch）
- 本轮新增 **Finding 10、11**
- **回填失败的退避策略**：失败现在会重新排队（这是刻意的，冻结的库比吵闹的日志更糟），但**永久性失败**（key 失效、账单停用）会按 daemon 的队列节奏一直重试并逐次打日志。需要 failure-aware backoff。
- `@xenova/transformers` **已停止维护**，1.x 与 2.x 均带 critical 通告。真解是迁移到 `@huggingface/transformers`；权宜之计是转 OpenAI 后 `npm install --omit=optional`。
- 两个 daemon 测试抖动（`stop-daemon-flow`、`admin-daemon-command`）合并为一个 issue，不阻塞。

## v0.14 的核心问题仍未改变

`l25_cov` **是否存在任何可行阈值**。dogfood 的结论不是"有信号了"，而是**分位数对比这个方法本身不可靠** —— 判据必须是分布级的（AUC / Mann-Whitney U）。且 `l25_legacy_hit` 恒为 0，**无任何正例标签**，仍需人工标注约 50 个样本。详见 dogfood 文档 Finding 2 与 V2。

## 建议使用的 skills

- **`superpowers:systematic-debugging`** —— Finding 11（孤儿任务）是典型的"现象清楚、机制未明"。本轮 Finding 9 就是靠它先取证再改代码才没修错地方。
- **`superpowers:test-driven-development`** —— 本项目的硬性纪律就是红-绿，与该 skill 一致。**且要读到"接线也要测"那一层**。
- **`superpowers:verification-before-completion`** —— 本轮两次差点把"没验证"当成"已完成"。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。
- **`superpowers:writing-plans`** —— 定下方向之后。v0.13 的计划本身有 4 处缺陷，**新计划里的测试代码要当作草稿而非圣经**。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`、`.wolf/anatomy.md`）已 gitignore。本轮新增 `bug-056`（daemon 环境白名单）与 `bug-057`（孤儿 running 任务）。
- SDD workspace **刻意保留**：它承载全部人类裁决及理由、final review findings、8 份任务报告。
- 探针决策流 `l25-probe.jsonl` 无上限设计（`retention_days: 0`）。`diagnose --feedback` 打印其磁盘占用 —— 刻意让运行时成本可见，**不要"优化"掉**。
- 本次运行的所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
- **成本提示**：本轮会话远超 CLAUDE.md Rule 6 的 token 预算。跨进程取证（读进程环境、比对多份配置、逐个调用点核实）代价很高 —— 下一轮若要做同类工作，**先分小段、及时 `/compact`**。
