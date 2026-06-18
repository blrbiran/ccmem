# ccmem vs claude-mem：基于 spec 与源码的借鉴评估

> 评估输入：
> - ccmem：`docs/design-motivation.md`、`docs/ccmem-design.md`、`docs/ccmem-v0.11-spec.md`、`docs/ccmem-v0.11-dogfood.md`、当前实现
> - 参考项目：`reference/claude-mem` 的 README、架构文档与关键源码
>
> 目标不是比较“谁功能更多”，而是回答一个更实际的问题：**在 ccmem 当前边界下，claude-mem 哪些东西值得借鉴，哪些不值得，为什么。**

---

## 一、先给结论

**值得借鉴的，不是 claude-mem 的重型运行时，而是它在“记忆系统可靠性”上的几处工程纪律。**

如果按对 ccmem 当前阶段的价值排序：

1. **现在就值得借鉴**
   - hook I/O discipline（stdout / stderr / exit code 的明确分层）
   - transcript parser hardening（对 JSONL 损坏、异构 transcript 形状的容错）
2. **值得借鉴，但应该放到 v0.12+ 这类下一阶段**
   - MCP 渐进式检索（search → timeline / detail 的 progressive disclosure）
   - 检索模块的 strategy/orchestrator 组织方式
   - 项目过滤 / exclusion 规则
3. **现在不值得借鉴**
   - Server Beta 那套 Postgres + BullMQ + Valkey + API key + split server/worker 架构
   - React viewer / 多 IDE 适配层
   - Chroma 为中心的重型向量栈
4. **可以当探索项，但不应误判为“下一个自然版本”**
   - Knowledge corpus + prime/query 会话化知识库

一句话概括：**claude-mem 对 ccmem 最有启发的，是“怎么把应用层记忆系统做得更稳”；不是“怎么把它做得更重”。**

---

## 二、评估标尺：什么才算“值得 ccmem 借鉴”

先把边界说清楚，否则对比很容易失真。

根据 `design-motivation.md`、`ccmem-design.md` 和 v0.11 spec，ccmem 当前不是一个通用 memory platform，而是一个有明确约束的 Claude Code 插件：

1. **宿主边界明确**：当前只服务 Claude Code，不追求多 IDE 一致性。
2. **hook 必须轻量**：hook 内只做本地 I/O，不做 LLM / spawn / 网络；主流程零阻塞优先。
3. **daemon-optional**：Tier 1 / Tier 1.5 即使 daemon 不在也要继续工作；不要把系统价值绑定到常驻服务在线。
4. **本地优先**：SQLite 是核心，不希望为了 richer surface 引入重型外部依赖。
5. **记忆治理是一等公民**：trust、feedback、half-life、security audit、revalidation 不是外围特性，而是 ccmem 的核心差异点。
6. **v0.11 的焦点是工程稳定性**：多窗口隔离、context 写入历史、注入可回放，而不是继续扩表面能力。

因此，一个特性即使“很强”，只要它会破坏这些边界，就不应被归类为“值得当前借鉴”。

---

## 三、claude-mem 的真实形态，不是一个单线架构

如果只看 README，很容易把 claude-mem 理解成一个“功能非常全的记忆插件”。但从源码和文档看，它更像是**两套架构并存、正在迁移中的系统**：

### 3.1 旧主线：worker runtime

从 `docs/architecture-overview.md` 可以看到，它的主线仍然是：

- hooks
- Bun CLI / hook orchestrator
- worker daemon（HTTP）
- SQLite
- Chroma
- MCP search tools

这一条线上，很多能力是**真实存在且可用的**：
- `src/shared/hook-io.ts`
- `src/shared/transcript-parser.ts`
- `src/servers/mcp-server.ts`
- `src/services/worker/search/*`
- `src/services/worker/knowledge/KnowledgeAgent.ts`

### 3.2 新方向：Server Beta

