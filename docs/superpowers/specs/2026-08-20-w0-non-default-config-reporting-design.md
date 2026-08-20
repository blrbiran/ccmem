# W0 设计：通用「非默认配置上报」机制

> 产出物是**设计**，不是实现。**本轮不写一行产品代码**（人类指令）。
> 下一步是 `superpowers:writing-plans` 出实现计划。**实现本身等测量窗口关闭**（§六）。
>
> 🔴 **W0 是人类 2026-08-19 从 W1 与 W2 的共同需求里抽出来的独立前置件** ——
> 原本它是 W1 的验收判据 4 和 W2 的一条"真实工作量"，各自实现会产生两份互不知情的机制。
> ⇒ v0.14 的实现计划由三份变四份（handoff ⅩⅤ.5 ④）。
>
> 📌 **本文件行号是写作当时（2026-08-20）的，会漂。** 用符号名 grep 复核，别照行号跳。

## 一、要解决的问题

`ccmem admin diagnose` **目前没有任何"报告非默认配置"的机制** —— 全文件（`scripts/lib/admin/diagnose.mjs`，
1675 行）里没有一处把用户的配置与产品默认值做比较。后果是：

**一个改变行为的配置键可以静默生效，而唯一的诊断入口对此一无所知。**

这不是假想。v0.14 里两条工作流各自要加一个开关：

| 工作流 | 键 | 默认 | 打开后的后果 |
|---|---|---|---|
| W1 | `security.quarantine_all_sources_at_write` | `false` | `user_explicit` 记忆在写入时可被 quarantine，**trust 从 0.9 砍到 0.3**，且**跳过 `buildEmbedding` ⇒ 该记忆对 cosine 检索永久不可见** |
| W2 | `eval.disable_scope_isolation` | `false` | 检索的四处 scope 谓词失效，跨项目记忆互相可见 |

两条都写着"**处于非默认值时必须在 `diagnose` 里报出来**"。W0 就是那个机制。

## 二、四条已由人类裁决的口径（2026-08-20）

| # | 问题 | 裁决 | 被否掉的选项与理由 |
|---|---|---|---|
| 1 | "非默认"的判定基准 | **值级 diff**：`loadConfig()` 的结果 vs `DEFAULT_CONFIG`，**值不同才算** | 否掉「文件级」（要改 `loadConfig` 的返回形状，且会把"写了键但值等于默认"的噪声也报出来）；否掉「生效级（含 `config_kv`）」（运行时状态与操作员意图是两种语义，混在一张表里报容易读错） |
| 2 | 报不报值 | 🔴 **只报键路径，永不报值** | 否掉「denylist 打码」：`openai_api_key` / `jina_api_key` 一旦设置就是非默认键，**名单漏一个就是把凭据打到 stdout**，而本仓库明令禁止把配置内容打印/落盘。本仓库刚花一轮证明"声明了但没人维护的东西会烂"（8 个死键），不该再造一份要人维护的名单 |
| 3 | 报在 `diagnose` 的哪一层 | **默认输出打一行摘要 + 新增 `--config` 打全量** | 否掉「只在 `--config` 下报」：没人传那个 flag 它就等于不存在，而 W1 判据 4 的全部目的正是"别让一个改安全行为的开关静默生效"。否掉「默认输出直接展开全量」：那 4 行是人和脚本都在看的，长度必须可控 |
| 4 | 未知键（`DEFAULT_CONFIG` 里不存在的路径）报不报 | **一并报，单独一组** | 同一次遍历天然产出，成本近零；且 **W1 要删 `security.tier3.block_user_explicit`**，删完用户 `config.json` 里的残留就变成"被忽略的多余键"—— W0 正好接住这个后果 |

## 三、接口与数据流

### 3.1 落点：新增一个纯函数模块

**新建 `scripts/lib/config-delta.mjs`**，导出：

```js
collectConfigDeltas(cfg, base = DEFAULT_CONFIG) → { nonDefault: string[], unknown: string[] }
```

**为什么是可注入 `base` 的纯函数，而不是别的形状：**

- 🔴 **`base` 可注入是关键，不是装饰。** 单元测试用**合成 fixture**，不吃真实 `DEFAULT_CONFIG`。
  这是测试 A（`tests/unit/v014-config-value-parity.test.mjs`，分支 `config-value-parity`）上一轮
  刚学到的教训：它原本拿"真实配置是干净的"当前提，**一次真漂移会把两条测试同时弄红**，已改成纯合成 fixture。
  W0 不该再犯一次。
