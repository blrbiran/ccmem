# ccmem v0.13 — Handoff

> v0.13 已发布并合并。此后完成 **第一轮 dogfood**，并在 2026-08-01 → 08-02 完成四波修复：
> Finding 9/4 → Finding 12（配置回落）→ Finding 13（hook 超时）→ **Finding 14（熔断阈值失效）**。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料与提交信息里。

## 先读这些，按顺序

| 材料 | 为什么需要 |
|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **最重要，先读。** 14 条 finding、V1–V8 验证清单、门禁。Finding 4/9/12/13/14 与 V4/V5/V8 均已按实测写定，可信。 |
| `git log`（近 ~13 个提交） | **每条修复的完整根因、证据、取舍都在提交信息里**，本文档刻意不重复。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger —— 每条人类裁决及理由、全部延期项。git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 末尾「NOT in this wave」= v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` | 附录 A 不变量 **仍未涵盖 dogfood 的任何修复**。 |

## Git 状态

**本文档不写 commit SHA，也不写"领先几个提交"** —— 提交这份文档本身就会改变这些数字。自己数：

```bash
git log --oneline -15
git rev-list --count origin/main..main    # 本地领先多少
git status --porcelain                    # 应为空
```

最近一波（Finding 14）落在 main 上的两个提交，**按标题找、不要按 SHA 找**：

- `fix(embedding): treat a missing circuit key as absent, not as zero`
- `docs(dogfood): record V5 and Finding 14, and retract the "circuit never opened" claim`

需要知道的事实：

- 本地 `main` **领先 `origin/main`，尚未推送**。**人类自己处理所有 push —— 不要代为推送。**
- 分支 `v0.13-spec`、`v0.13-dogfood-fixes` 均未删除（**删分支必须先问**）。
- 当前套件：**477 pass / 0 fail**，跑法 `npm test`。
  已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；不阻塞，但**红了要先确认是它**。

## ⚠️ 会咬人的既定事实

1. **`npm test` 现在同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**（脚本已改）。
   只 unset 配置路径**不再构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **默认目录以后迁到 `~/.ccmem/` 之类，只需改 `scripts/lib/paths.mjs` 一处** ——
   配置路径已跟着 `getDataRoot()` 走。**不要再在别处解析数据根。**
3. **`ps eww` 在这台机器上读不到进程环境。** 对自己的 shell 执行都查不到明明存在的变量。
   本文档旧版曾把它写成「唯一验证手段」，那是错的。可靠替身：
   `zsh -f -c 'echo $VAR'` 验继承 / 进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
4. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）；
   **只有 daemon 需要 `uninstall && install`**（plist 冻结安装时的环境快照，`restart` 不重新生成）。
   Finding 14 因此**不需要重启 daemon** —— 熔断 API 的调用点只有 `retrieval.mjs`，`scripts/daemon/` 零引用。

## 已完成（不要重做）

| 项 | 状态 |
|---|---|
| **G1**：OpenAI 回填 + 消费端 | ✅ 达成。`pending≈0`（随使用增长）、`cosine_contribution` 实测 0.967 |
| **V4**：签名过滤三个消费点 | ✅ 三个点全部**两面验证**通过（正面 + 异签名反面 + 突变）。证据见 dogfood §五 V4 |
| **V5**：两条命令的 enabled 口径 | ✅ **已做，分歧确认存在**。四组合实测见 dogfood §五 V5。**取证不修**（属 deferred 桶） |
| **V8**：hook 延迟预算 | ✅ 已测并已修（Finding 13）。**但熔断相关的样本全部作废，见下** |
| **Finding 12**：hook 读到另一份配置 | ✅ 已修。`loadConfig()` 回落到 `getDataRoot()/config.json` |
| **Finding 13**：预算对同步工作无效 | ✅ 已按实测重设三个 harness 超时（Stop 3s / SessionStart 2s / UserPromptSubmit 5s） |
| **Finding 14**：熔断阈值是死代码 | ✅ 已修（`readConfigKvInt` 转换前判存在）+ 4 条回归测试 |

**本轮最该记住的两条**：

- **Finding 13**：`withHookSafety` 的 `Promise.race + setTimeout` **只能切断异步工作**；
  `node:sqlite` 是同步 API，所以同步工作跑满全程、预算从不触发。
  **⇒ hooks.json 的 harness 超时对同步工作是唯一限制，必须按工作实测 p99 定尺寸。**
- **Finding 14**：`Number(null) === 0` 且 `0` 有限 ⇒ `readConfigKvInt` 把"key 不存在"答成 `0`，
  而调用方用 `== null` 判存在。**从未失败过的库读作熔断已开着的库** ⇒ 阈值是死代码、
  open 的 audit 落在不可达分支（3863 行 audit 里 close 2 行、open **0** 行）、
  健康检索每次写 `last_probe_at` 进而在零失败下误判熔断打开。

## 还欠什么（按建议顺序）

**验证项已全部做完。剩下的是文档回填与不变量，彼此独立，适合小步做。**

1. **dogfood 残余的自相矛盾**（纯回填）：

   | 位置 | 现状 | 应改为 |
   |---|---|---|
   | Finding 3 验证状态 | `⏳ 待 G1` | 已解除 |
   | §三 V3「OpenAI provider」清单 | 全未勾 | 已跑通，可逐条回填 |
   | §四 门禁表 G1 | `⏳ 方案已定，待执行` | ✅ 已达成（口径按 Finding 12 收窄） |
   | §四 优先级第 2 条 | `⏳ 待执行：G1` | 已完成 |
   | §四 G1 执行方案开头 | 「**不需要写 ccmem 配置文件**」 | **与 Finding 6/12 的最终裁决直接冲突**，实际走的是方案 A |
   | §五 V4 最后一个未勾项（生产计数） | 未勾 | Finding 12 修复后已有实测，可结 |
   | Closure checklist 后 3 项 | 未勾 | 按实际逐项判 |

2. **Finding 10 / 11 仍没有自己的条目**（目前只在 Finding 9 里交叉引用）：
   - **Finding 10：launchd plist 冻结安装时的环境快照。** 见上「既定事实 4」。
   - **Finding 11：孤儿 `running` 任务堵死链条（已修复）。** 两个各自正确的 guard 合成死锁 ——
     `enqueueContinuation` 只数 `queued`（刻意），`daemon/main.mjs` 数 `queued` 或 `running`，
     owner 已死的 `running` 行两边都不动 ⇒ 链条永久停摆且无信号。

3. **附录 A 不变量** 仍欠 Finding 6/7/8 + 本轮全部修复（12/13/14）的条目。
   **加之前必须先验证 grep 在破坏代码时真能变红**，否则重蹈 final review I9 的空不变量。
   这是剩余工作里唯一需要动代码判断的一块，**建议在干净的上下文里单独开一轮**。

## 当前运行时状态（会漂移，用命令核对）

```bash
ccmem admin semantic status          # provider / embedded / pending
ccmem admin diagnose --retrieval     # stale vectors / Circuit
tail ~/.claude/ccmem/daemon.err.log
```

- daemon 由 **launchd 托管**，plist 已重装并携带 `CCMEM_CONFIG_PATH`。
- embedding provider = **openai / text-embedding-3-small / 1536**；配置在 `~/.claude/ccmem/config.json`
  （仓库外，含 API key，**从未进入仓库或本文档**）。
- 回填持续在跑，**向量条数每次看都不一样，这是正常的**，别把增长当成回填倒退。
- 残留 2 条 `transformers-local:...:384`，均为 `decay_status='quarantine'`，**落在回填 population 之外**。
- `config_kv` 里 `embedding.active_model` 那行还在，但已**无害** —— 唯一读它的代码已删。
- **熔断会开**（Finding 14 修复前甚至第一次失败就开）。`embedding.circuit_open_until` 有行 = 开过，
  但该行会被下一次成功清掉，**看不到不等于没开过**。

## 硬性纪律（每一条都是这几轮真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** 已栽三次：
  ① 表名写错（`task_runs` 实为 `tasks`）；② dedup 探针挑错记忆（`candidateRows()` 取"最近 touch 的 20 条"，不是 FTS 捞的）；
  ③ 测试里的 stdout 桩没回调 `resolve`，把 `withHookSafety` 的 await 挂死。**三次的红都不是我以为的那条。**
- **纯函数有测试 ≠ 接线有测试。** 回填超时的第一版提交实际什么都没改变：override 只传给了 `getProvider()`，
  而 `load()`/`embed()` 各自回到 `loadConfig()` 把超时又拿了回来。
- **0 计数 / 不动的数字，先解释来源再当结论。** 已出现**五**种不同来源的 0：
  分母为 0（Finding 3）、进程比代码旧（Finding 1）、链条死掉（Finding 4/11）、
  幸存者偏差（V8：metrics 行由 hook 自己写，被杀的那次来不及写）、
  **查错了字段名（本轮：metrics.jsonl 的键是 `hook` 不是 `event`，`grep '"event"'` 得 0 匹配）**。
  第六种变体见 V5：**签名为 null 让 SQL 谓词恒不成立**，计数塌成 0 而看起来像健康。
- **单面的绿在同签名库上恒真。** 库里全是一个签名时，签名过滤是 no-op。
  验证必须构造异签名，且要用**同维不同模型**（维度不同会被长度检查安全挡掉）。
- **反面的"什么都没发生"需要正面对照才可信** —— 否则可能只是探针本身坏了。
  V5 的 B 组就是这个对照：同一条 SQL 在同一副本上能产出 4447，C 组的 0 才可信。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`），live 库零写入；
  取副本前后比对 mtime/size 确认。
