# ccmem v0.14 spec（范围设定版）

- **日期**：2026-08-11
- **状态**：范围已与人类逐节确认，**已过一轮 review 并按 review 修正**；~~**尚未落任何代码**~~
  🆕🔴 **2026-08-26 更正**：**W0 的实现已落**（新增 `scripts/lib/config-delta.mjs`；接线 `scripts/lib/admin/diagnose.mjs` 与 `scripts/cli.mjs`；新增 `tests/unit/v014-config-delta.test.mjs` 与 `tests/integration/v014-diagnose-config.test.mjs`），但**仍在分支上，未合入 `main`**，~~**完整测试套件尚未跑**（见 §七）~~
  🆕🔴 **2026-08-26 更正**：**完整测试套件已跑**——`21:18:24 → 21:18:48`，**605 pass, 0 fail**，
  记录见 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`（不是 §七，§七未提测试套件）。
  这只说明套件跑过且全绿，**不代表 W0 已合入、已定论或已完成**。**W1–W4 仍无任何代码。**
- 🆕🔴 **2026-08-25 更新**：本文档写于 2026-08-11，此后范围与状态都变了，**下面逐处标了 🆕**。
  最重要的两条：**① 工作流已是五条，不是四条** —— 2026-08-20 人类从 W1/W2 的共同需求里抽出了
  **W0（通用"非默认配置上报"机制）**，~~本文档全文没有它~~；
  🆕🔴 **2026-08-26 更正**：W0 已写入本文档——§二新增 `### W0` 一节，§三时机表加了 W0 一行。
  **② 四条工作流的设计与实现计划均已落盘**（W3 的设计 2026-08-25 补上），见 §七。
- **本文档回答**：v0.14 做什么、不做什么、为什么、什么时候能落
- **本文档不回答**：怎么做。实现细节（schema / 逐文件改动 / 完成判据编号）在走 `superpowers:writing-plans` 之后补进本文档或另开计划
- **配套文档**：dogfood 记录写入 `docs/ccmem-v0.14-dogfood.md`（尚未创建）

> ⚠️ 本文档与 `ccmem-v0.13-spec.md` 的形态不同：v0.13 那份是**实施 spec**（含 schema、完成判据、不变量 checklist），
> 本文档目前只是**范围设定**。实现计划落定后需要补齐成实施 spec 的形态，否则两个版本的文档不同构。

---

## 〇、这份 spec 的由来与目的

上一轮（2026-08-10）读了 `../ccmem_paper` 的 paper 初稿与模拟同行评审，**目的是定 v0.14 的范围，不是修 paper**（人类裁决，见 handoff Ⅺ.15）。

**人类已裁决的两条边界，本文档全程遵守：**

1. `ccmem_paper/reference/ccmem` 停在 v0.12 快照是**有意为之**，本轮不同步、不追"paper agent 读哪一份"。
   计划顺序是：先落地 v0.13/v0.14 的针对性优化 → 再刷新快照 → 再重启 paper 工作。
2. **v0.14 的首要目的是"解 paper 的 block"**，因此范围由审稿意见的 P0 切，不由 v0.13 自己的产品 backlog 切。

---

## 一、逐条判定：审稿意见相对 v0.13 的状态

**判定方法**：对当前 `main`（= v0.13）做只读 grep 复核，**不从 v0.12 快照或文档推断**。执行日期 2026-08-10/11，并经独立 reviewer 复验。

