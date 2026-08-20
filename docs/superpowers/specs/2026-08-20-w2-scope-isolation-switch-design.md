# W2 设计：scope 隔离降级开关（评测专用）

> 写作时点 **2026-08-20**，人类同日 brainstorming 裁决了三条口径（§三）。
> **2026-08-21 按代码评审改过一轮**：2 条 Critical、5 条 Important、6 条 Minor，逐条处置见 §十。
> **本设计一行代码未写**，且测量窗口仍开着 ⇒ **落地时机见 §七**。
> 结论**逐处复核过源码**：`scripts/lib/retrieval.mjs`、`scripts/lib/injection-cache.mjs`、
> `scripts/handlers/session-start.mjs`、`scripts/handlers/prompt-submit.mjs`、
> `scripts/lib/trust.mjs`、`scripts/lib/config.mjs`、`scripts/migrations/001_initial.sql`。
> ⚠️ **真实路径是 `scripts/lib/…`，不是 `lib/…`** —— handoff ⅩⅢ.4 原文写的是后者，会让人找不到文件。

## 一、要解决的问题

`S-SCOPE-03` 结构性不可判别：`C-NAIVE` 本该是"没有 scope 隔离"的控制组，
但产品在检索与注入两条通道上都**硬编码**了隔离谓词 ⇒ `C-NAIVE` 与 `C-FULL` 跑出来必然相同。

新增 `eval.disable_scope_isolation`（默认 `false`，**行为零变化**），
打开后让本机的跨项目记忆对检索与注入都可见，使 `C-NAIVE` 成为真控制组。

## 二、🔴 更正 ⅩⅢ.4 关于 injection-cache 的那段（理由错，结论也跟着错）

**ⅩⅢ.4 原话**：真正决定"什么记忆进得了缓存"的是生产者 `injection-cache.mjs:42`
（`scope='project' AND project_key=?`，**"比 retrieval 四处更严，连 global 都不含"**）⇒ **"只改消费者必然无效"**。

**实测（逐行读源码）**：

1. `rebuildInjectionCache(db, projectKey)` 跑**两条** SELECT、写**两行**：
   `:13-20` 取**全部 global 记忆** → 写成 `scope = 'global'`（`:31`）；
   `:37-45` 取本项目记忆 → 写成 `scope = 'project:<key>'`（`:56`）。
   ⇒ **`:42` 不是"更严、连 global 都不含"**，global 由**另一条查询**进了**另一行**。
   拿 `:42` 单独去比 retrieval 的 `(scope='global' OR project_key=?)`，是**拿一半比一个整体**。
2. `injection_cache` 的 DDL 是 **`scope TEXT PRIMARY KEY`**（`001_initial.sql:49-53`），
   存的是**按 scope 预渲染好的整块文本**（`rendered_text`），**不是行级过滤**。
3. 消费者 `session-start.mjs:65-70` 绑的是 `` `project:${projectKey}` ``，**读恰好两行**；
   且它是**全仓唯一的 `injection_cache` 读者**（另一处引用是 `admin/alias.mjs:41` 的 `DELETE`）
   ⇒ "覆盖消费者"确实只有一处。

⇒ **结论反过来**：把消费者改成"读全部行"**是有效的** ——
会把其他项目的 `project:*` 块一起拼进注入文本。
**限制是它只对"曾被 rebuild 过、因而存在缓存行"的项目有效**（见 §六 风险 2）。

⇒ 而**动生产者代价极高**：它**没有"去掉一个谓词"这种改法**（缓存按 scope 主键存整块文本），
要支持"不隔离"就得**发明一个新的缓存键**（如一行 `'all'`），
还要让 **15 个 `rebuildInjectionCache` 调用点**决定何时重建它
（`security-audit.mjs:219,222`、`monthly-meta-synthesis.mjs:108`、`weekly-synthesis.mjs:461`、
`resurrect.mjs:421,425`、`forget.mjs:18`、`save.mjs:151`、`pin.mjs:17`、`promote.mjs:79`、
`alias.mjs:40`、`tier15.mjs:203,206`、`revalidation.mjs:145,148`；按 global/project 的 if-else 对
折算则是 11 个逻辑点。**都不是 13** —— 本文初稿写 13 是错的，已更正，handoff 里那个错数也一并改了）。

