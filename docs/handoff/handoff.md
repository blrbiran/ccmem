# ccmem v0.13 — Handoff

> v0.13 已发布并合并。此后完成 **第一轮 dogfood**，2026-08-01 → 08-02 共六波修复/取证：
> Finding 9/4 → Finding 12（配置回落）→ Finding 13（hook 超时）→ Finding 14（熔断阈值失效）
> → 文档回填收口 + Finding 15 取证 → **本轮：Finding 10/11 成条 + 附录 A 不变量 + Finding 5 修复**。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料与提交信息里。

## 先读这些，按顺序

| 材料 | 为什么需要 |
|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **最重要，先读。** 15 条 finding（**1–15 现已全部有独立条目**）、V1–V8 验证清单、门禁、§六纪律。 |
| `git log`（近 ~25 个提交） | **每条修复的完整根因、证据、取舍都在提交信息里**，本文档刻意不重复。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger —— 每条人类裁决及理由、全部延期项。git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 末尾「NOT in this wave」= v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` 附录 A | 不变量现为 **120–142（23 行）**。136–142 覆盖 Finding 6/7/8/12/13/14/5，**每条都验过红**。 |

## Git 状态

**本文档不写 commit SHA，也不写"领先几个提交"** —— 提交这份文档本身就会改变这些数字。自己数：

```bash
git log --oneline -25
git rev-list --count origin/main..main    # 本地领先多少
git status --porcelain                    # 应为空
```

**本轮落在 `main` 上的提交，按标题找、不要按 SHA 找**（时间顺序）：

- `docs(dogfood): give Findings 10 and 11 their own entries`
- `chore(cerebrum): a retraction must void the original wording too`
- `docs(handoff): mark the Finding 10/11 write-up done`
- `docs(spec): add Appendix A invariants for the dogfood fixes`
- `docs(handoff): close out the last three items`
- `docs(spec): fix the off-by-one invariant citations`
- `docs(handoff): brief the Finding 5 round before it starts`
- `docs(dogfood): measure what a broken config actually does, and retract my own claim`
- `fix(config): reject a broken config file by name instead of by stack trace`

需要知道的事实：

- 本地 `main` **领先 `origin/main`**（人类在本轮中途推过一次，之后又有新提交）。
  **人类自己处理所有 push —— 不要代为推送。**
- 分支 `v0.13-spec`、`v0.13-dogfood-fixes` 均未删除（**删分支必须先问**）。
- 套件 **2026-08-02 实测 480 pass / 0 fail**（`npm test`，exit 0，本轮两次全跑均无抖动）。
  已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；不阻塞，但**红了要先确认是它**。
- 附录 A **23/23**（22 行机械判定共 25 个子检查 + #127 人判）。**附录 A 没有 runner，是人工 checklist** ——
  这正是"恒绿的不变量看起来和通过的一模一样"的由来。

## ⚠️ 会咬人的既定事实

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。
   只 unset 配置路径**不构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **默认目录以后迁走只需改 `scripts/lib/paths.mjs` 一处** —— 配置路径已跟着 `getDataRoot()` 走。
   **不要再在别处解析数据根。**
3. **`ps eww` 在这台机器上读不到进程环境。** 可靠替身：`zsh -f -c 'echo $VAR'` 验继承 /
   进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
4. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）；
   **只有 daemon 需要 `uninstall && install`** —— 见 Finding 10，`restart` 不重新生成 plist。
5. **「取副本前后比对 mtime/size 证明零写入」这条判据是坏的，已作废。**
   正确判据是连接开在 `mode=ro`（VFS 层阻断写）**加一个正面对照**。已记入 `.wolf/cerebrum.md`。
6. **🆕 坏配置现在会让 daemon 拒绝启动**（`ConfigError`，`fix(config): ...` 那个提交）。
   这是刻意的：回落 `DEFAULT_CONFIG` 会让它用 `transformers-local` 去查一库 openai 向量 ⇒ 静默重造 Finding 12。
   **hook 不受影响**，`withHookSafety` 早就正确降级了。

## 已完成（不要重做）

| 项 | 状态 |
|---|---|
| **G1**：OpenAI 回填 + 消费端 | ✅ 达成，口径收窄为"链路可用"，不是"链路始终在用" |
| **V1–V8** | ✅ 全部做完，§五 全部有实测条目 |
| **Finding 5 / 11 / 12 / 13 / 14** | ✅ 均已修复并有回归测试 |
| **Finding 1–15 条目完整性** | ✅ 15 条全部有独立条目（本轮补齐 10 与 11） |
| **附录 A 不变量** | ✅ 136–142 七条，覆盖 Finding 6/7/8/12/13/14/5，**每条验红** |
| **spec 内不变量引用** | ✅ 六处 off-by-one 已修（`#121`→`#122` 等，详见对应提交） |
| **Closure checklist** | ✅ 5 项全勾 |