- **不要从缺失下结论。** 本轮一度断言「open 不落 audit」，实际代码里有 `writeAudit` ——
  真相是那段代码不可达。**先找到写入点，再解释为什么没有行。**

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除**（不是只删 `active_model` 键）—— 签名机制已正确覆盖换模型，检测器唯一的独特效果是数据丢失。
3. **签名契约返回 `null`**，不是抛错 —— 抛错会打断 daemon 主循环（多处合法地传 null provider）。
   **注意**：正是这个 `null` 让 V5 的分歧表现为静默的 0（`<> NULL` 恒不成立）。契约本身没错，
   错的是 `diagnose` 在 embedding 关闭时仍去构造并展示一个由此得来的计数。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖（2026-08-02 裁决）。
5. **provider API key 不进 daemon 环境白名单** —— `renderPlist` 会把环境字典明文写进 `~/Library/LaunchAgents`。
6. 探针决策流 `l25-probe.jsonl` 无上限（`retention_days: 0`），`diagnose --feedback` 打印其磁盘占用 ——
   **刻意让运行时成本可见，不要"优化"掉**。
7. **Finding 14 的行为变更是刻意的**：熔断现在容忍 2 次失败才开，即 `failure_threshold` 本来的语义。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- dogfood **Finding 5**（`loadConfig()` 的 `JSON.parse` 无 try/catch）
- **Finding 10**（plist 冻结环境快照）、**Finding 11**（已修，但需成条）
- **Finding 13 的深层解**：让预算对同步工作真正生效，需要把 hook 工作切段、段间检查耗时 ——
  **设计改动，需人类裁决**。当前选择是承认限制、按实测定外部超时。
