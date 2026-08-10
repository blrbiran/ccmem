# ccmem v0.13 Dogfood 文档

> 验证 v0.13「L2.5 观察型探针 + 入库收紧 + embedding 签名版本化」的**运行时行为**是否符合 spec。
> 对照 [`ccmem-v0.13-spec.md`](./ccmem-v0.13-spec.md) 与
> [`.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md`](../.superpowers/sdd/2026-07-31-ccmem-v0.13/final-review-findings.md)。
> 验证方法：真实 live DB（`~/.claude/ccmem/global.db`）+ 真实 daemon + 真实 hook，逐项附命令证据。
>
> **背景**：v0.13 已通过 449 测试 + 附录 A grep 不变量 120–135（16/16），
> 并已 fast-forward 合并进 `main`（`3bd3092`，已推送）。
> **这两个数字是合并当时的，不是现在的** —— 当前值见下方 §一 末尾。最终 review 的 3 Critical + 10 Important
> 已在单轮 fix wave 中全部修复并经 scoped re-review 确认。
> **本文档要回答的是另一个问题：这些代码路径在生产里到底有没有被执行过。**
> 套件全绿不构成证据 —— 单测用 mock provider 与 `:memory:` DB，本文档只接受真实运行计数。

---

## 一、v0.13 实现状态

| 能力 | 状态 | 可 dogfood | 关键文件 |
|---|---|---|---|
| A1 L2.5 观察型探针 | ✅ ship | ✅ 已在跑（389 行） | `lib/feedback.mjs:1281-1500`、`lib/metrics.mjs` |
| A1b 决策流 `l25-probe.jsonl` + `retention_days:0` | ✅ ship | ✅ 观测磁盘增长 | `lib/metrics.mjs`、`lib/tier15.mjs`（config_kv 清理） |
| A1c `admin diagnose --feedback` 四队列分段 | ✅ ship | ✅ 已验证可用 | `lib/admin/diagnose.mjs` |
| A2 质量门 `env_failure` + `negative_assertion` | ✅ ship | ⚠️ 见 Finding 1 | `lib/quality-gate.mjs:82-97`、`daemon/tasks/summarize-pending.mjs:283` |
| A2b `quality_gate_reject` 按 reason 拆分 | ✅ ship | ✅ **已验证可用** | `lib/admin/diagnose.mjs:807-890` |
| B1 embedding 签名版本化（迁移 016） | ✅ ship | ❌ 见 Finding 3 | `lib/embedding/signature.mjs`、`retrieval.mjs:427`、`dedup.mjs`、`feedback.mjs`、`daemon/tasks/vec-backfill.mjs` |
| B2 `temporal_type` 显式写入 | ✅ 早于本分支已修 | ❌ 纯测试 | `tests/integration/v013-save-temporal.test.mjs` |
| B3 recall-loop 不变量 | ✅ ship | ❌ 纯测试 | `tests/unit/v013-recall-loop.test.mjs` |
| 配置版本 0.13 + 递归同步测试 | ✅ ship | ✅ 一行核对 | `lib/config.mjs:3`、`tests/unit/v013-config-sync.test.mjs` |

当前回归：**480 pass / 0 fail**（2026-08-02 实测 `npm test`，exit 0，无抖动）；
附录 A 不变量 **23/23**（120–142；#127 为人判项，本轮已核：`NEGATIVE_ASSERTION` 正则不含
`不支持` / `不要用` / `never use` / `avoid`。其余 22 行机械判定，逐条实跑 25 个子检查全过）；
trust 守恒 `SUM(trust_score)` 真实使用前后不变（期间 hooks 实际运行并新增 63 条探针行）。

**B2/B3 不列入 dogfood** —— 它们没有可观测的运行时行为变化（ledger T7 已确认 B2 的修复早于本分支）。
把它们写进验证清单只会制造"覆盖了"的假象。

---

## 二、Dogfood 前置发现（2026-08-01）

> 严重度：**P0** = 阻塞 dogfood / 观测结果无效；**P1** = 会导致误读或执行失败；**P2** = 打磨。
> v0.13 的 code review findings 不在此节 —— 它们已全部修复并记录于 `final-review-findings.md`。
> 本节记录的是**开始 dogfood 时才暴露的问题**。

### Finding 1：运行中的 daemon 早于 v0.13 代码，daemon 侧功能零执行（P0）

**现象**：`admin diagnose --tuning` 显示近 30 天 146 次质量门拒绝，
但 reason 全部是 v0.13 之前就存在的规则（`path_list` 140 / `too_specific` 3 / `test_count` 2 / `too_short` 1），
两条新规则 `negative_assertion` / `env_failure` **计数为 0**。

**根因**：daemon 在启动时 import 一次模块，此后持有内存中的那份代码。时间线：

| 事件 | 时间 |
|---|---|
| 当时运行的 daemon 启动（pid 8813，uptime 24h23m） | 2026-07-31 09:12 |
| A2 两条新规则首次提交（`d95f35b`） | 2026-07-31 22:34 |
| A2 脚本分档长度门修正（`4e7b931`） | 2026-07-31 23:02 |
| v0.13 合并进 main（`dfc7f93`） | 2026-08-01 01:49 |

daemon 比新规则早 **13.4 小时** ⇒ 它不可能执行过这两条规则。

**为什么这不是缺陷**：0 计数被完全解释。**若不查进程启动时间就直接下"规则坏了"的结论，会是一次误报。**

**对照证据（说明 A1 不受影响）**：A1 探针跑在 **Stop hook** 上 —— 每轮一个全新 node 进程，每次从磁盘读代码。
证据是探针行里已出现 `control: 'random'` 队列，而该字段是最终 review 修复波才加入的。这是数据，不是推断。

**修复**：重启 daemon。

**验证状态**：✅ **已解除（2026-08-01 09:41，人类手动执行 `ccmem admin daemon restart`）**
—— `pid=82700`、uptime 归零、`startup_schema=16`。

---

### Finding 2：首批探针情报已翻转，p50 对比方法本身不可靠（P1）

**现象**：交接文档记录的核心情报是「随机对照组 `l25_cov` p50 ≈ 0.125 **高于**信号组 ≈ 0.103」，
即"噪声底高于信号"。实测已翻转：随机组从 n≈9 增至 n=21 后，p50 降至 **0.075，低于信号**。

**根因**：n=21 时 p50 的置信区间宽到两组完全重叠。两次结论都是小样本抖动。

**为什么重要**：正确的读法**不是**"所以有信号了"，而是 **"分位数对比这个方法不能用作判据"**。
v0.14 的判据必须是分布级的（AUC / Mann-Whitney U），不是分位数比较。

**修复**：dogfood 期继续采集（V2），并记录 p50 随 n 的漂移轨迹 —— 漂移本身就是"方法不可用"的证据。

**验证状态**：⏳ 采集中，见 V2。

---

### Finding 3：B1 在本机完全休眠，`stale vectors: 0` 是分母为 0（P1）

**现象**：
```
admin semantic status    : enabled=false loaded=false provider=transformers-local
                           embedded=0 pending=4093 model=Xenova/all-MiniLM-L6-v2 dim=384
admin diagnose --retrieval: Embedding: disabled / stale vectors: 0 / Circuit: CLOSED
```

**根因**：embedding 全局关闭，0 条记忆有向量。整条 B1 机制（签名派生、三处过滤、vec_backfill 恢复路径）
**在本机从未执行过一次**。

**观测误读风险**：`stale vectors: 0` 看起来像"健康"，实际是**分母为 0** —— 签名不匹配的行数当然是 0，因为一个向量都没有。

**顺带澄清**：`semantic status` 的 `pending=4093` 与 `diagnose --retrieval` 的 `stale vectors: 0`
**不构成 review 中 I4 那类矛盾**（二者分母不同：前者"无向量"，后者"有向量但签名过期"，当前状态下两个数都对）。
follow-up 清单里那条（`semantic.mjs:103` 强制 `enabled:true` 而 `diagnose.mjs:58` 用原始 cfg）
**要等 embedding 打开后才具备显形条件**。

**修复**：门禁 G1，见 §四。

**验证状态**：✅ **已解除（2026-08-01，G1 执行）**。B1 整条机制已在本机真实执行过：
签名派生（`openai:text-embedding-3-small:1536`）、三处过滤（V4）、`vec_backfill` 恢复路径（V3）。

**但本条记录的观测陷阱没有过期，反而又中了一次**：V5 找到了"分母为 0"的**第二种来源** ——
不是库里没有向量，而是**签名为 `null` 让 SQL 谓词恒不成立**，计数静默塌成 0 而文案讲成健康。
见 §五 V5。

---

### Finding 4：一个超时值服务两种相反的负载（P1 → **已修复，实测证实**）

> **本条已按实测重写（2026-08-01 下午）。** 原记述把它写成「默认值调小了、有超时风险」，
> 方向对但表述不对 —— 真正的缺陷是**一个配置项被两个需求相反的调用方共用**。

**原计划**：先按默认 800ms 跑，把回填当作对这个默认值的第一次实测。**这个决定是对的，实测把它证伪了。**

**实测数据**（OpenAI provider 首次真正跑起来之后）：

| 时刻 | 事件 |
|---|---|
| 13:58:08 | 第一批成功 `{"embedded":50,"remaining":4259,"duration_ms":894}` |
| 13:58:11 | 第二批 `{"error":"Request timed out.","embedded_before_fail":0}` |
| 之后 | **再无任何 `vec_backfill_run`**，`pending` 冻在 4259 |

后续观测到的批次耗时区间是 **685–1427ms**，正好骑在 800ms 门限上。
（`duration_ms` 是整个 run 的耗时，含 DB 写入；API 调用本身的超时是 800ms。第一批是侥幸。）

**真正的根因 —— 一个值，两种相反的需求**：

| 调用方 | 负载 | 需要 | 失败代价 |
|---|---|---|---|
| prompt-submit 检索 hook | 1 条 query 向量 | **快**（hook 延迟预算 200ms） | 低 —— 退化为纯词法 |
| daemon `vec_backfill` | `backfill_batch_size`（50）条一次请求 | **慢**（网络往返 × 批量） | 高 —— **整条链死掉** |

`openai_timeout_ms: 800` 是为前者选的，且**这个选择是对的**（`openai.mjs` 内部按 100 分块，所以 50 条就是一次 API 请求）。
后者只是借用了同一个键。所以正确的修复不是"调大它"（那会牺牲 hook 预算），而是**让两条路径各有各的超时**。

**另外两个独立缺陷，同一次实测暴露**：

1. **一次超时就让整条链死掉。** review I3 的"回填后自动重排队"只覆盖**成功**路径；
   `catch` 分支写完 audit 直接 rethrow，不排队。所以症状不是"慢"，是"停"。
2. **这个失败完全不可见。** 错误只进 `audit_log`，`daemon.err.log` 一个字都没有，
   `semantic status` 只显示一个不再变化的 `pending`，熔断器也没响（阈值 3 次，只失败了 1 次）。
   **又一次"代码在跑、没有报错、数据悄悄错着"。**

**修复（三处，各自先红后绿）**：
- 新增 `embedding.backfill_timeout_ms`（默认 30000），只覆盖回填自己的 provider 调用；
  hook 路径保留 800ms。同时覆盖 `openai_timeout_ms` 与 `api_timeout_ms`，使 openai 与 jina 行为一致。
  按裁决 #6，`config.mjs` 的 `DEFAULT_CONFIG` 与 `config.default.json` **两边都加**。
- 失败路径也排队续链，并像成功路径那样打 stderr。
- **接线修正**：override 必须同时传给 `load()` 与 `embed()` —— 只传给 `getProvider()` **完全无效**，
  因为这两个方法在不带 override 时各自回到 `loadConfig()` 重新算超时，把 800 又拿了回来。
  **第一版提交因此实际上什么都没改变**，这正是 Finding 7 记过的「包装器有测试、接线只靠人看」。

**已知取舍（刻意接受）**：失败现在会重新排队，所以**永久性失败**（key 失效、账单停用）
会按 daemon 的队列节奏一直重试并逐次打日志。冻结的库比吵闹的日志更糟，故如此选择；
failure-aware backoff 列入 v0.14。

**验证状态**：✅ **已修复并实测**。修复上线后**零超时**，回填 `pending` 一路降到 **0**。

---

