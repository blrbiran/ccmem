# ccmem v0.13 — Handoff

> v0.13 已发布并合并。此后完成 **第一轮 dogfood**，2026-08-01 → 08-03 共七波修复/取证：
> Finding 9/4 → Finding 12（配置回落）→ Finding 13（hook 超时）→ Finding 14（熔断阈值失效）
> → 文档回填收口 + Finding 15 取证 → Finding 10/11 成条 + 附录 A 不变量 + Finding 5 修复
> → **最新一轮：Finding 10 修复完成并合并（六个 Task + 全分支审查）**。
> 本文档只做索引与状态提要 —— **不要仅凭它重建状态**，实质内容在下表的材料、ledger 与提交信息里。

---

# 🚀 Executive summary —— 下一位 agent 从这里开始

1. **Finding 10 已修复，并已 `--no-ff` 合进 `main`**（合并提交标题：`Merge branch 'finding10-plist-drift': restart regenerates the plist behind four gates`）。分支与 worktree **均已删除**。
2. **套件 514 pass / 0 fail，是在合并结果上跑的**，不是只在分支上。附录 A 现为 **120–143（24 行）**。
3. **v0.13 这条线没有已知欠项**；未修的 finding 只剩 **Finding 15**。下一步属于 v0.14，见「v0.14 待办来源」与「v0.14 的核心问题」两节。
4. 本轮全部人类裁决、实测取证、事故经过都在 **`.superpowers/sdd/2026-08-03-finding10-plist-drift/`**（26 份，gitignore，**已合并为一处**）。git 历史一条都不记这些。
5. 硬性禁止：**不要 push**（人类自己做）、**删分支必须先问**、**不要把 plist 或配置内容打印/落盘/写进文档**。
6. 本文档**不写任何 commit SHA、不写"领先几个提交"** —— 提交本文档就会改变这些数字。自己 `git log --oneline -25`。
7. 动手前先读 `docs/ccmem-v0.13-dogfood.md`（15 条 finding + §六纪律），再读 ledger。

---

# ✅ Finding 10 修复已完成并合并（Tasks 1–6）

`status` 接线、四道门禁（G1–G4）、`restart` 的带门禁重写、`installDaemon` 的单一求值点、
附录 A 不变量 #143、文档回填 —— 全部落地并合并。v0.13 那条线不受影响，下面的历史章节仍然有效。

**核心行为**（细节在设计文档与提交信息里，本文不重复）：

> `restart` 在**字节不等 且 环境字典可解析 且 G1–G4 全过**时重写 plist。
> **不是 `status === 'drifted'`** —— `status` 属报警轴，`in_sync` 且只有良性差异时**照写**，
> 这正是陈旧 `PATH`、node 路径、模板变更得以到达既有安装的路径。把这条关系写反，
> 整个特性退化成空操作。它被测试和附录 A #143 钉住，**不要"优化"掉**。

**⚠️ 这是活机器上的行为变更。** `ccmem` 走符号链接指向本仓库，所以修复现在是生效的。
已安装的 plist 仍是旧那份、运行中的 daemon 仍在用它；**下一次 `ccmem admin daemon restart`
会在门禁通过时重新生成它**。这是预期行为，但别让它变成意外。

## 接手两步

```bash
cat .superpowers/sdd/2026-08-03-finding10-plist-drift/progress.md   # ← SDD ledger，恢复地图
git log --oneline -25                                              # 自己数，本文不写 SHA
```

SDD workspace **已合并为一处**（主仓库那一份）。上一版本文档写的「ledger 与产物分处两地」
**已不再成立** —— 移除 worktree 前把它那一半的 24 份产物搬了过来，否则会随 worktree 一起消失。
那个双目录分裂本身害过一次人，见下方「这一轮踩到的坑」第 1 条。

## 材料