| # | 审稿指控 | 快照（v0.12）记录 | 当前 `main`（v0.13）实测 | 判定 |
|---|---|---|---|---|
| 1 | quarantine 只对 `source=external` 生效；默认 `save` 走 `user_explicit` 豁免 | `save.mjs:167-179` | `save.mjs:186` 仍硬编码 `source: 'user_explicit'`；`threat-scan.mjs::evaluateTier3` 仍对 `user_explicit` / `cron_consolidated` 提前返回 `force_demote` | **仍成立** |
| 2 | `external` 全库唯一写入路径是 import | `import.mjs:43` | 仍是唯一站点 | **仍成立** |
| 3 | threat-scan 纯正则、101 行、6 条英文 TIER2 | 101 行 | **仍是 101 行、同 6 条正则**；种子逐字命中的那条仍在 `:15`（原文 `/ignore (all \|the )?(previous\|prior) instructions/i`） | **仍成立** |
| 4 | scope 过滤是硬编码 SQL，config 关不掉 | `retrieval.mjs:130/149/169/438` | `:131 / :150 / :170 / :430`，**行号漂了、代码未变** | **仍成立** |
| 5 | `project_key` 取自 `git config remote.origin.url`（repo 内可写） | `project-key.mjs:20` | `resolveProjectKey` 仍是同一实现 | **仍成立** |
| 6 | trust 可被 `helpful_implicit` 爬回 | — | `trust.mjs:43` 仍在 | **仍成立** |
| 7 | **hook 触点 p50/p95 延迟无数据**（P1#5 第 1 个数） | 无 | 🆕 `hook-safety.mjs:83` 每个 hook 写 `ms_total`；`metrics-rollup.mjs:48-52` 按 hook 分桶，`:78-79` **已经在算 p50/p95** | **已被 v0.13 解决**（不只是数据源，读数出口也在） |
| 8 | **daemon 周期 model call 次数 / token / 稳态周成本**（P1#5 第 2、3 个数） | 无 | `daemon/claude-p.mjs` **零处**捕获 usage / token / 耗时 | **部分成立，见下** |

**关于第 8 行的精确表述**（原稿写"完全空白"，过头了）：
**per-run 的调用次数与耗时其实已经进了 audit 行** —— `contradiction-audit.mjs:176-177`、`security-audit.mjs:270-271`、
`weekly-synthesis.mjs:534`、`monthly-meta-synthesis.mjs:57`。
**真正缺的是 per-call 粒度与 token / 成本**。这个区别直接影响 W4 的设计选择（见 W4 的"为什么另开文件"）。

### 1.1 一条比逐条判定更重要的结构性发现

审稿意见里**只有一小部分**指向产品代码。分三族：

- **F1 论文写作与定位**：evidence tier 话术、元叙事泄漏、记号不一致、补引 8 篇文献、Table 1 strawman、hedging 密度。
  ⇒ **完全不驱动 v0.14 代码**，是人类刷 paper 时的事。
- **F2 评测协议**：`C-NAIVE` 不是真 control、`S-SCOPE-03` 结构性不可判别、`S-POISON-01` 自证式、repeated trials 只有一个 trio 做到、judge 只 grep 词法锚点。
  ⇒ 它对 ccmem 提出的代码需求是"**同一写入口** + **lifecycle 控制可开关**"两条（归属见 §四 4.5）。
- **F3 产品与机制真缺陷**：quarantine 豁免区、6 条正则可零成本绕过、`project_key` 完整性、trust 可操纵、注入通道 TOCTOU、成本不可计量、缺 `C-MANUAL` baseline。
  ⇒ **这才是 v0.14 的真候选池。**

### 1.2 另一条与审稿意见几乎不相交的候选清单

v0.13 spec §1.2 与 §十 backlog 已点名了自己的 v0.14 项：L2.5 真修复（改 trust，**标注 P0**，依赖 A1 探针数据）、type 通胀治理（71% `auto_inferred` 被标 `rule`）、live DB 速率体检命令、benchmark corpus ≥100、出口参数调整、migration hash CI 检查。

⇒ **v0.14 面对两条互不相交的清单**，范围问题的实质是二者怎么排。人类裁决：**按"解 paper 的 block"排**，产品路线图那条整体后移（见 §四）。

---

## 二、范围：~~四条~~ 🆕 **五条**互相独立的工作流

🆕🔴 **2026-08-20 更正**：W1–W4 之间没有共享状态，可任意顺序甚至并行实现。**W0 是例外**——它是 W1 与 W2 都要消费的机制，必须先落，顺序不是自由的（详见下方 W0 一节）。

### W0 — 通用「非默认配置上报」机制（**前置件**）

🆕🔴 **2026-08-20 新增 —— 本节原先没有它，别把 §二 当穷举。**

- **W0 = 通用"非默认配置上报"机制**。由人类 2026-08-19 从 W1 验收判据 4 与 W2 的同一条共享需求里抽出来独立成条，避免两份互不知情的实现。
- 设计：`docs/superpowers/specs/2026-08-20-w0-non-default-config-reporting-design.md`
- 计划：`docs/superpowers/plans/2026-08-20-w0-non-default-config-reporting.md`
- **只报键路径，永不报值**——`openai_api_key` / `jina_api_key` 一旦被操作者设置就是非默认键，把值打出来等于把凭证印上 stdout。
- **W0 先落，W1 才算验收完整**（W1 计划 Task 9 是这条依赖的闸门）。
- ⇒ **落地顺序 W0 → W1 → W2 → W3**。

