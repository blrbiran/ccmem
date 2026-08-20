# W2 设计：scope 隔离降级开关（评测专用）

> 写作时点 **2026-08-20**，人类在同日 brainstorming 里裁决了三条口径（§二）。
> **本设计一行代码未写**，且测量窗口仍开着 ⇒ **落地时机见 §七**。
> 结论**逐处复核过源码**：`scripts/lib/retrieval.mjs`、`scripts/lib/injection-cache.mjs`、
> `scripts/handlers/session-start.mjs`、`scripts/migrations/001_initial.sql`。
> ⚠️ **真实路径是 `scripts/lib/…`，不是 `lib/…`** —— handoff ⅩⅢ.4 写的是后者，会让人找不到文件。

## 一、要解决的问题

`S-SCOPE-03` 结构性不可判别：`C-NAIVE` 本该是"没有 scope 隔离"的控制组，
但产品在检索与注入两条通道上都**硬编码**了隔离谓词 ⇒ `C-NAIVE` 与 `C-FULL` 跑出来必然相同。

新增 `eval.disable_scope_isolation`（默认 `false`，**行为零变化**），
打开后让本机的跨项目记忆对检索与注入都可见，使 `C-NAIVE` 成为真控制组。

## 二、🔴 更正 ⅩⅢ.4 关于 injection-cache 的那段（理由错，结论也跟着错）

**ⅩⅢ.4 原话**：真正决定"什么记忆进得了缓存"的是生产者 `injection-cache.mjs:42`
（`scope='project' AND project_key=?`，**"比 retrieval 四处更严，连 global 都不含"**）⇒ **"只改消费者必然无效"**。

**实测（2026-08-20 逐行读源码）**：

1. `rebuildInjectionCache(db, projectKey)` 跑**两条** SELECT、写**两行**：
   `:16-19` 取**全部 global 记忆** → 写成 `scope = 'global'` 那一行；
   `:40-42` 取本项目记忆 → 写成 `scope = 'project:<key>'` 那一行。
   ⇒ **`:42` 不是"更严、连 global 都不含"**，global 由**另一条查询**进了**另一行**。
   拿 `:42` 单独去比 retrieval 的 `(scope='global' OR project_key=?)`，是**拿一半比一个整体**。
2. `injection_cache` 的 DDL 是 **`scope TEXT PRIMARY KEY`**（`001_initial.sql:49-53`），
   存的是**按 scope 预渲染好的整块文本**（`rendered_text`），**不是行级过滤**。
3. 消费者 `session-start.mjs:64-70` 绑的是 `` `project:${projectKey}` ``，**读恰好两行**。

⇒ **结论反过来**：把消费者改成"读全部行"**是有效的** ——
会把其他项目的 `project:*` 块一起拼进注入文本。
**限制是它只对"曾被 rebuild 过、因而存在缓存行"的项目有效**（见 §六 风险 2）。

⇒ 而**动生产者代价极高**：它**没有"去掉一个谓词"这种改法**（缓存按 scope 主键存整块文本），
要支持"不隔离"就得**发明一个新的缓存键**（如一行 `'all'`），
还要让 **13 个 `rebuildInjectionCache` 调用点**决定何时重建它。

⇒ **真正的取舍不是"消费者还是生产者"，而是"要不要覆盖 session-start"。**
**要覆盖，消费者是唯一合理的点。**

📌 handoff ⅩⅢ.4 已按本节**就地更正**（不是在新章节宣布）。

## 三、人类裁决的三条口径（2026-08-20）

| # | 裁决 | 关键理由 |
|---|---|---|
| 1 | **覆盖 retrieval 四处 + `session-start.mjs:68` 消费者**；**不动 injection-cache 生产者** | 这两条才是真正决定"什么进模型"的通道；生产者要改缓存键设计，远超"加一个默认关闭的开关" |
| 2 | **判据②落成仓内集成测试**，不等 harness | `S-SCOPE-03` 只有 fixtures 没有 runner，唯一那条 runner 跑的还是止于 v0.12 的 `reference/ccmem` 快照 ⇒ 今天答不了；且人类定的顺序是先落优化再刷快照 |
| 3 | **加一行 stderr 警告**，照 `SHADOW_NOTICE` 现成 pattern | `diagnose` 要人主动跑才看得见；这套工具链静默失败远多于大声失败，而这个开关一旦被误开就是跨项目泄漏 |

## 四、设计

### 4.1 配置键