⇒ **真正的取舍不是"消费者还是生产者"，而是"要不要覆盖 session-start"。**
**要覆盖，消费者是唯一合理的点。**

📌 handoff ⅩⅢ.4 已按本节**就地更正**（不是在新章节宣布）。

## 三、人类裁决的四条口径

| # | 裁决 | 关键理由 |
|---|---|---|
| 1 | **覆盖 retrieval 四处谓词 + `session-start.mjs:68` 消费者**；**不动 injection-cache 生产者** | 这两条才是真正决定"什么进模型"的通道；生产者要改缓存键设计，远超"加一个默认关闭的开关" |
| 2 | **判据②落成仓内集成测试**，不等 harness | `S-SCOPE-03` 只有 fixtures 没有 runner，唯一那条 runner 跑的还是止于 v0.12 的 `reference/ccmem` 快照 |
| 3 | **加一行 stderr 警告**，照 `SHADOW_NOTICE` 现成 pattern | `diagnose` 要人主动跑才看得见；这套工具链静默失败远多于大声失败 |
| 4 | 🆕 **开关打开时抑制 feedback 写入**（2026-08-21 裁决） | 见 §4.6：不抑制的话，开关会**持久改写别的项目的记忆**，且关回开关也撤不回 |

### 3.1 🔴 父 spec 那个问题今天**答不了**，这里是用裁决替代了它

`docs/ccmem-v0.14-spec.md:106-108` 要求实现计划**显式回答**
"session-start / injection-cache 要不要一并覆盖，取决于评测 harness 实际触发哪些 hook"，
并明说**不许把"四处"当成穷举**。

**本设计没有回答那个问题，而是替换了它**：裁决 2 已确认 `S-SCOPE-03` **根本没有 runner**
⇒ "harness 实际触发哪些 hook"**今天不存在事实**，问题**不可回答**。
⇒ 覆盖面改由**架构理由**决定（哪两条通道真正决定"什么进模型"），由人类裁决 1 拍板。

⚠️ **这是替换，不是回答。** 写在这里免得后人以为父 spec 的要求已被满足。
快照刷新、runner 补齐之后，**覆盖面应当按那时的事实重审一次**。

## 四、设计

### 4.1 配置键

`eval.disable_scope_isolation`，默认 `false`。
**同时加进 `DEFAULT_CONFIG`（`scripts/lib/config.mjs`）与 `config.default.json`**（值级 parity）。

✅ **实测无冲突**：`DEFAULT_CONFIG` 里**没有 `eval` 段**；
`mergeConfig`（`config.mjs:284-289`）是**递归深合并**
（`merged[key] = key in merged ? mergeConfig(merged[key], value) : structuredClone(value)`）
⇒ 用户 config 里写别的 `eval.*` 键**不会**把本键顶掉。

🔴 **读法一律 `=== true`，不许写 `!== false`。**
同一个 `retrieval.mjs` 里 `config?.retrieval?.like_fallback?.enabled !== false`（`:275`、`:411`）是相反写法 ——
**这里故意不跟（Rule 11 的例外，明写在此以免被后人"修正"回去）**：
`!== false` 会让任何拼写错误、类型意外、`undefined` 都**关掉隔离**，**fail-safe 方向是反的**。
本开关的安全默认是"隔离开着"，所以只有**显式 `true`** 才降级。

### 4.2 🔴 谓词处 ≠ 接线处（初稿在这里错过一次，别再错）

**初稿写"五个站点"，把 SQL 谓词处数当成了接线处数** ——
结果漏掉 `retrieveMemories` 里**自己复制的一份 lexical 块**，
照初稿实现会让开关在 FTS 与 LIKE 两条 lane 上**是哑的**。**两张表必须分开看。**

**表 A —— 要去掉谓词的地方（4 + 1）**

| # | 位置 | 函数 | 关掉隔离时 |
|---|---|---|---|
| 1 | `retrieval.mjs:131` | `ftsSearch`（`:120`） | 整条 `AND (m.scope='global' OR m.project_key=?)` 去掉 |
| 2 | `retrieval.mjs:150` | `likeSearch`（`:139`，**已 export**） | 整条 `WHERE (scope='global' OR project_key=?)` 去掉 |
| 3 | `retrieval.mjs:170` | `legacySubstringSearch`（`:159`） | 同上 |
| 4 | `retrieval.mjs:430` | `retrieveMemories`（`:333`）内向量候选 | 整条 `AND (scope='global' OR project_key=?)` 去掉 |
| 5 | `session-start.mjs:68` | session-start 消费者 | 整条 `WHERE scope='global' OR scope=?` 去掉 ⇒ 读全部行 |

