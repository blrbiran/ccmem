# ccmem vs claude-mem 对比分析

> 基于 [claude-mem v13.6.1](https://github.com/thedotmack/claude-mem) 源码与 ccmem v0.11 spec 的深度对比。
> 日期：2026-06-17

---

## 一、架构定位差异

| 维度 | ccmem | claude-mem |
|------|-------|------------|
| **哲学** | 轻量、零依赖、daemon-optional | 重型全栈、worker 常驻 |
| **运行时** | Node.js + node:sqlite | Bun + Express + Redis + PostgreSQL + ChromaDB |
| **LLM 调用** | `claude -p` 子进程 | Claude Agent SDK + OpenRouter |
| **依赖数** | ~0 runtime（opt-in embedding） | ~20+ runtime（React, BullMQ, pg, ioredis, express…） |
| **安装** | git clone + plugin register | `npx claude-mem install` |
| **代码量** | ~15K LOC（纯 .mjs） | ~50K+ LOC（TypeScript，tree-sitter 20+ 语言） |
| **记忆模型** | 4 类（rule/fact/episode/consolidated）+ trust 评分 | 6 类 observation type + session summary（无 trust） |
| **安全防御** | Tier 1/2/3 三层纵深 | 无显式安全机制 |
| **衰减管理** | half-life 衰减 + probation + auto-archive | 无衰减机制 |
| **检索** | FTS5 trigram + Jaccard + cosine 三路融合 | ChromaDB 向量 + SQLite FTS 两路 |

---

## 二、claude-mem 的架构概览

```
src/
├── adapters/          → Claude Code / Generic REST / OpenCode 适配器
├── cli/               → 命令行入口 + handler
├── core/schemas/      → Zod schema 定义
├── hooks/             → Hook 响应构造
├── sdk/               → Claude Agent SDK 集成（parser, prompts, hardened-options）
├── servers/           → MCP stdio server
├── server/            → Express HTTP server（auth, jobs, queue, routes）
├── services/
│   ├── context/       → ContextBuilder + ObservationCompiler + TokenCalculator
│   ├── sqlite/        → SQLite 存储层（observations, sessions, summaries, timeline）
│   ├── worker/        → Worker 服务（HTTP routes, agents, search, knowledge）
│   │   ├── agents/    → ResponseProcessor, ObservationBroadcaster
│   │   ├── search/    → ChromaSearchStrategy, SQLiteSearchStrategy, HybridSearchStrategy
│   │   └── knowledge/ → KnowledgeAgent, CorpusStore, CorpusBuilder
│   ├── sync/          → ChromaDB 同步
│   └── telemetry/     → PostHog 遥测
├── storage/           → PostgreSQL + SQLite 双存储
├── supervisor/        → 进程注册 + 健康检查
└── ui/viewer/         → React UI（记忆浏览器）
```

**数据模型**：

```typescript
// 观察记录（核心记忆单元）
interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title?: string;
  concept?: string;
  created_at: string;
}

// 会话摘要（每个 session 结束时生成）
interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;       // 用户请求了什么
  investigated: string | null;  // 调查了什么
  learned: string | null;       // 学到了什么
  completed: string | null;     // 完成了什么
  next_steps: string | null;    // 下一步计划
}

// 用户 prompt 记录
interface UserPromptRecord {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
}
```

---

## 三、值得借鉴的 5 个点

### 1. MCP Search Tools（中等价值，v0.12+ 考虑）

claude-mem 把记忆检索暴露为 **MCP tool**（`search` / `timeline`），Claude 可以**主动调用**搜索，而不只是被动接收 hook 注入。

```typescript
// claude-mem 的 MCP tool map
const TOOL_ENDPOINT_MAP = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};
```

**对 ccmem 的价值**：

目前 ccmem 的检索完全靠 UserPromptSubmit hook 自动触发 → 写入 context 文件 → Claude Read。如果加一个 MCP `ccmem_search` tool，Claude 可以在需要时**主动查询**历史记忆（比如"我之前怎么处理 auth 的？"），而不依赖 hook 自动匹配。这给了 agent 更多 agency。

**实现思路**：
- 用 stdio 模式（不需要常驻 HTTP），复用现有 `retrieval.mjs`
- 暴露 `ccmem_search(query, options)` 和 `ccmem_timeline(days)` 两个 tool
- 与现有 hook 注入互补，不替代

**代价**：需要 MCP server 进程 + `.mcp.json` 注册。

---

### 2. Session Summary 结构化字段（低成本，可在 summarize_pending prompt 中采纳）

claude-mem 的 `SessionSummaryRecord` 有 4 个结构化字段：

```typescript
interface SessionSummaryRecord {
  investigated: string | null;  // 调查了什么
  learned: string | null;       // 学到了什么
  completed: string | null;     // 完成了什么
  next_steps: string | null;    // 下一步
}
```

**对 ccmem 的价值**：

ccmem 的 `summarize_pending` 目前产出自由格式的 episode。如果让 LLM 输出结构化摘要（investigated/learned/completed/next_steps），检索时能更精准地匹配"上次调查过类似问题"的记忆，而不只是关键词命中。

**实现思路**：
- 修改 `summarize-pending.mjs` 的 prompt，要求输出 4 字段 JSON
- `parseLlmJson` schema 新增 4 个可选字段
- `insertMemory` 时把结构化字段存入 `content`（JSON 或拼接文本）
- 检索时可按字段类型过滤（如"只看 learned 类型的记忆"）

**代价**：改 summarize prompt + schema，零基础设施变更。

---

### 3. Knowledge Corpus + Priming（有趣但偏重，v0.13+ 候选）

claude-mem 的 `KnowledgeAgent` 可以把多个观察聚合成一个 **corpus**（知识库），然后用 Claude Agent SDK 创建一个新的 session 来"预热"（prime）这个 corpus，后续可以对这个 corpus 提问。

```typescript
class KnowledgeAgent {
  async prime(corpus: CorpusFile): Promise<string> {
    // 1. 渲染 corpus 内容为 prompt
    // 2. 调用 Claude Agent SDK 创建 session
    // 3. 保存 session_id 供后续 query 使用
  }

  async query(corpus: CorpusFile, question: string): Promise<string> {
    // 用已 prime 的 session 回答问题
  }
}
```

**对 ccmem 的价值**：

这与 ccmem 的 `weekly_synthesis`（consolidated rule）理念类似，但更进一步 — 不只是生成静态规则，而是创建一个**可交互的知识库 session**。用户可以说"问 ccmem 知识库：这个项目的 auth 是怎么设计的？"

**实现思路**：
- 复用 `weekly_synthesis` 的 consolidated rule 作为 corpus 素材
- 用 `claude -p` 替代 Agent SDK 做 prime + query
- 新增 `/ccmem:ask <question>` slash command

**代价**：需要持久化 Claude session + corpus 管理。目前 ccmem 的 consolidated rule 已经覆盖了 80% 的场景，这个可以作为 v0.13+ 探索方向。

---

### 4. Hybrid Search Strategy 模式（已在 ccmem v0.6+ 实现，验证方向正确）

claude-mem 的搜索策略模式：

```typescript
interface SearchStrategy {
  name: string;
  canHandle(options: StrategySearchOptions): boolean;
  search(options: StrategySearchOptions): Promise<StrategySearchResult>;
}

// 三种实现
class ChromaSearchStrategy implements SearchStrategy { ... }  // ChromaDB 向量搜索
class SQLiteSearchStrategy implements SearchStrategy { ... }  // SQLite FTS + 结构化查询
class HybridSearchStrategy implements SearchStrategy { ... }  // 组合两者
```

**对 ccmem 的价值**：

ccmem 的三路混合检索（FTS5 + Jaccard + cosine）已经比 claude-mem 更精细（三路 vs 两路）。这验证了我们的方向是正确的。

claude-mem 的 Strategy 模式（接口 + `canHandle` + `search`）在代码组织上更清晰，但目前 ccmem 的 `retrieval.mjs` 内聚也够用。如果未来新增检索策略（如 BM25、knowledge graph traversal），可以考虑重构为 Strategy 模式。

---

### 5. Multi-IDE 支持（值得借鉴的策略）

claude-mem 支持 Claude Code、Gemini CLI、OpenCode、Cursor 四个 IDE。安装时自动检测：

```bash
npx claude-mem install --ide gemini-cli
npx claude-mem install --ide opencode
```

其 adapter 层结构：

```
src/adapters/
├── claude-code/       → Hook 注册、settings.json 修改
├── generic-rest/      → 通用 REST API adapter
└── (cursor via integrations/CursorHooksInstaller)
```

**对 ccmem 的价值**：

ccmem 目前只服务 Claude Code。设计文档明确说"只服务 Claude Code 这一个宿主"，这是有意约束。但如果未来要扩展到 Gemini CLI 或 Codex，claude-mem 的 adapter 层结构值得参考 — 把 hook 注册、context 注入、命令定义抽象为 adapter 接口。

**代价**：较大。目前不建议投入。

---

## 四、不需要借鉴的部分

| claude-mem 特性 | 不借鉴的原因 |
|---|---|
| **Express HTTP worker** | ccmem daemon 用 launchd/systemd 更轻量，不需要 HTTP 服务 |
| **Redis (BullMQ)** | ccmem 的 task_runs lease + wake 文件已经够用 |
| **PostgreSQL** | ccmem 单用户场景，SQLite 零运维更合适 |
| **React UI Viewer** | ccmem 的 slash command 输出已经够用，加 UI 增加维护负担 |
| **PostHog telemetry** | ccmem 的 metrics.jsonl 本地遥测更符合"本地优先"原则 |
| **Tree-sitter 20+ 语言** | ccmem 不做代码解析，不需要 |
| **i18n 28 语言** | ccmem 用户群目前以中文为主 |
| **Trust/反馈系统** | claude-mem **没有** trust 评分和反馈系统 — ccmem 在这里领先 |
| **安全防御** | claude-mem **没有** Tier 1/2/3 安全链 — ccmem 在这里领先 |
| **衰减/归档** | claude-mem **没有** half-life 衰减 — ccmem 在这里领先 |

---

## 五、ccmem 的相对优势

| 能力 | ccmem | claude-mem |
|------|-------|------------|
| Trust 评分 + 4 层反馈 | ✅ L1/L2/L2.5/L4 | ❌ 无 |
| 安全防御纵深 | ✅ Tier 1/2/3 | ❌ 无 |
| half-life 衰减 + auto-archive | ✅ | ❌ 无 |
| 语义矛盾检测 | ✅ contradiction_audit | ❌ 无 |
| 跨项目知识发现 | ✅ cross_project_patterns | ❌ 无 |
| 三档可用性 | ✅ Tier 1/1.5/2 | ❌ worker 必须在线 |
| 零依赖核心 | ✅ node:sqlite | ❌ Bun + 20+ deps |
| Daemon-optional | ✅ | ❌ worker 必须运行 |
| MCP 主动查询 | ❌ | ✅ search/timeline |
| 结构化 session summary | ❌ 自由格式 | ✅ 4 字段结构化 |
| Knowledge corpus 交互 | ❌ | ✅ KnowledgeAgent |
| Multi-IDE | ❌ Claude Code only | ✅ 4 IDEs |
| UI 浏览器 | ❌ | ✅ React viewer |

---

## 六、建议优先级

| 优先级 | 改进项 | 版本 | 成本 | 价值 |
|--------|--------|------|------|------|
| P2 | 结构化 session summary（investigated/learned/completed/next_steps） | v0.12 | 低（改 prompt） | 提升检索精度 |
| P3 | MCP search tool（Claude 主动查询记忆） | v0.12+ | 中（MCP server） | 增加 agent agency |
| P3 | Knowledge corpus 探索（可交互知识库） | v0.13+ | 高（session 管理） | 新的交互模式 |
| 不做 | Multi-IDE 支持 | — | 高 | 保持 Claude Code 专注 |
| 不做 | React UI viewer | — | 中 | slash command 已够用 |

---

## 七、总结

**ccmem 在核心能力（trust 反馈、安全防御、衰减管理、三路检索）上已经领先 claude-mem。** claude-mem 的优势在**生态广度**（多 IDE、MCP tools、UI viewer）和**LLM 原生集成**（Agent SDK、Knowledge Corpus）。

两个项目的设计哲学根本不同：
- **ccmem**：轻量、本地优先、零依赖、防御纵深 — 适合注重隐私和可控性的用户
- **claude-mem**：全栈、重型、丰富生态 — 适合需要跨 IDE 一致体验的用户

借鉴应聚焦在**低成本高回报**的改进上（结构化 summary、MCP tool），而非追逐功能数量。