### W1 — quarantine 覆盖面开关（**产品特性**）

- 新增 `security.quarantine_all_sources`，**默认 `false`（行为零变化）**。
- 主改动点：`threat-scan.mjs::evaluateTier3` 中对 `user_explicit` / `cron_consolidated` 的提前返回。开关为真时不再豁免。
- **接口保持纯函数**：判定所需的开关由调用方传入，不在 `evaluateTier3` 内部 `loadConfig()`。
- **默认 `false` 的理由是产品理由，不是评测理由**：6 条英文正则的误报会直接吞掉用户手写的记忆，而本仓库自己在 dogfood。

🔴 **`evaluateTier3` 不是唯一站点**（原稿写"唯一改动点"是错的）。另有两处硬编码的 source 白名单同样把 `user_explicit` 排除在外：

| 站点 | 语句 | 后果 |
|---|---|---|
| `daemon/tasks/security-audit.mjs:78` | `WHERE m.source IN ('auto_inferred','external','tool_output')` | `user_explicit` 记忆**永远不进 LLM 安全审计** |
| `lib/tier15.mjs:141` | 同一谓词 | 同上，对 Tier-1.5 聚类不可见 |

⇒ **实现前必须裁决**：是把开关的语义收窄成"写入时"（则名字应为 `quarantine_all_sources_at_write`，并在 spec 里写明审计面不受影响），还是把这两处 SQL 一并纳入开关。**不许默认它们会跟着变。**

📌 另记一条事实，免得下个人重推：`lib/revalidation.mjs:106` **已经不分 source 地做隔离**（按 trust / pinned 门控）。
⇒ **豁免是写入时的性质，不是全局性质。**

### W2 — scope 隔离降级开关（**评测专用**）

- 新增 `eval.disable_scope_isolation`，**默认 `false`（行为零变化）**。
- 目标：让 `C-NAIVE` 成为真控制组，解开 `S-SCOPE-03` 的结构性不可判别。
- **四处站点分属不同函数，必须逐处判定，不许四处一起盲改：**

  | 站点 | 所在函数（已 grep 复核） |
  |---|---|
  | `retrieval.mjs:131` | `ftsSearch`（`:120`），FTS 路 |
  | `retrieval.mjs:150` | `likeSearch`（`:139`） |
  | `retrieval.mjs:170` | `legacySubstringSearch`（`:159`），**兜底路**，仅在 `candidateRows.length === 0` 时到达（`:287-288`） |
  | `retrieval.mjs:430` | 向量候选查询，喂 `cosineScores` → `candidateIds` |

- ✅ **一条原稿的错误更正（review 抓到，已复核确认）**：原稿说 `:430` 那处的注释表明它可能同时服务 `diagnose` 的 stale 计数，因此"开关不得改动它"。**这是误读，且照它做会让 W2 直接失效。**
  实际：`:432-435` 那段注释位于 `).all(sig, projectKey);` **之后**，描述的是紧随其后的 `staleVecs`（`:436-441`）那个 `COUNT(*)`；
  而 **`staleVecs` 根本没有 scope 谓词**，与本开关无关（它经 `:504` 的 `retrieval_stale_vecs` 出到 `admin/diagnose.mjs:74` 与 `handlers/prompt-submit.mjs:137`）。
  ⇒ **`:430` 是纯检索路径，必须被开关覆盖** —— 否则向量 lane 仍然隔离，而 `S-SCOPE-03` 正跑在这条 lane 上，W2 会"做完了但不起作用"。

- ⚠️ **这四处不是 scope 隔离的全部**：`handlers/session-start.mjs:68`（`WHERE scope = 'global' OR scope = ?`）与
  `lib/injection-cache.mjs:42`（`AND project_key = ?`）同样决定什么进模型。
  **是否需要一并覆盖，取决于评测 harness 实际触发哪些 hook** —— 实现计划里必须显式回答，不许把"四处"当成穷举。