**本轮最该记住的三条**：

- **Finding 5 的范围被实测整个改掉了。** 标题写的是"全 hook 单点故障"，我落笔前的 brief 也照抄了。
  实测：**三个 hook 全部 exit 0 并正确降级**，真正会死的是 **daemon**（且死在锁已拿到之后，
  launchd 每次重启白 churn 一次锁行）。**照原方案动手会修错地方。**
- **同一轮撞出一条从没被记过的**：`config.json` 是**合法 JSON 但形状不对**（如顶层是字符串）时，
  **静默等同于没有配置**，无任何报错 —— 今天就成立，不需要任何"修复"来触发。已随 Finding 5 一并修掉。
- **spec 里六处不变量引用系统性 off-by-one**，每一处引用的都是**真实存在但讲别的事**的不变量
  （`#121` 是 config drift 测试，不是 trust）。**这种错比引用不存在的编号更难发现**，因为看起来已核对过。

## 还欠什么

**v0.13 这条线上没有已知欠项。** 剩下全部属于 v0.14，见下方两节。

## 当前运行时状态（会漂移，用命令核对）

```bash
ccmem admin semantic status          # provider / embedded / pending
ccmem admin diagnose --retrieval     # stale vectors / Circuit
ccmem admin diagnose --feedback      # 探针队列 / l25-probe.jsonl 磁盘占用
tail ~/.claude/ccmem/daemon.err.log
```

上一轮在 live 库只读副本上量到的（**会漂移，只作量级参考**）：

- 签名分布：`openai:text-embedding-3-small:1536` **4696** / 无签名 468 / `transformers-local:...:384` **2**。
- **468 条无向量里 467 条在回填 population 之外**，真正 pending 的**只有 1 条**。
  **看到大数先算 population，别当积压。**
- `vec_backfill` 三个入队点：daemon 启动、链式续排、`daily_maintenance` 每天直接调一次
  （`vec-backfill.mjs:27` 的注释仍写「on no recurring schedule」，与直调不符 —— 陈述性小瑕疵，未改）。
- daemon 由 **launchd 托管**，plist 已重装并携带 `CCMEM_CONFIG_PATH`。
- embedding provider = **openai / text-embedding-3-small / 1536**；配置在 `~/.claude/ccmem/config.json`
  （仓库外，含 API key，**从未进入仓库或本文档**）。
- 探针：`l25-probe.jsonl` 约 2.6 MB / 1666 行（`retention_days: 0`，永不自动删）。

## 硬性纪律（每一条都是真栽过的）

- **每个回归测试必须先被亲眼看着变红，且红得对。** 已栽三次（表名写错 / dedup 探针挑错记忆 /
  stdout 桩没回调 `resolve` 挂死 await）。**不变量也一样**：附录 A 无 runner，
  加条目前必须镜像文件、单独回退对应修复、看它变红。
- **纯函数有测试 ≠ 接线有测试。** 回填超时的第一版提交实际什么都没改变。
  Finding 5 的三条回归测试因此全部打在**进程边界**（退出码 + stderr）。
- **🆕 读码推出来的影响面必须实测复核。** Finding 5 被读码推断误判了**两次**（原始 finding 一次、
  我的 brief 一次），两次都是"每个 hook 都会死"，两次都是错的。
- **🆕 撤回一个说法时，要去原话所在的位置作废它**，不能只在发现问题的那一条里记。
  `ps eww` 的更正记在 Finding 12，而 Finding 9 里"这条验证不可省"整整一波没被收掉。
- **0 计数 / 不动的数字，先解释来源再当结论。已出现七种来源**：分母为 0、进程比代码旧、
  链条死掉、幸存者偏差、**查错字段名**（`hook`≠`event`；`has_cjk`≠`is_cjk`）、
  签名为 null 让 SQL 谓词恒不成立、**分母只有 1**。