| 材料 | 用途 |
|---|---|
| `docs/superpowers/specs/2026-08-02-finding10-plist-drift-design.md` | **设计，动手前整篇读**。含 key 三桶分类、四道门禁、报警轴/重写轴解耦、time-of-check 那条坑 |
| `docs/superpowers/plans/2026-08-03-finding10-plist-drift.md` | 六个 Task 的实现计划。**已执行完毕，且已知有缺陷** —— 三处 bug 是它逐字规定的（正则回溯、自由变 key 三态、G2 漏 `CCMEM_DATA_ROOT`），多处数字过期。**当历史读，不要再当规范照做。** |
| ledger（`.superpowers/sdd/2026-08-03-finding10-plist-drift/progress.md`） | 每个 Task 的状态、全部人类裁决、deferred minor、实测取证、事故经过 |

## 状态：六个 Task 全部完成

| Task | 内容 |
|---|---|
| 1 | key 三桶分类 + 全覆盖断言 |
| 2 | plist 三轴拆分 + 环境字典解析 |
| 3 | 三轴比对 + `status` 接线（报警轴） |
| 4 | 四道门禁 G1–G4 + `restart` 的带门禁重写（重写轴） |
| 5 | `installDaemon` 复用 `renderPlist()`，单一求值点 |
| 6 | 附录 A #143 + 文档回填 + **真机实测复核** |

六个 Task 之后又做了**全分支审查（opus）+ 一轮 fix wave**，八条 finding 全部 ADDRESSED
（见 ledger 与 `final-fix-report.md`）。套件 **514 pass / 0 fail**，**在合并结果上实测**。
`stop-daemon-flow.test.mjs` 的已知抖动偶发，重跑即绿，不阻塞。

## 这一轮踩到的坑 —— 每条都真栽过

1. **一次险些成立的造假指控，起因是对照放错了目录。** 有人断定某份任务报告不存在、implementer
   两次撒谎；实际文件一直都在，且**比那条判决早 87 秒**。用来做正面对照的另一份报告在
   workspace 的**另一半目录**里。⇒ **正面对照只有和目标位于同一个目录时才有判定力**；
   跨目录的对照不构成对照，它给出的 0 和坏掉的 `find` 给出的 0 一样不可判定。
   （workspace 现已合并为一处，这个具体陷阱消失了，但纪律照旧。）
2. **测试跑真 `launchctl`，劫走了本机真实 daemon 注册。** 计划里的 `restart` 测试没有隔离
   launchctl，跑下去直接动了活系统。已修（改用仓库既有的 `CCMEM_LAUNCHCTL_BIN` 假 launchctl）、
   已恢复、已记入 `.wolf/buglog.json` 与 `cerebrum.md`。**最终审查又揪出同类的姊妹漏洞**：
   `CCMEM_LAUNCHAGENT_DIR` 当时还是 per-test opt-in，而且被一个 `finally` 主动删掉 ——
   忘了设它就会写到真的 `~/Library/LaunchAgents`。⇒ **测试隔离必须是模块级默认，不能靠人记得**。
3. **被测二进制解析到了错的 checkout —— 第七种不可判定的 0。** 实测复核时若直接用 PATH 上的
   `ccmem`，它走符号链接指向**主仓库**，而当时修复只在分支上，`grep` 必然返回 0 并"证明"修复无效。
   必须显式跑目标 checkout 的 `./bin/ccmem`。
4. **`cp` 在本机是交互式别名，会静默拒绝覆盖**（打印 `not overwritten`）而外层脚本照报成功。
   ⇒ **恢复要用校验和验证，不能信复制命令的退出码。**
5. **计划文本里的数字会过期，且会把 implementer 送进幻影 fix loop。** 本轮撞了四次：三次是测试
   计数陈旧，一次更阴 —— 一条断言数 `renderDaemonPlist(` 出现次数并要求等于 1，**但函数声明自己
   也匹配**，正确实现反而红。⇒ **派活前先拿计划里的数字对一遍真实文件。**