- **本开关必须在 `diagnose` 里显式可见**：处于非默认值时要报出来（见 §五 5.2 的测试要求）。
  ~~`admin/diagnose.mjs` 目前**没有**任何"报告非默认配置"的机制，⇒ **这是 W2 的一部分真实工作量，不是免费的**。~~
  🆕🔴 **2026-08-20 更正：这部分工作量已不属于 W2 —— W0 接管了它**（handoff ⅩⅥ.3）。
  ⇒ **W2 的范围因此比本节写的小**；W2 只需保证开关值能被 W0 的机制看见，不必自己造上报机制。

### W3 — threat-scan bypass suite + 扫描器改强

> 🆕🔴 **2026-08-25：W3 的设计已落盘，且它更正了本节对问题形状的判断。**
> `docs/superpowers/specs/2026-08-25-w3-threat-scan-bypass-suite-design.md`
> **本节把 W3 写成"补漏报 + 顺带防误伤"，实测下来重心相反**：6 条 TIER2 里 **3 条在典型合法工程记忆上误伤**
> （"不要把 API key print 到日志里" 0.45、"那条 sudo rm -rf 是故意的" 0.7、"这个 curl \| bash 不安全" 0.55），
> 根因是**扫描器分不清「提及」与「指示」** ⇒ **只加模式会让误伤更糟**，改强方向已改为
> **规范化 + 提及/指示区分，两个数字一起看**（设计 §2.1、§三.4）。
> 🔴 另有一条本节完全没有的风险：**改强 = bump `scan_patterns_version` ⇒ revalidation 会追溯重扫整个已有记忆库**
> （设计 §六.1）⇒ 实现计划里**新增一步"干跑 + 人类过目"**再 bump。

审稿人 P0#4 只要求**测量**（他自己标注"离线可跑、零模型成本、说服力增益最大"）。人类裁决**测量 + 改强**。

拆成两半，**两半的 CI 地位不同**：

| 半 | 位置 | 进 CI 断言？ |
|---|---|---|
| 语料 + 报告脚本 | 新建 `tests/fixtures/threat-payloads/`（语义等价 payload + 良性对照集）+ 新增 npm 脚本产出 detection rate / FP rate | **否**。改强后检出率会变，做成门就是一道永远在动的断言 |
| 误伤回归 | 良性对照集中"必须不被拦"的部分，**落在 `tests/unit/` 或 `tests/integration/`** | **是**。改强最可能弄坏的就是它，与 v0.13 A2 §5.2.2 那张误伤表同构 |

⚠️ **`tests/fixtures/` 目前不存在**（仓库只有 `tests/unit/` 与 `tests/integration/`），`package.json` 也只有 `test` / `test:unit` / `test:integration` 三个脚本。
⇒ 目录与脚本名都是**新建**，实现计划里要定，不要当成既有约定。

**纪律（不许绕过）**：**改强之前先跑一遍语料，把当前的漏报钉成基线**，否则说不出"改进了多少"。
这是 handoff Ⅴ"每个回归测试必须先被亲眼看着变红"在评测语料上的版本。

**语料的约束是覆盖面，不是条数**：至少覆盖审稿意见点名的五类绕过——双空格、同义改写（如 "disregard earlier guidance"）、中文、拆分写入、伪装成正常项目约定——外加一个良性对照集。
**每类具体几条由实现计划定**（本 spec 刻意不写死一个数，避免它变成一个没人复核过的魔数）。

### W4 — daemon 成本计量（最小可用版）

**落点**：`daemon/claude-p.mjs::runClaudeP`。

🔴 **JSON 路径是主路径，不是例外**（原稿把主次写反了，review 抓到，已复核）：
全仓 **7 个 `callClaudeP` 调用点**中，**6 个已经传 `jsonSchema`**，因而实际跑在 `--output-format json` 上：

```
summarize-pending.mjs:242 · weekly-synthesis.mjs:411/438/519
contradiction-audit.mjs:164 · monthly-meta-synthesis.mjs:65
```

**只有 `security-audit.mjs:257` 走纯文本路径。** 而那 6 个正是审稿意见点名的成本中心。
另：`lib/llm-parse.mjs:20` **已经在拆 `{type:'result'}` 信封** —— 承载 `usage` / `total_cost_usd` 的就是它，仓库已经认识这个形状。

