# ccmem v0.13 — Handoff

> v0.13 **已发布并合并**，其后完成了 **第一轮 dogfood**（2026-08-01）。
> 本文档面向接手 **v0.13 dogfood 收尾** 或 **v0.14** 的 agent。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料里。

## 先读这些，按顺序

| 材料 | 是什么 | 为什么需要 |
|---|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **第一轮 dogfood 的计划与记录** | **最重要，先读。** 9 条 finding（含根因、证据、修复方案、取舍）、V1–V8 验证清单、真实基线数据、两个门禁。接手工作的全部上下文在这里。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger | 每一条人类裁决及其理由、全部延期项、7 次「计划本身有缺陷」的记录。git 历史一条都不记。**dogfood Finding 9 正是两条被判 minor 的延期项合成的 P0** —— 这份 ledger 是判断"某个 minor 会不会咬人"的唯一依据。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 最终 review findings | 末尾「NOT in this wave」清单 = v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` | v0.13 规范 | §0.4、§0.5 承重。**附录 A 不变量（120–135）尚未涵盖 dogfood 的三个修复** —— 见下方未竟事项。 |

## Git 状态

**不要相信本文档里出现的任何 commit SHA** —— 提交这份文档本身就会移动 HEAD。用 `git log --oneline` 确认真实位置。

需要知道的事实，而非 SHA：

- v0.13 本体与 **dogfood 修复（4 个提交）** 均已 fast-forward 合并进本地 `main`，两次都在合并结果上重跑过完整套件。
- 本地 `main` **领先 `origin/main`，尚未推送**。人类自己处理所有 push —— 不要代为推送。
- 分支 `v0.13-spec`、`v0.13-dogfood-fixes` **均未删除**（全局规则：删分支必须先问）。
- 交接时工作区干净。

## ⚠ 第一优先级：Finding 9（P0，未修复）

**语义检索目前静默退化为纯词法**，无任何报错。三个签名互不相同：

| 来源 | 签名 |
|---|---|
| 库里 4223 行实际写入的 | `transformers-local:Xenova/all-MiniLM-L6-v2:384` |
| CLI `semantic status` 比对用的 | `local:Xenova/all-MiniLM-L6-v2:0` |
| 操作者选择的 | `openai:text-embedding-3-small:1536` |

根因、修复方向、以及**一个未解开的疑点**（daemon 在 `semantic on` 报告 `provider=openai` 后仍以本地 provider 写入）全部记在 dogfood 文档 Finding 9。不要在此处重复推导。

三条纪律，照做：

1. **不要重跑 `semantic on` 或重启 daemon 来"试试看"** —— 签名函数没修之前，重嵌多少次结果都一样。当前状态稳定。
2. **不要信任 `tests/unit/v013-embedding-sig.test.mjs`** —— ledger 已记：它 5 个测试里有 4 个走的是生产永不到达的 config-only 回退分支。
3. **Finding 4（`openai_timeout_ms: 800`）至今未被真实检验** —— 因为 OpenAI provider 实际从未跑起来过。修好 Finding 9 之后它才第一次成为真问题。

## 本轮 dogfood 的结果摘要

修复并合入（详见 dogfood 文档 Finding 6/7/8 与对应提交信息）：
- **Finding 6**：`admin semantic on` 的 config_kv 副作用永久遮蔽配置文件
- **Finding 7**：`openai` 包从未被声明为依赖；两个 provider 的动态 import 现在给出可操作错误
- **Finding 8**：测试套件未隔离 `CCMEM_CONFIG_PATH`，用户配置会污染测试结果

已记录未修：**Finding 9**（P0）、**Finding 5**（`loadConfig()` 的 `JSON.parse` 无 try/catch，配置文件是全 hook 单点故障）。

已验证通过：**V3 在本地 provider 上达成** —— `pending` 4155→0，零手工干预，`vec_backfill_run` 审计 136 次对 2 次 daemon 重启。这是 review I3「回填后自动重排队」修复在真实库上的首次确认。

当前套件：**454 pass / 0 fail**。新增 5 个测试，**全部先被亲眼看着变红**。

## ⚠ 未竟事项（人类要求过，本轮未完成）

**spec / 附录 A 不变量未更新。** Finding 6/7/8 三个修复都没有对应不变量。上一轮因上下文耗尽主动停手，理由是：在截断状态下改不变量编号区间，极可能产出又一条永远不可能失败的空不变量（final review 的 I9 就是两条这样的）。

候选（**两条都必须先验证 grep 在破坏代码时真能返回失败**，否则就是重蹈 I9）：
- grep `semantic.mjs`，确保 `active_provider` 不再被无条件 `setConfigValue`
- grep `scripts/lib/embedding/`，确保动态 import 全部走 `importOptional`

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易被误伤的：

1. **探针读 `recent_injections`，绝不读 `memory_feedback`**（后者 `outcome` 会被先于探针运行的反馈逻辑就地改写）。由不变量 #130/#131 守护。
2. **探针只标注，不抑制**；`control` 是**权威队列字段** —— `random` 才是噪声底，`stale_injection` 不是，`turn_aligned` 仅为兼容旧行保留。
3. `metrics.decision_data.enabled` 控制**持久性而非存在性**（false 时回落 `metrics.jsonl`，绝不丢弃）。
4. `retention_days: 0` = **永不自动删除**（刻意与运行时清理语义相反）。
5. 清理逻辑放 `tier15.mjs` 而非 `daily-maintenance.mjs`（daemon 是可选的）。
6. **`config.mjs` 的 `DEFAULT_CONFIG` 是权威配置源**，`config.default.json` 是测试保持同步的镜像，`loadConfig()` 从不读它。新增配置键**两边都要加**（递归全深度比较）。
7. `diagnose --feedback` 不跑 tier-1.5 前奏。
8. `env_failure` 长度门限按脚本分档（含 CJK 50，其余 120）。

dogfood 期新增一条：
9. **`semantic on` 不带 `--provider` 时删除 kv 覆盖而非跳过** —— 已中招的用户跑一次裸命令即可自愈，不新增 `semantic reset`。已知取舍（显式 `--provider X` 会被后续裸命令清掉）经人类裁决可接受。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」清单是权威版本。另需并入：

- dogfood **Finding 5、9**
- `@xenova/transformers` **已停止维护**，1.x 与 2.x 均带 critical 通告（1.x 是 canvas→node-pre-gyp→tar 任意文件写入链；2.x 是 onnxruntime-web→protobufjs + sharp）。`npm audit fix --force` 的"修复"是降级回 1.4.2，即换一组漏洞。真解是迁移到 `@huggingface/transformers`；权宜之计是转 OpenAI 后 `npm install --omit=optional`（这些全是 optional 依赖）。
- 两个 daemon 测试抖动（`stop-daemon-flow`、`admin-daemon-command`）合并为一个 issue，不阻塞。

## v0.14 的核心问题仍未改变

`l25_cov` **是否存在任何可行阈值**。dogfood 期间新增一条关键情报：

上一版 handoff 记录的「随机对照 p50 0.125 > 信号 0.103」**已随样本增长翻转**（随机组 n 从 ~9 到 21 后降至 0.075）。**正确结论不是"有信号了"，而是分位数对比这个方法本身不可靠** —— 判据必须是分布级的（AUC / Mann-Whitney U）。且 `l25_legacy_hit` 恒为 0，**无任何正例标签**，仍需人工标注约 50 个样本才能算 precision/recall。详见 dogfood 文档 Finding 2 与 V2。

## 这套流程为什么值得继续用

v0.13 八个任务里五个需要 fix round，失败形态高度一致：**代码能跑、测试全绿、缺陷只表现为悄悄错掉的数据**。**dogfood 又贡献了两次**：`negative_assertion` 计数为 0 看起来像规则坏了、实为 daemon 比代码早 13.4 小时；Finding 9 的三个签名分歧全程无任何报错。

两条实践几乎抓住了全部：

- **每轮 fix 之后做 scoped re-review** —— 只针对修复 diff 逐条判定 ADDRESSED / NOT ADDRESSED。
- **每个回归测试都必须先被亲眼看着变红才接受。** 破坏 → 确认红 → 还原 → 记录证据。dogfood 期新增的 5 个测试全部照此办理，其中两个"防过度修正的对照"在代码注释里被明确标注为修复前后皆绿，作用是抓错误实现而非证明正确实现。

**不要把"测试通过"当成"测试能失败"的证据；也不要把 0 计数当结论 —— 先解释它的来源。**

## 建议使用的 skills

- **`superpowers:systematic-debugging`** —— Finding 9 是典型的"证据充分但机制未明"，先定位 daemon 为何解析到本地 provider，再改代码。
- **`superpowers:test-driven-development`** —— 本项目的硬性纪律就是红-绿，与该 skill 一致。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。
- **`superpowers:writing-plans`** —— 定下方向之后。v0.13 的计划本身有 4 处缺陷，**新计划里的测试代码要当作草稿而非圣经**。
- **`superpowers:subagent-driven-development`** —— 有计划之后的执行工作流。ledger 中带 `Task N: complete` 的不要重派。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`、`.wolf/anatomy.md`）已 gitignore。**bug-052（L2.5 匹配器）按设计保持 open** —— v0.13 只做插桩，真修复属 v0.14 且依赖本版收集的数据。
- SDD workspace **刻意保留**：它承载全部人类裁决及理由、final review findings、8 份任务报告，git 历史一条都不记录。
- 探针决策流 `l25-probe.jsonl` 无上限设计（`retention_days: 0`），单行约 1.3 KB。`diagnose --feedback` 打印其磁盘占用 —— 刻意让运行时成本可见，**不要"优化"掉**。
- ccmem **没有默认配置文件路径**：`loadConfig()` 仅在 `CCMEM_CONFIG_PATH` 指向存在文件时读盘，否则直接用 `DEFAULT_CONFIG`。当前环境已设置该变量（方案 A），因此 Finding 5 那条未经检验的路径**已在真实运行中**。
- 本次运行的所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件，从未进入仓库或本文档。