6. **`npm test -- <文件>` 不隔离单文件** —— npm 把参数追加到脚本原有 glob 后面，结果还是全量。
   跑单文件用 `node --test <文件>`，**但两个环境变量一个都不能少**。
7. **`EnterWorktree` 默认从 `origin/<默认分支>` 分叉**（`worktree.baseRef=fresh`）。本地领先
   origin 时，建出来的工作区**不会有要执行的那份计划**。**遇到未推送提交先想这一层。**

## 不要做的事

- 不要 push（人类自己做）。**删分支必须先问。**
- **不要重做已完成的 Task。** SDD 点名"controller 丢失位置后重复派发已完成任务"是代价最高的
  失败模式，ledger 就是为防它而写的——**信 ledger 和 `git log`，不要信记忆**。
- 不要把 plist 内容或配置文件内容打印/落盘/写进文档 —— `DAEMON_ENV_PASSTHROUGH` 含 `ANTHROPIC_API_KEY` /
  `ANTHROPIC_FOUNDRY_API_KEY`，**只在安装那一刻的 shell 里该变量确实非空时才会被复制进 plist**
  （`scripts/lib/admin/daemon.mjs:84-87`）。这些凭据平时活在 `config.json`，不是环境变量，
  普通 shell 里通常没设置。本机当前那份 plist 经核实**不含任何凭据类 key**（只有
  `CCMEM_CLAUDE_P_COMMAND`/`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`/`PATH` 四项）——
  但规则不因此放松，plist **可能**含凭据，永远不打印/落盘/写进文档。

## 一条已被证伪的旧说法（本文档下方历史章节里还有它的残迹）

下面「人类裁决」第 5 条说「provider API key 不进 daemon 环境白名单」——**那只讲 embedding provider 的 key**。
`DAEMON_ENV_PASSTHROUGH` 里有 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_FOUNDRY_API_KEY`，任何
"plist 不含凭据"的推论都是错的。**但反过来"它们今天就明文写在 plist 里"同样是错的**——
`daemon.mjs:84-87` 的 passthrough 只在安装那一刻的 shell 里该变量确实非空时才会被复制，
而这些凭据平时活在 `config.json`，不是环境变量，普通 shell 里通常没设置。真实情况是
**取决于安装时的 shell**：本机当前那份 plist 经核实只含 `CCMEM_CLAUDE_P_COMMAND`/
`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`/`PATH` 四个 key，**零个凭据类 key**。
两种绝对化的说法（"不含" / "今天就有"）都错，设计文档 §二 已就此更正为条件命题。
安全规则不因此放松：plist **可能**含凭据，永远不打印/落盘/写进文档。

---

## 先读这些，按顺序

| 材料 | 为什么需要 |
|---|---|
| **`docs/ccmem-v0.13-dogfood.md`** | **最重要，先读。** 15 条 finding（**1–15 现已全部有独立条目**）、V1–V8 验证清单、门禁、§六纪律。 |
| `git log`（近 ~25 个提交） | **每条修复的完整根因、证据、取舍都在提交信息里**，本文档刻意不重复。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | SDD ledger —— 每条人类裁决及理由、全部延期项。git 历史一条都不记。 |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md` | 末尾「NOT in this wave」= v0.14 待办来源。 |
| `docs/ccmem-v0.13-spec.md` 附录 A | 不变量现为 **120–143（24 行）**。136–142 覆盖 Finding 6/7/8/12/13/14/5，**#143 覆盖 Finding 10**，**每条都验过红**（#143 为部分验红，范围见附录 A #143 下方说明）。 |

## Git 状态

**本文档不写 commit SHA，也不写"领先几个提交"** —— 提交这份文档本身就会改变这些数字。自己数：

```bash
git log --oneline -25
git rev-list --count origin/main..main    # 本地领先多少
git status --porcelain                    # 应为空
```