⇒ **W4 的首要需求是解析 `usage` 与 `total_cost_usd`，不是防守 null。**
`null` 纪律降为次要规则：**text 路径诚实记 `null`，不估算**（仍要有测试钉住，下个人极可能把 `null` 当 `0`）。

⚠️ **判断"这次有没有 usage"不能只看 `opts.jsonSchema`**：`resolveCommand`（`claude-p.mjs:44-50`）的优先级是
`opts.args` → `CCMEM_CLAUDE_P_ARGS_JSON` → 文本默认值，**任何一个都能独立选中 JSON**。
⇒ **判据是最终生效的 args 数组，不是 `jsonSchema` 是否为空。**

**每次调用记一行**，字段与其边界：

| 字段 | 说明 |
|---|---|
| task 类型 | — |
| `wall_clock_ms` | 🔴 **必须说清量的是哪一段**。`callClaudeP` 经 `tail` promise 链串行化（`:185-187`），排队等待可以任意长。`runClaudeP` 内部计时只覆盖 spawn→close，**丢掉排队时间**，而"稳态周成本"恰恰需要它。⇒ **两个都记，或明确记哪个并写明另一个被丢掉。** |
| 退出码 | **超时路径（`:146-149`，SIGTERM 后 reject）与 `child.on('error')`（`:159`）都没有退出码** ⇒ 规定为 `null` |
| 是否超时 | — |
| `usage` / `total_cost_usd` | JSON 路径解析；text 路径 `null` |

**写入点**：`finish()`（`:136`）是三条出口的唯一漏斗，行应当在那里写。

⚠️ **`mockOutput` 早返回（`:180-182`）在 `runClaudeP` 之前**，而所有 task 测试都用 `mockOutput`
⇒ **§五要求的那条测试无法经标准路径写出来**，必须用真 spawn 打桩（可用的 seam 是 `CCMEM_CLAUDE_P_COMMAND` / `CCMEM_CLAUDE_P_ARGS_JSON`）。
**并且要明确规定：走 `mockOutput` 的调用不产生任何行。**

**为什么另开文件而不是扩 audit 行**：per-run 的次数与耗时已经在 audit 行里（见 §一 第 8 行的更正）。
另开文件是为了 **per-call 粒度 + 与 `metrics.jsonl` 解耦**（后者的理由见 §三）。
先例：`metrics.mjs:40::decisionDataFile`。**这个取舍要在实现计划里再确认一次**，因为扩 audit 行更便宜。

**聚合读数出口**：输出周周期内的**调用次数、耗时分布、token 用量、成本合计**（子命令挂哪、叫什么由实现计划定；
`diagnose` 已有多个子命令，倾向复用）。
🔴 **验收判据是"能答出 P1#5 的第 2、3 个数"**——即 token 与稳态周成本。只出次数与耗时**不算完成 W4**。

---

## 三、落地时机（跨工作流的硬约束）

~~当前有一个**预登记的测量窗口**在跑~~（起点 `2026-08-10 01:53:30`，`metrics.jsonl` 6496 行；判据见 `docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md` 与其补遗）。
🆕🔴 **2026-08-26 更正：窗口已关闭**，读数已完成。下表中"等窗口关闭"各行按此解读为条件已满足。

| 工作流 | 时机 | 理由 |
|---|---|---|
| **W4** | **可先行**，但见下面的义务 | 它写独立文件，与 `metrics.jsonl` 解耦。**这是设计选择带来的，不是预登记要求的** |
| **W0** | ~~等**窗口关闭**~~ 🆕🔴 **2026-08-26：窗口已关闭**，条件已满足 | 它新增测试、改 `diagnose` 输出 ⇒ 会改套件时序。**与 W1/W2 同等对待** |
| **W1 / W2** | 等**窗口关闭** | 只加默认关闭的开关，时序影响接近零，保守起见仍等 |
| **W3 扫描器改强** | 等**窗口关闭** | 它改写入行为、会改套件时序 |

🔴 **W4 先行的附带义务**：在本仓库里干活本身就会往 `metrics.jsonl` 追加 `prompt_submit` / `Stop` 行，
而预登记的分析口径明写"**剔除本机跑批窗口**，并在跑批发生时**当场记下起止时间**，不要事后回忆"。
⇒ **实现 W4 期间的每次跑批，起止时间必须当场记进 ledger。** 不记就等于污染了窗口而无法剔除。