- **不放进 `scripts/lib/config.mjs`**：那个文件已 344 行，且是全仓库最热的 import 之一；
  塞一个只有 `diagnose` 用的函数进去是往热模块上继续堆。
- **不改 `loadConfig()` 的返回形状**：判定基准已定为值级，**不需要 provenance**，
  而 `loadConfig` 有几十个调用点 —— 风险与收益不成比例。

### 3.2 遍历规则（三条全部沿用测试 A 的既有约定，**不另立**）

1. **`_` 前缀键跳过，两侧都跳** —— 它们是文档键。
   （今天 `DEFAULT_CONFIG` 里一个 `_` 键都没有，所以"两侧"只在 `cfg` 侧起作用；
   写成两侧是为了将来往 `DEFAULT_CONFIG` 加文档键时不用回头改这条规则。）
   🔴 **这条不是洁癖，是防一个真实误报**：`config.default.json` 有 2 个 `_comment`
   （`:60` 与 `:221`，JSON 带不了注释），而 `DEFAULT_CONFIG` 里**一个都没有**；
   而 `config.default.json` 正是给用户抄的模板 ⇒ **凡是从模板起手的 `config.json`
   都会被报成 2 个 unknown key。**
2. **数组是叶子**，用 `JSON.stringify` 比较内容。
3. 只在**叶子**上产出键路径；对象节点本身不产出（§3.3 最后一行是唯一例外）。

### 3.3 分类规则（走两侧键的并集）

| 情形 | 归类 |
|---|---|
| 两侧都有该叶子、值不同 | `nonDefault` |
| 两侧都有该叶子、值相同 | **不报** |
| `cfg` 有、`base` 没有 | `unknown`（**报到叶子**，见下） |
| 🔴 **`base` 有、`cfg` 完全没有该键** | **忽略，什么都不报**（见下，这一行不是可有可无的） |
| 🔴 一侧是对象、另一侧是标量 | 在**该路径本身**记一条 `nonDefault`，**不再往下递归** |

**第 3 行「报到叶子」**：用户写了一整个 `base` 里不存在的子树（例如 `"eval": { "foo": 1 }`），
按 §3.2 规则 3 **报的是叶子路径 `eval.foo`**，不是子树根 `eval`。

**第 4 行为什么必须显式写出来（review 抓到的洞）：**

- **在 production 里它不可能发生** —— `mergeConfig` 以 `base` 的深拷贝起手，`base` 的每个键都会活下来；
  唯一能让 `base` 路径消失的情形（标量覆盖对象）**已被第 5 行在父路径上捕获**。
- 🔴 **但在测试里它是常态**：§五 明写要给 `cmdAdminDiagnose` **注入合成 `cfg`**，
  而合成 `cfg` 不可能覆盖 `DEFAULT_CONFIG` 的全部路径。**若不忽略，每个单元测试都得先构造一份完整的
  `DEFAULT_CONFIG` 副本 —— "用合成 fixture"这个决定就被架空了。**
- **忽略的代价，写明白**：万一将来 `mergeConfig` 改得会真的丢 `base` 键，**W0 会静默漏报**。
  ⇒ **实现计划里这一支要带注释写清它依赖 `mergeConfig` 的哪条性质**，
  别让下一个人以为是随手写的。

**最后一行的依据（读 `config.mjs::mergeConfig` 得到的两条实测事实，都要写进实现计划）：**

- 用户若写 `"consolidation": 5`，`mergeConfig` 会**把整个子树换成 `5`**
  （`return structuredClone(override ?? base)` 那一支），于是 `consolidation.*` 的全部默认路径凭空消失。
  ⇒ 往下递归会吐出一堆误导性的子路径；**在 `consolidation` 这一层记一条"生效值 ≠ 默认值"才是实话。**
- 🔴 **`"consolidation": null` 不会触发这一支** —— `override ?? base` 会把 `null` 回落成 `base`。
  **null 清空不了一个子树**，别按直觉理解。

### 3.4 输出契约

`cmdAdminDiagnose` 的返回对象新增一个字段（snake_case，跟 `project_key` / `tier2` 的既有风格）：

```js
config: {
  non_default_keys: ['retrieval.weights.semantic', 'security.quarantine_all_sources_at_write'],
  unknown_keys: ['security.tier3.block_user_explicit']
}
```

