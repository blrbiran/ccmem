# Finding 10 修复设计：plist drift 检测 + 带门禁的重写

> 状态：设计已由人类批准（2026-08-02），经一轮作者自评修订（2026-08-03），**尚未实现**。
> 对应 dogfood 条目：`docs/ccmem-v0.13-dogfood.md` Finding 10。
> 本文档不写 commit SHA。

## 一、问题

launchd plist 的 `EnvironmentVariables` 字典是**执行 `install` 那一刻 `buildDaemonEnv()` 的求值结果**，
此后仓库代码怎么改都不改变它，而且**没有任何东西会把这件事告诉用户**。

后果：任何改动 `buildDaemonEnv()` 白名单、`PATH` 拼装或 node 路径解析的修复，
**对既有安装都是静默无效的**。Finding 9 是第一次踩中，但机制是通用的。

## 二、代码事实

> **行号是 2026-08-02/03 逐处复核的实现前坐标**，本设计一落地它们必然位移。
> 上一轮刚栽过"六处 off-by-one 不变量引用"，所以：**引用这些行号前先核，不要照抄。**
> 未标注文件的均为 `scripts/lib/admin/daemon.mjs`。

| 事实 | 位置 |
|---|---|
| 写 plist 的**唯一**一处，在 `installDaemon()` 体内 | `:526` |
| `restartDaemon` = `stopDaemon` + `startDaemon`，二者之外无别的动作 | `:693` |
| `restartDaemon` 的**唯一调用点**是 verb 分发 | `:722-723` |
| `startDaemon` 的 launchd 分支只 `kickstart` / 回落 `bootstrap`，读磁盘现有 plist | `:614-621` |
| `stopDaemon` 的 launchd 分支只 `bootout` | `:661-668` |
| `renderPlist()` 会用**当前**环境重新求值，但**生产代码零调用点** | `:336` |
| `renderPlist()` 与 `installDaemon()` 的求值路径**逐字相同** | `:336-342` vs `:502-523` |
| `readPlist()` 只是 `readFileSync`，**没有解析器** | `:383` |
| `getLaunchAgentDir()` 认 `CCMEM_LAUNCHAGENT_DIR` 环境覆盖 —— 测试缝 | `:346-347` |
| `buildDaemonEnv` 的 `PATH` 取自调用方 shell，且会前插 `claudeBinDir` | `:50`、`:60-62` |
| `CCMEM_CLAUDE_P_COMMAND` 由那个 `PATH` 解析而来 | `:54-55` |
| passthrough 只在值非空时写入字典 | `:78` |
| `installDaemon()` 写 plist 前有两道门禁：claude 解析不出 / 探针不过 | `:506`、`:514` |
| `probeClaudeJsonSchemaSupport` 是 **`spawnSync` 且无 `timeout`** | `:263-264` |
| verb 分发 | `:709-733`（`status/start/stop/restart/install/uninstall`） |

**两条决定本设计走向、且与初稿假设相反的事实：**

1. **plist 里有凭据，今天就有。** `DAEMON_ENV_PASSTHROUGH`（`:15-25`）含
   `ANTHROPIC_API_KEY`、`ANTHROPIC_FOUNDRY_API_KEY`，经 `:83-88` 进 `daemonEnv`，
   由 `renderDaemonPlist` **明文写进 plist**。
   人类裁决 #5 讲的是 **provider（embedding）API key** 不进白名单
   （`tests/integration/v013-daemon-config-path.test.mjs:83` 钉的是 `OPENAI_API_KEY`），
   **不是"plist 不含凭据"**。初稿把它写成后者，是错的。

2. **daemon 会把记忆正文经由继承自 plist 的环境发出去。**
   `scripts/daemon/claude-p.mjs:118` 把 `process.env` 整个展开进子进程环境，
   `:175` 将 prompt 写入 `claude` 的 stdin，而 prompt 来自
   `summarize-pending.mjs` / `weekly-synthesis.mjs`——**内容是用户待入库的记忆正文**。
   ⇒ 环境里决定"发到哪个端点"的变量，是一条数据外发目的地。

   > **未实测的一环**：`claude` 二进制自身是否真的认 `ANTHROPIC_BASE_URL`。
   > 那是 Claude Code 的行为，不在本仓库，本轮未在本机验证。
   > 分类决定建立在这条外部知识上，若要坐实需起假端点观察实际连接目标。