**关于"能否提前读数"（已问答，结论记此备查）：**

- **不能靠降低 n 提前。** 预登记写死 `n ≥ 150 次真实 embed 尝试`；`n=150` 时若区间仍横跨 40.3% 还要延到 `n ≥ 300`。
  "先看一眼再决定要不要继续攒"正是预登记要挡的事。
- **但日期不是判据，n 才是。** `08-14/15` 只是按 ~36/天 的推算，实测更快。两次复核：

  | 复核时点 | 窗口已开 | n | 折算速率 |
  |---|---|---|---|
  | 2026-08-11 早 | 31.5 h | 62 | 47.3/天 |
  | 2026-08-11 晚（reviewer 复核） | 42.6 h | 72 | 40.5/天 |

  ⇒ **速率是个会动的估计，别把某一次的折算值当"实测常数"。** ~~两次都指向 **n=150 约在 08-13**。~~
  🆕🔴 **2026-08-25 更正：那个 ETA 早就过期了，别再照它排期。** 实测 **原始 `n` = 263**、
  **窗口已开 358.1 h**、已做 **8 次巡检**（记录见 `plans/2026-08-10-raise-openai-timeout.md` 末尾那张表）。
  ⚠️ **原始 `n` 越过 150/200/263 都不等于闸门开了** —— 闸门要**剔除后**的 `n`（补遗 3），
  而它**只有跑冻结脚本才算得出来，那一跑同时就是读数**（不可逆，人类没点头不许按）。
- 🔴 **ETA 指的是"第一次读数"，不是"窗口关闭"。** 若 `n=150` 时区间仍横跨 40.3%，预登记要求延到 `n ≥ 300`
  ⇒ **W1/W2/W3 的解封可能被显著推后。** 上面那张时机表的"等窗口关闭"要按这个理解，不要按 08-13 排期。
- **锚点稳健性**：分析改用 `ts >= 2026-08-10 01:53:30` 过滤，**不按行号**。
  两者选出同一批行（已核对：窗口前恰好 6496 行，窗口内首行 `01:54:50`；文件 `ts` 严格单调，reviewer 复核 0 处逆序）。
  **预登记的分析口径里从未规定过行选择器**，⇒ **这不是改判据**，但读数报告里必须写明，不得默默换。
  ⚠️ **别把 ts 过滤当成"对轮转免疫"**：轮转是 `renameSync` 到 `.1`（`metrics.mjs:21-22`），
  ts 过滤只会**静默少算**而不是算错。真正的护栏是预登记要求的**冻结快照** + 出现 `.1` 时一并读。
  当前 `metrics.jsonl` ~1.6 MB / 上限 8 MB（约 245 B/行、~112 行/天 ⇒ 余量以月计），眼下不危险。

---

## 四、明确不做的事

### 4.1 审稿意见 F1 全族 —— 不做

evidence tier 收敛、元叙事清除、补引 Mem0 / A-MEM / MemOS / ExpeL / AWM / AgentPoison / LoCoMo / LongMemEval、
Table 1 修正、记号与 lifecycle 枚举统一、hedging 密度、**P2#11（与平台内置 memory 的关系与可移植性）**、
**P2#12 的"§4 补 hook 延迟预算与超时失败语义"**。
**这些是刷 paper，不是改 ccmem。**

📌 但 P2#12 那条值得单独记一句：**它要的数据 v0.13 已经有了**（§一 第 7 行，`metrics-rollup.mjs` 已在算 p50/p95）
⇒ 对 paper 而言这是一条**几乎零成本的正向补充**，刷 paper 时不要漏。

### 4.2 F3 剩下的四条 —— 成立，但推到 v0.15

| 项 | 出处 | 为什么不在 v0.14 |
|---|---|---|
| `project_key` 完整性（`remote.origin.url` 由 repo 内容控制，改 origin 即可碰撞他人项目的记忆） | R3-M6 | 要动威胁模型本身 |
| 注入通道 TOCTOU（`.ccmem/context-<sid>.md` 明文，写入与模型读取之间可被任何本地进程改写；`renderRetrievedBlock` 无 provenance 标注） | R3-M4 | 同上 |
| trust 可操纵（`helpful_implicit` +0.025 可让被 demote 的记录爬回；`resurrect --quarantined`；quarantine 30 天 sunset / 14 天 hard delete 自动出池） | R3-M7 | 同上 |
| **多租户维度整体缺失**（单一 SQLite、无 ACL、无加密、`--global` 无条件注入） | R3-M6 同段 | 同上；且它是"声明单用户单机假设"就能大幅缓解的一类，属论文 P2#10 与产品的交叉 |