`eval.disable_scope_isolation`，默认 `false`。
**同时加进 `DEFAULT_CONFIG`（`scripts/lib/config.mjs`）与 `config.default.json`**（值级 parity）。

🔴 **读法一律 `=== true`，不许写 `!== false`。**
同一个 `retrieval.mjs` 里 `config?.retrieval?.like_fallback?.enabled !== false` 是相反写法 ——
**这里故意不跟（Rule 11 的例外，明写在此以免被后人"修正"回去）**：
`!== false` 会让任何拼写错误、类型意外、`undefined` 都**关掉隔离**，**fail-safe 方向是反的**。
本开关的安全默认是"隔离开着"，所以只有**显式 `true`** 才降级。

### 4.2 开关怎么送到站点（approach A1）

三个 lexical helper **拿不到 `config`**（实测签名）：

```
ftsSearch(db, ftsQuery, projectKey, limit)              // :120
likeSearch(db, prompt, projectKey, limit)               // :139  (export)
legacySubstringSearch(db, prompt, projectKey, limit)    // :159
```

⇒ **各加一个布尔参数 `crossProject`**。
✅ **实测全仓（`scripts/` 与 `tests/`）在 `retrieval.mjs` 之外没有任何调用者**，加参数零破坏。

- `lexicalRetrieve(db, …, config, …)`（`:272`）已有 `config` ⇒ 由它算出布尔再传给三个 helper。
- `:430` 向量候选查询在 `retrieveMemories(db, prompt, projectKey, config)`（`:333`）内 ⇒ 直接读。
- `session-start.mjs` 内已有 `config`（`:90` 就在用 `config.injection?.file_based`）⇒ 直接读。

**否掉的两条**（写下来免得后人重走）：

- **传 SQL 子句字符串**：把 SQL 拼接扩散到更多地方，为省一个参数换来注入面。
- **用 `projectKey` 哨兵值（`null` / `'*'`）不改签名**：**语义是反的** ——
  `(scope='global' OR project_key = ?)` 传 `null` 会退化成**只剩 global**，比隔离还严；
  且哨兵值会污染 `renderRow`、缓存键等一切用 `projectKey` 的地方。

### 4.3 五个站点的行为

| 站点 | 函数 | 关掉隔离时 |
|---|---|---|
| `retrieval.mjs:131` | `ftsSearch` | 整条 `AND (m.scope='global' OR m.project_key=?)` 去掉 |
| `retrieval.mjs:150` | `likeSearch` | 整条 `WHERE (scope='global' OR project_key=?)` 去掉 |
| `retrieval.mjs:170` | `legacySubstringSearch` | 同上 |
| `retrieval.mjs:430` | `retrieveMemories` 内向量候选 | 整条 `AND (scope='global' OR project_key=?)` 去掉 |
| `session-start.mjs:68` | session-start 消费者 | 整条 `WHERE scope='global' OR scope=?` 去掉 ⇒ 读全部 `injection_cache` 行 |

🔴 **子句与 bind 参数必须成对构造**（同一处代码同时产出 SQL 片段与参数数组）。
**这五处真实的 bug 面就是"去掉了谓词、忘了去掉参数"** —— better-sqlite3 会因参数个数不符抛错，
但若某处恰好还有别的 `?`，就会**静默绑错列**。

🔴 **`session-start.mjs` 必须补确定性排序。**
现有 `ORDER BY CASE WHEN scope='global' THEN 0 ELSE 1 END` 在只读两行时够用；
读全部行之后**多个 `project:*` 之间没有稳定顺序** ⇒ 注入文本的拼接顺序不确定 ⇒ **评测不可复现**。
⇒ 加 `, scope` 作次级排序。**这一条与开关是否打开无关，两种状态下都要成立。**

### 4.4 运行时信号

`crossProject` 为 true 时，`session-start` 写**一行 stderr 警告**，
常量放在 `SHADOW_NOTICE` 旁边、**照它的写法**（`process.stderr.write(...)`，已是仓内既有 pattern）。

- **只在 `session_start` 报，不在 `prompt_submit` 报** —— 后者每个 prompt 一次，太吵。
- ⚠️ **它落在 stderr，不进 `additionalContext`**，不改变注入内容。

### 4.5 diagnose 上报：**W2 不写任何代码**