## 三、被否决的方案，以及价值分布的实话

1. **只检测、不自动改** —— 零行为变更风险，但人类选择要自动修复路径。
2. **`restart` 无条件重写 plist** —— 引入**反向的静默失败**：
   `installDaemon()` 写 plist 前有两道门禁，`restartDaemon()` 这条路径上一道都没有。
   从 `claude` 不在 `PATH` 的 shell 里 restart，会让 `CCMEM_CLAUDE_P_COMMAND`
   **从 plist 里消失**，把本来好的安装改坏。

采用第三条：**检测 + 带门禁的重写**。

> ### 自动重写覆盖什么、不覆盖什么
>
> **不覆盖 Finding 9 自己那一类。** 按 §六 的 G2，该类修复两条路都传播不到既有安装：
>
> - 操作者 shell **没有**导出 `CCMEM_CONFIG_PATH`（`scripts/lib/config.mjs:296-298`
>   写明这是常态：该变量无任何持久来源）⇒ 新 env 里没有这个 key，重写与否都一样；
> - 操作者 shell **导出了**真实覆盖路径 ⇒ 有效配置文件改变 ⇒ **G2 拦下，仍不写**。
>
> **这不是缺陷，G2 拦得对**——拦下来还报警，强过悄悄改指。指向类的修复走人工
> `uninstall && install`，这是刻意的。
>
> **覆盖 Finding 10 列举的另外两类**：`PATH` 拼装（`:60-62`）与 node 路径解析的修复，
> 加上渲染器模板本身的变更（§五 第三轴）与未来新增的非指向非凭据类 key。
> 这几类不掺操作者身份与数据去向，是自动重写最该也最安全去修的东西。
>
> 前提是**报警与重写必须解耦**（§五）：`PATH` 变不值得报警，但**必须重写**，
> 否则 Finding 10 点名的三类静默无效里，这条会原封不动地留着。

## 四、key 分类

**分类原则（人类裁决 2026-08-03，选项 D）：**

> **凡决定"daemon 用谁的身份、把数据发到哪、读哪个文件"的 key，值不得静默变；
> 凡只决定"怎么做"（模型、超时、参数、本地 `PATH`）的 key，自由变。**

| 桶 | key | 处理 |
|---|---|---|
| **指向类** | `CCMEM_DATA_ROOT`、`CCMEM_CONFIG_PATH` | 值不得变；**打印新旧值**（本地路径，人要看见改指到哪） |
| **指向类** | `ANTHROPIC_BASE_URL`、`ANTHROPIC_FOUNDRY_BASE_URL`、`CLAUDE_CODE_USE_FOUNDRY` | 值不得变；**只打 key 名** |
| **凭据类** | `ANTHROPIC_API_KEY`、`ANTHROPIC_FOUNDRY_API_KEY` | 值不得变；**只打 key 名，永不打值** |
| **自由变** | `PATH`、`CCMEM_CLAUDE_P_COMMAND`、`CCMEM_CLAUDE_P_ARGS_JSON`、`CCMEM_CLAUDE_P_TIMEOUT_MS`、`ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET}_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` | 不拦，不报警，**参与重写** |

**本表只管环境字典里的 key。** node 路径不是环境变量，它是 `ProgramArguments` 的内容，
按 §五 的第二轴处理——不要把它混进这张表（初稿混过一次）。

**唯一的刻意例外，写明理由不留暗门**：`CCMEM_CLAUDE_P_COMMAND` 决定哪个本地二进制被执行，
按原则字面也算"身份"，但归自由变——它消失由 G1 挡、它指向变坏由 G4 的探针挡，两头都有人管。