**四条都已在当前 `main` 上复核为仍然成立**。不做的理由是"与本轮目的不在一条线上"，**不是"已解决"或"不重要"**。

### 4.3 `inject.max_chars=4000` 对宿主注入预算一无所知 —— 记录，不做

审稿意见 R3-M9 点名。它是**产品侧**问题（ccmem 的注入与 Claude Code 自身的注入争同一份上下文预算）。
**v0.14 不做**：要做需要先能观测宿主注入量，而那取决于 harness 契约，属于 `docs/claude-code-behavior-uncertainties.md` 的范畴。
**记在这里，免得下个人以为漏了。**

### 4.4 v0.13 自己的 backlog —— 整体后移

L2.5 真修复（改 trust）、type 通胀治理、live DB 速率体检、benchmark corpus ≥100、出口参数调整、migration hash CI。

🔴 **必须点名一条**：**L2.5 真修复在 v0.13 spec §十 里标的是 P0**。把它排到"解 paper 的 block"之后，是**目的选择的后果，不是它降级了**。下一轮排 v0.15 时必须重新把它顶到前面。

⚠️ **W4 不覆盖 backlog #1。** 原稿写"顺手覆盖 live 速率体检的一半"是错的：
v0.13 spec 定义 backlog #1 为**数据库侧的速率不变量**（入口/出口比、trust 分化率、feedback 解决率），
而 W4 产出的是 daemon 调用次数与成本，**三个都不是**。该条仍完整地留在 v0.15。

### 4.5 评测执行与 paper 侧动作 —— 不在 ccmem 仓库做，但必须有归属

| 审稿项 | 归属 | 备注 |
|---|---|---|
| **P0#1 修正 quarantine 适用范围误述**（§5.4、§7 限定为 import 路径；Limitations 明写默认 save 路径的豁免是未缓解攻击面） | **paper 仓库** | 🔴 **与 W1 存在交互**：W1 落地后"仅 import 路径"变成**取决于一个配置开关**，paper 的措辞必须写成"默认配置下"，否则改完又是一次适用范围误述 |
| **P0#2 的"同一写入口"那一半** | **待裁决，倾向 paper 仓库的 harness** | ccmem 侧可能已经够用：`save.mjs:72` 有 `cfg.security.tier3.enabled` 门控，`C-NAIVE` 或许可以直接走 `insertMemory` 而不必 `direct_sql`。**实现计划前必须查清这一条，别让它没有主人。** |
| P0#3 交付 live-model、有重复 trial 的判别性三条件结果 | paper 仓库 | v0.14 只交付使之成为可能的能力（W1/W2 开关、W3 语料） |
| P1#6 `C-MANUAL`（手写 CLAUDE.md/rules）baseline | paper 仓库 | 审稿人指出本仓库自己就在用手写 CLAUDE.md，是最锋利的那条 |

---

## 五、错误处理与测试策略

### 5.1 错误处理

- **W1/W2 的配置层级**：`loadConfig()` **无缓存、每次读盘，`mergeConfig` 递归深合并**（Ⅳ.4）。
  ⇒ 改配置不需要重启 daemon，**但层级必须对**。Ⅲ.6 记过一次真栽：`latency_probe` 加在顶层而代码读 `cfg.embedding?.latency_probe`，**完全不生效且静默**。
  **判据是看同段其它键有没有回落到默认，不是看你关心的那个键。** 两个新开关都要有这个证据。
- **W4 绝不能让 daemon 任务失败**：记录失败吞掉并继续，与 v0.13 A1 探针"probe 失败不阻断 Stop hook 其余逻辑"同构。

### 5.2 测试