- **反面的"什么都没发生"需要正面对照才可信。** 本轮两次用到：
  grep 返回 0 时先证明同一条命令对另一个 pattern 返回 1；"非对象配置应失败"的测试自带
  "无配置文件仍应成功"的对照。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`），
  **但不要用 mtime/size 比对"证明"零写入**。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除** —— 签名机制已正确覆盖换模型。
3. **签名契约返回 `null`**，不是抛错。正是这个 `null` 让 V5 的分歧表现为静默的 0。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
5. **provider API key 不进 daemon 环境白名单** —— plist 的环境字典会明文落到 `~/Library/LaunchAgents`。
   （注意措辞：真正写盘的是 `installDaemon()`；`renderPlist()` 在生产代码里没有调用点。）
6. 探针决策流 `l25-probe.jsonl` 无上限，`diagnose --feedback` 打印其磁盘占用 ——
   **刻意让运行时成本可见，不要"优化"掉**。
7. **Finding 14 的行为变更是刻意的**：熔断现在容忍 2 次失败才开。
8. **🆕 坏配置 = 响亮地死，daemon 不刷栈**（2026-08-02 裁决）。**明确不回落 `DEFAULT_CONFIG`** ——
   那正是 Finding 5 自己原先提的方案，它写在 Finding 12 之前，照做就是重造 Finding 12。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

- **Finding 10**（launchd plist 是安装时冻结的环境快照，`restart` 不重生成、无任何提示）——
  **已成条、未修**。影响面比 Finding 9 大：任何改 `buildDaemonEnv()` 白名单、`PATH` 拼装或
  node 路径解析的修复，对既有安装都静默无效。详见 dogfood Finding 10。
- **Finding 13 的深层解**：让预算对同步工作真正生效需把 hook 工作切段 —— **设计改动，需人类裁决**。
- **Finding 15**：重新推导 `openai_timeout_ms`。**判据是实测 p99，而现有数据截尾**
  （失败样本被 800ms 截断）—— 取无截断样本会改变生产行为，**需人类裁决取样方式**。
- **V5 取证出的三条**（均未修，见 dogfood Closure review 的 deferred 桶）。
- **回填失败的退避策略**：永久性失败（key 失效、账单停用）会一直重试。
- `@xenova/transformers` **已停止维护**。真解是迁移到 `@huggingface/transformers`。
- 两个 daemon 测试抖动合并为一个 issue，不阻塞。

## v0.14 的核心问题：`l25_cov` 是否存在可行阈值

- 随机对照 **n 已达 399**（原判据 ≥60，达成）。
- **p50 漂移轨迹 `0.125 → 0.075 → 0.029`，跨度 0.096，远超 V2 自己设的 ±0.03 门限**
  ⇒ **「分位数对比不可作判据」已经坐实**，不要再用它。
- ⚠️ **现在信号(0.081) 高于噪声(0.029)，看起来"终于有信号了"。这正是 Finding 2 警告的读法，不要中招。**
- `l25_legacy_hit` 仍 **0/1666**，**无任何正例标签**，仍需人工标注约 50 个样本。

**三条已知的样本偏差，做分布分析前必须先评估**：

1. Finding 13 之前，长会话的 stop hook 可能被 harness 杀掉，而 stop hook 正是写探针行的地方
   ⇒ 现有探针数据集可能系统性缺失慢会话/长会话。
2. Finding 14 之前，熔断在第一次失败就开、且会在零失败下误开 ⇒ 该时期的通道统计偏向词法。
3. **Finding 15 未修之前，约 1/3 的检索因 embed 超时根本没拿到查询向量** ——
   同样偏向词法，且**这条偏差至今仍在持续产生**。**这是 v0.14 分析线的闸门。**

## 建议使用的 skills

- **`superpowers:systematic-debugging`** —— 本项目所有修对了的东西都靠"先取证再改代码"。
  反面教材：`ps eww` 那次测量失效、从缺失下结论那次、mtime 判据、`is_cjk` 字段名、
  **以及 Finding 5 连续两次读码误判影响面**。
- **`superpowers:test-driven-development`** —— 硬性纪律是红-绿，**且要读到"接线也要测"那一层**。
  给附录 A 加条目同样适用：不变量要先被证明能变红。
- **`superpowers:verification-before-completion`** —— 多次差点把"没验证"当"已完成"。
- **`superpowers:brainstorming`** —— 若转向 v0.14 的阈值可行性判据（设计问题，先发散）。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`）已 gitignore；`.wolf/cerebrum.md` 入库。
  已记 `bug-058`（hook 配置分歧）、`bug-059`（hook 超时三层根因）、`bug-060`（熔断阈值失效）、
  **`bug-061`（坏配置打死 daemon + 错形状配置静默丢弃）**。
  **未修的 finding（10、15）不记 bug，只活在 dogfood 文档里。**
- SDD workspace **刻意保留**：承载全部人类裁决及理由、final review findings、8 份任务报告。
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 那轮 ~$60，文档回填那轮 ~$45，
  **本轮（10/11 + 附录 A + Finding 5）~$80**。跨进程 / 跨数据源取证代价很高。
  **开新一轮前先 `/compact`**，本轮末尾是在接近上下文上限的情况下做完的。
