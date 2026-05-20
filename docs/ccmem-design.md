# Claude Code 记忆插件设计方案

> 基于 Chroma 向量数据库，为 Claude Code 实现持久化记忆系统。
> 利用 Hook 生命周期实现记忆的加载与沉淀，用 Cron 实现周期性整合。

---

## 一、设计目标

在不修改 LLM 权重的前提下，通过应用层机制为 Claude Code 提供：
1. **跨会话记忆持久化**：会话结束后记忆不丢失
2. **智能优先级排序**：高价值记忆优先注入上下文
3. **自动衰减与整合**：旧记忆自动淘汰，周期性深度整理
4. **双层作用域**：全局通用记忆 + 项目专属记忆

---

## 二、技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 向量数据库 | chromadb-js (npm) | 与现有 hook 生态一致（Node.js/ESM），本地 persistent mode |
| Hook 语言 | Node.js ESM | 与 OpenWolf hooks、audit-hook 一致 |
| LLM 调用 | `claude -p` 子进程 | OpenWolf cron 已验证的模式（`use_claude_p: true`） |
| Cron 实现 | launchd (macOS) / crontab | 系统级调度，独立于 Claude Code 进程 |
| 记忆存储路径 | `~/.claude/memory/` (全局) + `.claude-memory/` (项目) | 双层分离 |

---

## 三、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code 会话                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  SessionStart Hook                    Stop/SessionEnd Hook  │
│  ┌─────────────────┐                 ┌──────────────────┐  │
│  │ 1. 读取 stdin    │                 │ 1. 读取会话数据   │  │
│  │ 2. 查询 Chroma   │                 │ 2. claude -p 总结│  │
│  │ 3. 优先级排序    │                 │ 3. 写入 Chroma   │  │
│  │ 4. stderr 注入   │                 │ 4. 更新元数据    │  │
│  └─────────────────┘                 └──────────────────┘  │
│           │                                    │            │
│           ▼                                    ▼            │
│  ┌──────────────────────────────────────────────────┐      │
│  │              Chroma 向量数据库                      │      │
│  │  ┌────────────────┐  ┌─────────────────────┐     │      │
│  │  │ global_memory   │  │ project_{hash}_memory│     │      │
│  │  │ (全局通用记忆)   │  │ (项目专属记忆)        │     │      │
│  │  └────────────────┘  └─────────────────────┘     │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    Cron 后台任务                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │ 每日 02:00 - 记忆整合 pass                         │      │
│  │   去重合并 / 矛盾解决 / 抽象提升 / 衰减计算         │      │
│  │ 每周日 03:00 - 深度反思                            │      │
│  │   跨项目模式识别 / 通用规则提炼 / 过期淘汰          │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、记忆数据模型

### 4.1 Chroma Collection 设计

每条记忆在 Chroma 中存储为一个 document，附带结构化 metadata：

```javascript
{
  // Chroma 原生字段
  id: "mem_20260520_143022_a7f3",         // 唯一ID
  document: "用户偏好 TypeScript，禁止在此项目使用 JavaScript", // 记忆正文（用于向量检索）
  
  // metadata 字段
  metadata: {
    // 基础信息
    type: "rule",              // rule | fact | skill | episode | consolidated
    source: "user_explicit",   // user_explicit | auto_inferred | nudge_reflection | cron_consolidated
    created_at: "2026-05-20T14:30:22Z",
    
    // 优先级相关
    priority_score: 1.85,      // 综合优先级分数（动态计算）
    base_priority: 1.0,        // 基础优先级（写入时确定）
    recall_count: 7,           // 被召回次数
    last_recalled_at: "2026-05-20T10:00:00Z",
    last_touched_at: "2026-05-20T14:30:22Z", // 最后被触碰时间（召回或更新）
    
    // 衰减相关
    decay_rate: 0.02,          // 每日衰减系数
    decay_status: "active",    // active | candidate_expire | archived
    
    // 作用域
    scope: "project",          // global | project
    project_hash: "a1b2c3d4",  // 项目路径的 hash（scope=project 时有值）
    
    // 来源追溯
    session_id: "session-2026-05-20-1430",
    confidence: 0.9            // 置信度 0-1
  }
}
```

### 4.2 记忆类型定义