但与此同时，它又在推进一套新的 server-beta runtime：

- Postgres 做 canonical storage
- Valkey/BullMQ 做队列
- API key auth
- HTTP server 与 generation worker 分进程 / 分容器

这一点在 `docs/server.md` 与 `docs/server-storage-boundary.md` 里写得非常明确。

更关键的是，`docs/server-beta-parity-map.md` 也明确承认：**很多 legacy `/api/*` 路由在 server-beta 下仍然是 unsupported**。这意味着：

- 它不是“更成熟的新架构已经完全接管旧架构”
- 而是“功能很强，但正处于迁移与双轨并存阶段”

这对我们很重要，因为它决定了哪些点是成熟经验，哪些点只是方向性探索。

---

## 四、值得现在借鉴的部分

## 4.1 Hook I/O discipline：值得现在借鉴

**证据**：`reference/claude-mem/src/shared/hook-io.ts`

claude-mem 在这件事上做得比大多数插件都更明确：它把 hook 输出分成了几种不同 intent：

- `MODEL_CONTEXT`
- `DIAGNOSTIC`
- `USER_HINT`
- `BLOCKING_FEEDBACK`
- `EXIT_SIGNAL`

并且集中管理：
- 哪些东西走 stdout
- 哪些东西走 stderr
- 哪些情况 exit 0
- 哪些情况 exit 2
- 以及如何缓冲 / 丢弃 stderr 噪音

### 为什么这对 ccmem 有价值

这和 ccmem 的设计原则是同方向的：
- `ccmem-design.md` 已经明确要求 stdout / stderr 分流，LLM 可见内容必须极度克制
- 我们也已经把 hook 的轻量、fail-loud、LLM-safe 当成核心约束

但 ccmem 当前更像是“原则已经有了，局部实现也对”，还没有把这套 discipline 提炼成一个**统一的 hook emitter contract**。claude-mem 的启发在这里不是“改产品架构”，而是“把已有约束做成更不容易退化的代码结构”。

### 建议借鉴方式

借鉴它的**工程纪律**，不要借鉴它的**运行时模型**：

- 保持 ccmem 现有 hook 预算与轻量边界不变
- 但可以把 hook 输出语义统一到一个共享模块里
- 明确 transport error / client bug / blocking feedback 的处理分层
- 让 stdout JSON、stderr 诊断、exit code 语义不再散落在各 handler 中

### 结论

**高价值、低侵入、适合现在做。**

---

## 4.2 Transcript parser hardening：值得现在借鉴

**证据**：`reference/claude-mem/src/shared/transcript-parser.ts`

claude-mem 的 transcript parser 做了几件很实用的防御：

- 同时兼容 JSONL 与 Gemini transcript JSON 对象
- 兼容 `type` / `role` 两种 role 字段
- 兼容 `message.content` 为 string 或 array
- 遇到 malformed / truncated JSONL 行时跳过，而不是整段崩溃
- 可选地 strip system reminders
- 对 tool-only / empty-text turn 有回退行为

### 为什么这对 ccmem 有价值

这几乎是现在最值得直接借鉴的点。

ccmem 当前的 `scripts/lib/transcript.mjs` 仍然偏薄：
- `parseTranscript()` 直接逐行 `JSON.parse()`
- 没有对坏行做容错
- 对 transcript 形状的兼容也比较有限

而 `summarize_pending` 又依赖 transcript 解析去提取会话 excerpt。换句话说，**这里不是“架构品味”问题，而是实打实的稳定性问题**。

### 建议借鉴方式

不是搬 claude-mem 的整个 parser，而是吸收它的几条硬规则：

1. **坏行跳过，不要整段失败**
2. **兼容 string / array 两种 content 形状**
3. **兼容 `type` / `role` 字段**
4. **明确处理 tool-only turn**
5. **system reminder stripping 做成可选开关**

### 结论

**这是当前最直接、最对题的借鉴项。**

---