### Finding 5：`loadConfig()` 的 `JSON.parse` 无 try/catch，配置文件是全 hook 单点故障（P1）

**现象**：`config.mjs:309` 的 `JSON.parse` 至今无保护（全文件无任何 try/catch）。
上面这句在 Finding 12 之前只影响导出了 `CCMEM_CONFIG_PATH` 的进程；
**Finding 12 让路径回落到数据根之后，每个进程都会去 parse 它。**

**为什么当初写成 P1**：本环境曾从未设置过 `CCMEM_CONFIG_PATH`，`mergeConfig` 这条路从未被执行过
（ledger 亦记录：`v013-config-sync.test.mjs` 从不设置该变量）。人类选了方案 A 之后，这条路径已被激活。

#### 实测（2026-08-02，隔离 `CCMEM_DATA_ROOT` 的临时库，`-u CCMEM_CONFIG_PATH`）

| 入口 | 坏配置（截断的 JSON）下的实际行为 |
|---|---|
| `hook session-start` / `prompt-submit` / `stop` | **exit 0，输出合法**。`withHookSafety` 兜住，stderr 一行 `ccmem: <hook> failed (<解析错误>)`，降级为空上下文 |
| `cli.mjs admin semantic status` | **exit 1**，未捕获 `SyntaxError` 栈 |
| `daemon/main.mjs` | **exit 1，启动即死**（同一条未捕获栈；正常配置下 12s alarm 未触发退出 ⇒ 存活对照成立） |

⇒ **"配置文件是全 hook 单点故障"这个标题口径过重，按实测收窄**：hook 不崩，
**真正会死的是 daemon 与 CLI**。daemon 由 launchd 托管 ⇒ 坏配置期间它会反复启动失败，
回填与 daily maintenance 全停，而用户侧只有 `daemon.err.log` 里的栈。

**三条错误信息都不含文件名** —— 栈里只有 `<anonymous_script>:1` 和 JSON 位置偏移，
不告诉你是 ccmem 的 `config.json` 出了问题。

#### 🆕 同一轮撞见的第二条：合法 JSON、错误形状 ⇒ **静默等同于没有配置**

`config.json` 内容为 `"just a string"`（合法 JSON，但不是对象）时：
**没有任何报错**，三个 hook 与 CLI 全部正常返回，`semantic status` 显示
`provider=transformers-local`、`enabled=false` —— 与**完全没有配置文件**时逐字节相同。
⇒ 用户的整份配置被静默丢弃。**这正是 Finding 12 的形状（无声地跑在错误的 provider 上），
而且它今天就已经成立，不需要任何"修复"来触发。**

#### ⚠️ 本条原先提的修复方案现在是危险的

原文写：「`JSON.parse` 包 try/catch，解析失败时 warn 到 stderr 并**回落 `DEFAULT_CONFIG`**」。
**那句写在 Finding 12 之前。照做就是重造 Finding 12**：
`DEFAULT_CONFIG.embedding.provider` 是 `transformers-local`，而库里的向量是
`openai:text-embedding-3-small:1536` ⇒ 签名不匹配 ⇒ 检索静默退化成词法，一条报错都没有。
**"解析失败该响亮地死，还是带着错误的 provider 静默活下去"是设计问题，已交人类裁决。**

#### 裁决与修复（2026-08-02）

**裁决：响亮地死 + daemon 不刷栈。** 明确**不**回落 `DEFAULT_CONFIG`。

1. `loadConfig()` 抛具名 `ConfigError`，**消息里带文件路径** —— 解析失败与"不是对象"两种都抛。
2. `daemon/main.mjs` 在 `openDb()` / `acquireDaemonLock()` **之前**先验一次配置，
   失败则写一行可读 stderr 后 `exit 1`。**顺带修掉一个次生问题**：原先它死在
   `warmSemanticProvider`，那时锁已经拿到了，launchd 每次重启都白churn 一次锁行。
3. **hook 一行未改** —— 实测它们已经正确降级，改它们没有依据。

**回归测试** `tests/integration/config-parse-failure.test.mjs` 三条，**全部打在进程边界上**
（退出码 + stderr 内容），先红后绿；第三条自带"无配置文件仍应成功"的正面对照，
以免它是因为命令本身坏了才失败。**套件 480 pass / 0 fail**（原 477，+3）。

**验证状态**：✅ **已修复**。附录 A 新增不变量 **#142**（两半各自验红 `2→0`）。已记 `bug-061`。

---

### Finding 6：`admin semantic on` 的 `config_kv` 副作用永久遮蔽配置文件（P0）

**现象**：人类在 `~/.claude/ccmem/config.json` 里配好 `openai_api_key` 后执行 `ccmem admin semantic on`，
结果启用的是**本地 provider** 而非 OpenAI：
```
provider=transformers-local  model=Xenova/all-MiniLM-L6-v2  dim=384  enabled=true
```

**根因（两层）**：
1. `semantic.mjs:81` 的 provider 解析是 `requestedProvider ?? cfg.embedding?.provider ?? 'transformers-local'`。
   config.json 只写了 `openai_api_key`、没写 `provider` ⇒ 回落默认本地模型。
2. **真正的缺陷在这里**：`semantic.mjs:98-100` 把 `embedding.enabled` / `active_provider` / `active_model`
   作为**副作用**写进 `config_kv`，而 `resolveProviderName`（`provider.mjs:69-79`）**先读 kv**。
   于是一旦跑过一次 `semantic on`，配置文件里的 `provider` 就**永久失效**，且：
   - 没有任何命令能清除这些 kv 行（`semantic off` 只把 `enabled` 写成 `false`，不删行）
   - 文件侧无法覆盖 kv
   - 用户看不到任何提示说明"你的配置文件被 kv 遮蔽了"

**为什么是 P0**：这不是"少打一个参数"。一个**开关动作**顺手把**声明式配置**钉死了，
而用户的合理心智模型是"改配置文件 + 重启 daemon 即生效" —— 这个模型在**全新安装上本来是成立的**
（`resolveEnabled`/`resolveProviderName` 都会回落文件层），只是被 `semantic on` 的副作用破坏。
要求用户记住 `ccmem admin semantic on --provider openai` 是不合理的补偿。

**修复（本版内，人类裁决通过）**：`semantic.mjs` 的 `on` 分支 ——
**给了 `--provider` 就写 kv；没给就删掉这一行**，且该操作移到 `getProvider` **之前**。

移到之前是修复的第二半：`providerName` 由配置文件算出，而 `getProvider` 独立解析且 kv 优先，
两者原本会分歧 —— 命令加载 A 却记录 B。现在二者必然一致。

不新增命令（Rule 2）：删除而非跳过，意味着已中招的用户跑一次裸的 `ccmem admin semantic on`
就自动解除遮蔽，无需 `semantic reset`，也无需手工 DELETE 数据库。

**已知取舍（人类裁决：可接受）**：若曾用 `--provider X` 显式设过，之后跑一次裸的 `semantic on`
会丢掉该设置。理由：文件层立即接管，行为可预测且可见。

**回归测试**（3 个，均先被看着变红）：`tests/integration/v013-semantic-provider-kv.test.mjs`
1. 裸 `semantic on` 后 kv 行必须**不存在**，且文件声明的 provider 真正生效 — RED（`JINA_API_KEY not set`，
   即残留 kv 赢过文件、加载了错误 provider）→ GREEN
2. `--provider` 仍写入 kv —— **防过度修正的对照**，按设计修复前后皆绿，作用是抓"总是删除"的错误实现
3. 命令报告的 provider 与实际加载的一致 — RED（同 1）→ GREEN

**验证状态**：✅ **已修复（2026-08-01）**。全量 **452 pass / 0 fail**（原 449，+3）。

---

### Finding 7：`openai` 包从未被声明为依赖，选它必崩（P0）

**现象**：Finding 6 修复后，`ccmem admin semantic on` 终于真的去加载 OpenAI provider，随即裸崩：
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'openai'
    imported from .../scripts/lib/embedding/openai.mjs