**Finding 10 那轮落在 `main` 上的提交，按标题找、不要按 SHA 找**（时间顺序，末尾是合并提交）：

- `feat(daemon): report plist drift from status without spawning anything`
- `fix(plist-drift): exclude free-key add/remove from the alarm verdict`
- `feat(daemon): rewrite the plist on restart only when four gates allow it`
- `fix(daemon): close G2's CCMEM_DATA_ROOT gap, report blocked rewrites, harden test isolation`
- `refactor(daemon): give the plist a single point of evaluation`
- `docs: close out Finding 10 and add its invariant`
- `docs: void the credential claim in the binding plan file, disclose partial invariant coverage`
- `fix(plist-drift): close final review's eight-item fix wave`
- `Merge branch 'finding10-plist-drift': restart regenerates the plist behind four gates`

（此前几轮的提交标题不再逐条列出，`git log` 里按 `docs(dogfood)` / `fix(config)` 等前缀找即可。）

需要知道的事实：

- 本地 `main` **领先 `origin/main`**。**人类自己处理所有 push —— 不要代为推送。**
- 分支 `finding10-plist-drift` **已删除**（其工作已合并）；`v0.13-spec`、`v0.13-dogfood-fixes`
  **均未删除**（**删分支必须先问**）。worktree 只剩 `ccmem-v012-finalization` 一个，与本线无关。
- 套件 **514 pass / 0 fail**，**在合并结果上实测**（`npm test`，exit 0）。
  已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；不阻塞，但**红了要先确认是它**。
- 附录 A **24 行（120–143）**。**没有 runner，是人工 checklist** —— 这正是"恒绿的不变量
  看起来和通过的一模一样"的由来。**#143 是部分验红**：镜像只关掉了门禁判断，所以只验到
  G1–G4 那一支，字节相等短路与解析失败两支未单独验红 —— 这点已如实写进附录 A #143 下方。

## ⚠️ 会咬人的既定事实

1. **`npm test` 同时钉 `CCMEM_DATA_ROOT` 和 `-u CCMEM_CONFIG_PATH`**。
   只 unset 配置路径**不构成隔离** —— 配置回落会让测试读到真实的 `~/.claude/ccmem/config.json`，**含 API key**。
2. **默认目录以后迁走只需改 `scripts/lib/paths.mjs` 一处** —— 配置路径已跟着 `getDataRoot()` 走。
   **不要再在别处解析数据根。**
3. **`ps eww` 在这台机器上读不到进程环境。** 可靠替身：`zsh -f -c 'echo $VAR'` 验继承 /
   进程自己写出的签名验 daemon / `memory_feedback.session_id` + 时间戳验 hook 归属会话。
4. **hook 侧代码改动下次调用即生效**（`~/.claude/plugins/ccmem` 是指向本仓库的符号链接）；
   daemon 现在 `restart` 时会在字节不等、环境字典可解析、G1–G4 全过时自动重写 plist（Finding 10
   已修复，附录 A #143）——**但指向类 key 的改动（`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT`）会被拦下，
   不会自动重写，仍需人工 `uninstall && install`**，这是刻意的。
   ⚠️ **拦它的通常是 G1 而不是 G2**：最常见的真实情形是「装的时候 shell 导出了
   `CCMEM_CONFIG_PATH`，重启时那个 shell 没导出」，此时该 key 是**从新环境里消失**，
   G1（拒绝缩减 key 集合）先于 G2 触发。结果与补救办法相同，但排查时别盯着 G2 找。
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
| **Finding 5 / 10 / 11 / 12 / 13 / 14** | ✅ 均已修复并有回归测试（**10 于 2026-08-03 合并**） |
| **Finding 1–15 条目完整性** | ✅ 15 条全部有独立条目 |
| **附录 A 不变量** | ✅ 136–143 八条，覆盖 Finding 6/7/8/12/13/14/5/10，**每条验红**（#143 部分验红，范围见附录 A） |
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
- **0 计数 / 不动的数字，先解释来源再当结论。已出现八种来源**：分母为 0、进程比代码旧、
  链条死掉、幸存者偏差、**查错字段名**（`hook`≠`event`；`has_cjk`≠`is_cjk`）、
  签名为 null 让 SQL 谓词恒不成立、**分母只有 1**、
  **🆕 被测二进制解析到了错的 checkout**（PATH 上的 `ccmem` 走符号链接指向主仓库，
  而修复当时只在分支上 —— grep 必然返回 0 并"证明"修复无效）。