| type | 说明 | 默认 base_priority | 默认 decay_rate |
|------|------|-------------------|-----------------|
| `rule` | 用户偏好/项目规则 | 1.2 | 0.02/天 |
| `fact` | 事实性信息（技术栈、配置） | 1.0 | 0.03/天 |
| `skill` | 操作技能/方法论 | 1.3 | 0.01/天 |
| `episode` | 具体情景记录 | 0.7 | 0.1/天 |
| `consolidated` | 周期整合产出的高阶规则 | 1.5 | 0.01/天 |

### 4.3 来源置信度映射

| source | 默认 confidence | 说明 |
|--------|-----------------|------|
| `user_explicit` | 0.95 | 用户明确陈述的偏好/规则 |
| `auto_inferred` | 0.6 | 从对话中自动推断 |
| `nudge_reflection` | 0.75 | Stop hook 反思总结产出 |
| `cron_consolidated` | 0.85 | Cron 整合任务产出 |

---

## 五、优先级排序算法

### 5.1 综合优先级计算公式

```
priority_score = base_priority × recency_weight × frequency_boost × type_multiplier × confidence
```

各因子：

```javascript
// 时间衰减权重：距离上次触碰越久，权重越低
recency_weight = 1 / (1 + decay_rate × days_since_last_touched)

// 频率提升：被召回越多，说明越重要（上限 cap 为 2.0）
frequency_boost = Math.min(1.0 + 0.1 × recall_count, 2.0)

// 类型乘数
type_multiplier = {
  consolidated: 1.5,  // 周期总结产出，最高优先
  skill: 1.3,         // 技能类
  rule: 1.2,          // 规则类
  fact: 1.0,          // 事实类
  episode: 0.7        // 情景类，最低
}[type]
```

### 5.2 实际检索流程

```
1. 从 Chroma 做语义检索，取 top-30 候选（where: decay_status = "active"）
2. 对候选集计算实时 priority_score
3. 按 priority_score 降序排列
4. 取 top-k（默认 k=10）注入上下文
5. 对被选中的记忆：recall_count++, last_recalled_at = now
```

### 5.3 Touch 机制

以下行为会刷新记忆的 `last_touched_at`，从而重置衰减：
- 被检索命中并注入上下文（recall）
- 被 Cron 整合任务引用但未淘汰（survive consolidation）
- 被用户在对话中再次提及相同内容（re-confirm）

---

## 六、Hook 实现设计

### 6.1 目录结构

```
~/.claude/plugins/claude-memory/
├── package.json
├── scripts/
│   ├── memory-hook.mjs          # 统一入口（根据 hook_event_name 分发）
│   ├── handlers/
│   │   ├── session-start.mjs    # 会话开始：加载记忆
│   │   ├── stop.mjs             # 会话结束：总结记忆
│   │   └── user-prompt.mjs      # 用户提交：可选的实时记忆触发
│   ├── lib/
│   │   ├── chroma-client.mjs    # Chroma 连接与查询封装
│   │   ├── priority.mjs         # 优先级计算逻辑
│   │   ├── summarizer.mjs       # claude -p 调用封装
│   │   └── config.mjs           # 配置加载
│   └── cron/
│       ├── daily-consolidation.mjs   # 每日整合任务
│       └── weekly-reflection.mjs     # 每周深度反思
├── config.json                  # 插件配置
└── data/
    └── chroma/                  # Chroma 持久化目录
```

### 6.2 settings.json Hook 注册

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/plugins/claude-memory/scripts/memory-hook.mjs",
            "timeout": 8
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/plugins/claude-memory/scripts/memory-hook.mjs",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/plugins/claude-memory/scripts/memory-hook.mjs",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ]
  }
}
```

### 6.3 SessionStart Handler 逻辑

```javascript
// handlers/session-start.mjs 伪代码

async function handleSessionStart(hookData) {
  const projectPath = hookData.cwd || process.cwd();
  const projectHash = hashPath(projectPath);
  
  // 1. 查询全局记忆（语义检索 + 优先级排序）
  const globalMemories = await queryMemories({
    collection: "global_memory",
    query: buildContextQuery(hookData),  // 基于当前项目信息构建查询
    topK: 30,
    where: { decay_status: "active" }
  });
  
  // 2. 查询项目专属记忆
  const projectMemories = await queryMemories({
    collection: `project_${projectHash}_memory`,
    query: buildContextQuery(hookData),
    topK: 30,
    where: { decay_status: "active" }
  });
  
  // 3. 合并并按 priority_score 排序
  const allMemories = [...globalMemories, ...projectMemories];
  const ranked = computePriorityScores(allMemories);
  const topMemories = ranked.slice(0, config.maxInjectCount); // 默认 10 条
  
  // 4. 更新被召回记忆的元数据
  await batchUpdateRecallMetadata(topMemories);
  
  // 5. 格式化并通过 stderr 注入上下文
  const formatted = formatForInjection(topMemories);
  process.stderr.write(`\n📝 记忆系统已加载 ${topMemories.length} 条相关记忆:\n${formatted}\n`);
}
```

### 6.4 Stop Handler 逻辑

```javascript
// handlers/stop.mjs 伪代码

