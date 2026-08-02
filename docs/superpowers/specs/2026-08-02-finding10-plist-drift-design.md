# Finding 10 修复设计：plist drift 检测 + 带门禁的重写

> 状态：设计已由人类批准（2026-08-02），**尚未实现**。
> 对应 dogfood 条目：`docs/ccmem-v0.13-dogfood.md` Finding 10。
> 本文档不写 commit SHA。

## 一、问题

launchd plist 的 `EnvironmentVariables` 字典是**执行 `install` 那一刻 `buildDaemonEnv()` 的求值结果**，
此后仓库代码怎么改都不改变它，而且**没有任何东西会把这件事告诉用户**。

后果：任何改动 `buildDaemonEnv()` 白名单、`PATH` 拼装或 node 路径解析的修复，
**对既有安装都是静默无效的**。Finding 9 是第一次踩中，但机制是通用的。

## 二、代码事实（2026-08-02 逐处复核，路径为 `scripts/lib/admin/daemon.mjs`）

| 事实 | 位置 |
|---|---|
| 写 plist 的**唯一**一处，在 `installDaemon()` 体内 | `:526` |
| `restartDaemon` = `stopDaemon` + `startDaemon`，二者之外无别的动作 | `:693` |
| `startDaemon` 的 launchd 分支只 `kickstart` / 回落 `bootstrap`，读磁盘现有 plist | `:614-621` |
| `stopDaemon` 的 launchd 分支只 `bootout` | `:661-668` |
| `renderPlist()` 会用**当前**环境重新求值，但**生产代码零调用点** | `:336` |
| `renderPlist()` 与 `installDaemon()` 的求值路径**逐字相同**（`getDataRoot()` / `buildLaunchdDaemonEnv()` / `resolveInstallNodePath(process.env)`） | `:336-342` vs `:502-523` |
| `readPlist()` 只是 `readFileSync`，**没有解析器** | `:383` |
| `getLaunchAgentDir()` 认 `CCMEM_LAUNCHAGENT_DIR` 环境覆盖 —— 测试缝 | `:346-347` |
| `buildDaemonEnv` 的 `PATH` 取自调用方 shell | `:50` |
| `CCMEM_CLAUDE_P_COMMAND` 由那个 `PATH` 解析而来 | `:54-55` |
| `CCMEM_CONFIG_PATH` 是 passthrough（值取自调用方 shell） | `:73` |
| `installDaemon()` 写 plist 前有两道门禁：claude 解析不出 / 探针不过 | `:506`、`:514` |
| `probeClaudeJsonSchemaSupport` 是 **`spawnSync` 且无 `timeout`** | `:263-264` |
| verb 分发 | `:709-733`（`status/start/stop/restart/install/uninstall`） |

## 三、被否决的两个更简方案及理由

1. **只检测、不自动改**（drift 时提示用户 `uninstall && install`）——
   零行为变更风险，但人类选择要自动修复路径。
2. **`restart` 无条件重写 plist** —— 一步到位，但引入**反向的静默失败**：
   `installDaemon()` 写 plist 前有两道门禁，`restartDaemon()` 这条路径上**一道都没有**。
   从一个 `claude` 不在 `PATH` 的 shell（cron、GUI 启动的终端、CI）里 restart，
   重新求值会让 `CCMEM_CLAUDE_P_COMMAND` **从 plist 里消失**，把一个本来好的安装改坏。

采用的是第三条：**检测 + 带门禁的重写**。

> **这个方案自带一个新的出错面**：门禁谓词本身。它是新发明的判据，
> 所以下面 §7 要求它的每一门都能被单独验红。

## 四、检测

**快路**：`renderPlist()` 与磁盘 plist **字节相等即 `in_sync`**。
因为两者求值路径逐字相同（见 §二），这条比较是有意义的，且不需要解析器。

**慢路**（仅在不相等时走）：需要说清"差在哪"，才解析。解析范围**只限我们自己渲染的那段**：