```

**根因**：`package.json` 的 `optionalDependencies` 只有 `@xenova/transformers`。
`openai.mjs:52` 的 `await import('openai')` 所需的包**在 package.json 里没有任何声明**。
而 `provider: "openai"` 是一等公民配置项 —— `config.mjs` 为它准备了 6 个键
（`openai_api_key` / `openai_base_url` / `openai_model` / `openai_dim` / `openai_timeout_ms` / `provider`），
`providerByName` 也把它列为三个合法 provider 之一。**任何全新安装都不可能跑起来。**

失败形态同样是缺陷：一个裸的 ESM 解析器栈回溯，指向内部文件路径，不提 npm，不给补救办法。
`transformers-local.mjs:76` 是同款动态 import，只是它的包被声明了才没暴露；
`npm install --omit=optional` 会走进完全相同的死胡同。

**修复（人类裁决：两个 provider 一起修）**：
1. 新增 `scripts/lib/embedding/optional-import.mjs`，把 `ERR_MODULE_NOT_FOUND` 翻译成可操作错误
   （`embedding provider 'X' requires the optional 'Y' package — run: npm install Y`，
   错误码 `CCMEM_OPTIONAL_DEP_MISSING`）。两个 provider 共用，避免第二份消息格式（同 I4/I10 的教训）。
2. `openai.mjs` 与 `transformers-local.mjs` 的动态 import 均改走该 helper。
3. `package.json` 的 `optionalDependencies` 补上 `"openai": "^4.104.0"`。

**回归测试**（`tests/unit/v013-optional-import.test.mjs`）：
1. 缺失包给出可操作错误而非 ESM 栈 —— **突变验证**：把 `ERR_MODULE_NOT_FOUND` 分支改成 `if (false)`
   ⇒ pass 1 / fail 1（红），还原后绿
2. 可解析模块原样返回 —— **防过度修正的对照**，抓"包装器吞掉/改形成功路径"的错误实现

**未覆盖并如实声明**：包装器本身有测试，但两个 provider 的**接线**只经人工检查 ——
包装后无法在已安装该包的环境里触发缺失路径。

**验证状态**：✅ **已修复（2026-08-01）**。全量 **454 pass / 0 fail**。

---

### Finding 8：测试套件未隔离 `CCMEM_CONFIG_PATH`，用户配置会污染测试（P1，未修复）

**现象**：`npm test` 在本机 **443 pass / 11 fail**；`env -u CCMEM_CONFIG_PATH npm test` 则 **454 / 0**。

**根因**：测试文件统一设置了 `CCMEM_TEST_MODE` 与 `CCMEM_DATA_ROOT` 来隔离环境，
但**没有隔离 `CCMEM_CONFIG_PATH`**。`loadConfig()`（`config.mjs:291`）照读不误，
于是测试进程加载了用户真实的 `~/.claude/ccmem/config.json`。
人类今天往该文件加入 `provider: "openai"` 后，11 个测试跑去加载 OpenAI provider 而失败。

**影响面**：**任何通过配置文件设置了非默认 provider 的用户，跑 `npm test` 都会看到失败**，
且失败原因与被测代码无关。这与 ledger 反复记录的失败形态同构：绿/红都不代表代码的真实状态。

**与 Finding 7 无关**：修复前这些测试同样失败，只是错误信息是裸的 `ERR_MODULE_NOT_FOUND`。

**修复（PROPOSED，未应用）**：测试入口统一 `delete process.env.CCMEM_CONFIG_PATH`
（与既有的 `CCMEM_DATA_ROOT` 处理一致），或在 `package.json` 的 test 脚本里 `env -u`。
前者更稳（不依赖调用方式）。

**验证状态**：⏳ 未修复，待裁决是否纳入本版。
**临时规避**：本机跑套件请用 `env -u CCMEM_CONFIG_PATH npm test`。

---

### Finding 9：daemon 与 CLI 读到两份不同配置，语义检索静默为空（P0 → **已修复**）

> **本条已按实测重写（2026-08-01 下午）。原记述的根因是错的，不要照着它去修。**
>
> 原文写「三个互不相同的签名」「签名函数有缺陷」。实测结论相反：
> **签名函数是对的，它被喂了两份不同的配置。**
> 原文列的第三个签名 `local:Xenova/all-MiniLM-L6-v2:0` **在当时的代码里就复现不出来** ——
> 它是 `currentEmbeddingSig(cfg)` **只传一个参数**的产物（`provider=cfg, config=null` ⇒ 标签 `'local'`、`dim 0`），
> 而生产的 17 个调用点全是两参数。**那是上一轮的测量误差，不是运行时行为。**

**现象**：`semantic status` 显示 `enabled=true provider=openai embedded=4223 pending=4223`
—— 全部已嵌入，却全部待办。无任何报错。

**取证（只读，同一个函数、两种环境）**：

| 进程 | `cfg.embedding.provider` | `currentEmbeddingSig` 输出 |
|---|---|---|
| CLI / hooks（有 `CCMEM_CONFIG_PATH`） | `"openai"` | `openai:text-embedding-3-small:1536` |
| daemon（**没有**） | `"transformers-local"` | `transformers-local:Xenova/all-MiniLM-L6-v2:384` |

库里 4223 行全是后者，`daemon.err.log` 逐批打印的也是后者 —— 完全吻合。**只有两个签名，不是三个。**

**根因**：`scripts/lib/admin/daemon.mjs:47` 的 `buildDaemonEnv()`
**不是继承环境，而是用白名单重建环境**（PATH / `CCMEM_DATA_ROOT` / `CCMEM_CLAUDE_P_*` / 9 个 `ANTHROPIC_*`）。
`CCMEM_CONFIG_PATH` 从来不在这个名单里，于是 daemon 的 `loadConfig()` **永远返回 `DEFAULT_CONFIG`**
（`provider: 'transformers-local'`），而 CLI 与 hooks 继承用户 shell、读到 config.json 的 `provider: "openai"`。

这个白名单的来历值得记：`git log -S` 显示它只被引入过一次（`31c5831`，2026-06-04），
提交信息是 *"**propagate** daemon bridge/auth environment so launchd summarization can write memories"*
—— **它是"补齐"清单，不是"收窄"清单**，因为 launchd 启动的进程本来就不继承任何 shell。
v0.13 的 ledger 里对它零记录，**从未有过人类裁决**。

**为什么这次才炸**：`config_kv` 的 `embedding.active_provider` 行曾是**唯一能跨进程传递 provider 的通道**（daemon 读 DB）。
**Finding 6 的修复在裸 `semantic on` 时删掉那一行**，把权威交还给配置文件 —— 而 daemon 读不到配置文件。
Finding 6 的裁决本身是对的，但它切断了 daemon 的最后一条通道。**两条各自正确的改动合成一个静默故障。**

**修复（四处，各自先红后绿）**：
1. `CCMEM_CONFIG_PATH` 进 daemon 环境白名单（根因）。
   **API key 刻意不进** —— `renderPlist` 会把环境字典明文写进 `~/Library/LaunchAgents`；
   daemon 靠读配置文件拿 key，只要 ① 成立 ② 自动成立。
2. 签名契约改为 **无 provider 即无签名，返回 `null`**（不再由 `?? 0` 伪造一个没有任何向量拥有的 `dim:0`）。
   **注意：dogfood 原文写的「抛错」方案会打断 daemon 主循环** —— `daemon/main.mjs:40` 与
   `vec-backfill.mjs:59` 都合法地传 null provider 并在之后处理。
3. provider 标签默认值 `'local'` → `'transformers-local'`，使签名不会命名一个 `providerByName` 拒绝的 provider。
   （**如实声明：这一条没有生产可达的红测** —— `DEFAULT_CONFIG` 永远带 `provider`，该分支进不去。不为它编一个恒绿的测试。）
4. 移除 `semantic on` 里那个换模型检测器 —— 见下方"顺带拆掉的定时炸弹"。

**必须同时知道的第二层（现已单独成条，见 Finding 10）**：daemon 由 **launchd 托管**，
`~/Library/LaunchAgents/com.ccmem.daemon.plist` 的 `EnvironmentVariables` 是**安装时冻结的快照**，
**`admin daemon restart` 不会重新生成它**。所以第 1 条修复对已安装的用户**不会自动生效**，
必须 `admin daemon uninstall && install`，且没有任何提示告诉用户这件事。
⚠️ **本段原写「靠 `ps eww -p <pid> | grep CCMEM_CONFIG_PATH` 才发现 restart 白做了，这条验证不可省」——
该取证手段在这台机器上不成立**（`ps eww` 读不到进程环境，见下方 Finding 12 的「测量陷阱」框）。
可用的判据是代码路径与磁盘上的 plist 本身，**见 Finding 10**。

**顺带拆掉的定时炸弹**：`config_kv` 当时的状态是 `active_model=text-embedding-3-small` 但**无 `active_provider`**
（Finding 6 的修复只删了后者）。两个键来自不同层，于是在一个没有 `CCMEM_CONFIG_PATH` 的 shell 里跑一次裸的
`semantic on` ⇒ `newModel ≠ currentModel` ⇒ 触发 `UPDATE memories SET embedding = NULL`，**4292 条向量全清**。
经人类裁决**整体移除该检测器**：签名机制已经正确且非破坏性地覆盖了换模型（vec_backfill 按签名不匹配逐批重嵌，
从不在替代品就位前丢弃向量），检测器唯一的独特效果就是数据丢失，且 review 早已把它列为 v0.14 移除项。

**验证状态**：✅ **已修复并端到端验证**。daemon 现在写 `openai:text-embedding-3-small:1536`，
`pending` 归零，`diagnose --retrieval` 的 `stale vectors: 0`、Circuit CLOSED。

**教训**：本条原记述之所以错，是因为上一轮**用一个与生产不同的调用形态去测量生产行为**。
「三个签名」这个说法本身就该引起警觉 —— 生产里只有两个进程，不可能有三个当事人。

### Finding 10：launchd plist 是安装时冻结的环境快照，`restart` 不重新生成（P1 → **已修复**）

**由 Finding 9 分出。** Finding 9 的修复 ① 把 `CCMEM_CONFIG_PATH` 加进 daemon 环境白名单
（现见 `admin/daemon.mjs:65-74` 的 `passthroughKeys`，注释写明了 API key 为什么刻意不进）。
但那条修复**对已安装的用户不会自动生效** —— 原因不在白名单，在 plist 的生命周期。

**代码事实（2026-08-02 逐处复核，非转述）**：

| 环节 | 代码位置 | 是否重写 plist |
|---|---|---|
| `admin daemon install` | `admin/daemon.mjs:526` `writeFileSync(plistPath, renderDaemonPlist(...))` | ✅ **唯一一处** |
| `admin daemon restart` | `admin/daemon.mjs:693` = `stopDaemon` + `startDaemon`，二者之外无别的动作 | ❌ |
| `stopDaemon` | `admin/daemon.mjs:662` → `launchctl bootout` | ❌ |
| `startDaemon` | `admin/daemon.mjs:615` → `launchctl kickstart`，失败回落 `bootstrap`（`:617`） | ❌ 两者都只读磁盘上现有的 plist |

`admin/daemon.mjs` 全文只有四处 `writeFileSync`（`:157` 安装状态、`:202` fallback wrapper、
`:237` wrapper pid、`:526` plist），写 plist 的那处在 `installDaemon()` 体内。
⇒ `EnvironmentVariables` 字典的内容 = **执行 `install` 那一刻 `buildDaemonEnv()` 的求值结果**，
此后仓库代码怎么改都不改变它。

**没有任何东西会把这件事告诉用户 —— 三条都核过**：

1. 全仓唯一出现 "reinstall" 字样的是 `admin/daemon.mjs:290`，讲的是 Claude 二进制不支持 `--json-schema`，与本条无关。
2. `renderPlist()`（`admin/daemon.mjs:336`）确实会用**当前**环境重新求值，
   但它**在生产代码里没有任何调用点** —— 全仓引用它的只有 `tests/integration/v013-daemon-config-path.test.mjs`。
   ⇒ 也就不存在一条"看看现在的 plist 该长什么样"的命令能让用户撞见分歧。
3. `install` 的返回里带 `plist: readPlist()`（`:543`/`:554`），读的是**磁盘上的**内容，且只在 install 时返回；
   没有任何地方把磁盘 plist 与重新求值的结果做 drift 比较。

**影响面比 Finding 9 大**（记述取自修复前的代码事实，**本条已修复，不代表当前行为**——见下方「验证状态」）：
任何改动 `buildDaemonEnv()` 白名单、`PATH` 拼装或 node 路径解析的修复，在修复前对既有安装都是
**静默无效**的。Finding 9 是第一次踩中，但机制在修复前是通用的。

**验证状态**：✅ **已修复并在真实环境实测**（2026-08-03）。`restart` 现在会在**字节不等、环境字典可解析、
G1–G4 全过**时重写 plist（附录 A **#143**）；其余情形字节不变，`restart` 仍成功。

实测过程：先 `ccmem admin daemon install`，此时真实 plist 里 `grep -c ANTHROPIC_SMALL_FAST_MODEL` 返回 **0**；
同一条 grep 对 `CCMEM_DATA_ROOT`（一个确定存在的 key）返回 **1**，作正面对照，
证明这个 `0` 是真 0，不是 grep 本身失效。再带着 `ANTHROPIC_SMALL_FAST_MODEL` 跑一次
`./bin/ccmem admin daemon restart`，同一条 grep 变为 **1**，对照仍是 **1**。
⇒ `restart` 确实重新生成了真实 plist，不只是测试里绿。收尾后机器已还原为字节级原状，daemon 验证在运行。

**自动重写不覆盖指向类**：Finding 9 自己那类（`CCMEM_CONFIG_PATH`/`CCMEM_DATA_ROOT` 等指向类 key
的改动）被 G2 拦下，不会自动重写，仍需人工 `uninstall && install` ——这是刻意的（见设计文档
§三「自动重写覆盖什么、不覆盖什么」）。`PATH` 拼装、node 路径解析等非指向、非凭据类的修复
则会自动重写进 plist。

**取证方式本身值得记**：本条的依据**全部是代码路径与磁盘文件**，不是进程环境读数。
Finding 9 原文说这件事是靠 `ps eww -p <pid>` 发现的，**那条手段在这台机器上根本读不到进程环境**
（见 Finding 12 的「测量陷阱」框），该处已改。

### Finding 11：owner 已死的 `running` 任务把回填链堵死（P1 → **已修复**）

**现象**（记述取自修复提交，**本轮未复现，不作为本轮实测**）：
`admin daemon restart` 在批次中途杀掉 daemon 之后，回填链停在 `pending=1159` 并保持 12 分钟不动 ——
无报错、无日志行，`semantic status` 的数字就是不再动。同一天还积了四条 `summarize_pending` 孤儿
⇒ 这是 `tasks` 表的性质，不是 `vec_backfill` 独有的。

**根因：两个各自正确的 guard 合成死锁。**

| 位置 | 数什么 | 为什么它单独看是对的 |
|---|---|---|
| `daemon/tasks/vec-backfill.mjs:36` `enqueueContinuation` | **只**数 `queued` | 调用它的那个 run 自己就是 `running`；把 `running` 算进去会让条件恒真，链子永远续不上（`:31` 注释写明是刻意的） |
| `daemon/main.mjs:44` 启动重排队 | 数 `queued` **或** `running` | 启动时什么都没在跑，把 `running` 算进去才不会重复排队 |

`running` 行的 owner 一旦死掉，**两边都不动它**：前者看不见它，后者把它读成"已经排上了"。
在此之前没有任何东西回收这种行。

**修复**（提交 `fix(daemon): reclaim tasks left running by a dead daemon`）：
`reclaimOrphanedTasks`（`daemon/loop.mjs:244`）在启动时把所有 `running` 无条件置 `failed`，
写 `error_excerpt='daemon exited while this task was running'` —— 与 `runTask` 记录失败的方式一致，
于是各任务类型自己的重排队路径接手。调用点 `daemon/main.mjs:64`，
**排在 `warmSemanticProvider`（`:71`）之前**，`:62` 的注释说明了原因：后者的重排队 guard 正是会被孤儿压住的那个。
回收数 >0 时写 stderr（回填自己的进度行也走那里）。

**"无条件回收"的安全性边界 —— 提交信息里被压缩成一个词，这里展开**：
论证是"`acquireDaemonLock` 返回即证明没有第二个 daemon"。核 `daemon/lock.mjs`：
它在 `heartbeat_at` 距今 **> 60000ms** 时**强取**锁（`:11-18`），只有心跳新鲜时才抛 `daemon already running`（`:22`）。
⇒ 严格的前提是"**没有心跳在 60s 内的另一个 daemon**"，而非绝对唯一。
**本条不主张这个窗口构成实际故障** —— 只是把前提写清楚，别让后来者把它当成无条件成立。

**验证状态**：✅ **已修复**。回归测试 `tests/unit/v013-orphaned-tasks.test.mjs` 两条，
提交信息记载两条均先被看着变红（`0 !== 2 reclaimed`；`1 !== 0` 幸存行堵住 guard）。
**本轮实测重跑该文件：2 pass / 0 fail。**
**本轮未查 live 库当前还有没有孤儿** —— 那里查出 0 在本条上不构成证据（0 的来源见 §六）。

**顺带核到的陈述性瑕疵**：`daemon/tasks/vec-backfill.mjs:27` 的注释仍写
`vec_backfill ... is on no recurring schedule`，但 `daemon/tasks/daily-maintenance.mjs:150`
**每天直接 `await runVecBackfill(db, task)`**（不经 `tasks` 表）。注释陈旧，行为无误。

### Finding 12：hook 进程与 CLI 读到两份不同配置，语义贡献恒为 0（P0 → **已修复**）

**Finding 9 的同一种病，换了个当事人。** Finding 9 修的是 daemon 侧（白名单缺 `CCMEM_CONFIG_PATH`）；
本条是 **hook 侧**，至今未修。发现于 2026-08-01 深夜做 V4 验证时。

**现象**：`metrics.jsonl` 的 `prompt_submit` 行，两种结果在时间上**交错出现**：

```
19:16:52  pool=1322  stale=0     cos_contribution=0.985  path=A
19:17:27  pool=0     stale=4406  cos_contribution=0      path=A   ← 35 秒后
23:54:35  pool=0     stale=4449  cos_contribution=0      path=A   ← 此后连续 27 次
```

交错 ⇒ **不是代码变更，是不同进程读到不同配置**。`stale` 恰好等于库中全部已嵌入行
（4454 条 `openai:text-embedding-3-small:1536`，差值来自采样间隔内的新增），即该进程认为**没有一条向量可用**。

**根因**（`scripts/lib/config.mjs:291-297`）：

```js
const userPath = process.env.CCMEM_CONFIG_PATH;
if (!userPath || !existsSync(userPath)) {
  return applyV08Compatibility(DEFAULT_CONFIG);   // ← 不回落到 ~/.claude/ccmem/config.json
}
```

`loadConfig()` 在该环境变量缺失时**直接返回 `DEFAULT_CONFIG`**，而不是回落到用户配置文件。
`DEFAULT_CONFIG.embedding.provider = 'transformers-local'`，`config_kv` 的 `embedding.enabled=true`
又把它打开 ⇒ 这类 hook 进程**用 MiniLM 嵌入查询**，算出 `transformers-local:...:384`，
与库里 4454 条 openai 签名无一匹配。

**三个必须一起看的后果**：

1. **检索静默退化为纯词法**，而 `retrieval_path` 仍报 `'A'` —— 该字段只说明"embedding 可用、走了融合分支"，
   **不说明 cosine 有没有贡献**。真正的判据是 `cosine_contribution` 与 `retrieval_pool`。
2. **「G1 已达成」的口径必须收窄**：回填确实跑通了（4454 条向量、`pending=0`），
   但**消费端大部分时间没在用它们**。「库里有向量」≠「检索在用向量」。
3. **V4 的三个消费点全部正确工作 —— 正是它们的正确工作，才让这次配置分歧表现为静默的 0
   而不是错误的检索结果。** 签名过滤按设计把不可比的向量全部排除了。

**谁有、谁没有（2026-08-02 取证）**：

| 进程 | 有 `CCMEM_CONFIG_PATH` | 证据 |
|---|---|---|
| 三个 live Claude 会话中的 1 个 | 有 | `zsh -f -c`（完全不读 rc）仍继承到该值 ⇒ 来自 claude 进程 |
| 另外 2 个会话 | **没有** | 它们的 hook 时间戳与 metrics 里全部 `pool=0` 行**逐条对齐** |
| daemon | 有 | plist 重装带入（Finding 9 的修复） |

**该变量没有任何持久来源** —— 不在 `.zshrc`/`.zprofile`、不在 `launchctl`、不在 Claude settings。
它只存在于当初有人手动 export 过的那个 shell 及其后代里。**"没有它"才是常态。**

> **测量陷阱，记一笔**：handoff 曾写「验证手段只有一个：`ps eww -p <pid>`」。
> 这台机器上 **`ps eww` 根本读不到进程环境** —— 对自己的 shell 执行都查不到明明存在的变量。
> 用它得出的任何"没有该变量"都是测量失效，不是事实。可靠替身：
> `zsh -f -c 'echo $VAR'`（验继承）、进程自身写出的签名（验 daemon）、
> `memory_feedback.session_id` + 时间戳（验 hook 属于哪个会话）。

**修复（人类裁决：统一回落）**：`loadConfig()` 在变量缺失或指向不存在的文件时，
改为读 `getDataRoot()/config.json`；变量本身降级为**覆盖**而非唯一来源。
路径经 `getDataRoot()` 解析而不是再写死一份 —— 配置文件从此跟着库走，
**日后把默认目录从 `~/.claude/ccmem/` 迁到别处时只需改 `paths.mjs` 一处**。
`getDataRoot()` 因此移入新的 `scripts/lib/paths.mjs`（`config.mjs` 不能 import `db.mjs`，后者已 import 前者），
`db.mjs` 保留再导出，六个既有导入方不受影响。

**同时必须改测试隔离**：`env -u CCMEM_CONFIG_PATH` 原本够用，正是因为"没有变量 = `DEFAULT_CONFIG`"。
回落一加，测试会读到真实的 `~/.claude/ccmem/config.json`，**连 API key 一起**。
已实测确认该泄漏存在，再把 `CCMEM_DATA_ROOT` 钉到一次性目录 ——
Finding 8 的隔离不但保住，而且更强（库也是临时的了）。

**验证状态**：✅ 已修复并端到端验证。在**真正的 hook 入口**、不带该变量、数据根隔离的条件下：
`retrieval_pool` 0 → **1360**，`stale` 4449 → **0**，`cosine_contribution` 0 → **0.967**。
对照组是 metrics 里此前连续 27 行的 `pool=0`。套件 470 pass / 0 fail。
`~/.claude/plugins/ccmem` 是指向本仓库的符号链接，**hook 下次调用即生效**，不像 daemon 那样需要 uninstall/install。
已记为 `bug-058`。

### Finding 13：`withHookSafety` 的超时预算对同步工作完全无效（P1 → **已修复：改为按实测尺寸设外部超时**）

**发现路径**：追查 V8 里顺手记下的 `stop` hook 线索时撞见的。它比那条线索本身重要得多 ——
**它推翻了「内部预算能兜底」这个贯穿全项目的前提。**

**矛盾的两个事实**（2547 次生产 stop hook 运行）：

| 事实 | 值 |
|---|---|
| `ms_business` 超过 200ms 预算的比例 | **50.2%** |
| metrics 里记录的超时次数 | **0** |

一个正常工作的计时器不可能同时满足这两条。

**根因**：`withHookSafety` 用 `Promise.race([fn(), setTimeout(reject, budget)])` 计时，
而**定时器回调只在事件循环空闲时才会执行**。ccmem 的 hook 大量是同步的 ——
`node:sqlite` 是同步 API，`stop` hook 还要先把整个 transcript 读完再碰数据库 ——
同步工作霸占事件循环，那个 reject 永远排不上队。

**直接实验**（不是推断）：
```
异步 800ms 工作 → 在 201ms 被切断      ← 预算生效
同步 800ms 工作 → 跑满 800ms，没被切断  ← 预算完全无效
```

**这条修正了 V8 的结论，但没有推翻它的修复**：prompt_submit 抬高 harness 超时是对的，
而且比原提交说的**更必要** —— "优雅降级"这个理由只对异步部分成立，
而那次恰好正是 OpenAI 调用（异步）在撑爆预算，所以方向没错、理由说窄了。

**真正的结论**：**harness 超时不是内部预算背后的兜底，对同步工作它是唯一的限制**，
因此必须按**工作本身的实测 p99** 来定尺寸，而不是按预算定。

**修复**：

| hook | 实测 | 原超时 | 现超时 |
|---|---|---|---|
| `Stop` | p99 824ms / **max 1787ms** | 1s | **3s** |
| `SessionStart` | p99 262ms / max 356ms | 1s | **2s** |
| `UserPromptSubmit` | p95 1787ms（见 V8） | 2s | 5s |

三个预算合并进 `HOOK_BUDGET_MS` 一张表，不变量测试覆盖全部 hook 而不只是出事的那个；
**同步工作不受预算约束这件事本身也写成了测试**，并明确标注它记录的是「限制」而非「期望属性」——
否则那个余量迟早会被当成富余砍掉。

**被杀一次的代价（这是把 1s 改掉的理由）**：丢掉该轮的 `summarize_pending` 入队与 L2.5 探针行。
两者都随 transcript 长度增长，**所以最容易被杀的恰恰是内容最多的长会话**，
而 v0.14 要依赖的探针数据集会系统性缺失慢会话。

**未做（需人类裁决）**：让预算对同步工作真正生效需要把 hook 的工作切段、在段间检查耗时 ——
这是设计改动，不是顺手能改的。当前选择是**承认限制并按实测定外部超时**。

---

### Finding 14：`Number(null) === 0` 让熔断阈值成为死代码（P1 → **已修复**）

**发现路径**：做 V5 时顺手核对 `config_kv`，看见 `embedding.circuit_open_until` 有值 ——
而 handoff 与 V8 都写着「熔断至今一次没开过」。**先解释这个矛盾，才撞见根因。**

**两个对不上的事实**：

| 事实 | 值 |
|---|---|
| `config_kv` 证明熔断当天开过（`set_at` 02:04:22Z，5 分钟窗口） | 开过 |
| `audit_log` 中 `embedding_circuit_open` 累计行数（表回溯到 2026-05-30、3863 行、**未裁剪**） | **0** |
| 同表 `embedding_circuit_close` | 2 |

**恢复被记录了，导致恢复的失败没有。** 这个不对称是本条唯一的入口 —— 只看 close 会以为一切正常。

**根因（`provider.mjs:30`）**：`readConfigKvInt()` 先转换、后判存在：

```js
const raw = readConfigKv(key);   // key 不存在时返回 null
const n = Number(raw);           // Number(null) === 0
return Number.isFinite(n) ? n : null;   // 0 有限 ⇒ 返回 0，不是 null
```

而两个调用方都用 `== null` / `!= null` 判存在性。**"从未失败过的库"于是读作"熔断已经开着的库"。**

**一次强制转换，三个后果**（均在 live 库的 `VACUUM INTO` 副本上先复现、后修改）：

1. **阈值是死代码，第一次失败就开闸。** `recordEmbedFailure:149` 永远走"已开着，延长窗口"分支并 `return`。
   探针实测：failure #1 之后 `openUntil` 已写、`consecutive_failures` **为 null**，此后不变。
   `embedding.circuit.failure_threshold` 从来没作用于任何东西。
2. **open 的 audit 落在这条不可达分支里** —— 即上表那个 0。
3. **`getProviderWithCircuit` 的 `'closed'` 快路径同样不可达**，健康检索每次都落到探测分支并写
   `embedding.last_probe_at`。而 `retrieval.mjs:358` 在**查询向量缓存命中**时跳过 embed、
   因而也跳过 `recordEmbedSuccess` ⇒ 该行不被清 ⇒ `probe_interval_ms`（默认 60s）内的下一次检索
   被判成熔断打开，**在零失败的情况下**退化为纯词法。

**生产计数**：2060 条带 `retrieval_path` 的行中 `B-off` 1965 / `A` 79 / **`B-circuit` 9** / `B-fail` 7。
按 300s 冷却期逐条对齐：6 次紧跟真实失败（正确门控），**3 次冷却期内没有任何失败**。

> **这 3 条不作为证据**：`B-fail` 行由 hook 自己写，被 harness 杀掉的那次留不下行 ——
> **Finding 13 的幸存者偏差在这里同样成立**。本条修复站得住的是直接复现，不是这个计数。
> 记在这里是为了说明该机制在生产中可达，不是为了证明它。

**修复**：`raw == null` 时在转换前返回 `null`。

**刻意的行为变更**：熔断现在容忍 2 次失败才开，即 `failure_threshold` 本来的语义。
Finding 4 已把 hook 与回填的超时分开，单次瞬时超时不该赔上整条语义通道。

**回归测试**（`tests/unit/v013-circuit-threshold.test.mjs`，4 条，每条先被看着变红且红因与预测一致）：
1. 单次失败只计数不开闸 — RED（`consecutive_failures` 恒为 null）
2. 第 3 次才开闸**且落 audit** — RED（第 2 次时已开；audit 计数 0）
3. 从未失败的库报 `'closed'` 且**不写** `last_probe_at` — RED（`half-open` + 已写入）
4. 真开着的熔断仍必须门控 —— **防过度修正的对照**，按设计修复前后皆绿，用来抓"总是返回 closed"的实现

**验证状态**：✅ **已修复**（提交 `fc66890`）。套件 **477 pass / 0 fail**（原 473，+4）。
副本上端到端复核：`1→2→3` 才开闸、audit 落 1 行、第 4 次只延长窗口不重复 audit。
**无需重启 daemon** —— 熔断 API 的调用点只有 `retrieval.mjs`，其消费者
（`prompt-submit.mjs` / `cmd/list.mjs` / `admin/retrieval-check.mjs`）全是每次新起的进程，
`scripts/daemon/` 零引用。已记为 `bug-060`。

---

### Finding 15：`openai_timeout_ms: 800` 落在查询嵌入延迟分布的中间（P1 → **已取证；🆕 已于 2026-08-10 修复，抬至 1200**）

> 🆕🔴 **本条状态已变更（2026-08-10，v0.13 闭合之后）：常数已从 800 抬到 1200 并合进 `main`。**
> **下面这一整节保留为发现当时的原文**（那是 Finding 15 的取证记录，仍然成立）；
> **修复、预登记判据、以及"结论还没出来"这三件事见本文档末尾的《v0.13 闭合后：Finding 15 的后续》。**
> ⚠️ **不要把本节读成"至今未修"** —— 那是本条在 2026-08-02 闭合时的状态，不是现在的状态。

**发现路径**：为回填 V4 的"生产计数"而按 Finding 12 修复时刻切分 `metrics.jsonl` 时撞见的。

**现象**（全部样本取自 Finding 12 修复之后，`hook=prompt_submit` 共 **193** 行 ——
冻结快照，取自 **2026-08-04 21:32** 的 `metrics.jsonl` 副本）：

| `retrieval_path` | n | `retrieval_embed_error` | `retrieval_embed_ms` |
|---|---|---|---|
| `A`（走成语义） | 130 | — | 322–948ms（另 25 次 0ms = query 向量缓存命中） |
| `B-fail` | 54 | 全部 `Request timed out.` | **802–809ms** |
| `B-circuit` | 8 | — | — |
| `B-off` | 1 | — | — |

> **`A` 行的区间与它的 n 必须同源。** 上面这一格取自与全表相同的 2026-08-04 21:32 快照：
> 成功样本 n=105（130 减去 25 次缓存命中），min **322** / p50 669 / p90 736 / max **948**。
> 该格一度残留着旧快照（`B-fail`=43 那一版）的 `384–796ms`，与旁边换过的计数不同源 ——
> 这正是本轮"计数必须来自单一快照"那条纪律要防的错误，别再让它复发。

**105 条成功样本里只有 1 条越过 800ms**（那条 948ms 至今未解释，见探针设计文档 §八.2，单点不用于任何结论）；
**其余 104 条全部落在 800ms 以下，而 54 条失败样本全部落在 802ms 以上。**
换句话说 800ms 这条线不是画在分布之外，而是**直接切在分布主体上**。
`openai_timeout_ms: 800` 不是一个"只有异常才会碰到"的上界，
它**落在真实查询嵌入延迟分布的中间** —— 真实尝试（触达 provider 的调用，即 `A` 减去缓存命中
再加 `B-fail`：105 + 54）共 **159** 次，其中 `B-fail` **54** 次超时，截尾率 **34.0%**，
即 `800ms` 落在约 **p66**（`B-circuit` 与 `B-off` 未触达 provider，不计入真实尝试分母）。

**这与 Finding 12 的症状相同、原因不同**，不要混淆：
Finding 12 是签名不匹配（`pool=0`、`cos=0`，向量存在但不可比）；
本条是 embed 压根没返回（`pool=null`、`cos=null`），检索**退化为纯词法**。

**根因不是代码缺陷，是一个没跟着预算变的常数**：

| 时点 | hook 侧预算 | `openai_timeout_ms` |
|---|---|---|
| Finding 4（拆开 hook 与回填的超时） | 内部预算 200ms | 800（**为 hook 选的**，当时"反正会降级"） |
| V8 / Finding 13 之后 | harness **5s**、内部预算 **2000ms** | **仍是 800** |
| 🆕 **2026-08-10（v0.13 闭合后）** | harness **5s**、内部预算 2000ms（**该软闸从未开过火**，见末节） | **1200** |

Finding 4 里"这个选择是对的"的前提已经被 V8/Finding 13 换掉了，**而这个值从未被重新推导**。

**必须一起看的第三个后果**：`B-fail` 会走 `recordEmbedFailure`，
连续 3 次即开熔断（Finding 14 修复后的正确语义）。
所以偏小的超时不只丢当次检索，还会**周期性把整条语义通道关掉一个 `probe_interval`**。
实测中连续两次失败已经发生过（12:49:53、12:52:57）。

**为什么本轮不修**：修它等于重新选一个值，而判据应当是实测 p99。
**现有数据算不出这个 p99** —— `retrieval_embed_ms` 只在成功时有意义，
失败样本被 800ms 截断，这是**截尾数据**。要得到真实分布，
要么临时放大超时取样，要么用回填侧无截断的样本近似。
取样动作会改变生产行为，属人类裁决，故本轮只取证。

**⚠️ 这条曾被写成"修复后零次熔断"，已被证伪。** 该说法在 2026-08-02 12:20 落笔时为真，
当晚即不再成立：熔断在 **08-02 23:10:20–23:20:13 之间开了 7 次**，并在 **08-04 21:01:41
又开了第 8 次**。Finding 14 的"连续 3 次"语义工作正常 —— 喂给它的正是本条的超时。

触发链（同一快照实测）：

    22:55:51  B-fail          失败 1
    22:57:29  B-fail          失败 2
    23:07:35  A  (embedMs=0)  ← 查询向量缓存命中，未触碰 provider，因此不重置失败计数
    23:08:57  B-fail          失败 3
    23:10:20  B-circuit       闸门打开

**缓存命中不重置连续失败计数** —— 统计"连续"类计数器时，只有真正触达 provider 的调用才算数。

**验证状态**：✅ 已取证（live 库 `VACUUM INTO` 副本 + `metrics.jsonl` 按修复时刻切分）；
❌ **未修**，列入 v0.14。

---

## 三、Dogfood 验证清单

> 单元/集成测试用 mock provider 与 `:memory:` DB。下列项必须在**真实环境**验证。

### V1. A2 质量门两条新规则在真实入库流上的行为
- [x] 前置：daemon 已重启（Finding 1）✅
- [ ] 正常使用 3–7 天，让 `summarize_pending` 自然处理真实待入库内容
- [~] `admin diagnose --tuning` 中 `negative_assertion` / `env_failure` 出现非零计数
      —— **只达成一半**：`negative_assertion` **3**（全部在 daemon 重启之后），`env_failure` 仍 **0**
      且**规则遮蔽未被排除**。见 §五 V1
- [ ] **重点是误杀，不是漏杀**：用 `/ccmem:audit` 读每条 `quality_gate_reject` 的 80 字符摘录，人工判断是噪声还是合法约束
  - 预期误杀形态（review I5）：`"这个 API 不支持批量请求，需要逐条调用"`（合法 API 约束）、
    `"prettier is not installed globally; use npx prettier"`（51 字符，低于 Latin 120 门限，却正是提取提示词要求的 remedy 形式）
- [ ] **计数为 0 时不得直接下结论 —— 存在规则遮蔽**：`env_failure`(`:88`) 与 `negative_assertion`(`:95`)
      是 9 条规则中的第 8、9 条，命中即返回。同时像 `path_list` 又像 `negative_assertion` 的内容会被记成前者。
      要区分需离线把候选内容逐规则喂给 `checkQuality`，而非看线上计数。
- [ ] **成功判据**：≥ 20 条经这两条规则的拒绝被人工判读，误杀率有一个数（数值高低不由 dogfood 裁决）
- [x] **关注 Finding 1**：确认观测窗口起点晚于 daemon 重启时刻，否则计数仍是旧代码的
      —— §五 V1 的计数即按 08-01 09:41 切分，并附全期对照

### V2. A1 探针数据积累与判据可行性
- [ ] 不改动任何东西，让探针继续采集；每日快照一次 `admin diagnose --feedback` 并追加到 §五
- [x] **成功判据**：随机对照非 CJK 样本 **n ≥ 60** —— ✅ **达成，n=399**（基线 21）。见 §五 V2
- [x] 记录 p50 随 n 的漂移轨迹；若 n 翻倍后仍在 ±0.03 内摆动，即证明分位数不可作判据
      —— 实测漂移 **0.125 → 0.075 → 0.029**，跨度 0.096 **远超** ±0.03 ⇒ 判据不可用，结论成立
- [ ] **已知限制**：`l25_legacy_hit` 恒为 **0/1666**（基线 0/389），**无任何正例标签**，采集再多也算不出 precision/recall
      —— 该限制由 v0.14 的人工标注解决，不属 dogfood 范围
- [ ] **已知偏差，记入分析笔记不修**：随机组排除范围只有 `recent_injections` 那么宽，
      而 tier15 裁到每会话 20 条，超长会话约 1.8% 污染率（k=3），方向保守（抬高噪声底）
- [x] **关注 Finding 2**：不要把 p50 的任何一次翻转当作结论
      —— 本次快照信号(0.081) 已高于噪声(0.029)，**这不是"有信号了"**，理由见 §五 V2

### V3. B1 首次启用与回填恢复路径

**本地 provider（transformers-local）：✅ 2026-08-01 已通过**

- [x] **成功判据达成**：`pending` 4155 → 0，**全程零手工 `admin cron run vec_backfill`**
- [x] 证据：`audit_log` 中 `vec_backfill_run` **136 次**，而人类仅重启 daemon 2 次；
      4161 条 ÷ 50/批 = 84 批 —— 链式自动排队确实在跑
- [x] 机制：`vec-backfill.mjs:36` `enqueueContinuation()` 在每批结束后排下一批，
      guard 只计 `queued` 不计 `running`（否则条件恒真、链条永不继续）
- [x] **这就是 review I3 修复的全部意义**：修复前 vec_backfill 仅在 daemon 启动时入队、无重复调度，
      4161 条需 `ceil(4161/50) = 84` 次 daemon 重启才能恢复语义检索 —— 用户既想不到也做不到
- [x] 签名分布干净：`transformers-local:Xenova/all-MiniLM-L6-v2:384 -> 4161`（单一签名，无混杂）

**OpenAI provider：✅ 2026-08-01 已通过**（逐条回填于 2026-08-02，证据见各条）

- [x] 签名为 `openai:text-embedding-3-small:1536` —— daemon 侧逐批打印该签名（Finding 9），
      副本实测 **4696 行**携带它
- [x] 4161 条既有向量因签名不匹配被 `vec-backfill.mjs:74-76`
      （`WHERE embedding IS NULL OR embedding_sig IS NULL OR embedding_sig <> ?`）捡走并重嵌
      —— 副本上 `transformers-local:...:384` 只剩 **2 行**，且均 `decay_status='quarantine'`（落在回填 population 之外）
- [x] **验证 B1 的设计意图**：签名机制自身即可优雅处理换模型，
      **无需** `semantic.mjs:89-96` 那个批量 `UPDATE ... SET embedding = NULL`。
      **这条是被反过来证明的**：Finding 9 已把该检测器**整体移除**，
      而换模型重嵌在没有它的情况下照样完成 —— 移除后仍能重嵌，正是"重叠的旧机制"这个判断的实证
- [ ] ~~`diagnose --retrieval` 的 `stale vectors` 先升后归零~~
      **只观测到「归零」，没有「先升」的样本 —— 不勾。**
      回填期间无人对 `stale vectors` 做时间序列采样，事后无法从 `audit_log` 重建该曲线
      （`vec_backfill_run` 只记 `embedded`/`remaining`，不记 stale）。
      可替代的等价证据是 `remaining` 的下降轨迹（见上方本地 provider 那条）
- [x] **关注 Finding 4**：这是 `openai_timeout_ms: 800` 的第一次真实检验（本地 provider 不走该超时）
      —— **检验结果是证伪**：回填侧 800ms 直接把链条打死（Finding 4），
      hook 侧则被证明该值落在延迟分布中间（**Finding 15**）。这一项的价值全在于它没通过
- [x] **关注 Finding 3**：回填前的 `stale vectors: 0` 是分母为 0，不是健康
      —— 已应验第二次，换了个来源（签名为 null），见 §五 V5

### V4. B1 签名过滤三个消费点在非空向量集上生效（需 G1）

**✅ 2026-08-01 深夜三项全部通过 —— 实测记录见 §五 V4。**

- [x] `retrieval.mjs:427` —— 检索侧 cosine 通道只取当前签名的行
- [x] `dedup.mjs` —— 签名不匹配的候选跳过 cosine 通道（防止同维度换模型时静默丢弃真实记忆）
- [x] `feedback.mjs`（review I2）—— **写 trust 的那个消费点**，`helpful_implicit` 不再施加到任意记忆上
- [x] 验证手段：**每个消费点都做正反两面** —— 只做正面等于 Finding 3 的分母为 0，
      因为库里 4454 条全是同一签名，过滤条件在这样的库上是恒真的 no-op，绿了什么也没证明
- [x] **注意**：I2 是 review 中唯一"签名盲且写 trust"的消费点，优先级高于检索侧漏检 —— 已按此顺序先做
- [x] **生产计数已补（2026-08-02）**。上述证据是"真实数据 + 真实代码路径"，不是"生产里跑过多少次"，
      按 §六 的纪律两者不能混为一谈。Finding 12 修复后的实测计数见 §五 V4 的第二张表。
      **结论不是"三个点都在生产里跑过"** —— `retrieval.mjs` 是，`dedup.mjs` 算出了 cosine 但未命中 lane 阈值，
      `feedback.mjs` **仍是 0 次且只能部分解释**。三条各自的分母写在表里

### V5. 配置面一致性：`config_kv` override 与两条命令的口径（需 G1）

**✅ 2026-08-02 已做 —— 分歧确认存在。实测记录见 §五 V5。**

- [x] `admin semantic status` 与 `admin diagnose --retrieval` 对 enabled 状态口径一致 ——
      **两条命令报告的 `enabled` 字段本身一致，但由它派生的计数不一致**，见下条
- [x] **follow-up 已证实**：`semantic.mjs:48` 强制 `enabled:true` 构造签名配置，而 `diagnose.mjs:58` 用原始 cfg。
      当「文件配置禁用 embedding 且 `config_kv` 未设」且**库中存在异签名行**时显形：
      同一个库上 `pending=4448` 而 `stale vectors=0`。三条件缺一不可 —— 只构造前两条会得到"两边都是 0"的假绿
- [x] `admin semantic on` 的模型切换分支 —— **该分支已不存在**，Finding 9 整体移除了它，原地只剩注释。
      本条清单项作废（原表述"本次不应触发"已过期）
- [ ] **未修**：按 Closure review，该分歧属 deferred 桶。本次只取证并记录，修复留待 v0.14

### V6. 决策流磁盘成本与 `retention_days: 0` 语义
- [ ] `diagnose --feedback` 头部持续显示 `l25-probe.jsonl` 磁盘占用（刻意让运行时成本可见，不要"优化"掉）
- [x] 实测每行体积与增速，对照设计估算（~1.3 KB/行，每 turn-aligned 轮次 ≤11 行，~200 KB/天）
      —— 行体积 **1146 B 吻合**；增速 **~2.1 MB/天 是估算的 10 倍**，但该倍数反映使用强度。见 §五 V6
- [ ] 确认 `retention_days: 0` 表示**永不自动删除**（刻意与运行时清理语义相反 —— 人类裁决 #4）
- [ ] 确认 `metrics.decision_data.enabled` 控制的是**持久性而非存在性**：为 false 时探针行回落 `metrics.jsonl`，绝不丢弃（裁决 #3）

### V7. 升级链兼容（migration 016 在真实库上）
- [x] 迁移 016 按文件名自动发现、事务内执行，已干净应用于 live store（schema 15→16）
- [x] `EXPLAIN QUERY PLAN` 在真实 14MB store 的副本上确认部分索引 `idx_memories_embedding_sig`
      对 allVecs seek 与 stale-count scan 均被选中 —— 非 hook 预算问题
- [x] 迁移后既有行 `embedding_sig IS NULL`，由 V3 的回填路径恢复（这正是 I3 存在的原因）
      —— 副本上仅剩 468 行 NULL 签名，其中 **467 行在回填 population 之外**，真正待回填 1 行。见 §五 V7

### V8. hook 延迟预算
- [x] 探针 C1+C3（reply 摘录 + 随机对照队列）实测：p50 1.36→2.88ms，p95 2.82→3.66ms
      （4,500 条记忆的库，每 turn-aligned Stop 一次 `ORDER BY RANDOM()`，预算 200ms）
- [x] G1 之后复测：启用 OpenAI embedding 后检索路径的真实 hook 延迟 —— **已测，见 §五 V8。
      结果是超时真的发生了**（用户报告 `UserPromptSubmit hook timed out after 2s`），已修复
- [ ] **熔断器介入时的退化延迟仍未测**。
      ⚠️ **本条原写作「熔断至今一次都没打开过，无样本」，那是错的** —— 熔断开过多次
      （生产 `retrieval_path=B-circuit` 共 9 次），而且**开的口径本身是坏的**：Finding 14 之前
      第一次失败就开闸，还有 3 次在零失败下误开。
      ⇒ **Finding 14 之前采集的任何熔断相关延迟样本都不可用于评估设计中的熔断行为**，
      因为它们量的是一个阈值失效的熔断。修复后需重新采集
- [ ] **关注 Finding 4**：熔断打开时应快速失败并退化为词法，而非等满超时 —— 同上，未检验

---

## 四、门禁与优先级

| 门禁 | 内容 | 不做的后果 | 成本/风险 | 状态 |
|---|---|---|---|---|
| **G0** | 重启 ccmem daemon | V1 完全无法开始；`--tuning` 的 0 计数永远是假象 | 低 | ✅ **2026-08-01 09:41 人类手动执行**（`pid=82700`） |
| **G1** | 在真实库上打开 embedding | V3/V4/V5 永远零执行，B1 正确性只有单测背书 | < $0.02；检索行为改变，非观察型 | ✅ **2026-08-01 达成，口径已收窄** —— 见下 |

### G1 执行方案 —— OpenAI `text-embedding-3-small`

> **⚠️ 以下是执行前写的方案，两处已被实际执行推翻。先读这两条，再读原文。**
>
> **① 「不需要写 ccmem 配置文件」是错的，实际走的是方案 A。**
> 原理由是"`config_kv` 优先级高于文件配置"。**Finding 6 恰恰把这个优先级当作缺陷修掉了** ——
> 裸 `semantic on` 现在会**删除**那些 kv 行，把权威交还给配置文件。
> 于是配置文件不但需要，还成了唯一的 provider 声明来源；
> Finding 9（daemon 读不到它）与 Finding 12（hook 读不到它）都是这个转移的后果。
> 密钥最终按方案 A 落在 `~/.claude/ccmem/config.json`（仓库外，含 key），
> Finding 5 那条未经检验的路径**因此被真实激活**，风险由 dogfood 承担。
>
> **② G1 的达成口径必须收窄。** 回填确实跑通（4696 条向量、真正 pending 为 1），
> 但**「库里有向量」≠「检索在用向量」**：Finding 12 之前 hook 侧大部分时间没在用，
> 修复后 `pool=0` 归零；而 **Finding 15** 表明当前仍有约 1/3 的 prompt_submit
> 因 embed 超时拿不到查询向量。**G1 达成的是"链路可用"，不是"链路始终在用"。**

**~~不需要写 ccmem 配置文件。~~**（见上方 ①）`config_kv` 优先级高于文件配置（`provider.mjs:59-79`），
且 `embedding.openai_model` 默认值本就是 `text-embedding-3-small`（`config.mjs:20`）。

**密钥落位（方案 B，规避 Finding 5）—— ~~本方案未被采用~~，实际执行的是下方备选方案 A**：
```bash
# ~/.zshrc（可提交，无机密）
[ -f ~/.zshrc.local ] && source ~/.zshrc.local