**分类必须是全覆盖的，且由测试保证**（见 §八 T12）。
理由：Finding 10 的教训正是"别处改了、这里静默不覆盖"。
若分类靠一份人肉清单，下次有人往 `DAEMON_ENV_PASSTHROUGH` 加 key，它会默默落进自由变。
断言负责逼出决定，上面那条原则负责指出往哪边归。
**不使用 `/_API_KEY$/` 之类的正则去猜**——有了全覆盖断言就不需要猜，而猜会误判。

## 五、检测

**快路**：`renderPlist()` 与磁盘 plist **字节相等即 `in_sync`**。
两者求值路径逐字相同（见 §二），这条比较有意义，且不需要解析器。

**慢路**（仅在不相等时走）：`renderDaemonPlist`（`:314-334`）渲染七块
（`Label` / `ProgramArguments` / `RunAtLoad` / `KeepAlive` / `StandardErrorPath` /
`StandardOutPath` / `EnvironmentVariables`），所以比对**必须拆三轴，不能只看环境字典**：

| 轴 | 比什么 | 怎么比 |
|---|---|---|
| **① 环境字典** | `EnvironmentVariables` | 解析成 K/V 后按 §四 分类逐 key 比 |
| **② `ProgramArguments`** | node 路径等启动参数 | 整段字符串比 |
| **③ 其余模板** | 剩下五块 | 剔除 ①② 后的残余整段字符串比 |

① 的解析步骤：

1. 截出 `<key>EnvironmentVariables</key><dict>` 到其配对 `</dict>` 之间的文本；
2. 按 `renderEnvDict`（`:301`）的固定形状抽 `<key>K</key><string>V</string>` 对；
3. 反转义 `escapeXml`（`:362`）的五个实体（`&amp; &lt; &gt; &quot; &apos;`）。

**若该区间内有任何未被匹配吃掉的非空白残留，判定为 `unknown`，不得判 `in_sync`。**
手改过的、或旧格式的 plist 属于"不可判定"——不能从解析不出来推出"没有 drift"。

**轴 ③ 存在的理由**：渲染器模板变了（例如以后加一个 `ProcessType`）时，
字节不等而环境字典完全相同。这是**纯代码版本差异、不掺任何操作者环境**，
是自动重写最该也最安全去修的场景。初稿只解析环境字典，这种情况会落进未定义分支——
要么误报 `in_sync` 把它咽掉，要么误判 `unknown`。

### 报警与重写是两个轴，不得压成一个

初稿把两者压成一个，后果是 `PATH` 只要没别的差异就永远不会被重写，
而 `PATH` 拼装的修复**正是 Finding 10 点名的三类静默无效之一**——设计本身会让它继续静默无效。

|  | `PATH` / 模板变 | 指向类 / 凭据类变 |
|---|---|---|
| **报警给人看** | 不该（噪声，Finding 2 的读法） | 该 |
| **重写** | **该**（否则修复传不过去） | 不该（门禁拦下） |

**报警轴 —— `status` 三态**，只回答"值不值得人看一眼"：

- `drifted`：轴 ① 里**指向类 / 凭据类 / key 增删**有差异；
- `in_sync`：其余（含只有自由变 key、轴 ②、轴 ③ 有差异）；
- `unknown`：轴 ① 解析失败。

自由变 key 的差异单列 `benign_changed`，轴 ②③ 的差异单列 `template_changed`，
**都不影响三态**。

**重写轴 —— 独立成一句**：

> **字节不等 且 轴 ① 可解析 且 G1–G4 全过 ⇒ 重写。**

于是 `in_sync` 但 `benign_changed` / `template_changed` 非空时**照写**，
这正是 `PATH`、node 路径、模板变更得以传播的路径。

**检测三态与四个列表**：`unknown` 时 `added` / `removed` / `changed` /
`benign_changed` / `template_changed` **一律为空数组，不缺省**
——解析不出来就是没有可报的条目，不是"没有条目"。

**检测不 spawn 任何进程。** 探针只属于门禁。
（准确说法：无子进程；`resolveCommandFromPath` 仍会对 `PATH` 每一段做 `existsSync`。
这就是 `status` 能顺带报 drift 的原因。）

## 六、门禁

`restart` 在**真要写之前**判四条，**全过才写**。
（初稿是三条；凭据类独立成门，`blocked_by` 才能指出是哪一类被拦，故探针由 G3 改编号为 G4。）