`admin/diagnose.mjs` 的"报告非默认配置"能力**归 W0**（人类 2026-08-20 裁决）。
W0 是**通用**的值级 diff ⇒ **本键一旦存在于 `DEFAULT_CONFIG`，W0 自动接住，W2 零工作量。**
⚠️ **v0.14 spec §二 W2 那句"这是 W2 的一部分真实工作量"已作废**，落地时要就地改掉。

## 五、验收判据

1. **不变量**：`DEFAULT_CONFIG.eval.disable_scope_isolation === false`，
   且 `config.default.json` 同键同值。
2. **五个站点逐处生效**（临时 DB 播项目 A、项目 B 各一条记忆 + 一条 global）：
   - 关：只见自己项目 + global；**开：见得到另一个项目的那条**。
   - 三条 lexical lane **逐条直接调 helper** 断言（lane 选择由回退逻辑决定，端到端测不稳），
     **外加一次走 `retrieveMemories` 的端到端**，证明布尔真的串通了。
   - **向量 lane（`:430`）单独一条断言** —— 它不在三个 helper 里，**不会被上面任何一条覆盖到**。
     取证代价见 §六 风险 1。
   - session-start：断言**行集与顺序**两者。
3. **stderr 警告**：开时出现、关时不出现。
4. **默认路径零行为变化**：不带任何 config 时，上述断言与开关引入前一致。

⚠️ **判据 2 的"逐条直接调 helper"与"端到端"分工不许合并**：
只做端到端 ⇒ 三条 lane 里只有一条真的被执行；只做直调 ⇒ 测不到布尔有没有串通。

## 六、风险

1. 🔴 **向量 lane 的测试比另外四处重**：要造 `embedding` + `embedding_sig` 并绕开真实 provider。
   若实现时发现必须引入 provider stub，**那是计划里单独的一步**，
   **不许悄悄降级成"只断言 SQL 字符串"** —— 那正是 review 在 `:430` 撞到过的"做完了但不起作用"。
2. ⚠️ **session-start 的覆盖是不完全的**：只对**存在缓存行**的项目有效
   （缓存行由 13 个 `rebuildInjectionCache` 调用点在写入/维护时产生）。
   ⇒ **评测报告里必须写出这条**，不许把"读了全部行"读成"看见了全部项目"。
3. ⚠️ **测试隔离**：`npm test` 全轮共用一个 `CCMEM_DATA_ROOT`，写 `config.json` 会跨文件污染。
   绕法**照仓库既有 pattern**（模块级 `mkdtemp` + 覆盖 `process.env.CCMEM_DATA_ROOT`，
   靠 `node --test` 每文件独立进程隔离），**不自己发明**。
4. ⚠️ **本开关是新的攻击面**：它能关掉跨项目隔离。
   缓解是四件套：**默认 `false` + `=== true` 的 fail-safe 读法 + 不变量测试钉死默认值 +
   stderr 警告 + W0 的 diagnose 上报**。

## 七、依赖与时序

- **落地时机**：测量窗口关闭之后（v0.14 spec §三）。**窗口期内一行代码都不写。**
- **顺序**：**W0 先落**（W1 判据 4 的前置件），再 W1，再 W2。
  本设计**不依赖 W1**，但 W1 先落可避免两次改 `DEFAULT_CONFIG` 撞车。
- **执行方式**：`superpowers:subagent-driven-development`（人类 2026-08-19 选定）。

## 八、明确不做

- **不动 `injection-cache.mjs` 生产者**，不新增 `'all'` 缓存键（§二）。
- **不写 `S-SCOPE-03` 的 runner**，不碰 paper 仓库，不刷 `reference/ccmem` 快照。
- **不在 `admin/diagnose.mjs` 写一行**（归 W0）。
- **不做每站点独立开关** —— 一个布尔覆盖五处，YAGNI。
- **不改 `prompt_submit`**。

## 九、效力边界

- §二、§四的所有结论**都是 2026-08-20 逐行读源码得到的**，不是推断。
- **行号是写作当时的，会漂** —— 实现时按**函数名/符号名**找（§四.3 每行都给了函数名）。
- 🔴 **本设计过程中未跑任何测试**（全量与单文件都没有）⇒ **spec 里的代码构想一行都没被执行过。**
  执行时按 TDD 步骤走，**别假设它们能直接跑通**。
- **判据 2 的"另一个项目可见"只证明 SQL 谓词被关掉了**，
  **不证明 `C-NAIVE` 与 `C-FULL` 在评测里真的会分开** —— 那要等快照刷新后在 paper 仓库验（§三 裁决 2）。