**表 B —— 要把布尔接进去的地方（7）**

| # | 位置 | 说明 |
|---|---|---|
| 1 | `lexicalRetrieve`（`:272`）→ `ftsSearch`（`:273`） | 已有 `config`，由它算出布尔 |
| 2 | `lexicalRetrieve` → `likeSearch`（`:278`） | 同上 |
| 3 | `lexicalRetrieve` → `legacySubstringSearch`（`:288`） | 同上 |
| 4 | 🔴 **`retrieveMemories:409` → `ftsSearch`** | **不经过 `lexicalRetrieve`** |
| 5 | 🔴 **`retrieveMemories:414` → `likeSearch`** | **不经过 `lexicalRetrieve`** |
| 6 | `retrieveMemories:430` 内联向量查询 | 直接读 |
| 7 | `session-start.mjs` 的 SELECT | 直接读（位置见 §4.3） |

🔴 **表 B 第 4、5 条是初稿漏掉的那两处，也是最要命的两处**：
`retrieveMemories` 在**嵌入可用**时（`retrievalPath: 'A'`，**正常配置、也正是 `S-SCOPE-03` 跑的那条**）
**复制了一份 lexical 块**，只在嵌入关闭（`:370`）或 embed 失败（`:394`）时才回落进 `lexicalRetrieve`。
⇒ **只接 `lexicalRetrieve` 的实现，在真实评测路径上开关完全不生效。**
⇒ 建议 `retrieveMemories` **在函数开头算一次布尔**，供第 4、5、6 三处共用。

### 4.3 布尔的名字与两个 helper 的可见性

- 🔴 **布尔命名 `disableScopeIsolation`，不叫 `crossProject`。**
  仓内已有一个**无关**的 `config.cross_project` 域（`config.mjs:108-122`、
  `daemon/tasks/cross-project-patterns.mjs`、`daemon/loop.mjs:186` 的 `crossProjectCfg`），
  那是"把重复记忆提升为 global"的 daemon 审计。**同名会把读者引到错的配置段。**
- 🔴 **`ftsSearch`（`:120`）与 `legacySubstringSearch`（`:159`）没有 export** ——
  只有 `likeSearch` 有。判据 2 要"逐条直调 helper"就**必须给这两个加 export**。
  ⇒ **明写为一项已知代价**：本改动**会加宽 `retrieval.mjs` 的公开面（test-only surface）**。
  §4.2 那句"加参数零破坏"只对**参数**成立，**对可见性不成立**。

### 4.4 session-start 的三处细节

1. **`loadConfig()` 必须上移。** 现在它在 `:89`（`:90` 用它），而要改的 SELECT 在 `:65-70`
   ⇒ **`config` 在需要它的地方还不在作用域里**。必须把 `loadConfig()` 提到 SELECT 之前。
   ⚠️ **上移会跨过 `mode === 'shadow'` 的提前 return（`:73-76`）** ⇒
   今天 shadow 模式**从不调用 `loadConfig()`**，上移后会调用，
   而 `loadConfig` 对畸形 `config.json` 会抛 `ConfigError`（`config.mjs:330`）
   ⇒ **shadow 模式会新增一种失败方式。**
   **裁决（本设计作者，非人类裁决）：接受并明写。** 理由：畸形到会抛的 `config.json`
   本来就会让所有非 shadow 会话失败，**shadow 模式在坏配置上静默成功本身就是一种静默失败**。
2. **确定性排序。** 现有 `ORDER BY CASE WHEN scope='global' THEN 0 ELSE 1 END`
   在只读两行时够用；读全部行之后**多个 `project:*` 之间没有稳定顺序** ⇒ 注入文本拼接顺序不确定
   ⇒ **评测不可复现**。⇒ 加 `, scope` 作次级排序，**与开关无关，两种状态下都成立**。
   ✅ **这不破坏"默认路径零行为变化"**：带 `WHERE` 时最多两行，且分属两个不同的主排序桶
   （`scope` 是 PRIMARY KEY ⇒ `'global'` 至多一行、`project:<key>` 至多一行）
   ⇒ **次级键永远不会被用到**。