| 门 | 判据 |
|---|---|
| **G1** | `keys(new) ⊇ keys(old)` |
| **G2** | **指向类 key 的有效值不得变** |
| **G3** | **凭据类 key 的值不得变** |
| **G4** | 新解析出的 `CCMEM_CLAUDE_P_COMMAND` 过 `probeClaudeJsonSchemaSupport`，**带 timeout** |

### G2 的"有效值"

比的是 **daemon 实际会读哪个文件 / 连哪个端点**，不是字典里有没有那个 key。
配置文件的解析规则**直接复用 `loadConfig`**（`scripts/lib/config.mjs:307`
`userPath && existsSync(userPath) ? userPath : getConfigPath()`），不另发明：

```
effectiveDataRoot(env)    = env.CCMEM_DATA_ROOT ?? getDataRoot()
effectiveConfigPath(env)  = (env.CCMEM_CONFIG_PATH && existsSync(env.CCMEM_CONFIG_PATH))
                              ? env.CCMEM_CONFIG_PATH
                              : join(effectiveDataRoot(env), 'config.json')
```

其余三个指向类 key 的有效值 = 其字面值，**缺省记为 `null`**
（于是"旧无、新有"= `null` → 值，判为不同 ⇒ 拦）。

四种情形自然全中：

| 旧 plist | 新 env | 有效值 | 结果 |
|---|---|---|---|
| 无 `CCMEM_CONFIG_PATH` | = 默认路径 | 相同 | 放行（新增无害） |
| 无 | stray 且文件存在 | **不同** | **拦** |
| 无 | stray 但文件不存在 | 检查时相同 | **拦**——见下方 time-of-check 说明 |
| 有 X | 无 | 不同 | G1 与 G2 双拦 |

**time-of-check ≠ time-of-use，所以"文件不存在"不能放行。**
初稿在这一格写了放行，理由是 `loadConfig:307` 会回落默认、daemon 读的没变。
**那只在检查那一刻成立。** 放行意味着 `CCMEM_CONFIG_PATH=<不存在的路径>` 被**持久化进 plist**；
哪天那个文件被创建出来（手滑、别的工具、恢复备份），daemon 下次启动就读它了——
我们亲手写下一颗延时地雷，而且它绕过了 G2 自己。
指向不存在的文件本来就是异常环境，拦下报清楚即可，
不值得为它设计"写入时剔除该 key"那套机械。

### 边界语义（必须实现成显式分支，不能靠"应该不会发生"）

- **检测为 `unknown` ⇒ 不写**，`blocked_by: 'unparsable'`。
  解析不出旧 env 就判不了 G1–G3（**此处的 G1–G3 不是笔误**：这三门都要拿旧 env 作比，
  G4 只看新 env，但旧的判不了就已经不能写了），此时重写等于在看不见的前提下改配置。
- **字节相等 ⇒ 不写**，`blocked_by: null`、`written: false`。没有差异就没有要写的东西。
  **判据是字节相等，不是 `in_sync`**——`in_sync` 只是报警轴的取值，
  它与 `benign_changed` / `template_changed` 非空并存，那种情形要写（§五 重写轴）。
- **G4 在新 env 不含 `CCMEM_CLAUDE_P_COMMAND` 时空过**（没有东西可探）。
  正常路径下先被 G1 拦下（旧 plist 由 `installDaemon()` 写出必然含该 key，见 `:504-512`）；
  空过分支只为手改过的 plist 兜底，**不得反过来当成"探针通过"记入输出**。

### 探针 timeout

**取 5000ms 常数，不进配置。** 理由：`claude -p --help` 是本地进程启动，量级远低于此；
restart 是人为动作，宁可等也不要误判；新增配置项就是新增一个可与代码分歧的面（Finding 12 的形状）。
**这个值是设计决定，不是实测导出的。**

**timeout 只在 restart 这条路径上传，`installDaemon()` 的调用点一个字不改**
——install 是一次性人为动作，其无超时行为不在本轮范围内。

### 门禁不过时