- 🔴 **永不含值。这是契约的一部分，不是实现细节。**
- **两个数组各自按字典序排序** —— 输出稳定，测试才能直接 `deepEqual` 而不是先 `sort()`。
- **两个数组恒存在**，无内容时是 `[]`，**不是 `null`、也不省略字段** ——
  省略会让"机制没跑"和"跑了但没发现"不可区分，那正是判据 4 要挡的事。
- **无条件计算**（不挂 flag）：默认输出要用它，成本是一次遍历。

### 3.5 CLI 输出

**默认分支**（无 flag，`scripts/cli.mjs` 写作当时约 `:951` 那个 `else`）固定新增一行：

```
ccmem: config 2 non-default keys, 1 unknown key
```

- 🔴 **`N=0` 且 `M=0` 时照打**：`ccmem: config 0 non-default keys, 0 unknown keys`。
  那一行同时证明**机制还活着** —— 只在有内容时才出现的东西，没内容时和"不存在"无法区分。
  这正是 8 个死键教出来的。
- 单复数按数量变（`key` / `keys`），因为这一行是给人看的；机器要读的那份在结构化对象里。

**`--config` 分支**：摘要行 + 两组分开、每键一行缩进两格。

```
$ ccmem admin diagnose --config
ccmem: config 2 non-default keys, 1 unknown key
non-default:
  retrieval.weights.semantic
  security.quarantine_all_sources_at_write
unknown:
  security.tier3.block_user_explicit
```

⚠️ **`--config` 在 `cli.mjs` 的 if/else 链里要放在 `--feedback` / `--cost` 之后**（那两个分支在前面就把
`admin diagnose` 拦截掉了），放在 `--restart-history` 之后、默认分支之前。
⇒ **同时传 `--config` 与别的 section flag 时，链上靠前的那个赢** —— 这是既有 flag 全族的行为，
**W0 不为此做任何特殊处理**，也不报错。

📌 **这里的 `--config` 版式与提问时那份候选预览不完全一样**：预览是**两条摘要行**
（`config N non-default keys` 一条、`config M unknown key` 一条），本设计改成
**一条摘要行 + 两个带标签的分组**。理由：摘要行与默认输出那一行**逐字相同**，
人不必学两种格式，测试也只需要一个断言形状。**内容与分组完全没变。**
🔴 **如果你更想要预览里那种两条摘要行的版式，这一处要改，现在说比实现后改便宜。**

## 四、验收判据（**防死键**，这是 W0 的底线）

W0 的死法和 W1 不一样。W1 怕的是"键没人调"；W0 的函数一定会被 `diagnose` 调。
**W0 真正的三种死法是：**

1. 函数算出来了，但 `cli.mjs` 那两行没接上 ⇒ **结构化对象里有，人永远看不见**（判据 4 白做）；
2. `--config` 加进了 if/else 链但**被前面的分支吃掉**；
3. 报出来了但**报错了**（比如把 `_comment` 算成 unknown）⇒ **人学会忽略这个输出，比没有更糟。**

| # | 判据 | 挡住哪种死法 |
|---|---|---|
| 1 | 纯函数单元测试覆盖 §3.3 那张表的**每一行**，含 `_` 跳过、数组叶子、对象↔标量；**用合成 `base`** | 3 |
| 2 | `cmdAdminDiagnose` 返回的 `result.config` 精确等于预期数组 | 逻辑接线 |
| 3 | 🔴 **spawn 真实 CLI**（无 flag）断言 stdout 有那一行；再 spawn `--config` 断言全量列表。**怎么 spawn 见 §五那一小节 —— 不是 `./bin/ccmem`** | **1 与 2** |
| 4 | **干净配置下**那一行仍然出现且计数为 `0, 0` | "只在有内容时才出现" |

📌 **"干净配置"在本设计里指两种情形，判据 4 两种都要覆盖**：
① `config.json` **根本不存在**（`loadConfig()` 直接返回 `DEFAULT_CONFIG`）；
② `config.json` 存在但每个叶子都等于默认值。**两种都必须报 `0 non-default keys, 0 unknown keys`。**
第 ① 种是本机全新安装的常态，第 ② 种是从 `config.default.json` 抄模板的常态 ——
**后者正是 `_comment` 误报会咬人的地方**（§3.2 ①），所以它不是多余的一条。