3. **stderr 警告的触发规则（钉死，别留给实现者猜）**：
   **当且仅当跨项目查询真的跑了，才报警。**
   - `mode === 'off'`：`:60-62` 提前 return，**查询根本没跑** ⇒ **不报**。
   - `mode === 'shadow'`：查询在 `:65`，**在 shadow 的 return（`:73`）之前就跑了**
     ⇒ **跨项目行确实被读了** ⇒ **要报**。此时保持沉默等于撒谎。
   常量放在 `SHADOW_NOTICE` 旁边、照它的写法（`process.stderr.write(...)`，
   仓内既有 pattern：`session-start.mjs:9,74`、`stop.mjs:8,17`、`prompt-submit.mjs:11,46`）。

⚠️ **警告只在 `session_start` 报，不在 `prompt_submit` 报**（后者每 prompt 一次太吵）。
⚠️ **它落在 stderr，不进 `additionalContext`**，不改变注入内容。
⚠️ **`retrieveMemories` 还有两个 `session_start` 之外的调用者** ——
`scripts/lib/cmd/list.mjs:37`（`ccmem list --query`）与 `scripts/lib/admin/retrieval-check.mjs:36`，
两者都传 `loadConfig()` ⇒ **开关打开时它们同样跨项目，且都不会报这行警告**。别当成 bug 重新发现一次。

### 4.5 diagnose 上报：**W2 不写一行 diagnose 代码**

`admin/diagnose.mjs` 的"报告非默认配置"能力**归 W0**（人类 2026-08-20 裁决）。
W0 是**通用**的值级 diff ⇒ 本键一旦存在于 `DEFAULT_CONFIG`，W0 自动接住，**W2 零工作量**。

⚠️ **但别高估它**：W0 的默认 `diagnose` 输出只有**计数**
（`ccmem: config 1 non-default keys, 0 unknown keys`，W0 设计 `:121-131`），
**键名只在 `ccmem admin diagnose --config` 下才出现**（`:132-142`）。
⇒ **跑普通 `diagnose` 的人只知道"有东西非默认"，不知道"跨项目隔离关着"。**
⇒ **按名字点出这件事的唯一信号是 §4.4 那行 stderr 警告。**

⚠️ **v0.14 spec `:111` 那句"这是 W2 的一部分真实工作量"已作废**，落地时要就地改掉（见判据 5）。

### 4.6 🆕 C2：开关打开时**抑制 feedback 写入**（人类 2026-08-21 裁决）

**问题（实测）**：开关打开后，检索结果里会含**其他项目的记忆 id**，而这些 id 会流进写入路径：

- `prompt-submit.mjs:89-116`：把 `injectedIds` **无条件**写进 `recent_injections`
  （`writeRecentInjection`）**和** `memory_feedback`（`outcome='unknown'`）。
- `session-start.mjs:80-83`：`injectedIds` 是 `rows.flatMap(parseMemberIds)`
  ⇒ 开关打开时就是**每个项目的 `member_ids`**。
- 这些 id 之后由 feedback 结算路径交给 `trust.mjs:18-54` 的 `adjustTrust`，它执行
  `UPDATE memories SET trust_score = …, helpful_count = …, last_touched_at = ? WHERE id = ?`
  —— **没有任何 scope 或 project 校验**。

⇒ **精确的效力**：`recent_injections` / `memory_feedback` 里的外来 id 是**立即且无条件**写入；
`trust_score` / `last_touched_at` 的改动发生在**那些 feedback 行被结算时**。
**两者都不会因为把开关关回 `false` 而撤销。**
而 `last_touched_at` 喂给衰减与注入排序 ⇒ **污染不是装饰性的。**

> 🔴 **裁决（人类 2026-08-21）**：`disableScopeIsolation` 为 true 时
> **不写 `recent_injections`、不写 `memory_feedback`** —— 两个 handler 都是。
> 理由：开关的定位是**只读降级**，它不该有持久副作用；且评测本身不需要 feedback 回路。

⚠️ **这条把 `prompt-submit.mjs` 拉进了 W2 的改动范围** —— §八原本写着"不改 prompt_submit"，**已作废**。