1. 截出 `<key>EnvironmentVariables</key><dict>` 到其配对 `</dict>` 之间的文本；
2. 按 `renderEnvDict`（`:301`）的固定形状抽 `<key>K</key><string>V</string>` 对；
3. 反转义 `escapeXml`（`:362`）的五个实体（`&amp; &lt; &gt; &quot; &apos;`）。

**若该区间内有任何未被匹配吃掉的非空白残留，判定为 `unknown`，不得判 `in_sync`。**
手改过的、或旧格式的 plist 属于"不可判定"——不能从解析不出来推出"没有 drift"。

`ProgramArguments` 里的 node 路径同样比对，但归入 §五 的"自由变"桶。

**检测三态**：`in_sync` / `drifted` / `unknown`；`drifted` 附 `added` / `removed` / `changed` 三组 key 名。

**检测不 spawn 任何进程。** 探针只属于门禁，不属于检测——这条区分让 `status` 可以免费报 drift。

## 五、门禁（分类规则）

`restart` 在**真要写之前**判三条，**全过才写**：

| 门 | 判据 | 对应的已实例化伤害 |
|---|---|---|
| **G1** | `keys(new) ⊇ keys(old)` | claude 掉出 `PATH` ⇒ `CCMEM_CLAUDE_P_COMMAND` 消失（Finding 9 的反向） |
| **G2** | `CCMEM_CONFIG_PATH`、`CCMEM_DATA_ROOT`：旧 plist 若有该 key，新值必须与旧值一致 | stray 变量把 daemon 改指到另一份配置 ⇒ **重造 Finding 12** |
| **G3** | 新解析出的 `CCMEM_CLAUDE_P_COMMAND` 过 `probeClaudeJsonSchemaSupport`，**带 timeout** | 指向不支持 `--json-schema` 的旧 build |

`PATH`、node 路径落在**自由变**桶：只报告，不拦。

**三个边界语义，必须实现成显式分支，不能靠"应该不会发生"**：

- **检测为 `unknown` ⇒ 不写**，`blocked_by: 'unparsable'`。
  解析不出旧 env 就无法判 G1/G2，此时重写等于在看不见的前提下改配置。
  （因此 `blocked_by` 的取值是 `'G1'|'G2'|'G3'|'unparsable'|null`，比 §六 初稿多一个。）
- **检测为 `in_sync` ⇒ 不写**，`blocked_by: null`、`written: false`。没有差异就没有要写的东西。
- **G3 在新 env 不含 `CCMEM_CLAUDE_P_COMMAND` 时空过**（没有东西可探）。
  正常路径下这种情况会先被 G1 拦下（旧 plist 由 `installDaemon()` 写出，必然含该 key，见 `:504-512`）；
  空过分支只为手改过的 plist 兜底，**不得反过来当成"探针通过"记入输出**。

**G3 的 timeout 只在 restart 这条路径上传。`installDaemon()` 的调用点一个字不改**
——install 是一次性人为动作，它现有的无超时行为不在本轮范围内。

**timeout 取 5000ms 常数，不进配置**。理由：`claude -p --help` 是本地进程启动，
量级远低于此；restart 是人为动作，宁可等也不要误判；新增一个配置项就是新增一个
可以与代码分歧的面（Finding 12 的形状）。这个值是本设计的一个可调决定，不是实测导出的。

**门禁不过 ⇒ 不写 plist，但 `restart` 照常完成并返回 `restarted`。**
理由：restart 的本职是把 daemon 起回来；用一个可疑的配置问题去阻断重启，
是拿一个可疑问题换一个确定的停机。差异与拦截原因写进返回结果。

## 六、输出形状

`daemon status`（零 spawn，只做 §四 的比对）：

```
plist_drift: { status, added: [...], removed: [...], changed: [...] }
```

`daemon restart` 在此之上多一段：