# ~/.zshrc.local（不进 git，chmod 600）
export OPENAI_API_KEY='sk-...'
```

> **备选方案 A**（key 完全不进环境变量）：把 `{"embedding":{"openai_api_key":"..."}}` 写入
> `~/.claude/ccmem/config.json`（仓库外，chmod 600），`.zshrc` 只导出非机密的
> `CCMEM_CONFIG_PATH`。代价是激活 Finding 5 那条未经检验的路径。
> 日后若需调整 `openai_timeout_ms`（Finding 4）则必须走 A。
>
> ⚠️ **不要用 `.claude/settings.local.json` 存密钥** —— 本仓库 `.gitignore` 并未忽略它。

**执行顺序（不可颠倒）**：
```bash
# 1. 密钥就位并 source
# 2. 启用（会真实验证 key）
node scripts/cli.mjs admin semantic on --provider openai
# 3. 重启 daemon —— 回填在 daemon 进程里跑，它必须继承到 OPENAI_API_KEY
```

`admin semantic on`（`semantic.mjs:80-102`）先 `provider.load()` **真实验证 key**
（无 key 直接抛 `OPENAI_API_KEY not set`，不留半开状态），再写入三个 `config_kv` 键：
`embedding.enabled=true` / `embedding.active_provider=openai` / `embedding.active_model=text-embedding-3-small`。

**两个进程都要拿到 key**：daemon（回填）与 hook（检索）。
若 key 只存在于某个终端会话，hook 取不到 ⇒ 熔断器打开 ⇒ 检索静默退回词法，**V4 就 dogfood 不到**。

**签名预期**：`openai:text-embedding-3-small:1536`。`openai_dim` 默认 null ⇒ `applyConfig` 取 1536
（`openai.mjs:17`），与该模型实际输出维度一致。注意签名在 `load()` **之前**计算（ledger I1 deviation），
用的是配置声明值而非观测值 —— 本例相符，但这是 ledger 记过的一个 minor。

**成本**：4093 条 × ≤500 字符（`save.max_chars_per_memory` 上限）≈ ≤50 万 token，
$0.02/1M ⇒ **总计 < $0.02**，不构成决策因素。

### 优先级

1. **✅ 已解除**：Finding 1（daemon 陈旧，P0）—— 解除 V1 阻塞。
2. **✅ 已完成（2026-08-01）**：G1 —— V3/V4/V5 阻塞全部解除，三项均已实测完成。
   V3 的 `pending` 下降曲线确实同时验证了 I3 修复与 Finding 4：**I3 通过**（链式排队自动跑完），
   **Finding 4 证伪了 800ms**（第二批即超时打死整条链）。**口径见上方 G1 执行方案的 ②。**
3. **dogfood 期间持续收集**：V1（误杀率）与 V2（样本量 + p50 漂移）—— 这两项是 v0.14 的决策依据。
4. **后续（v0.14 候选）**：Finding 5（`JSON.parse` 无保护）；
   `final-review-findings.md` 末尾「NOT in this wave」清单；两个 daemon 测试抖动合并为一个 issue。

---

## 五、Dogfood 验证结果

> 按 §三 V1–V8 逐项实测回填，每项附命令证据。
> 需要真实 infra 而当前不可得的子项标注 🔶 blocked，并说明已验证的替代面。

### 基线快照（2026-08-01 09:35）

**A1 探针** —— `node scripts/cli.mjs admin diagnose --feedback`
```
l25-probe.jsonl: 228,090 bytes
samples: 389 total (365 turn-aligned, 24 random-control, 0 stale-injection, 0 unclassified)

