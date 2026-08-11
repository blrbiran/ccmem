# v0.14 范围设计（scope design）

- **日期**：2026-08-11
- **状态**：设计已与人类逐节确认；**尚未落任何代码**
- **本文档回答的问题**：v0.14 做什么、不做什么、为什么
- **本文档不回答**：怎么做（实现计划另开，见文末"下一步"）

---

## 〇、这份 spec 的由来与目的

上一轮（2026-08-10）读了 `../ccmem_paper` 的 paper 初稿与模拟同行评审，**目的是定 v0.14 的范围，不是修 paper**（人类裁决，见 handoff Ⅺ.15）。

**人类已裁决的两条边界，本文档全程遵守：**

1. `ccmem_paper/reference/ccmem` 停在 v0.12 快照是**有意为之**，本轮不同步、不追"paper agent 读哪一份"。
   计划顺序是：先落地 v0.13/v0.14 的针对性优化 → 再刷新快照 → 再重启 paper 工作。
2. **v0.14 的首要目的是"解 paper 的 block"**，因此范围由审稿意见的 P0 切，不由 v0.13 自己的产品 backlog 切。

---

## 一、逐条判定：审稿意见相对 v0.13 的状态

**判定方法**：对当前 `main`（= v0.13）做只读 grep 复核，**不从 v0.12 快照或文档推断**。执行日期 2026-08-10/11。

| # | 审稿指控 | 快照（v0.12）记录 | 当前 `main`（v0.13）实测 | 判定 |
|---|---|---|---|---|
| 1 | quarantine 只对 `source=external` 生效；默认 `save` 走 `user_explicit` 豁免 | `save.mjs:167-179` | `save.mjs:186` 仍硬编码 `source: 'user_explicit'`；`threat-scan.mjs::evaluateTier3` 仍对 `user_explicit` / `cron_consolidated` 提前返回 `force_demote` | **仍成立** |
| 2 | `external` 全库唯一写入路径是 import | `import.mjs:43` | 仍是唯一站点 | **仍成立** |
| 3 | threat-scan 纯正则、101 行、6 条英文 TIER2 | 101 行 | **仍是 101 行、同 6 条正则**，`ignore (all\|the )?(previous\|prior) instructions` 一字未改 | **仍成立** |
| 4 | scope 过滤是硬编码 SQL，config 关不掉 | `retrieval.mjs:130/149/169/438` | `:131 / :150 / :170 / :430`，**行号漂了、代码未变** | **仍成立** |
| 5 | `project_key` 取自 `git config remote.origin.url`（repo 内可写） | `project-key.mjs:20` | `resolveProjectKey` 仍是同一实现 | **仍成立** |
| 6 | trust 可被 `helpful_implicit` 爬回 | — | `trust.mjs:43` 仍在 | **仍成立** |
| 7 | **hook 触点 p50/p95 延迟无数据**（P1#5 第 1 个数） | 无 | 🆕 `hook-safety.mjs:83` 每个 hook 写 `ms_total`；`metrics-rollup.mjs:48-52` 已按 hook 分桶 | **已被 v0.13 解决**（数据源就位） |
| 8 | **daemon 周期 model call 次数 / token / 稳态周成本**（P1#5 第 2、3 个数） | 无 | `daemon/claude-p.mjs` **零处**捕获 usage / token / 耗时 | **仍成立，完全空白** |

### 1.1 一条比逐条判定更重要的结构性发现

审稿意见里**只有一小部分**指向产品代码。分三族：

- **F1 论文写作与定位**：evidence tier 话术、元叙事泄漏、记号不一致、补引 8 篇文献、Table 1 strawman、hedging 密度。
  ⇒ **完全不驱动 v0.14 代码**，是人类刷 paper 时的事。
- **F2 评测协议**：`C-NAIVE` 不是真 control、`S-SCOPE-03` 结构性不可判别、`S-POISON-01` 自证式、repeated trials 只有一个 trio 做到、judge 只 grep 词法锚点。
  ⇒ 它对 ccmem 提出的**唯一代码需求**是"同一写入口 + lifecycle 控制可开关"，其余是重跑评测（paper 侧执行）。
- **F3 产品与机制真缺陷**：quarantine 豁免区、6 条正则可零成本绕过、`project_key` 完整性、trust 可操纵、注入通道 TOCTOU、成本不可计量、缺 `C-MANUAL` baseline。
  ⇒ **这才是 v0.14 的真候选池。**

### 1.2 另一条与审稿意见几乎不相交的候选清单

v0.13 spec §1.2 与 §十 backlog 已点名了自己的 v0.14 项：L2.5 真修复（改 trust，**标注 P0**，依赖 A1 探针数据）、type 通胀治理（71% `auto_inferred` 被标 `rule`）、live DB 速率体检命令、benchmark corpus ≥100、出口参数调整、migration hash CI 检查。

⇒ **v0.14 面对两条互不相交的清单**，范围问题的实质是二者怎么排。人类裁决：**按"解 paper 的 block"排**，产品路线图那条整体后移（见 §四）。

---

## 二、范围：四条互相独立的工作流

四条之间没有共享状态，可任意顺序甚至并行实现。