**不写 plist，但 `restart` 照常完成并返回 `restarted`。**
restart 的本职是把 daemon 起回来；用一个可疑的配置问题去阻断重启，
是拿一个可疑问题换一个确定的停机。差异与拦截原因写进返回结果。

## 七、输出形状

`daemon status`（无子进程）：

```
plist_drift: {
  status, added: [...], removed: [...], changed: [...],
  benign_changed: [...],      // 自由变 key
  template_changed: [...]     // 轴 ②③：'ProgramArguments' / 'template'
}
```

`daemon restart` 在此之上多一段：

```
plist_rewrite: {
  written: bool,
  blocked_by: 'G1'|'G2'|'G3'|'G4'|'unparsable'|null,
  reason: string        // 单行人类可读；不含任何值，除下述唯一例外
}
```

**被 G2 / G3 拦下时，`reason` 必须给出补救动作**（`uninstall && install`）。
只说"被 G3 拦下"是把人停在半路——凭据轮换的人尤其需要，
他的 daemon 此刻正拿着 plist 里的旧 key 在跑。

**值一律不打印，只打印 key 名**，唯一例外是 `CCMEM_CONFIG_PATH` 与 `CCMEM_DATA_ROOT` 的新旧值
——G2 拦下来时，人必须看见它想把你改指到哪才能裁决。

**这条不是防御深度，是硬性必需**：按 §二 事实 1，plist 环境字典**今天就含 Anthropic 凭据**。
一个照直觉实现 diff 的人会打印新旧值，那就是把凭据打进终端和日志。

## 八、测试与不变量

测试打在 `cmdAdminDaemon(db, { verb })` 这一层，**不打在检测函数上**。
理由：Finding 5 的教训是"纯函数有测试 ≠ 接线有测试"，
而这里的接线就是 **verb 分发有没有真的调到检测**。
用 `CCMEM_LAUNCHAGENT_DIR` 指向临时目录，测试不碰真实的 `~/Library/LaunchAgents`。

| 测 | 内容 | 怎么验红 |
|---|---|---|
| T1 | 磁盘 plist 缺 `CCMEM_CONFIG_PATH` ⇒ `status` 报 `drifted`、`removed` 含它 | 未接线时报 `in_sync` |
| T2 | **只有 `PATH` 不同** ⇒ `status` 仍 `in_sync`、`PATH` 落 `benign_changed`，**且 `written: true`、磁盘 plist 的 `PATH` 已更新** | 两个方向都要验：不做分类时报 `drifted`；把不写的条件写成 `in_sync` 时 `written` 为 `false` |
| T2b | **只有模板不同**（改 `renderDaemonPlist` 加一块）⇒ `status` `in_sync`、`template_changed` 非空、**`written: true`** | 只解析环境字典的实现会判成 `in_sync` 且不写 |
| T3 | G1：新 env 少 key ⇒ 不写，`blocked_by:'G1'`，**磁盘 plist 字节不变** | 去掉 G1，它会被改写 |
| T4 | G2：stray `CCMEM_CONFIG_PATH` **指向真实存在的文件** ⇒ 不写，`blocked_by:'G2'` | 去掉 G2，它会被改指 |
| T5 | G2：旧无 / 新有 `ANTHROPIC_BASE_URL` ⇒ 不写，`blocked_by:'G2'` | 按"旧有才比"的初稿写法，它会放行 |
| T6 | G3：`ANTHROPIC_API_KEY` 值变 ⇒ 不写；**且整个返回结果中不出现该值**，只出现 key 名 | 打印值的实现会红；断言自带正面对照（同一检查对 key 名必须命中） |
| T7 | G4：探针失败 ⇒ 不写，`blocked_by:'G4'` | 去掉 G4，它会写 |
| T8 | **正面对照**：新增一个自由变 key（用 `CCMEM_CLAUDE_P_TIMEOUT_MS`，**不得用指向类或凭据类 key**）、其余不变、探针过 ⇒ **写了**，磁盘 plist 含新 key | 这条保证 T3–T7、T11 的"没写"不是因为压根不会写 |
| T9 | 门禁失败时 `restart` 仍返回 `restarted` | 让实现返回 `restart_blocked`，断言 `'restarted'` 即红 |
| T10 | 残留文本不可解析 ⇒ `status` 报 `unknown`，**不是** `in_sync` | 把 unknown 折叠成 in_sync，它会变绿 |
| T11 | 同一份不可解析的 plist ⇒ `restart` 不写，`blocked_by:'unparsable'`，字节不变 | 不显式分支时它会走进重写 |
| T12 | **分类全覆盖**：枚举 `daemonEnv` 所有 key 来源（`PATH`、`CCMEM_DATA_ROOT`、`CCMEM_CLAUDE_P_COMMAND`、`passthroughKeys`、`DAEMON_ENV_PASSTHROUGH`），每个 key 必须归入三桶之一 | 往任一来源加一个未分类 key，它必须红 |