async function handleStop(hookData) {
  const sessionData = hookData; // stdin 传入的会话数据
  
  // 1. 判断是否有值得记忆的内容
  if (!hasSignificantActivity(sessionData)) {
    return; // 无实质活动，跳过
  }
  
  // 2. 用 claude -p 生成记忆摘要
  const summaryPrompt = buildSummaryPrompt(sessionData);
  const memories = await callClaudeP(summaryPrompt);
  // 返回格式: [{ content, type, scope, confidence }, ...]
  
  // 3. 写入 Chroma
  for (const mem of memories) {
    const collection = mem.scope === "global" 
      ? "global_memory" 
      : `project_${projectHash}_memory`;
    
    await upsertMemory(collection, {
      id: generateMemoryId(),
      document: mem.content,
      metadata: {
        type: mem.type,
        source: "nudge_reflection",
        created_at: new Date().toISOString(),
        base_priority: BASE_PRIORITY[mem.type],
        decay_rate: DECAY_RATE[mem.type],
        recall_count: 0,
        last_recalled_at: null,
        last_touched_at: new Date().toISOString(),
        decay_status: "active",
        scope: mem.scope,
        project_hash: mem.scope === "project" ? projectHash : null,
        session_id: sessionData.session_id || "unknown",
        confidence: mem.confidence
      }
    });
  }
}
```

### 6.5 claude -p 总结 Prompt 模板

```
你是一个记忆提取助手。分析以下 Claude Code 会话数据，提取值得跨会话记忆的信息。

会话数据：
{session_summary}

任务：
1. 识别用户偏好和规则（type: "rule"）
2. 识别事实性信息如技术栈、项目配置（type: "fact"）  
3. 识别可复用的操作技能（type: "skill"）
4. 仅在必要时记录关键情景（type: "episode"）

每条记忆要求：
- 简洁精炼，不超过 100 字
- 独立可理解，不依赖上下文
- 标注 scope："global"（适用于所有项目）或 "project"（仅适用当前项目）
- 标注 confidence：0.6-0.95

输出 JSON 数组：
[{"content": "...", "type": "...", "scope": "...", "confidence": 0.8}]

如果本次会话没有值得记忆的新信息，返回空数组 []。
```

---

## 七、Cron 任务设计

### 7.1 调度配置

macOS launchd plist 或 crontab：

```
# 每日 02:00 - 记忆整合
0 2 * * * node ~/.claude/plugins/claude-memory/scripts/cron/daily-consolidation.mjs

# 每周日 03:00 - 深度反思
0 3 * * 0 node ~/.claude/plugins/claude-memory/scripts/cron/weekly-reflection.mjs
```

### 7.2 每日整合任务逻辑

```javascript
// cron/daily-consolidation.mjs 伪代码

async function dailyConsolidation() {
  const collections = await listAllCollections();
  
  for (const collection of collections) {
    // 1. 衰减计算：更新所有 active 记忆的 priority_score
    const allMemories = await getAllMemories(collection, { where: { decay_status: "active" } });
    
    for (const mem of allMemories) {
      const daysSinceTouch = daysBetween(mem.metadata.last_touched_at, now());
      const newScore = computePriorityScore(mem.metadata);
      
      // 检查是否应该标记为候选淘汰
      if (mem.metadata.recall_count === 0 && daysSinceTouch > 30) {
        await updateMetadata(collection, mem.id, { decay_status: "candidate_expire" });
      } else {
        await updateMetadata(collection, mem.id, { priority_score: newScore });
      }
    }
    
    // 2. 去重：语义相似度 > 0.92 的记忆合并
    const duplicates = await findDuplicates(collection, threshold: 0.92);
    for (const [keep, remove] of duplicates) {
      // 保留 priority 更高的，合并 recall_count
      await mergeMemories(collection, keep, remove);
    }
    
    // 3. 淘汰：candidate_expire 超过 14 天的删除
    const expired = await getMemories(collection, {
      where: { 
        decay_status: "candidate_expire",
        last_touched_at: { $lt: daysAgo(14) }
      }
    });
    await deleteMemories(collection, expired.map(m => m.id));
  }
  
  logConsolidation({ processed: allMemories.length, merged: duplicates.length, deleted: expired.length });
}
```

### 7.3 每周深度反思任务逻辑

```javascript
// cron/weekly-reflection.mjs 伪代码