| 工作流 | 必须有的测试 |
|---|---|
| W0 | 🆕 已有：`tests/unit/v014-config-delta.test.mjs`（12 条，纯 diff 逻辑）与 `tests/integration/v014-diagnose-config.test.mjs`（10 条，接线到 `diagnose` 输出，含真 spawn CLI） |
| W1 | ① 不变量：默认 `quarantine_all_sources === false`；② 开关为真时 `user_explicit` 命中 TIER2 确实进隔离（**两个方向都要看着变红**）；③ 若裁决把两处 SQL 白名单纳入开关，则各自要有测试 |
| W2 | ① 不变量：默认 `disable_scope_isolation === false`；② **关掉后 `C-NAIVE` 与 `C-FULL` 真的能分开**，且**必须覆盖向量 lane**（`:430`）——这是本开关唯一的存在理由；③ `diagnose` 在非默认值时确实报出来 |
| W3 | 误伤回归进 CI 且必须能失败；bypass 报告不进 CI |
| W4 | ① 钉住"text 路径记 `null` 而不是 `0`"（**须用真 spawn 打桩，`mockOutput` 到不了 `runClaudeP`**）；② 钉住"`mockOutput` 调用不产生行"；③ 钉住 JSON 路径确实解析出 `usage` |

**通用纪律（handoff Ⅴ，全部适用）**：定向变异红，红在被测断言自己命名的行为上，且对照测试保持绿；"崩溃红"与"函数不存在"都不算数。

---

## 六、已知风险

1. **W3 改强扫描器会改变写入行为与误报率，而本仓库自己在 dogfood。**
   缓解：误伤回归集 + 落地时机避开测量窗口。**这是本轮范围里风险最高的一条。**
2. **W2 给产品加了一个能关掉安全机制的开关，本身是新的攻击面。**
   缓解：默认关闭 + 不变量测试钉死默认值 + `diagnose` 显式报出非默认状态（**该缓解已写进 §二 W2 的范围与 §五 的测试，不是只写在风险栏里**）。
   （R3 已指出 `project_key` 由 repo 内容控制；配置面值得同样怀疑 —— 但那条属 §4.2，v0.15 处理。）
3. ~~**W1 的开关语义未定**（写入时 vs 含审计面），见 §二 W1。未裁决就实现会得到一个名字与行为不符的开关。~~
   🆕✅ **已裁决（handoff ⅩⅢ.6 ②）**：W1 **不接线** `security.tier3.block_user_explicit` 那个死开关，
   改为**新增新键**并把死键删掉。设计与实现计划见
   `specs/2026-08-19-w1-quarantine-all-sources-design.md` 与 `plans/2026-08-19-w1-quarantine-all-sources.md`。
4. **W4 可能做成一个答不出 P1#5 的版本** —— 若只记次数与耗时、不解析 `usage`。见 §二 W4 的验收判据。

---

## 七、下一步

> 🆕✅ **2026-08-25：下面这三条已全部完成。** 四条工作流（外加 W0，共五条）的设计已齐：
> W1（08-19）、W0（08-20）、W2（08-20/21）、**W3（08-25，补做）**；
> W0/W1/W2 的实现计划已落盘，**W3 的实现计划随后**。W4 已实现并合进 `main`。
> 🔴 **三个未决点的现状**：**W1 的开关语义已裁**（§六 风险 3）；**W2 的站点覆盖面已在 W2 设计里答**；
> **P0#2「同一写入口」的归属仍未见裁决记录** —— 下一位接手时先确认它有没有主人（§四 4.5）。

1. ~~本文档提交（**不 push**）。~~ ✅
2. ~~人类复审。~~ ✅
3. ~~复审通过后走 `superpowers:writing-plans` 出实现计划。~~ ✅（W3 的那份在写）
   四条工作流无共享状态且解封时机不同，**大概率要拆成四份独立计划**，不要合成一份。
   计划里必须先回答三个未决点：**W1 的开关语义**、**W2 的站点覆盖面（含 session-start / injection-cache）**、
   **P0#2"同一写入口"的归属**。
   ~~⚠️ **落地时机受 §三 约束**：W4 可先行（带记录跑批窗口的义务）；W1/W2/W3 等测量窗口关闭，
   而"关闭"可能因预登记的 `n ≥ 300` 延长条款而晚于 08-13。~~
   🆕🔴 **2026-08-26 更正**：测量窗口**已关闭**，读数已完成；预登记的 `n ≥ 300` 延长条款**未触发**（不适用），
   "可能晚于 08-13"的推测已作废。W4 可先行、带记录跑批窗口的义务，这条不变。