**判据 3 不可省**：只测结构化对象，恰好漏掉"人看得见"这一步，而那一步就在 `cli.mjs` 里。

**每条都要故意改坏、亲眼看着变红**（handoff Ⅴ；W1 计划每个测试任务都带这一步，W0 照抄）。
**绿色本身不算证据** —— 本仓库出过全绿但测的是别的 checkout（A2）。

## 五、测试策略 —— 以及一枚必须绕开的雷

🔴 **雷：不能往共享 data root 里写 `config.json`。**

`npm test` 给**整轮所有测试文件共用一个** `CCMEM_DATA_ROOT`（handoff Ⅳ.3，`package.json` 的
`test` 脚本用 `CCMEM_DATA_ROOT="$(mktemp -d)"`），而 `getConfigPath()` 就是
`$CCMEM_DATA_ROOT/config.json`（`scripts/lib/paths.mjs::getConfigPath`）。
⇒ **在里面写一份非默认配置，等于让同一轮里每个调 `loadConfig()` 的测试都看见它。**

🔴 **但这个雷本仓库早就拆过了，别自己发明第二种拆法。**
`tests/integration/admin-diagnose-command.test.mjs:9-18` 的既有做法（也是 handoff Ⅳ.22 记的那条）是：
**模块级 `mkdtempSync` + 直接覆盖 `process.env.CCMEM_DATA_ROOT`**，靠 `node --test`
**每个测试文件跑在自己的进程里**来隔离。`plist-drift.test.mjs` 同款。
**W0 照抄这个 pattern，不要另立**（CLAUDE.md Rule 11：conformance > taste）。

**三层各自解决：**

| 层 | 文件 | 怎么拿到"非默认配置" |
|---|---|---|
| 纯函数 | `tests/unit/v014-config-delta.test.mjs` | 合成 `base` + 合成 `cfg`，**完全不碰真实配置** |
| 结构化对象 | `tests/integration/v014-diagnose-config.test.mjs` | 给 `cmdAdminDiagnose` 的 options **加一个 `cfg = loadConfig()`**，测试注入合成 `cfg` |
| CLI 可见性 | 同上文件 | 模块级自有 `CCMEM_DATA_ROOT`（`mkdtempSync`）+ 往里写一份真 `config.json`，**`execFileSync` 时把同一个 root 显式放进子进程 `env`** |

📌 **`cfg = loadConfig()` 这个默认参数不是新发明**：`getTuningDiagnostics(db, cfg = loadConfig())`、
`getMetricsDiagnostics(db, { cfg = loadConfig() })`、`getRetrievalDiagnostics(db, cfg = loadConfig())`
已经是这个形状。W0 只是把同一个约定推到最外层。

🔴 **判据 2 与判据 3 的分工必须写清，否则会被后人优化掉：**
判据 2 注入合成 `cfg` ⇒ **它永远不执行 `loadConfig() → collectConfigDeltas` 这条真链**。
**只有判据 3 走真链。** ⇒ **判据 3 不许改成 in-process 调用**（哪怕嫌 spawn 慢）——
那样改会留下一个无人覆盖的缺口：真实配置文件到报告之间的全部路径。

### 🔴 spawn 怎么写：两条既有硬约束**互相矛盾**，照既有测试解

handoff Ⅳ.2 / Ⅳ.20 要求**显式 `/usr/local/bin/node`**（PATH 上是 nvm v22.13.1，**没有 fts5**）；
Ⅳ.13 要求**跑目标 checkout 的 `./bin/ccmem`**（PATH 上的 `ccmem` 指向主仓库，A2 那类事故的来源）。

**这两条不能同时照字面做** —— `bin/ccmem` 的最后一行是：

```bash
exec node --no-warnings --experimental-sqlite "$DIR/../scripts/cli.mjs" "$@"
```

**它 exec 的是裸 `node`**，正是 Ⅳ.20 点名的那个没有 fts5 的解释器。

✅ **既有两个测试文件的解法（W0 照抄）：绕开 `bin/ccmem`，直接跑目标 checkout 的 `scripts/cli.mjs`** ——
Ⅳ.13 想挡的是"用 PATH 上的 `ccmem`"，这样写同样挡住，且不违反 Ⅳ.2：

```js
const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI  = path.join(ROOT, 'scripts/cli.mjs');
execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--config'], { cwd, env, encoding: 'utf8' });
```