async function weeklyReflection() {
  const collections = await listAllCollections();
  
  for (const collection of collections) {
    // 1. 获取本周新增和高频召回的记忆
    const recentMemories = await getMemories(collection, {
      where: { created_at: { $gt: daysAgo(7) } }
    });
    const frequentMemories = await getMemories(collection, {
      where: { recall_count: { $gt: 3 } },
      orderBy: "recall_count",
      limit: 50
    });
    
    // 2. 用 claude -p 做深度分析
    const reflectionPrompt = buildReflectionPrompt(recentMemories, frequentMemories);
    const insights = await callClaudeP(reflectionPrompt);
    // 返回: { consolidated_rules: [...], contradictions: [...], patterns: [...] }
    
    // 3. 写入整合产出的高阶规则
    for (const rule of insights.consolidated_rules) {
      await upsertMemory(collection, {
        id: generateMemoryId(),
        document: rule.content,
        metadata: {
          type: "consolidated",
          source: "cron_consolidated",
          base_priority: 1.5,
          decay_rate: 0.01,
          confidence: 0.85,
          // ...其他字段
        }
      });
    }
    
    // 4. 处理矛盾：标记低置信度的为 candidate_expire
    for (const contradiction of insights.contradictions) {
      await updateMetadata(collection, contradiction.weaker_id, { decay_status: "candidate_expire" });
    }
  }
}
```

### 7.4 每周反思 Prompt 模板

```
你是一个记忆整合专家。分析以下记忆集合，执行深度整理。

本周新增记忆（{recent_count} 条）：
{recent_memories_json}

高频召回记忆（{frequent_count} 条）：
{frequent_memories_json}

任务：
1. 识别可以合并为一条通用规则的多条具体记忆（consolidated_rules）
2. 识别互相矛盾的记忆对，判断哪条应保留（contradictions）
3. 识别频繁共现的模式，总结为新规则（patterns）

输出 JSON：
{
  "consolidated_rules": [{"content": "...", "source_ids": ["id1", "id2"]}],
  "contradictions": [{"pair": ["id1", "id2"], "weaker_id": "id1", "reason": "..."}],
  "patterns": [{"content": "...", "evidence_ids": ["id1", "id2", "id3"]}]
}

如果没有值得整合的内容，对应数组返回空。
```

---

## 八、双层作用域设计

### 8.1 全局记忆 vs 项目记忆

```
~/.claude/plugins/claude-memory/data/chroma/
├── global_memory/                  # 全局通用记忆
│   └── (chroma persistent data)
├── project_a1b2c3d4_memory/        # 项目 A 专属记忆
├── project_e5f6g7h8_memory/        # 项目 B 专属记忆
└── ...
```

### 8.2 作用域判断规则

| 信息类型 | 示例 | 归属 scope |
|----------|------|-----------|
| 用户通用偏好 | "偏好 4 空格缩进" | global |
| 沟通风格 | "回答要简洁" | global |
| 项目技术栈 | "本项目使用 Next.js 14 + TypeScript" | project |
| 项目约定 | "API 路由统一放在 /app/api/" | project |
| 操作技能 | "Docker Compose 部署流程" | 视通用性判断 |

### 8.3 检索时的合并策略

```javascript
// SessionStart 时的检索逻辑

// 全局记忆：始终加载，但数量较少（top-5）
const globalTop = await queryWithPriority("global_memory", query, 5);

// 项目记忆：项目相关，数量更多（top-7）
const projectTop = await queryWithPriority(`project_${hash}_memory`, query, 7);

// 合并后再统一排序，最终注入 top-10
const merged = [...globalTop, ...projectTop]
  .sort((a, b) => b.priority_score - a.priority_score)
  .slice(0, 10);
