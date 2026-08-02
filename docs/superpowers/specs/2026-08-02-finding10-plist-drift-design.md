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

> ### 自动重写的实际覆盖面比初稿描述的窄，这一点必须写在这里
>
> 按 §六 的 G2 加 §四 的分类，Finding 9 那类修复**两条路都传播不到既有安装**：
>
> - 操作者 shell **没有**导出 `CCMEM_CONFIG_PATH`（`scripts/lib/config.mjs:296-298`
>   写明这是常态：该变量无任何持久来源）⇒ 新 env 里没有这个 key，重写与否都一样；
> - 操作者 shell **导出了**真实覆盖路径 ⇒ 有效配置文件改变 ⇒ **G2 拦下，仍不写**。
>
> 留给自动重写的实际场景只剩：`PATH` 刷新、node 路径刷新、模型类变量、
> 以及未来新增的**非指向非凭据类** key。
>
> **这不是缺陷，G2 拦得对**——拦下来还报警，强过悄悄改指。
> 但它意味着本特性的主要价值落在**检测与报警**上，自动重写是较窄的附赠。
> 人类在知情后（2026-08-03）仍选择保留带门禁的重写。

## 四、key 分类

**分类原则（人类裁决 2026-08-03，选项 D）：**

> **凡决定"daemon 用谁的身份、把数据发到哪、读哪个文件"的 key，值不得静默变；
> 凡只决定"怎么做"（模型、超时、参数、本地 `PATH`）的 key，自由变。**

| 桶 | key | 处理 |
|---|---|---|
| **指向类** | `CCMEM_DATA_ROOT`、`CCMEM_CONFIG_PATH` | 值不得变；**打印新旧值**（本地路径，人要看见改指到哪） |
| **指向类** | `ANTHROPIC_BASE_URL`、`ANTHROPIC_FOUNDRY_BASE_URL`、`CLAUDE_CODE_USE_FOUNDRY` | 值不得变；**只打 key 名** |
| **凭据类** | `ANTHROPIC_API_KEY`、`ANTHROPIC_FOUNDRY_API_KEY` | 值不得变；**只打 key 名，永不打值** |
| **自由变** | `PATH`、node 路径、`CCMEM_CLAUDE_P_COMMAND`、`CCMEM_CLAUDE_P_ARGS_JSON`、`CCMEM_CLAUDE_P_TIMEOUT_MS`、`ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET}_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` | 不拦，只报告 |

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

**慢路**（仅在不相等时走）：解析范围**只限我们自己渲染的那段**：

1. 截出 `<key>EnvironmentVariables</key><dict>` 到其配对 `</dict>` 之间的文本；
2. 按 `renderEnvDict`（`:301`）的固定形状抽 `<key>K</key><string>V</string>` 对；
3. 反转义 `escapeXml`（`:362`）的五个实体（`&amp; &lt; &gt; &quot; &apos;`）。

**若该区间内有任何未被匹配吃掉的非空白残留，判定为 `unknown`，不得判 `in_sync`。**
手改过的、或旧格式的 plist 属于"不可判定"——不能从解析不出来推出"没有 drift"。

**检测必须与门禁用同一套分类。**
`PATH` 取自调用方 shell 且会前插 `claudeBinDir`（`:50`、`:60-62`），
换个终端 / tmux / cron 跑一次 `status` 就会不同。
若自由变 key 的差异也计入判定，`status` 会**常态报 `drifted`**，
把新加的报警训练成噪声——正是 Finding 2 警告过的读法。因此：

- **只有指向类 / 凭据类 / key 增删** 参与 `status` 三态判定；
- **自由变 key 的差异单列 `benign_changed`**，不影响三态。

**检测三态**：`in_sync` / `drifted` / `unknown`。
`unknown` 时 `added` / `removed` / `changed` / `benign_changed` **一律为空数组，不缺省**
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
| 无 | stray 但文件不存在 | 相同 | 放行——正确，`loadConfig:307` 本就回落默认，daemon 读的没变 |
| 有 X | 无 | 不同 | G1 与 G2 双拦 |

### 边界语义（必须实现成显式分支，不能靠"应该不会发生"）

- **检测为 `unknown` ⇒ 不写**，`blocked_by: 'unparsable'`。
  解析不出旧 env 就判不了 G1–G3（**此处的 G1–G3 不是笔误**：这三门都要拿旧 env 作比，
  G4 只看新 env，但旧的判不了就已经不能写了），此时重写等于在看不见的前提下改配置。
- **检测为 `in_sync` ⇒ 不写**，`blocked_by: null`、`written: false`。没有差异就没有要写的东西。
  （只有 `benign_changed` 非空也算 `in_sync`，同样不写。）
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
plist_drift: { status, added: [...], removed: [...], changed: [...], benign_changed: [...] }
```

`daemon restart` 在此之上多一段：

```
plist_rewrite: {
  written: bool,
  blocked_by: 'G1'|'G2'|'G3'|'G4'|'unparsable'|null,
  reason: string        // 单行人类可读；不含任何值，除下述唯一例外
}
```

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
| T2 | **只有 `PATH` 不同** ⇒ `status` 仍 `in_sync`，`PATH` 落 `benign_changed` | 不做分类时它会报 `drifted` |
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
*`restart` 只在检测为 `drifted` 且 G1–G4 全过时重写 plist；
其余一切情形（`in_sync` / `unknown` / 任一门不过）plist 字节不变，且 restart 仍成功。*

附录 A **无 runner，是人工 checklist**，所以按既定做法：
**镜像文件 + 单独回退本条修复 + 看它变红**，不靠"看起来对"。

## 九、明确不做

- 不改 `installDaemon()` 的行为。
- 不给 `diagnose` 接线（输出面限定 `status` + `restart`）。
- 不动 `buildDaemonEnv()` 的白名单内容。
- 不碰 Finding 15（v0.14 分析线的闸门，需人类裁决取样方式）。

## 十、验收判据

1. `npm test` 全绿，且**基线数在动代码前先量过**
   （必须同时钉 `CCMEM_DATA_ROOT` 与 `-u CCMEM_CONFIG_PATH`，缺一会读到含 API key 的真实配置）。
2. T1–T12 每条都被看着变红过，红因确认无误。
3. 不变量 #143 用镜像文件验过红。
4. **实测复核影响面，不用读码结论**：真实执行 `install` →
   往 `buildDaemonEnv()` 加一个**自由变**测试 key → `restart` → 检查磁盘 plist，
   确认修复前不重生成、修复后重生成。
   （Finding 5 被读码推断误判过两次，此步不可省。）
   **取证只 grep key 名，不打印 plist 内容、不落盘、不进任何文档**
   ——本机那份 plist 按 §二 事实 1 很可能含 Anthropic 凭据。
5. 任何 0 计数配正面对照；不能解释的 0 写"不可判定"。

## 十一、已复核并撤回的担心

**"daemon 自重启会走这条路径，于是每次自重启都尝试改写 plist"** —— **不成立，已核**。
`restartDaemon` 的唯一调用点是 verb 分发（`:722-723`）；
`scripts/daemon/self-restart.mjs` 不经过它。记在这里，免得下一轮有人重新怀疑一遍。