- **反面的"什么都没发生"需要正面对照才可信 —— 而且对照必须和目标同处一地。**
  本轮既靠它挡下了误伤（grep 返回 0 时先证明同一条命令对另一个 pattern 返回 1），
  也**被它反咬过一次**：对照文件放在另一个目录，于是那个 0 依旧不可判定，却看起来已经验过。
- **🆕 恢复/写入类操作要用校验和验证，不要信命令的退出码。** 本机 `cp` 是交互式别名，
  静默拒绝了一次覆盖并打印 `not overwritten`，而外层脚本照报成功。
- **🆕 测试隔离必须是模块级默认，不能靠下一个人记得调用某个 helper。** 本轮一条测试跑了真
  `launchctl` 并劫走本机 daemon 注册；修完之后**同类的姊妹漏洞还剩着**（另一个环境变量仍是
  per-test opt-in，且被 `finally` 主动删掉），直到最终审查才揪出来。**失败是静默的**：
  测试照样绿，同时动着真系统。
- **在 live 库的副本上验证**（`sqlite3 "file:...?mode=ro" "VACUUM INTO '<副本>'"`），
  **但不要用 mtime/size 比对"证明"零写入**。
- **不要从缺失下结论**；**不能解释的 0 就写"不可判定"**。

## 人类裁决 —— 不得静默推翻

完整理由在 ledger。最容易误伤的：

1. **切到 OpenAI 是既定方向**，按 `config.json` 的声明走。
2. **换模型检测器整体移除** —— 签名机制已正确覆盖换模型。
3. **签名契约返回 `null`**，不是抛错。正是这个 `null` 让 V5 的分歧表现为静默的 0。
4. **`CCMEM_CONFIG_PATH` 统一回落到数据根下的 `config.json`**，该变量降级为覆盖。
5. **provider API key 不进 daemon 环境白名单**。
   ⚠️ **这条括号注解已过期，别再照抄**：原文写「真正写盘的是 `installDaemon()`；`renderPlist()`
   在生产代码里没有调用点」。**Task 5 之后 `renderPlist()` 正是唯一求值点** —— `installDaemon()`
   改为调它，`status` 的漂移检测与 `restart` 的重写也都调它。这是刻意的：两处独立求值意味着
   谁改了一边没改另一边，检测就会与一个错的基准比对，而且不会有任何症状。
6. 探针决策流 `l25-probe.jsonl` 无上限，`diagnose --feedback` 打印其磁盘占用 ——
   **刻意让运行时成本可见，不要"优化"掉**。
7. **Finding 14 的行为变更是刻意的**：熔断现在容忍 2 次失败才开。
8. **坏配置 = 响亮地死，daemon 不刷栈**（2026-08-02 裁决）。**明确不回落 `DEFAULT_CONFIG`** ——
   那正是 Finding 5 自己原先提的方案，它写在 Finding 12 之前，照做就是重造 Finding 12。

**🆕 Finding 10 那轮的五条裁决（2026-08-03，理由全在 ledger）：**

9. **自由变 key 的差异一律不抬三态 —— 包括整个新增或整个消失，不只是值变化。**
   计划文本只豁免了值变化，设计文档 §五/§三 则是无条件豁免；**设计压计划**。
   实现上是把自由变 key 排出 `raisesVerdict`，而**不是**把它们塞进 `benign_changed` ——
   `added`/`removed` 仍完整列出，人能看到 `PATH` 没了。它消失另有 G1 在重写轴上守着。