### W1 — quarantine 覆盖面开关（**产品特性**）

- 新增 `security.quarantine_all_sources`，**默认 `false`（行为零变化）**。
- 唯一改动点：`threat-scan.mjs::evaluateTier3` 中对 `user_explicit` / `cron_consolidated` 的提前返回。开关为真时不再豁免。
- **接口保持纯函数**：判定所需的开关由调用方传入，不在 `evaluateTier3` 内部 `loadConfig()`。
- **默认 `false` 的理由是产品理由，不是评测理由**：6 条英文正则的误报会直接吞掉用户手写的记忆，而本仓库自己在 dogfood。

### W2 — scope 隔离降级开关（**评测专用**）

- 新增 `eval.disable_scope_isolation`，**默认 `false`（行为零变化）**。
- 目标：让 `C-NAIVE` 成为真控制组，解开 `S-SCOPE-03` 的结构性不可判别。
- **四处站点分属不同 lane，必须逐处判定，不许四处一起盲改：**

  | 站点 | 所在 lane |
  |---|---|
  | `retrieval.mjs:131` | `ftsSearch`（FTS 路） |
  | `retrieval.mjs:150` | `LOWER(content) LIKE` 回落路 |
  | `retrieval.mjs:170` | recency 候选路 |
  | `retrieval.mjs:430` | 向量候选路 |

- ⚠️ **已知未决点**：`:430` 那处的注释显式说明它的 `status` / `decay_status` 谓词是**刻意与 `vec_backfill` 的候选查询逐字对齐**的，因此它可能同时服务 `diagnose` 的 stale 向量计数。
  **实现前必须确认该站点是否属于检索路径**；若它同时服务 diagnose，则开关不得改动它，否则会污染一个与本线无关的诊断口径。

### W3 — threat-scan bypass suite + 扫描器改强

审稿人 P0#4 只要求**测量**（他自己标注"离线可跑、零模型成本、说服力增益最大"）。人类裁决**测量 + 改强**。

拆成两半，**两半的 CI 地位不同**：

| 半 | 位置 | 进 CI 断言？ |
|---|---|---|
| 语料 + 报告脚本 | `tests/fixtures/threat-payloads/`（语义等价 payload + 良性对照集）+ `npm run threat-bypass-report` 产出 detection rate / FP rate | **否**。改强后检出率会变，做成门就是一道永远在动的断言 |
| 误伤回归 | 良性对照集中"必须不被拦"的部分 | **是**。改强最可能弄坏的就是它，与 v0.13 A2 §5.2.2 那张误伤表同构 |

**纪律（不许绕过）**：**改强之前先跑一遍语料，把当前的漏报钉成基线**，否则说不出"改进了多少"。
这是 handoff Ⅴ"每个回归测试必须先被亲眼看着变红"在评测语料上的版本。

**语料的约束是覆盖面，不是条数**：至少覆盖审稿意见点名的五类绕过——双空格、同义改写（如 "disregard earlier guidance"）、中文、拆分写入、伪装成正常项目约定——外加一个良性对照集。
**每类具体几条由实现计划定**（本 spec 刻意不写死一个数，避免它变成一个没人复核过的魔数）。

### W4 — daemon 成本计量（最小可用版）

- 落点：`daemon/claude-p.mjs::runClaudeP`（现在 spawn 完只回 stdout，不记任何东西）。
- 每次调用记一行：task 类型、`wall_clock_ms`、退出码、是否超时。
- 🔴 **token 只在 JSON 路径拿得到**：默认 args 是 `['-p','--output-format','text']`，纯文本没有 usage 信封；只有传了 `jsonSchema` 才切到 `--output-format json`。
  ⇒ **text 路径诚实记 `null`，不估算。这条必须有测试钉住**——下一个人极可能把 `null` 当成 `0`。
- 🔴 **写独立文件，不写 `metrics.jsonl`**（理由见 §三）。仓库已有先例：`metrics.mjs::decisionDataFile` 就是另一个文件。
- 再加一个聚合读数出口，输出"周周期内的调用次数与耗时分布"（**子命令挂在哪、叫什么，由实现计划定**——现有 `diagnose` 已有多个子命令，倾向复用而非新建顶层命令）。
  它填上论文 overhead 轴的空白，也顺手覆盖 v0.13 backlog #1（live 速率体检）的一半。

---

## 三、落地时机（跨工作流的硬约束）

当前有一个**预登记的测量窗口**在跑（起点 `2026-08-10 01:53:30`，`metrics.jsonl` 6496 行；判据见 `2026-08-10-raise-openai-timeout-prereg.md` 与其补遗）。

| 工作流 | 时机 | 理由 |
|---|---|---|
| **W4** | **可随时做** | 因为它写独立文件、与 `metrics.jsonl` 解耦。**这是设计选择带来的，不是预登记要求的** |
| **W1 / W2** | 等**窗口关闭**（不是等读数） | 只加默认关闭的开关，时序影响接近零，保守起见仍等 |
| **W3 扫描器改强** | 等**窗口关闭** | 它改写入行为、会改套件时序 |