## 五、验收判据

1. **不变量**：`DEFAULT_CONFIG.eval.disable_scope_isolation === false`，且 `config.default.json` 同键同值。
2. **谓词逐处生效**（临时 DB 播项目 A、项目 B 各一条记忆 + 一条 global）：
   - 关：只见自己项目 + global；**开：见得到另一个项目的那条**。
   - 三条 lexical lane **逐条直调 helper** 断言（需先 export 两个，见 §4.3）。
   - **向量 lane（`:430`）单独一条断言** —— 不在三个 helper 里，上面任何一条都覆盖不到。
   - session-start：断言**行集与顺序**两者。
3. 🔴 **端到端必须钉死走的是 `retrievalPath === 'A'`。**
   跨项目那一例要**在嵌入 lane 活着的状态下**跑，并**显式断言 `retrievalPath === 'A'`**。
   ⚠️ **理由写进测试注释**：不钉死路径的话，无 provider 的测试会走 `:370` 回退进 `lexicalRetrieve`
   —— 那是被覆盖的那条路 ⇒ **判据对 §4.2 表 B 第 4、5 条那种漏接线是结构性失明的**。
   这一条正是为了让那种漏接**大声红掉**（Rule 9：测试要编码 WHY）。
4. 🆕 **feedback 抑制**：开关打开跑一次检索后，`recent_injections` 与 `memory_feedback`
   **零新增行**；关闭时**照常新增**。
5. **stderr 警告**：`mode` 正常时开→有、关→无；**`mode === 'shadow'` 时开→仍要有**；
   **`mode === 'off'` 时开→没有**（查询没跑）。
6. **文档同步**：`docs/ccmem-v0.14-spec.md:111` 那句"这是 W2 的一部分真实工作量"**已就地改掉**
   （验证方式：grep 原措辞**必须无输出**）。
7. **默认路径零行为变化**，两个已知例外**已论证为非行为性**：
   §4.4-2 的 `ORDER BY` 次级键在默认路径永不被用到；
   §4.4-1 的 `loadConfig()` 上移**只**在"畸形 config.json + shadow 模式"这一组合下可见。

⚠️ **判据 2 的"逐条直调"与判据 3 的"端到端"分工不许合并**：
只做端到端 ⇒ 三条 lane 里只有一条真被执行；只做直调 ⇒ 测不到布尔有没有串通。

## 六、风险

1. 🔴 **向量 lane 的测试比另外四处重**：要造 `embedding` + `embedding_sig` 并绕开真实 provider。
   若实现时发现必须引入 provider stub，**那是计划里单独的一步**，
   **不许悄悄降级成"只断言 SQL 字符串"** —— 那正是 review 在 `:430` 撞到过的"做完了但不起作用"。
   📌 判据 3 要求端到端断言 `retrievalPath === 'A'`，**这两条是同一个 provider stub 的两个用户**。
2. ⚠️ **session-start 的覆盖是不完全的**：只对**存在缓存行**的项目有效
   （缓存行由 15 个 `rebuildInjectionCache` 调用点在写入/维护时产生）。
   ⇒ **评测报告里必须写出这条**，不许把"读了全部行"读成"看见了全部项目"。
   ⚠️ **附带的注入体积问题**：`render.mjs:20` 让每块 `rendered_text` 都以
   `=== ccmem: stable context ===` 开头，且 `renderStableContext` 从不返回空串
   ⇒ `session-start.mjs:71` 的 `filter(Boolean)` 什么都滤不掉
   ⇒ **N 个缓存项目就有 N+1 份表头**，还包括"有缓存行但已无存活记忆"的空块。
   **开关打开时这会吃掉注入 token 预算，而评测正好在量这个。**
3. ⚠️ **测试隔离有两条现成 pattern，计划里挑一条，别自己发明**：
   (a) 模块级 `mkdtemp` + 覆盖 `process.env.CCMEM_DATA_ROOT`；
   (b) **`process.env.CCMEM_CONFIG_PATH` 指向临时配置文件 + save/restore** ——
   `loadConfig` 优先读它（`config.mjs:317-318`），仓内 16 个测试文件在用，
   且 `npm test` 跑的是 `env -u CCMEM_CONFIG_PATH` ⇒ 起点保证干净。
   📌 **(b) 更轻**：它**完全不碰共享的数据根**，而 `npm test` 全轮共用一个 `CCMEM_DATA_ROOT`。