## 五、值得借鉴，但应放到下一阶段的部分

## 5.1 MCP 渐进式检索：值得借鉴，但不该抢在当前稳定性工作前面

**证据**：
- `reference/claude-mem/README.md` 的 MCP Search Tools 部分
- `reference/claude-mem/src/servers/mcp-server.ts`

这里真正有价值的，不是“它有 MCP server”，而是它把记忆读取设计成了一个**渐进式信息披露**流程：

1. `search`：先拿 compact index
2. `timeline`：看上下文关系
3. `get_observations`：最后才拉 full detail

它的核心收益不是召回率，而是**token discipline**：先缩小候选，再展开细节。

### 为什么对 ccmem 有价值

这和 ccmem 的方向并不冲突，反而很契合：
- ccmem 已经有 `scripts/lib/retrieval.mjs` 的三路检索
- 也有 `show` / `diagnose --context-history` 这类 detail surface
- 缺的是一个让 Claude **主动查询历史**、而不是只靠 hook 被动注入的接口

### 但为什么不应当现在就上

原因不是“没价值”，而是**当前版本焦点不对**：
- v0.11 刚做完多窗口隔离与 context history
- 现在最紧要的是把 retrieval / summarize / transcript 这一圈做稳
- MCP tool 是 surface 扩张，不是稳定性 closure

### 建议借鉴方式

如果做，应该是一个很轻的版本：

- 只做 read-only MCP
- 只暴露 search / maybe timeline / get_by_ids
- 后端直接复用 SQLite 检索，不引入 HTTP server
- 作为 hook 注入的补充，不替代 hook 注入

### 结论

**值得做成 v0.12+ 的明确候选，但不是“现在就照搬”。**

---

## 5.2 Search strategy / orchestrator 组织方式：值得借鉴，但主要是代码组织价值

**证据**：`reference/claude-mem/src/services/worker/search/*`

claude-mem 把检索拆成：
- orchestrator
- filter
- formatter
- strategy（SQLite / Chroma / Hybrid）

### 对 ccmem 的价值

这不是算法层面的领先，而是**模块组织上的启发**。

因为就检索能力本身看，ccmem 现在并不落后：
- lexical + Jaccard + optional semantic 的三路融合已经存在
- 并且我们还有 fallback 与 daemon-optional 的约束

真正值得借鉴的是：如果后面要继续加 MCP 读取、不同 retrieval mode、不同 detail 视图，`scripts/lib/retrieval.mjs` 可能会开始承担过多职责。到那时，引入更清晰的 strategy / orchestrator 分层是合理的。

### 结论

**是“未来代码组织优化”的候选，不是当前产品差距。**

---

## 5.3 Project exclusion / filtering：值得借鉴，但偏 hygiene

**证据**：`reference/claude-mem/src/utils/project-filter.ts`

claude-mem 在项目过滤上做得比较朴素但实用：
- glob pattern
- basename 与 full path 双匹配
- 支持 `~`
- pattern 失效时只 warn，不致命

### 对 ccmem 的价值

这个点不 flashy，但很适合 ccmem：
- 用在 importer（例如 OpenWolf import、外部导入）上很自然
- 用在未来 multi-project admin surface 也合理
- 和本地优先 / 安全边界是一致的

### 结论

**低成本 hygiene，可以放在后续小版本顺手补。**

---

## 六、可以探索，但不要误判成熟度的部分

## 6.1 Knowledge corpus + prime/query：真实存在，但成本比表面更高

**证据**：`reference/claude-mem/src/services/worker/knowledge/KnowledgeAgent.ts`

这不是 README 里的空想，它确实在代码里存在：
- 先 render corpus
- 再用 Claude Agent SDK prime 一个 session
- 后续 query 复用该 session
- session 失效时自动 reprime

### 为什么它有吸引力

它提供的不是普通检索，而是“带上下文状态的知识会话”。这比单纯把 consolidated rule 存下来再 search，一步更深。