📌 那个 `'--'` 分隔符也是既有惯例（`cli.mjs:22` 会把它剥掉），照抄即可。
📌 **handoff Ⅳ.13 的措辞本身会误导下一个人**（字面读出来就撞 Ⅳ.20）——
**建议下一轮就地改 Ⅳ.13**，本设计不替它改。

✅ **`--config` 与现有 flag 零碰撞**（已核实：`scripts/cli.mjs` 与 `bin/ccmem` 里都没有这个字符串），
写在这里免得下一个人再查一遍。

测试文件命名跟既有惯例（`v014-diagnose-cost.test.mjs` / `v013-diagnose-feedback.test.mjs`）。

## 六、依赖与时序

- 🔴 **W0 等测量窗口关闭。** `docs/ccmem-v0.14-spec.md` §三 只点名 W1/W2/W3，
  但 W0 是它们的前置件、且**新增测试会改套件时序** ⇒ **同等对待**。
  **本轮只出 spec 与计划，一行代码不写。**
- **W0 先于 W1 落地**；W1 计划 Task 9 的闸门查的就是"W0 已落地并覆盖了本键"。
  **这条依赖两份计划都要写**（W1 设计 §六已有，W0 这边对上）。
- **W0 不依赖任何人**，是四条工作流里唯一可以第一个动手的。
- 落地后跑全量套件，**跑批起止时间当场记进 `plans/2026-08-10-raise-openai-timeout.md`**，不事后回忆。
- 🔴 **W0 的测试不许拿任何"W1/W2 将要新增或删除的真键"当样本**，一律用合成 fixture 里的假键。
  点名三个：
  | 键 | 状态 | 拿它当样本会怎样 |
  |---|---|---|
  | `security.tier3.block_user_explicit` | W0 落地时**还在** `DEFAULT_CONFIG` 里，W1 才删 | W1 删键那一步把 W0 的测试弄红 |
  | `security.quarantine_all_sources_at_write` | W0 落地时**还不存在**，W1 才加 | W1 加键那一步把 W0 的测试弄红 |
  | `eval.disable_scope_isolation` | W0 落地时**还不存在**，W2 才加 | 同上 |
  ⇒ **规则一句话：W0 的测试对真实 `DEFAULT_CONFIG` 的内容零假设。**
  ✅ **人类 2026-08-20 放行了唯一一个例外：顶层 `version` 键存在可以假设**
  （`v013-config-sync.test.mjs` 已经依赖它，不是新耦合；完全零假设就没有"已存在的键"可改，
  `nonDefault` 那条链路在集成层测不到）。**只放行这一个键，上表三个仍然一个都不许用。**
  实现细节见计划文件末尾自审记录第 4 条。
  （§3.4 与 §3.5 里出现这几个键**只是文档示例**，不是测试样本。）

## 七、明确不做

- **不报值**，任何形式，包括打码后的值。
- **不加 `--json`** —— `diagnose` 全族都没有（只有 `stats` 有），不在这里开先例。
- **不在 daemon 启动日志、hook metrics 或别处上报** —— `diagnose` 一处够了。
- **不改 `loadConfig()` 的返回形状。**
- **不判定"这个键有没有消费者"** —— 那是测试 B / 死键清单的事
  （`specs/2026-08-14-default-config-dead-keys.md`）。**W0 只说"和默认不一样"。**
- **不把 `config_kv` 的运行时覆盖算进来**（§二 ①）。`diagnose` 已单独报 embedding 相关状态。

## 八、一条本轮被更正的说法（记下来免得下个人重推）

设计过程中我先写过一条：

> ~~`applyV08Compatibility` 会凭空补出 `consolidation.cluster_loose_threshold`
> ⇒ naive diff 会误报一个用户没改过的键，需要专门处理。~~

**这条是错的，已复核。** `applyV08Compatibility` 只有两个调用点（`config.mjs:320` 与 `:343`），
**两处都在 `mergeConfig(DEFAULT_CONFIG, parsed)` 之后**，而
`DEFAULT_CONFIG.consolidation.cluster_loose_threshold` 本来就是 `0.5`
⇒ **合并后它永远非 null**，那个补偿分支**只有在用户显式写 `"cluster_loose_threshold": null` 时才开火** ——
那种情况下报它是对的。**不需要任何特殊处理。**

真正的误报源是另一个：**`_comment` 文档键**（§3.2 ①）。