- **V5 取证出的三条**（均未修，见 dogfood Closure review 的 deferred 桶）：
  ① `semantic`/`diagnose` 的签名口径分歧本体；
  ② `diagnose` 把签名为 null 的 0 讲成"待 vec_backfill 重嵌"；
  ③ `semantic status` disabled 分支的 `model`/`dim` 与同一行的 `pending` 不同源。
- **回填失败的退避策略**：失败会重新排队（刻意），但**永久性失败**（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**。真解是迁移到 `@huggingface/transformers`。
- 两个 daemon 测试抖动合并为一个 issue，不阻塞。

## v0.14 的核心问题仍未改变

`l25_cov` **是否存在任何可行阈值**。dogfood 的结论不是"有信号了"，而是**分位数对比这个方法本身不可靠** ——
判据必须是分布级的（AUC / Mann-Whitney U）。且 `l25_legacy_hit` 恒为 0，**无任何正例标签**，
仍需人工标注约 50 个样本。详见 dogfood Finding 2 与 V2。

**两条已知的样本偏差，做分布分析前必须先评估**：

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉，而 stop hook 正是写探针行的地方
   ⇒ **现有探针数据集可能系统性缺失慢会话/长会话**。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开
   ⇒ **该时期任何"检索是否走了语义通道"的统计都偏向词法**，不代表设计行为。

## 建议使用的 skills

- **`superpowers:systematic-debugging`** —— 本轮 Finding 12/13/14 都是靠"先取证再改代码"才没修错地方。
  尤其记住它的反面教材：`ps eww` 那次测量失效，以及本轮从缺失下结论那次。
- **`superpowers:test-driven-development`** —— 项目硬性纪律就是红-绿，**且要读到"接线也要测"那一层**。
- **`superpowers:verification-before-completion`** —— 本轮多次差点把"没验证"当"已完成"。
- **`superpowers:writing-plans`** —— 若开附录 A 不变量那一轮。**新计划里的测试代码要当草稿而非圣经**（v0.13 的计划本身有 4 处缺陷）。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`）已 gitignore；`.wolf/cerebrum.md` 入库。
  本轮新增 `bug-058`（hook 配置分歧）、`bug-059`（hook 超时三层根因）、`bug-060`（熔断阈值失效）。
- SDD workspace **刻意保留**：承载全部人类裁决及理由、final review findings、8 份任务报告。
- 本次运行的所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件。
- **成本提示**：Finding 12/13 那轮已超 $110，Finding 14 这轮再 ~$60，均远超 CLAUDE.md Rule 6 的预算。
  跨进程 / 跨数据源取证（进程环境、多份配置、metrics 与 audit_log 与 config_kv 对账）代价很高。
  **剩余工作是文档回填与不变量，不该再按这个量级花** —— 分小段、及时 `/compact`。