**关于"能否提前读数"（已问答，结论记此备查）：**

- **不能靠降低 n 提前。** 预登记写死 `n ≥ 150 次真实 embed 尝试`；`n=150` 时若区间仍横跨 40.3% 还要延到 `n ≥ 300`。
  "先看一眼再决定要不要继续攒"正是预登记要挡的事。
- **但日期不是判据，n 才是。** `08-14/15` 只是按 ~36/天 的推算，实测更快：
  2026-08-11 复核时窗口已开 31.5 小时、`n = 62`、**实测 47.3/天** ⇒ **ETA 约 08-13**，不动任何判据就自己提前了 1–2 天。
- **锚点稳健性**：分析改用 `ts >= 2026-08-10 01:53:30` 过滤，**不按行号**（行号对轮转不免疫）。
  两者选出同一批行（已核对：窗口内首行 `01:54:50`）。**这不是改判据，是换等价且更稳的选择器，读数报告里必须写明，不得默默换。**
  当前 `metrics.jsonl` 1.59 MB / 上限 8 MB、无 `.1`，锚点眼下不危险。

---

## 四、明确不做的事

### 4.1 审稿意见 F1 全族 —— 不做

evidence tier 收敛、元叙事清除、补引 Mem0 / A-MEM / MemOS / ExpeL / AWM / AgentPoison / LoCoMo / LongMemEval、Table 1 修正、记号与 lifecycle 枚举统一、hedging 密度。
**这些是刷 paper，不是改 ccmem。**

### 4.2 F3 剩下的三条 —— 成立，但推到 v0.15

| 项 | 出处 | 为什么不在 v0.14 |
|---|---|---|
| `project_key` 完整性（`remote.origin.url` 由 repo 内容控制，改 origin 即可碰撞他人项目的记忆） | R3-M6 | 要动威胁模型本身 |
| 注入通道 TOCTOU（`.ccmem/context-<sid>.md` 明文，写入与模型读取之间可被任何本地进程改写；`renderRetrievedBlock` 无 provenance 标注） | R3-M4 | 同上 |
| trust 可操纵（`helpful_implicit` +0.025 可让被 demote 的记录爬回；`resurrect --quarantined`；quarantine 30 天 sunset / 14 天 hard delete 自动出池） | R3-M7 | 同上 |

**三条都已在当前 `main` 上复核为仍然成立**（见 §一）。不做的理由是"与本轮目的不在一条线上"，**不是"已解决"或"不重要"**。

### 4.3 v0.13 自己的 backlog —— 整体后移

L2.5 真修复（改 trust）、type 通胀治理、live DB 速率体检、benchmark corpus ≥100、出口参数调整、migration hash CI。

🔴 **必须点名一条**：**L2.5 真修复在 v0.13 spec §十 里标的是 P0**。把它排到"解 paper 的 block"之后，是**目的选择的后果，不是它降级了**。下一轮排 v0.15 时必须重新把它顶到前面。

### 4.4 评测执行本身 —— 不在 ccmem 仓库做

审稿人 P0#3（交付至少一组 live-model、有重复 trial 的判别性三条件结果）与 P1#6（`C-MANUAL` baseline）**在 paper 仓库执行**。
v0.14 交付的是**使之成为可能的代码能力**（W1/W2 的开关、W3 的语料），不包括跑 eval。

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
| W1 | 不变量：默认 `quarantine_all_sources === false`；开关为真时 `user_explicit` 命中 TIER2 确实进隔离（**两个方向都要看着变红**） |
| W2 | 不变量：默认 `disable_scope_isolation === false`；**关掉后 `C-NAIVE` 与 `C-FULL` 真的能分开**（这是 `S-SCOPE-03` 结构性不可判别的解药，也是本开关唯一的存在理由） |
| W3 | 误伤回归进 CI 且必须能失败；bypass 报告不进 CI |
| W4 | 钉住"text 路径记 `null` 而不是 `0`" |

**通用纪律（handoff Ⅴ，全部适用）**：定向变异红，红在被测断言自己命名的行为上，且对照测试保持绿；"崩溃红"与"函数不存在"都不算数。

---

## 六、已知风险

1. **W3 改强扫描器会改变写入行为与误报率，而本仓库自己在 dogfood。**
   缓解：误伤回归集 + 落地时机避开测量窗口。**这是本轮范围里风险最高的一条。**
2. **W2 给产品加了一个能关掉安全机制的开关，本身是新的攻击面。**
   缓解：默认关闭 + 不变量测试钉死默认值 + `diagnose` 必须显式报出它处于非默认状态。
   （R3 已指出 `project_key` 由 repo 内容控制；配置面值得同样怀疑 —— 但那条属 §4.2，v0.15 处理。）
3. **W2 的 `:430` 站点归属未定**（见 §二 W2）。实现前必须查清，否则会污染 diagnose 的 stale 计数。

---

## 七、下一步

1. 本文档提交（**不 push**）。
2. 等人类复审。
3. 复审通过后走 `superpowers:writing-plans` 出实现计划。
   ⚠️ **计划落地的时机受 §三 约束**：W4 可先行；W1/W2/W3 等测量窗口关闭。