```
plist_rewrite: { written: bool, blocked_by: 'G1'|'G2'|'G3'|'unparsable'|null, reason }
```

**值一律不打印，只打印 key 名**，唯二例外是 `CCMEM_CONFIG_PATH` 与 `CCMEM_DATA_ROOT` 的新旧值
——G2 拦下来时，人必须看见它想把你改指到哪才能裁决。
这既是防御深度（按人类裁决 #5，plist 环境字典本来就不该含凭据），
也避免 `PATH` 那种长串污染输出。

## 七、测试与不变量

测试打在 `cmdAdminDaemon(db, { verb })` 这一层，**不打在检测函数上**。
理由：Finding 5 的教训是"纯函数有测试 ≠ 接线有测试"，
而这里的接线就是 **verb 分发有没有真的调到检测**。
用 `CCMEM_LAUNCHAGENT_DIR` 指向临时目录，测试不碰真实的 `~/Library/LaunchAgents`。

| 测 | 内容 | 怎么验红 |
|---|---|---|
| T1 | 磁盘 plist 缺 `CCMEM_CONFIG_PATH` ⇒ `status` 报 `drifted`、`removed` 含它 | 未接线时它会报 `in_sync` |
| T2 | G1：新 env 少 key ⇒ 不写，`blocked_by:'G1'`，**磁盘 plist 字节不变** | 去掉 G1 判断，它会被改写 |
| T3 | G2：stray `CCMEM_CONFIG_PATH` ⇒ 不写，`blocked_by:'G2'` | 去掉 G2，它会被改指 |
| T4 | G3：探针失败 ⇒ 不写 | 去掉 G3，它会写 |
| T5 | **正面对照**：纯新增 key、指向类不变、探针过 ⇒ **写了**，磁盘 plist 含新 key | 这条保证 T2–T4、T8 的"没写"不是因为压根不会写 |
| T6 | 门禁失败时 `restart` 仍返回 `restarted` | — |
| T7 | 残留文本不可解析 ⇒ `status` 报 `unknown`，**不是** `in_sync` | 把 unknown 折叠成 in_sync，它会变绿 |
| T8 | 同一份不可解析的 plist ⇒ `restart` **不写**，`blocked_by:'unparsable'`，字节不变 | 不显式分支时它会走进重写 |

**T5 是 T2–T4 与 T8 的正面对照**，按 dogfood §六「反面的"什么都没发生"需要正面对照」配的。

**每条测试必须先被亲眼看着变红，且确认红的原因是预期的那个**（不是表名写错、不是桩没回调）。

**附录 A 新增不变量 #143**：
*`restart` 只在 G1–G3 全过时重写 plist；任一门不过则 plist 字节不变，且 restart 仍成功。*
附录 A **无 runner，是人工 checklist**，所以按既定做法：
**镜像文件 + 单独回退本条修复 + 看它变红**，不靠"看起来对"。

## 八、明确不做

- 不改 `installDaemon()` 的行为。
- 不给 `diagnose` 接线（输出面限定 `status` + `restart`）。
- 不动 `buildDaemonEnv()` 的白名单内容。
- 不碰 Finding 15（v0.14 分析线的闸门，需人类裁决取样方式）。

## 九、验收判据

1. `npm test` 全绿，且**基线数在动代码前先量过**
   （必须同时钉 `CCMEM_DATA_ROOT` 与 `-u CCMEM_CONFIG_PATH`，缺一会读到含 API key 的真实配置）。
2. T1–T8 每条都被看着变红过，红因确认无误。
3. 不变量 #143 用镜像文件验过红。
4. **实测复核影响面，不用读码结论**：真实执行 `install` → 改 `buildDaemonEnv()` → `restart`
   → grep 磁盘 plist，确认修复前不重生成、修复后重生成。
   （Finding 5 被读码推断误判过两次，此步不可省。）
5. 任何 0 计数配正面对照；不能解释的 0 写"不可判定"。