**T8 是 T3–T7 与 T11 的正面对照**，按 dogfood §六「反面的"什么都没发生"需要正面对照」配的。
**T6 自带正面对照**（凭据值 0 命中 / key 名 ≥1 命中），按同一条纪律。

**每条测试必须先被亲眼看着变红，且确认红的原因是预期的那个**（不是表名写错、不是桩没回调）。

**附录 A 新增不变量 #143**：
*`restart` 只在**字节不等、轴 ① 可解析、G1–G4 全过**时重写 plist；
其余一切情形（字节相等 / `unknown` / 任一门不过）plist 字节不变，且 restart 仍成功。*

（**注意措辞**：条件是字节不等，**不是** `status === 'drifted'`。
`status` 属报警轴，`in_sync` 时照样可能要写——把这条写成 `drifted` 就复刻了初稿那个错。）

附录 A **无 runner，是人工 checklist**，所以按既定做法：
**镜像文件 + 单独回退本条修复 + 看它变红**，不靠"看起来对"。

## 九、明确不做

- 不改 `installDaemon()` 的**行为**。**但要改它的一行调用**（人类裁决 2026-08-03）：
  `:526` 现在直接调 `renderDaemonPlist(...)`，而 `renderPlist()`（`:336-342`）又自己拼一遍同样三行。
  今天逐字相同，但**它们是两处**——谁改了一边没改另一边，drift 检测就在和一个错的基准比，
  而且不会有任何症状。改成 `installDaemon` 复用 `renderPlist()`，一处求值。
  这比加一条"断言两者相等"的测试更彻底：不是去测分歧，是让分歧无法存在。
- 不给 `diagnose` 接线（输出面限定 `status` + `restart`）。
- 不动 `buildDaemonEnv()` 的白名单内容。
- 不碰 Finding 15（v0.14 分析线的闸门，需人类裁决取样方式）。

## 十、验收判据

1. `npm test` 全绿，且**基线数在动代码前先量过**
   （必须同时钉 `CCMEM_DATA_ROOT` 与 `-u CCMEM_CONFIG_PATH`，缺一会读到含 API key 的真实配置）。
2. T1–T12 **及 T2b**（共 13 条）每条都被看着变红过，红因确认无误。
3. 不变量 #143 用镜像文件验过红。
4. **实测复核影响面，不用读码结论**：真实执行 `install` →
   往 `buildDaemonEnv()` 加一个**自由变**测试 key（**临时改动，不提交**——
   §九"不动白名单内容"指的是不提交白名单变更，取证用的临时 key 用完即还）→
   `restart` → 检查磁盘 plist，确认修复前不重生成、修复后重生成。
   （Finding 5 被读码推断误判过两次，此步不可省。）
   **取证只 grep key 名，不打印 plist 内容、不落盘、不进任何文档**
   ——本机那份 plist 按 §二 事实 1 很可能含 Anthropic 凭据。
5. 任何 0 计数配正面对照；不能解释的 0 写"不可判定"。

## 十一、已复核并撤回的担心

**"daemon 自重启会走这条路径，于是每次自重启都尝试改写 plist"** —— **不成立，已核**。
`restartDaemon` 的唯一调用点是 verb 分发（`:722-723`）；
`scripts/daemon/self-restart.mjs` 不经过它。记在这里，免得下一轮有人重新怀疑一遍。