10. **G2 必须包含 `CCMEM_DATA_ROOT`。** 计划只枚举了四个值；一旦 `CCMEM_CONFIG_PATH` 显式指向
    一个存在的文件，data root 就整个掉出比较，daemon 会被静默重指向另一个 `global.db`。
    模块自己的 `POINTING_KEYS` 早把它归为指向类 —— 计划自相矛盾。
11. **`plist_rewrite` 被拦时必须打到 stderr。** 否则被 G1/G2 拦住的人每次 restart 都被拦、
    却永远看不到原因 —— 那是 Finding 10 同一家族的静默无效。只打 key 名、门禁编号与 reason。
12. **红证据缺口用变异红补，不用"函数不存在"那种廉价红。** 关掉被测断言所守的那一段，
    看它红在自己命名的那个行为上，**且对照测试保持绿**（证明变异是定向的）。
13. **SDD workspace 保留，不按 SDD 流程删。** 它承载全部裁决理由、实测取证与事故经过，
    git 历史一条都不记。移除 worktree 前**必须先把它那一半搬出来**。

## v0.14 待办来源

`final-review-findings.md` 末尾的「NOT in this wave」是权威版本。另需并入：

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
- **`superpowers:subagent-driven-development`** —— 若下一轮同样是"有计划、任务基本独立"的执行，
  照旧用它。它规定的 ledger、per-task 双验收（spec 合规 + 质量）、fix loop 五轮上限与 breaker，
  正是 `.superpowers/sdd/` 里那些记法的来源；不读它会看不懂 ledger。
  **本轮的经验：把能力预算花在审查而不是实现上** —— 实现用中档模型足够（计划里已有完整代码），
  而**两轮 Opus 审查抓出了全部真正重要的缺陷**，包括计划自己规定的那几个。
- **`superpowers:writing-plans`** —— 若要为 v0.14 写计划，先读它，并记住本轮的教训：
  **计划里的数字（测试计数、出现次数、行号）会过期，并且会把 implementer 送进幻影 fix loop**；
  计划正文里给出的代码也可能自带缺陷（本轮有三处是计划**逐字规定**的 bug，均需人类裁决）。

## 备注

- OpenWolf 记账文件（`.wolf/buglog.json`、`.wolf/memory.md`）已 gitignore；`.wolf/cerebrum.md` 入库。
  已记 `bug-058`（hook 配置分歧）、`bug-059`（hook 超时三层根因）、`bug-060`（熔断阈值失效）、
  `bug-061`（坏配置打死 daemon + 错形状配置静默丢弃）、
  **🆕 Finding 10 那轮的 launchd 标签冲突（测试劫走真实注册）**。
  **未修的 finding（15）不记 bug，只活在 dogfood 文档里。**
- **两个 SDD workspace 都刻意保留**（均 gitignore）：
  `2026-07-31-ccmem-v0.13/`（v0.13 那轮）与 **`2026-08-03-finding10-plist-drift/`（Finding 10 那轮，
  26 份：ledger + 6 份 brief + 6 份 report + final-fix-report + 11 份 review diff）**。
  承载全部人类裁决及理由、实测取证、事故经过 —— **git 历史一条都不记**。
- 所有产物中不含任何凭据或个人数据；API key 存放于仓库外的用户配置文件。
- **成本提示**：Finding 12/13 那轮 >$110，Finding 14 那轮 ~$60，文档回填那轮 ~$45，
  10/11 + 附录 A + Finding 5 那轮 ~$80，**Finding 10 修复那轮（6 个 Task + 全分支审查 + fix wave，
  13 次 subagent 派发，其中 3 次 Opus）~$140**。跨进程 / 跨数据源取证代价很高。
  **开新一轮前先 `/compact`** —— 上述两轮末尾都是在接近上下文上限的情况下做完的。