4. ⚠️ **本开关是新的攻击面**：它能关掉跨项目隔离。缓解分两类，**别把两类混为一谈**：
   - **可见性**：默认 `false` + `=== true` 的 fail-safe 读法 + 不变量测试钉死默认值 +
     stderr 警告（**唯一按名字点出它的信号**）+ W0 的 `--config` 上报（**默认输出只有计数**）。
   - **持久性**：§4.6 的 feedback 抑制。**这一类初稿完全没有**，是评审补上的。

## 七、依赖与时序

- **落地时机**：测量窗口关闭之后（v0.14 spec §三）。**窗口期内一行代码都不写。**
- **顺序**：**W0 先落**（它是 W1 判据 4 的前置件），再 W1，再 W2。
  本设计**不依赖 W1**，但 W1 先落可避免两次改 `DEFAULT_CONFIG` 撞车。
- **执行方式**：`superpowers:subagent-driven-development`（人类 2026-08-19 选定）。

## 八、明确不做

- **不动 `injection-cache.mjs` 生产者**，不新增 `'all'` 缓存键（§二）。
- **不写 `S-SCOPE-03` 的 runner**，不碰 paper 仓库，不刷 `reference/ccmem` 快照。
- **不在 `admin/diagnose.mjs` 写一行**（归 W0）。
- **不做每站点独立开关** —— 一个布尔覆盖全部，YAGNI。
- ~~**不改 `prompt_submit`**~~ ⇒ **已作废**：§4.6 的 feedback 抑制要动它。
- **不给 `adjustTrust` 加 scope 校验** —— 那是产品行为的改动，不在本开关范围内；
  §4.6 是从源头掐断，不是去修 `trust.mjs`。

## 九、效力边界

- §二、§四的所有结论**都是逐行读源码得到的**，不是推断；评审又独立复核了一遍。
- **行号是写作当时的，会漂** —— 实现时按**函数名/符号名**找（两张表每行都给了函数名）。
- 🔴 **本设计过程中未跑任何测试**（全量与单文件都没有）⇒ **spec 里的代码构想一行都没被执行过。**
  执行时按 TDD 步骤走，**别假设它们能直接跑通**。
- **判据 2/3 的"另一个项目可见"只证明 SQL 谓词被关掉了**，
  **不证明 `C-NAIVE` 与 `C-FULL` 在评测里真的会分开** —— 那要等快照刷新后在 paper 仓库验（§3.1）。

## 十、评审处置（2026-08-21）

| 级别 | findings | 处置 |
|---|---|---|
| Critical | C1 漏了 `:409`/`:414` 两处接线，判据结构性失明 | §4.2 拆成表 A/表 B；判据 3 新增 `retrievalPath === 'A'` 断言 |
| Critical | C2 开关会持久改写别的项目的记忆 | §4.6 新增，人类裁决抑制 feedback 写入；判据 4 新增；§八 作废一条 |
| Important | I1 两个 helper 没 export，判据 2 写不出来 | §4.3 明写为已知代价（加宽公开面） |
| Important | I2 `loadConfig()` 上移会跨过 shadow 的提前 return | §4.4-1 明写，并给出裁决与理由 |
| Important | I3 stderr 警告在 off / shadow 两态下的行为未定 | §4.4-3 钉死"查询真跑了才报" |
| Important | I4 高估了 W0 的缓解力（默认只有计数） | §4.5 与 §六 风险 4 改写 |
| Important | I5 父 spec 那个问题被替换而未说明 | §3.1 新增 |
| Minor | M1 调用点是 15 不是 13 | §二 更正，handoff 同步 |
| Minor | M2 `crossProject` 与既有 `config.cross_project` 撞名 | §4.3 改名 `disableScopeIsolation` |
| Minor | M3 测试隔离还有更轻的 `CCMEM_CONFIG_PATH` 一路 | §六 风险 3 两条并列 |
| Minor | M4 v0.14 spec 的就地改动没有判据兜着 | 判据 6 新增 |
| Minor | M5 `retrieveMemories` 另有两个调用者 | §4.4 末尾补 |
| Minor | M6 注入文本会重复 N+1 份表头 | §六 风险 2 补 |