### 为什么对 ccmem 不是自然下一步

因为它引入的复杂度也是真实的：
- 需要持久化 session 生命周期
- 需要处理 resume / expire / reprime
- 需要为 corpus 定义更新策略
- 需要处理成本与可观测性

更关键的是，ccmem 当前的核心价值仍然是：
- trust / feedback / security / lifecycle
- daemon-optional
- 本地 SQLite + hook 注入稳定性

Knowledge corpus 会把系统重心往“长生命周期 agent session 管理”方向拉，这不是我们现在最缺的东西。

### 结论

**真实可行，但应视为远期实验项，而不是 v0.12 的默认目标。**

---

## 七、当前不值得借鉴的部分

## 7.1 Server Beta 整体架构：不值得当前借鉴

**证据**：
- `reference/claude-mem/docs/server.md`
- `reference/claude-mem/docs/server-storage-boundary.md`
- `reference/claude-mem/docs/server-beta-parity-map.md`

这套架构的关键词是：
- Postgres canonical storage
- BullMQ / Valkey queue
- API key auth
- HTTP server / generation worker split
- Docker / deployable mode

### 为什么不适合 ccmem

因为它与 ccmem 的核心边界基本相反：

| 维度 | ccmem 当前方向 | claude-mem server-beta 方向 |
|---|---|---|
| 宿主 | Claude Code 单宿主 | 面向更通用 client / deployable runtime |
| 存储 | SQLite 本地优先 | Postgres canonical |
| 可用性 | daemon-optional | server / worker 在线价值更高 |
| 运维复杂度 | 零运维优先 | 容器、队列、鉴权、分进程 |
| 当前焦点 | 稳定性与记忆治理 | 平台化与部署能力 |

而且它现在还不是“完全替换旧架构”的成熟收束状态，parity map 里明确有大量 unsupported surface。

### 结论

**不只是“成本高”，而是与当前 ccmem 的产品边界不一致。**

---

## 7.2 多 IDE 适配层与 Web Viewer：当前不值得借鉴

这两件事在 claude-mem 中都是真实存在的，但对 ccmem 现在没有决定性价值。

### 多 IDE

claude-mem 确实在往 Claude Code 之外扩：Gemini CLI、Cursor 等。

但 ccmem 在设计文档里已经明确：**当前只服务 Claude Code**。在这个阶段去抽象 adapter 层，很容易提早为不存在的问题付复杂度。

### Web Viewer

viewer 对 claude-mem 合理，因为它本身已经走到了 HTTP server / richer surface。

但 ccmem 当前已经有：
- slash command
- diagnose
- stats
- context-history

对当前需求来说，viewer 并不是价值密度最高的方向。

### 结论

**这两项都属于“生态广度”，不是 ccmem 当前最缺的能力。**

---

## 7.3 直接借 context injection 机制：不建议照搬

**证据**：`reference/claude-mem/src/utils/context-injection.ts`

claude-mem 的注入方式是真实可用的：
- 往 markdown 文件里写包裹 tag
- 若已有 tag 就原位替换
- 并且会做 BMP-safe 处理，避免 surrogate pair 被截断导致 session 出问题

### 哪部分值得看

- **BMP-safe / Unicode 边界处理** 这个细节值得学习

### 哪部分不该照搬

- 它的注入模型和 ccmem 不同
- ccmem 已经在 v0.10 / v0.11 上收敛到了 session-scoped context file + write history
- 我们现在更该保护这条路径，而不是改回“在一个 markdown 里包 tag 做替换”

### 结论

**借鉴 edge case 处理，不借鉴整体机制。**

---

## 八、对旧版对比文档的几个纠偏

旧版文档里有一些结论方向大体没错，但表述过于粗，容易误导后续决策。这里明确纠偏。

## 8.1 “claude-mem 没有安全机制”——这句话太粗

更准确的说法应该是：