Turn-aligned（信号组）
  non-CJK (n=266)  l25_cov p50=0.103 p75=0.176 p90=0.257 p95=0.318 max=0.520
                   l25_lcp p50=1 p90=2 max=3
  CJK     (n=99)   l25_cov p50=0.042 p75=0.125 p90=0.250 p95=0.333 max=0.375
                   l25_lcp p50=1 max=2

Random control（噪声底）
  non-CJK (n=21)   l25_cov p50=0.075 p75=0.133 p90=0.176 p95=0.364 max=0.548
  CJK     (n=3)    l25_cov p50=0.053 max=0.087

legacy hits: 0/389        id literal: 0/389
```

**A2 质量门** —— `node scripts/cli.mjs admin diagnose --tuning`
```
Quality gate rejections (last 30 days): 146
  path_list 140 / too_specific 3 / test_count 2 / too_short 1
```
四种 reason 全部是 v0.13 之前的规则（Finding 1 已解释）。
**按 reason 拆分这个展示本身是 review I5 的修复产物 —— 它工作正常，
是 v0.13 第一个被真实数据确认可用的新功能。**

**B1** —— 见 Finding 3 的命令输出。

**环境**
```
main = origin/main = 3bd3092（已推送）；分支 v0.13-spec 仍在，未删
daemon（重启后）: pid=82700, startup_schema=16
```

### V1–V8 实测

V1 自 daemon 重启（09:41）起计，待回填。V3 的 OpenAI 分支已跑通（`pending=0`，待逐条回填）。
**V4、V5、V8 已完成，记录如下。**

#### V4. 签名过滤三个消费点（2026-08-01 深夜）

**方法**：`sqlite3 global.db "VACUUM INTO <副本>"` 取 live 库的一致性快照，
在副本上跑**真实代码路径 + 真实 1536 维向量**（不是 mock provider、不是 `:memory:` 库）。
**live 库全程零写入。** 异签名一律构造为 `openai:text-embedding-3-large:1536` ——
**同维不同模型**才是注释里说的 plausible-but-wrong 危险情形；维度不同会被长度检查安全挡掉，验不出东西。

| 消费点 | 正面（同签名） | 反面（异签名） | 承重性证据 |
|---|---|---|---|
| `feedback.mjs:1293`（写 trust） | trust `0.200 → 0.225`、`helpful_count 0 → 1`、feedback 行 `helpful_implicit_partial`、`evidence=l1_positive_cosine:1.000` | 异签名行是 **cosine 1.0 的完美匹配**，trust `0.5 → 0.5` 纹丝不动，feedback 行仍 `unknown`/`locked=0` | **代码突变**：`embedding_sig = ?` 改为恒真 ⇒ 异签名行立刻拿到 trust（`0.5 → 0.525`）。还原后复跑双绿，`git diff` 空 |
| `retrieval.mjs:427` | `retrievalPath=A`、`candidatePool=2281`、`cosineContribution=0.957` | 翻掉最高 cosine 行（id 4633，semantic 0.5007）⇒ `pool` 减 1、`stale` 加 1、该行**整条掉出 top-6** | 三个数字按预测精确咬合移动，等价于突变 |
| `dedup.mjs:101` | `lane=cosine`、audit 记 `cosine=0.9999999999999998` | `lane=trigram`、`cosine=null`，且 `duplicate` 仍 true、`existingId` 不变 | 同时证伪了两种失效：cosine 没被误用，**候选也没被整条丢掉**（守卫不过度） |

**正面对照是必需的，不是冗余**：`feedback.mjs` 的反面结论是"什么都没发生"，
而"什么都没发生"也可能只是探针本身坏了。同签名那一路必须能真的写进 trust，反面的空结果才可信。

**过程中栽的一次红错，如实记**：dedup 探针第一版报 `duplicate=false`，看着像反面成立。
取证后是挑错了记忆 —— `candidateRows()` 取的是**最近 touch 的 20 条**
（`ORDER BY last_touched_at DESC, id DESC LIMIT 20`），**不是 FTS 捞的**，`ftsQuery` 只作内容合法性闸门。
我挑的是 `ORDER BY id` 的最老一条，压根不在候选池里。按同一口径重挑才是真绿。
**这正是 §六"红得对吗"那条纪律的第二次应验。**

**生产真实计数（与上面的构造证据严格分开）**：

| 消费点 | 生产计数 | 说明 |
|---|---|---|
| `dedup.mjs` | `lane=cosine` **3 次** / `lane=trigram` **356 次** | 3 次 cosine 命中仍是 08-01 11:31、12:04、23:10。**"修复后无新增"的分母是 1** —— 23:10 之后总共只发生过 **1 次** dedup 事件，该次 `cosine=0.8007` 低于 `cosine_threshold 0.85`（`dedup.mjs:130`）故判给 trigram。**关键在于 cosine 被算出来了、不是 null** ⇒ 该消费点在 Finding 12 修复后确实拿得到可用向量 |
| `retrieval.mjs` | Finding 12 修复后 43 次 `prompt_submit`：**A 22 / B-fail 14 / B-circuit 7**；`cosine_contribution>0` **22 次** | `pool=0` 的行数 **31 → 0**（修复前 2567 行中 31 次，修复后 43 行中 0 次）⇒ 配置分歧确已消除。**但 21/43 仍没走成语义通道**，原因不是签名过滤而是 embed 超时与熔断 —— 见 **Finding 15**。**这一行的 43/22/14/7 是本节（2026-08-01 深夜）的快照，已被 Finding 15 一节 2026-08-04 21:32 的更晚快照取代（193/130/54/8+1）**——两次测量的时点不同，总量与占比对不上是预期之中，不要拿两处数字互相核对当同一次数据用 |
| `feedback.mjs` | **仍 0 次** | `memory_feedback` 中 `evidence LIKE 'l1_positive_cosine%'` 计数为 0。**先解释来源**：全表 evidence 分布为 空 2070 / `neg_keyword` 79 / `assistant_self_correction` 28 / `assistant_reference` 2 —— **feedback 写入本身是活跃的**，缺的只是这一种。该路径要求"注入 → 用户回肯定语"且当时 embedding 真的可用。**这个 0 只能部分解释**：现有数据分辨不了"触发条件从未出现"与"条件出现了但路径没跑"，因为没有任何独立计数在记录"注入后收到肯定语"这件事。**因此不下结论** —— 这条写 trust 的路径在生产中**是否**跑过，目前不可判定；要判定需先加一个该条件的观测点 |

---

#### V5. 两条命令的 enabled 口径（2026-08-02）

**方法**：同 V4 —— live 库的 `VACUUM INTO` 副本，真实 CLI 进程，**live 库零写入**
（取副本前后 mtime/size 一致，其余访问一律 `mode=ro`）。不设 `CCMEM_CONFIG_PATH`，
让 `loadConfig()` 走 Finding 12 的回落，即真实 hook 进程的条件。
副本 population：4447 条 `openai:text-embedding-3-small:1536` + 1 条无向量。

**四个组合，先写预测后观测，四项全中**：

| 组合 | 文件配置 | `semantic status` `pending` | `diagnose --retrieval` `stale` | 一致？ |
|---|---|---|---|---|
| A | `enabled:true` + openai | 1 | 0 | ✅ |
| B | `enabled:true` + transformers-local | **4448** | **4447** | ✅ |
| **C** | `enabled:false` + transformers-local | **4448** | **0** | ❌ **分歧** |
| D | `enabled:false` + openai | 1 | 0 | — |

A/B 的差 1 是**合法差值**：`pendingEmbeddings` 的 population 含 `embedding IS NULL` 的行，
diagnose 的 stale 只数 `embedding IS NOT NULL`。**先算清这个差值，否则会把它误读成分歧。**

**B→C 只翻转 `enabled` 一个变量**：`pending` 纹丝不动，`stale` 从 4447 塌到 0。
B 就是那个必需的正面对照 —— 它证明同一条 SQL 在这个副本上**能**产出非零，
所以 C 的 0 不是探针坏了（同 V4 的"反面需要正面对照"）。

**机制不是"关闭了所以不数"**：`diagnose.mjs:58` 用原始 cfg ⇒ `getProvider()` 返回 `null`
⇒ `currentEmbeddingSig` 按契约返回 `null` ⇒ SQL 里 `embedding_sig <> NULL` **求值为 NULL**
（单独验证：`('x' <> NULL) IS NULL` 为真）⇒ 谓词永不成立 ⇒ 计数静默塌成 0。
**代码突变**：把 `semantic.mjs` 的强制 `enabled:true` 签名配置移植进 `diagnose.mjs`，
C 立刻变 4447；还原后回 0，`git diff` 空。

**三条顺带发现，均未修（属 deferred 桶）**：

1. **那个 0 后面还跟着 `(signature mismatch — will be re-embedded by vec_backfill)`。**
   **Finding 3 的"分母为 0"换了个来源** —— 这次不是库空，是签名为 null，而文案把它讲成健康。
2. **`semantic status` 的 disabled 分支 `model`/`dim` 写死回落 transformers-local。**
   组合 D 实测输出 `provider=openai model=Xenova/all-MiniLM-L6-v2 dim=384`，
   而**同一行的 `pending=1` 是用 openai 1536 签名算出来的** —— 一行之内自相矛盾。
3. **两处 enabled 解析是两份独立实现，且默认方向相反**：`semantic.mjs:23` 是 `Boolean(...)`（缺省 false），
   `diagnose.mjs:26` 是 `!== false`（缺省 true）。
   **但可达性受限**：`DEFAULT_CONFIG.embedding.enabled = false` 经深合并后该字段恒为布尔，
   正常配置构造不出分歧。记为**潜伏**，不夸大成在跑的缺陷。

**做 V5 时撞见 Finding 14** —— `config_kv` 里那个不该存在的 `circuit_open_until` 行。

#### V8. hook 延迟预算（2026-08-02，由用户报告触发）

**用户报告**：多次看到 `UserPromptSubmit hook timed out after 2s — output discarded`。
**结论：是 ccmem 的 hook**（`hooks/hooks.json` 的 `UserPromptSubmit` `"timeout": 2`），且已修复。

| 窗口 | n | p50 | p95 | max |
|---|---|---|---|---|
| embedding 接通前 | 2506 | 64.5ms | 90.4ms | 318ms |
| **接通后** | 62 | **397ms** | **1787ms** | **1901ms** |

**这份数据里"超 2000ms 的样本 = 0"必须先解释再看** —— metrics 行是 hook 自己写的，
**被杀在 2s 的那次根本来不及写**。0 是幸存者偏差，超时的样本恰恰是缺失的那些行。
这正是 §六「0 计数先解释来源」的又一次应验：报告与数据看似矛盾，其实是数据有幸存者选择。

**两个成因**：

1. `hooks.json` 给 harness 的超时（2s）**等于** `withHookSafety` 的内部预算（2000ms）。
   内部预算的意义是"慢了就降级成空上下文，并且仍然写 stdout 与 metrics" ——
   而进程在预算到点的同一刻被杀，这条降级路径**永远跑不完**。
   已改为 harness 5s，并把预算导出成常量，让测试能断言这个先后关系而不是靠两处数字各自漂移。
   余量还必须覆盖 **node 启动与模块加载** —— 它们发生在内部计时器启动之前，`ms_total` 不含它们。
2. OpenAI 客户端构造时**没设 `maxRetries`**，SDK 默认重试 2 次，于是 `openai_timeout_ms` 变成它自己的倍数：
   配置 800ms，**实测 embed 1683ms**（一次尝试 + 一次重试）。已改为 `maxRetries: 0` ——
   重试没有丢失，只是回到它该在的地方：回填失败会重新排队，provider 整体挂掉由熔断器接管。

两条判据都做了突变验证（改回 `timeout: 2` 或 `maxRetries: 2` 各自变红）。套件 472 pass / 0 fail。

**追查 `stop` hook 那条线索，查出了比它本身更重要的东西 —— 见 Finding 13。**

#### V1. 质量门两条新规则（2026-08-02 快照）

`audit_log.quality_gate_reject`，按 daemon 重启时刻（08-01 09:41）切分：

| 窗口 | reason 分布 |
|---|---|
| 重启之后 | `path_list` 13 / **`negative_assertion` 3** / `env_failure` **0** |
| 全期对照 | `path_list` 159 / `too_specific` 3 / `negative_assertion` 3 / `too_short` 2 / `test_count` 2 |

**3 条 `negative_assertion` 全部落在重启之后** ⇒ Finding 1 的 0 计数确已解除，
新规则在**真实入库流**上执行过，不再只有单测背书。

**`env_failure` 仍为 0，不得据此下结论** —— V1 清单已写明规则遮蔽：
`env_failure`(`:88`) 与 `negative_assertion`(`:95`) 是 9 条规则中的第 8、9 条，命中即返回，
既像 `path_list` 又像它的内容会被记成前者（`path_list` 占 159/169）。
要区分必须离线把候选内容逐规则喂给 `checkQuality`，不能看线上计数。

**成功判据（≥20 条人工判读、误杀率有一个数）未达成**：可判读样本只有 3 条。**V1 仍在采集。**

#### V2. 探针积累与判据可行性（2026-08-02 快照）

| 队列 | 基线 n（08-01 09:35） | 现 n | 基线 `l25_cov` p50 | 现 p50 |
|---|---|---|---|---|
| random non-CJK（噪声底） | 21 | **399** | 0.075 | **0.029** |
| random CJK | 3 | 45 | 0.053 | 0 |
| turn-aligned non-CJK（信号） | 266 | 642 | 0.103 | 0.081 |
| turn-aligned CJK | 99 | 544 | 0.042 | 0.032 |
| stale_injection | 0 | 36 | — | non-CJK 0.046 / CJK 0 |

- **成功判据 `n ≥ 60`（random non-CJK）达成**：399。
- **p50 漂移轨迹**：`n≈9 → 0.125`；`n=21 → 0.075`；**`n=399 → 0.029`**。
  跨度 **0.096**，远超 V2 设的 ±0.03 门限 ⇒ **"分位数对比不能作判据"这个结论成立**（Finding 2）。
- **不要反向误读**：现在信号 0.081 高于噪声 0.029，看起来"终于有信号了"。
  **这正是 Finding 2 警告过的那种读法。** 噪声底随 n 单调下降本身就说明小 n 的 p50 不稳；
  且**总体是否随时间改变并未被排除**（采样窗口内库规模与会话构成一直在变）。
  判据仍必须是分布级的（AUC / Mann-Whitney U）。
- `l25_legacy_hit` **0/1666**、`l25_id_literal` **0/1666** ⇒ 仍无任何正例标签，已知限制不变。
- 新事实：`stale_injection` 队列从 0 增至 36 行（基线时该队列为空）。
- **字段名陷阱记一笔**：本次统计一度用 `is_cjk` 取值，全表恒 falsy，
  得出"random 组 444 条全是 non-CJK"的假结果。真字段名是 **`has_cjk`**。
  这是 §六「0 计数先解释来源」第六种变体（查错字段名）的**又一次实例**，与 `metrics.jsonl` 的 `hook`/`event` 同型。

#### V6. 决策流磁盘成本（2026-08-02）

| 时点 | `l25-probe.jsonl` |
|---|---|
| 基线 08-01 09:35 | 228,090 bytes / 389 行 |
| 现 08-02 ~13:00 | **2,623,712 bytes / 1666 行** |

- 平均行体积 **1146 字节**，与设计估算 **~1.3 KB/行 吻合**。
- 增速约 **2.4 MB / 27.5h ≈ 2.1 MB/天**，是设计估算 ~200 KB/天 的 **10 倍**。
  **先解释再当结论**：估算前提是"每 turn-aligned 轮次 ≤11 行"，
  而本窗口是**重度 dogfood 期**（多会话并行、轮次密集）。
  **这个倍数反映的是使用强度，不能直接当稳态速率**。
- 方向仍然明确：`retention_days: 0` 意味着永不自动删除，**成本随使用单调累积**。
  让它在 `diagnose --feedback` 头部可见是裁决 #4，**不要"优化"掉**。
- **未验证**：`metrics.decision_data.enabled=false` 时探针行回落 `metrics.jsonl`（裁决 #3）——
  需构造该配置，本轮未做。

#### V7. 迁移 016（补第三项）

前两项原已勾（迁移干净应用、部分索引被查询计划选中）。第三项现有证据：
副本上 `embedding_sig IS NULL` 仅剩 **468 行**，其中 **467 行在回填 population 之外**
（`superseded` / `candidate_expire` / `archived` / `quarantine`），
真正待回填的是 **1 行**。⇒ 迁移后的 NULL 签名行确实由 V3 的回填路径恢复完毕。

---

## Closure checklist

- [x] 实现状态表区分「ship」与「可 dogfood」——纯测试项不列入验证清单
- [x] 每条 finding 标注验证状态，已解除项注明解除时间与证据
- [x] 每个 V 项在 §五 有对应实测记录或 🔶 blocked 说明 —— **V1–V8 全部有条目**（2026-08-02 补齐 V1/V2/V6/V7）
- [x] real-infra 受阻项显式标记，不以"测试通过"顶替 —— 未达成的判据均写明**还差什么**：
      V1 差 ≥20 条人工判读、V2 差 ~50 条人工标注（无正例标签）、V6 差裁决 #3 的配置构造、
      V8 差熔断退化延迟的重新采集（旧样本因 Finding 14 作废）
- [x] Admin 命令面与 `scripts/cli.mjs` + `commands/admin.md` 一致 —— 核对发现 `cron run` 少列
      `cross_project_patterns`（`MANUAL_RUN_TYPES` 8 个 vs 文档 7 个），**已补**；
      daemon 6 verb、semantic 3 verb × 3 provider、diagnose 11 flag、`retrieval-check`、`alias` 均一致

## Closure review

| bucket | items |
|---|---|
| implemented | schema 16（`016_*.sql`）、L2.5 观察型探针 + 决策流、`diagnose --feedback` 四队列分段、`quality_gate_reject` 按 reason 拆分、质量门两条新规则、embedding 签名版本化 + 三处过滤 + 回填重排队 |
| deferred | Finding 5（`loadConfig` 的 `JSON.parse` 保护）、`semantic.mjs`/`diagnose.mjs` 的 enabled 口径分歧（**V5 已取证，见 §五 V5**）、`diagnose` 把签名为 null 的 0 讲成"待 vec_backfill 重嵌"的文案、`semantic status` disabled 分支 `model`/`dim` 与同行 `pending` 不同源、`readDecisionProbeRows` 流式读取、`semantic.mjs:88-96` 重叠的模型变更检测器（**已在 Finding 9 移除，本项作废**） |
| needs real infra dogfood | A2 两条新规则的真实误杀率、B1 全链路（需 G1）、随机对照样本量 n≥60、v0.14 所需的 ~50 条人工标注 |

---

## 六、纪律

- **"跑了测试"不算 dogfood 证据。** 只接受生产路径上的真实计数与真实内容。
- **0 计数必须先解释来源再当结论。** Finding 1 就是反例：看到 `negative_assertion: 0`
  的第一反应本该是"规则坏了"，实际是 daemon 比代码早 13.4 小时。
- **数据翻转要如实记录，不要追认旧结论。** Finding 2 即按此处理。
- 与 v0.13 的八条人类裁决冲突时，裁决优先（见
  `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md`）。最易误踩两条：
  探针读 `recent_injections` 不读 `memory_feedback`；
  `control` 是权威队列字段（`random` 才是噪声底，`stale_injection` 不是，`turn_aligned` 仅作旧数据兼容）。

---

# v0.13 闭合后：Finding 15 的后续（2026-08-10 起，**活动中，非 v0.13 交付**）

> 🔴 **写给任何以本文档为资料来源的下游消费者（包括写 paper 的 agent）：**
> **本节描述的是一件正在进行、结论尚未产生的事。到本节写作时为止，没有任何效果结论可以引用。**
> 上文 §一–§六 与 `Closure checklist` / `Closure review` 是 **v0.13 的冻结记录，不受本节影响**；
> 本节独立成章，**就是为了不污染那份闭合记录**。

## 1. 改了什么（已落地）

`openai_timeout_ms` **800 → 1200**，已合进 `main`（合并提交标题
`merge: raise openai_timeout_ms 800 -> 1200 (hemostasis + uncensored sampling)`）。
两处默认值真相源都已同步：`scripts/lib/config.mjs`（运行时读）与 `config.default.json`（发布模板，运行时不读）。

**动机不是 Finding 15 原文里的推断，而是 hook 的直接测量**：`metrics.jsonl` 每条 `prompt_submit`
自带 `retrieval_path`（`A` / `B-fail` / `B-circuit` / `B-off`），`B-fail` 严格等价于 embed 超时。
基线（W2 冻结快照，08-05 22:21 → 08-09 16:2x）**截尾率 66/136 = 48.5%**。

## 2. 🔴 结论状态：**没有结论。不许引用任何效果数字。**

- 判据在**改动之前**冻结提交：`docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md`（**不得修改**）。
- 口径补遗（钉死 Wilson 的 `z` 等）：同目录 `…-prereg-addendum.md`。
- **样本量门槛：n ≥ 150 次真实 embed 尝试。n < 150 时只许报"数据不足"。**
- **测量窗口起点 `2026-08-10 01:53:30`（当时 `metrics.jsonl` 6496 行）。**
  窗口开启约 6 小时只攒到 11 条 `prompt_submit`；按基线速率（~36 次真实尝试/天）
  **最早 2026-08-14/15 才够读数。**

⚠️ **因此：任何声称"抬超时把截尾率降到了 X%"的说法，在本节被更新之前都是无据的。**
唯一已确认的是**改动生效**（见下），**不是改动有效**。这两件事必须分开写。

## 3. 已确认的（活体验证，2026-08-10）

新值确实到达 hook 路径，两条**改动前就写死**的判据都满足：

- 出现 `retrieval_path === "A"` 且 `retrieval_embed_ms = 839`（旧窗口 `A` 路径实测 max 为 812，旧值下不可能越过）；
- 三条 `B-fail` 的截尾点落在 **1203 / 1205 / 1203**，而非 ~800。

**存在性证据**：那条 839 在旧值下必然是 `B-fail` ⇒ **抬超时确实能捞回样本**。
⚠️ **单个样本，不可读量级**，更不可外推成比例。

## 4. 中止判据的现状（**paper 若要描述本轮方法，必须连这条一起写**）

预登记有三条中止判据。**实际生效的只有两条：**

| # | 判据 | 状态 |
|---|---|---|
| 1 | 任何 `prompt_submit` 且 `error !== null` | 生效；**至今未命中**（全历史 3106 条该字段全为 `null`） |
| 2 | `ms_total` p99 > 3000ms | 生效；未命中（窗口内 max 1435ms。p99 需 n≥150，现只作离群监视） |
| 3 | hook 因失败返回空 `additionalContext` | 🔴 **不可操作化，未执行（2026-08-10 裁决）** |

判据 3 失效的原因是**字段名实不符**：`metrics.jsonl` 里唯一名字对得上的 `additional_context_empty`
在 `scripts/handlers/prompt-submit.mjs` 中被赋为 `useFileBased` —— **它记录的是走没走文件通道，不是上下文是否为空**，
因此**全历史 3012/3012 恒为 `true`**。三个候选替代字段在健康基线上的开火率分别是 **100% / 16.3% / 6.9%**，
**没有一个能区分故障与常态** ⇒ 裁决为**不换判据**，记为"未执行"。
**读数报告与任何基于它的写作都必须显式写出"判据 3 从未执行"，不得默认它通过了。**

## 5. 巡检节奏（到读数为止）

**每天至少看一次判据 1 与判据 2**（**不是原计划写的"1 和 3"** —— 判据 3 已按上表作废）。
判据 2 在 n<150 时只做离群监视，不算 p99。

## 6. 权威来源（本节只是给下游的摘要，**不是真相源**）

| 内容 | 文件 |
|---|---|
| 活状态、完整证据链 | `docs/handoff/handoff.md` Ⅺ.11–Ⅺ.14 |
| 冻结判据（**不得修改**） | `docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md` |
| 口径补遗与判据 3 裁决 | `docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg-addendum.md` |
| 实施计划（Task 4 已完成、Task 5 待做） | `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md` |
| 执行账本（**以主仓库那份为准**） | `.superpowers/sdd/2026-08-10-raise-openai-timeout/progress.md` |

⚠️ **若本节与上述任何一份冲突，以上述文件为准，并回来修本节。**