```

---

## 九、与 OpenWolf 的协作

本插件与 OpenWolf 并行运行，职责分工：

| 职责 | OpenWolf | 记忆插件 |
|------|----------|----------|
| 文件导航优化 | ✅ anatomy.md | — |
| Token 审计 | ✅ token-ledger | — |
| Session 内行为追踪 | ✅ hooks + memory.md | — |
| 跨 session 语义记忆 | — | ✅ Chroma 向量检索 |
| 规则/偏好持久化 | ⚠️ cerebrum.md（文本） | ✅ 向量化 + 优先级排序 |
| 周期性整合 | ⚠️ cron-manifest（简单压缩） | ✅ LLM 驱动的深度整合 |
| 技能沉淀 | — | ✅ type=skill 记忆 |

**协作而非冲突**：OpenWolf 的 cerebrum.md 侧重于「当前 session 内的即时学习提醒」，记忆插件侧重于「跨 session 的长期知识积累与智能检索」。

---

## 十、配置文件设计

```json
// ~/.claude/plugins/claude-memory/config.json
{
  "version": 1,
  "chroma": {
    "persistPath": "~/.claude/plugins/claude-memory/data/chroma",
    "embeddingModel": "default"
  },
  "retrieval": {
    "maxInjectCount": 10,
    "globalTopK": 5,
    "projectTopK": 7,
    "candidatePoolSize": 30,
    "similarityThreshold": 0.3
  },
  "priority": {
    "basePriority": {
      "rule": 1.2,
      "fact": 1.0,
      "skill": 1.3,
      "episode": 0.7,
      "consolidated": 1.5
    },
    "decayRate": {
      "rule": 0.02,
      "fact": 0.03,
      "skill": 0.01,
      "episode": 0.1,
      "consolidated": 0.01
    },
    "frequencyBoostCap": 2.0,
    "frequencyBoostStep": 0.1
  },
  "consolidation": {
    "dailyCronTime": "0 2 * * *",
    "weeklyCronTime": "0 3 * * 0",
    "deduplicationThreshold": 0.92,
    "candidateExpireDays": 30,
    "finalDeleteDays": 14
  },
  "summarization": {
    "model": "claude -p",
    "maxSessionTokens": 4000,
    "maxMemoryContentLength": 100
  },
  "hooks": {
    "sessionStartTimeout": 8,
    "stopTimeout": 15,
    "stopAsync": true
  }
}
```

---

## 十一、注入格式设计

SessionStart hook 通过 stderr 注入的记忆格式：

```
📝 Memory System: 10 relevant memories loaded

[RULES]
• (0.95) 用户偏好 TypeScript，禁止在此项目使用 JavaScript
• (0.90) 回答要简洁直接，不要冗余解释

[FACTS]  
• (0.85) 本项目使用 Next.js 14 + App Router + Tailwind CSS
• (0.80) 部署目标：AWS cn-north-1，使用 CDK 管理基础设施

[SKILLS]
• (0.88) Docker 部署流程：先 build → 推送 ECR → 更新 ECS task definition

[CONSOLIDATED]
• (0.92) 此项目的测试规范：单元测试用 Vitest，E2E 用 Playwright，覆盖率 > 80%
```

括号内为 confidence 值，便于 Claude 判断可信度。

---

## 十二、安全与防护

### 12.1 记忆写入校验

- 新记忆写入前，与现有记忆做语义相似度检查（> 0.95 视为重复，跳过）
- 与现有记忆做矛盾检测（相似度 0.7-0.9 且语义方向相反 → 标记为需要人工确认）

### 12.2 置信度防护

- `source: auto_inferred` 的记忆 confidence 上限为 0.7
- 仅 `user_explicit` 来源可达 0.95
- confidence < 0.4 的记忆不会被注入上下文

### 12.3 容量保护

- 单个 collection 最大 2000 条记忆
- 超过上限时触发强制整合（淘汰最低 priority_score 的 20%）
- 注入上下文的总字符数上限：2000 字符（避免挤占有效上下文）

---

## 十三、实现路线图

### Phase 1：核心功能
- Chroma 初始化与基础 CRUD
- SessionStart hook：基础语义检索 + 注入
- Stop hook：claude -p 总结 + 写入
- 优先级排序算法
- 全局/项目双层 collection

### Phase 2：智能整合
- 每日 Cron 整合任务（衰减、去重、淘汰）
- 每周 Cron 深度反思（LLM 驱动的规则提炼）
- Touch 机制与衰减状态机

### Phase 3：增强功能
- 矛盾检测与自动解决
- 容量保护与强制整合
- 记忆导出/导入（迁移支持）
- 可视化 dashboard（记忆状态、优先级分布）