- claude-mem **没有 ccmem 这种以 trust / memory poisoning / security_audit / revalidation 为核心的记忆治理链路**
- 但它并不是“没有安全设计”
- 至少在 server-beta 上，它有：API key、runtime validation、auth mode 限制、生产环境约束

所以正确结论是：

> **在“记忆内容治理”这一维，ccmem 明显更强；在“服务端运行时防护”这一维，claude-mem 也不是空白。**

## 8.2 “claude-mem 的 MCP / server 能力已经是一套成熟大一统架构”——不准确

更准确的说法是：

- worker 路线上的 MCP / search / hook 能力是真实且成熟度不错的
- 但 server-beta 仍处于迁移中
- parity map 明确列出大量 unsupported 路由

所以不能把它简单理解成“它已经有了统一成熟平台，而我们没有”。

## 8.3 “Knowledge corpus 是下一个自然版本”——判断过快

它当然是真实能力，不是 PPT；但它带来的复杂度远高于看起来。

如果 ccmem 现在直接追这个方向，很可能会：
- 把注意力从 trust / retrieval / summarize 稳定性上拉走
- 提前引入 session lifecycle 管理复杂度
- 让 daemon-optional 的设计张力变大

## 8.4 “Hybrid search 证明我们方向对”——这句可以保留，但要降噪

可以说 claude-mem 的存在再次说明：
- 单一路径检索通常不够
- strategy/orchestrator 分层是常见演化方向

但不能因此推导出“我们要跟着它的 Chroma / server 方向走”。

ccmem 当前更应该坚持的是：
- lexical 优先
- semantic 可选
- fallback 明确
- 零运维默认

---

## 九、建议的行动优先级

## P1：应尽快做

### 1. transcript parser hardening

目标：降低 `summarize_pending`、Stop / transcript 相关路径的脆弱性。

建议落点：
- `scripts/lib/transcript.mjs`
- `scripts/daemon/tasks/summarize-pending.mjs`

### 2. hook I/O discipline 收口

目标：把 stdout / stderr / exit 语义从“多处约定”变成“单点约束”。

建议落点：
- hook 共享输出模块
- transport / diagnostic / blocking feedback 分类收口

## P2：下一阶段可以设计

### 3. 只读 MCP search

目标：让 Claude 在需要时主动查记忆，而不是完全依赖被动注入。

原则：
- 只读
- SQLite 直连
- 不引入 HTTP server
- progressive disclosure

### 4. project exclusion / import hygiene

目标：给 importer / admin surface 增加更明确的项目边界控制。

## P3：观察后再说

### 5. retrieval strategy 重构

只有当 `scripts/lib/retrieval.mjs` 明显变得过载时再做；不要为“好看”而重构。

### 6. knowledge corpus 探索

可以保留为研究 backlog，但不应挤占当前 closure work 的优先级。

## 不建议进入 roadmap 的项

- server-beta 式重型 runtime
- viewer
- 多 IDE 适配层
- Chroma 为中心的向量存储路线

---

## 十、最终判断

从 ccmem 当前状态看，**claude-mem 不是一个“应该整体追赶”的对象，而是一个“应该有选择地吸收其工程经验”的参考样本。**

最值得学的三件事是：

1. **hook 输出语义要收口，不能靠约定散落**
2. **transcript parser 必须按脏数据世界来设计**
3. **主动检索如果要做，应当走渐进式披露，而不是一次性把细节全塞进上下文**

最不该学的是：

1. **把系统重心迁移到重型服务端 runtime**
2. **为了生态广度提早抽象多宿主适配层**
3. **把“功能更多”误当成“更适合当前 ccmem”**

所以，针对这个 reference repo 的正确姿势不是“照着做一个轻量版 claude-mem”，而是：

> **继续坚持 ccmem 自己的边界，同时吸收 claude-mem 在可靠性与检索交互上的成熟工程手法。**
