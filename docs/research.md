
```markdown
# Agent 记忆系统：应用层解决方案研究

> 基于论文 *"Contextual Agentic Memory is a Memo, Not True Memory"*（港中大 & 浙大，2026.04）的问题分析，结合 Hermes Agent 的工程实践，探索不依赖模型权重修改的应用层解决路径。

---

## 一、问题定义

### 论文核心结论

当前 Agent 记忆系统本质上是**备忘录（Memo）**而非真正的记忆（True Memory）：
- 只做「查找」，不做「学习」
- 模型权重在会话间完全不变，Agent 永远从同一起点出发
- 类比：只有海马体（快速存取），没有新皮层（抽象整合）

### 三大结构性缺陷

| 缺陷 | 本质 | 数学/实证依据 |
|------|------|--------------|
| 信息量≠能力 | 堆积案例无法产生专家级知识重组织 | Chi et al., 1981 认知科学研究 |
| 泛化天花板 | 检索式系统需要 Ω(k²) 案例覆盖组合，参数化学习只需 O(d) | 样本复杂度理论 |
| 记忆投毒 | 持久化存储对对抗性注入固有脆弱 | MINJA 98.2% 成功率, PoisonedRAG 90% 成功率 |

### 约束条件

- **不做** pre-train / fine-tune（成本过高）
- **聚焦**在 Agent 应用层 / 用户使用侧
- **可改造**向量数据库、记忆架构、召回策略等

---

## 二、已验证的工程实践：Hermes Agent 记忆机制

Hermes Agent 是目前在应用层记忆设计上最成熟的实践之一。在提出新方案前，先明确它已经解决了什么。

### 2.1 Hermes 四层记忆架构

| 层级 | 存储介质 | 容量/策略 | 作用 |
|------|----------|-----------|------|
| **热记忆** | `MEMORY.md` + `USER.md` | 严格上限 3,575 字符 | 最高价值认知，冻结快照直接注入 prompt |
| **会话存档** | SQLite + FTS5 全文检索 | 全量存储，按需召回 | 历史细节的冷存储，<10ms 检索 |
| **技能记忆** | `~/.hermes/skills/` Markdown | 渐进式披露 + Patch 迭代 | 程序性记忆，成功方法论的结构化复用 |
| **外部记忆** | Mem0 / Tablestore 等插件 | 向量语义检索 | 海量记忆的跨会话、跨 Agent 共享 |

### 2.2 Hermes 的关键设计亮点（源码验证）

**有界热记忆 + 强制提炼**（`tools/memory_tool.py` → `MemoryStore`）
- MEMORY.md 上限 2,200 字符 + USER.md 上限 1,375 字符，硬编码
- `§` 分隔符标记条目边界，支持条目级增删改
- 会话开始时冻结快照注入 system prompt，**写入不改变当前 session 的 prompt**（保护 prefix cache）
- 写入时带有**安全扫描**：检测 prompt injection、exfiltration、隐形 unicode 字符，命中则拒绝写入

**技能自动沉淀**（`tools/skill_manager_tool.py`）
- 动作：create / edit / patch / delete / write_file / remove_file
- 目录结构：`~/.hermes/skills/<name>/SKILL.md` + references/ + templates/ + scripts/ + assets/
- Patch 式迭代：仅修改问题片段，保留有效逻辑
- 安全扫描：新建技能可选触发 `skills_guard` 扫描

**记忆插件架构**（`plugins/memory/__init__.py`）
- **8 个可插拔后端**：holographic、honcho、mem0、hindsight、retaindb、openviking、byterover、supermemory
- **同一时间只能激活一个**外部 provider（防止 tool schema 膨胀和冲突）
- 插件发现机制：扫描 bundled + user-installed 目录，bundled 优先

**MemoryProvider 生命周期**（`agent/memory_provider.py`）
- `initialize(session_id)` → 连接/创建资源
- `prefetch(query)` → 每轮前预取相关上下文
- `queue_prefetch(query)` → 后台异步为下一轮预加载
- `sync_turn(user, assistant)` → 每轮后异步写入
- `on_pre_compress(messages)` → **上下文压缩前**提取关键信息（避免丢失）
- `on_session_end(messages)` → 会话结束时的整体提取
- `on_memory_write(action, target, content)` → 镜像内置记忆写入到外部后端
- `on_delegation(task, result)` → 观察子 agent 的执行结果

**Holographic Reduced Representations（HRR）**（`plugins/memory/holographic/`）
- 用相位向量（phase vectors）实现**组合绑定**：bind（关联）、unbind（检索）、bundle（合并）
- `bind(a, b)` = 将两个概念关联为一个复合向量（与两者都不相似）
- `unbind(memory, key)` = 从复合记忆中提取关联值
- `bundle(*vectors)` = 将多个向量合并为一个（与所有输入都相似）
- 容量上限：O(√dim) 个绑定项，dim=1024 时约 32 个概念
- **这是对论文「组合泛化」问题的一个实际数学解决尝试**

**混合检索策略**（`plugins/memory/holographic/retrieval.py` → `FactRetriever`）
- **三路融合评分**：FTS5 全文搜索（权重 0.4）+ Jaccard 词重叠（0.3）+ HRR 向量相似度（0.3）
- **Trust-weighted scoring**：`final_score = relevance × trust_score`
- **可选时间衰减**：`decay = 0.5^(age_days / half_life)`，half_life 可配置
- 当 numpy 不可用时自动降级为 FTS5 + Jaccard 双路

**Trust Scoring**（`plugins/memory/holographic/store.py`）
- 每条 fact 有 `trust_score`（0.0-1.0），默认 0.5
- Helpful 反馈 +0.05，Unhelpful 反馈 -0.10（惩罚力度大于奖励）
- 带实体解析（entity extraction）：从记忆内容中提取命名实体并建立关联

**MemoryManager 统筹层**（`agent/memory_manager.py`）
- 统一管理内置记忆 + 外部 provider
- `<memory-context>` 标签包裹注入内容
- `StreamingContextScrubber`：流式输出时实时剔除记忆上下文标签，防止泄露给用户
- `sanitize_context()`：防止 provider 返回内容中嵌套注入

**用户建模（Honcho）**（`plugins/memory/honcho/__init__.py`）
- 4 个工具：`honcho_profile`（读写 peer card）、`honcho_search`（语义搜索）、`honcho_reasoning`（辩证推理 Q&A）、`honcho_conclude`（写入结论）
- 支持多 peer 建模（不只是 user，还有 ai 自身、workspace 中其他参与者）
- `reasoning_level`：minimal → low → medium → high → max（控制推理深度/成本）

**Mem0 集成**（`plugins/memory/mem0/__init__.py`）
- 服务端 LLM 做 fact extraction + semantic search + reranking + 自动去重
- Circuit breaker 模式：连续 5 次失败后暂停 120 秒，避免 hammering 挂掉的服务
- 工具：`mem0_profile`（全量 dump）、`mem0_search`（语义检索）、`mem0_conclude`（写入）

### 2.3 Hermes 对论文缺陷的覆盖情况（源码修正版）

| 论文缺陷 | Hermes 应对 | 覆盖评估 |
|----------|-------------|----------|
| 信息≠能力 | 有界热记忆强制提炼 + 技能沉淀 | ✅ 已覆盖 |
| 检索依赖相似度 | 热记忆直接注入 + 三路混合检索（FTS5+Jaccard+HRR） | ✅ 已覆盖 |
| 组合泛化不足 | HRR 相位向量的 bind/unbind/bundle 操作实现组合绑定 | ⚠️ 部分覆盖（数学机制存在，但无显式技能图谱） |
| 没有整合机制 | MemoryProvider 生命周期（prefetch/sync_turn/on_session_end/on_pre_compress） | ⚠️ 部分覆盖（有多时机提取，但无离线深度整合） |
| 记忆投毒 | `_scan_memory_content()` 威胁模式扫描 + trust scoring + 不对称惩罚 | ⚠️ 部分覆盖（有写入扫描和信任分，但无观察期/审计机制） |
| 自动过期/衰减 | holographic 插件有可选 `temporal_decay_half_life` | ⚠️ 部分覆盖（可选参数，非系统性衰减策略） |

**关键修正**：之前的分析低估了 Hermes 的覆盖度。源码显示：
- 「组合泛化」并非完全未覆盖——HRR 的 bind/unbind 机制在数学层面解决了组合编码问题
- 「记忆投毒」并非仅靠手动修正——有正则威胁扫描 + trust score 的不对称调整（+0.05/-0.10）
- 「自动衰减」在 holographic 插件中已有 half-life 衰减公式，只是默认关闭

### 2.4 OpenWolf 的工程实践（源码验证）

OpenWolf 提供了另一个维度的参考——它不是记忆系统本身，而是围绕 Claude Code Hook 生态的**记忆运维基础设施**：

**Hook 生命周期管理**（`src/hooks/`）
- `session-start.ts`：初始化 session 状态 JSON、追加 memory.md 表头、检查 cerebrum 新鲜度、提醒学习
- `stop.ts`：统计文件读写、检测多次编辑但未记 buglog 的情况、更新 token-ledger、写 session 摘要
- `pre-read.ts` / `post-read.ts`：跟踪重复读取、anatomy.md 命中率
- `pre-write.ts` / `post-write.ts`：跟踪写入、编辑计数

**Cron Engine**（`src/daemon/cron-engine.ts`）
- 基于 `node-cron` 的真正调度器，非轮询
- 支持 task 类型：`scan_project`（文件扫描）、`consolidate_memory`（记忆压缩）、`generate_token_report`（审计）、`ai_task`（调 claude -p 执行 LLM 任务）
- Retry + exponential backoff + dead letter queue + 连续失败告警
- 执行日志持久化到 `cron-state.json`

**记忆整合策略**（`cron-manifest.json`）
- 每日 02:00：压缩 7 天前的 memory.md 条目（`consolidate_memory`）
- 每周日 03:00：AI 审查 cerebrum.md——去重、清理 90 天前的 Do-Not-Repeat、合并重叠学习（`ai_task`）
- 每周一 04:00：基于 memory.md + anatomy.md 生成项目改进建议（`ai_task`）

**配置化约束**（`config.json`）
- `memory.consolidation_after_days: 7` — 多少天后触发整合
- `memory.max_entries_before_consolidation: 200` — 条目阈值触发
- `cerebrum.max_tokens: 2000` — cerebrum.md 的 token 上限
- `cerebrum.reflection_frequency: "weekly"` — 反思频率

---

## 三、增量方案：在 Hermes + OpenWolf 基础上补齐缺口

源码调研表明 Hermes 的覆盖度比预期高：HRR 解决了组合编码、trust scoring 解决了部分信任问题、temporal decay 提供了衰减基础。真正的增量空间在于：**将这些分散的能力串联成系统性的闭环**。

### 3.1 组合泛化：从 HRR 数学基础到工程可用

**现状**：Hermes holographic 插件用 HRR bind/unbind 实现了组合编码，但这是**单个 provider 内的底层能力**，没有暴露为上层的「技能组合」语义。技能文件（SKILL.md）之间仍然是独立的 Markdown，没有关系索引。

**增量方案：在 SKILL.md 层建立显式关系图谱**

- HRR 提供数学基础（向量空间中的组合），但用户可观测的层面需要**显式关系**
- 在 `~/.hermes/skills/_graph.json` 维护全局技能关系索引
- 关系来源：
  1. **自动发现**：holographic store 中频繁共现的 fact 对 → 标记为 `composable`
  2. **会话观察**：同一 session 内连续触发的技能 → 候选 `composable`
  3. **LLM 推断**：cron `ai_task` 周期性分析技能集，推断 `depends_on` / `mutually_exclusive`

```json
// ~/.hermes/skills/_graph.json
{
  "edges": [
    {"from": "nginx-config", "to": "ssl-cert", "relation": "composable", 
     "hint": "配置HTTPS时先完成证书申请再修改server block",
     "confidence": 0.8, "evidence_count": 3},
    {"from": "docker-deploy", "to": "port-management", "relation": "depends_on",
     "hint": "容器端口映射需先确认宿主机端口未占用",
     "confidence": 0.9, "evidence_count": 5}
  ]
}
```

**与 HRR 的桥接**：`_graph.json` 的 edge 生成可以利用 HRR 的 `unbind` 操作——从 bundled memory vector 中提取高相关概念对，作为关系候选。

---

### 3.2 系统性离线整合：融合 OpenWolf Cron + Hermes Provider 生命周期

**现状**：
- Hermes 的 `on_session_end` 和 `on_pre_compress` 提供了**多时机提取**能力
- OpenWolf 的 cron-engine 提供了**定时 ai_task 执行**能力
- 但两者没有打通——Hermes provider 的提取结果没有被 cron 级别的整合任务消费

**增量方案：三级整合管线**

| 级别 | 触发时机 | 操作 | 对应已有基础 |
|------|----------|------|-------------|
| L1 实时 | 每轮结束（`sync_turn`） | 异步写入 raw fact | Hermes MemoryProvider 已有 |
| L2 会话级 | 会话结束（`on_session_end`） | LLM 总结本次会话的规则/偏好变更 | Hermes 已有，但产出未结构化 |
| L3 离线深度 | cron 每日/每周 | 跨会话去重、矛盾解决、抽象提升、关系发现 | OpenWolf cron-engine 提供调度，但缺少记忆专用任务 |

**L3 整合任务的具体操作**：
1. **去重合并**：holographic store 中 HRR 相似度 > 0.92 的 fact 对 → 合并（保留 trust 更高的文本）
2. **矛盾解决**：检测内容相关但 trust 调整方向相反的 fact 对 → 保留最新/最高 trust 的
3. **抽象提升**：同类 episode 累积 ≥3 条 → 用 `ai_task` 归纳为一条 rule，trust=0.75
4. **关系发现**：同一 session 内 5 分钟内连续召回的 fact 对 → 候选写入 `_graph.json`

**与已有系统的集成**：
- 调度层：复用 OpenWolf `CronEngine` 的 `ai_task` 类型 + retry/backoff/dead-letter
- 存储层：直接操作 Hermes holographic `MemoryStore` 的 SQLite
- 产出消费：整合结果写回 holographic store（trust=0.85, category="consolidated"）

---

### 3.3 系统性衰减：将 holographic 的可选参数变为强制策略

**现状**：Hermes holographic 插件有 `temporal_decay_half_life` 参数，但默认为 0（禁用）。`trust_score` 有不对称调整（+0.05/-0.10），但没有基于时间的自然衰减。

**增量方案：多维度衰减策略**

```
综合衰减公式：
effective_trust = trust_score × recency_factor × frequency_factor

recency_factor = 0.5^(days_since_last_recall / half_life[type])
frequency_factor = min(1.0 + 0.1 × retrieval_count, 2.0) / 2.0

half_life 按类型分级：
  consolidated: 180 天（整合产出衰减极慢）
  rule/skill:    90 天
  fact:          60 天
  episode:       14 天（情景记忆衰减快）
```

**状态机**：
```
active → (retrieval_count=0 且 age > half_life×2) → candidate_expire
candidate_expire → (L3整合审查：仍有价值) → active（降低 base trust 10%）
candidate_expire → (L3整合审查：无价值) → archived
archived → (90天无召回) → deleted
```

**与 Hermes 的集成**：
- 在 holographic `MemoryStore` 的 `facts` 表增加 `decay_status TEXT DEFAULT 'active'`
- 在 `FactRetriever.search()` 中默认启用 `temporal_decay_half_life`（按 category 分级）
- L3 cron 任务执行状态转移

---

### 3.4 记忆安全：扩展已有的威胁扫描为完整防御链

**现状**：
- Hermes `memory_tool.py` 有 `_scan_memory_content()` 做正则威胁扫描（injection/exfiltration/隐形字符）
- holographic store 有 trust scoring（+0.05/-0.10 不对称）
- 但**缺少**：语义矛盾检测、观察期、周期性审计

**增量方案：在已有基础上补充三层防御**

| 层 | 已有 | 增量 |
|----|------|------|
| 写入时 | 正则威胁模式扫描 | + **语义矛盾检测**：新 fact 与 trust≥0.8 的现有 fact 做 HRR 相似度，高相似但语义相反 → 拒绝或降 trust |
| 存储时 | trust_score 字段 | + **来源分级初始 trust**：user_explicit=0.9, tool_output=0.7, inferred=0.5, external=0.3 |
| 生命期 | 无 | + **观察期**：source=inferred/external 的新 fact，前 14 天 trust 上限锁定为 0.6，期间被负面反馈直接删除 |
| 周期性 | 无 | + **审计 ai_task**：每周 cron 让 LLM 审查 trust<0.4 的 fact 集，检测矛盾簇和异常模式 |

**与 Hermes 的集成**：
- 写入层：在 `MemoryStore` 的插入方法中增加语义矛盾检测步骤
- 观察期：在 `facts` 表增加 `probation_until TIMESTAMP` 字段
- 审计：作为 OpenWolf cron-engine 的 `ai_task` 任务注册

---

## 四、完整架构视图

```
┌─────────────────────────────────────────────────────┐
│                   Agent 运行时                        │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────┐    ┌──────────────┐               │
│  │  MEMORY.md   │    │   USER.md    │  ← 直接注入   │
│  │  (有界热记忆) │    │  (用户建模)   │    不走检索   │
│  └──────┬───────┘    └──────┬───────┘               │
│         │                   │                       │
│  ┌──────▼───────────────────▼───────┐               │
│  │         技能图谱 (新增)            │               │
│  │   SKILL.md + 关系索引 + 组合提示   │  ← 渐进披露  │
│  └──────────────┬───────────────────┘               │
│                 │                                   │
│  ┌──────────────▼───────────────────┐               │
│  │    SQLite + FTS5 会话存档         │               │
│  │    + 元数据（衰减/置信度/召回数）   │  ← 按需检索  │
│  └──────────────┬───────────────────┘               │
│                 │                                   │
│  ┌──────────────▼───────────────────┐               │
│  │    外部向量数据库 (Mem0 等)        │  ← 语义召回  │
│  └──────────────────────────────────┘               │
│                                                     │
├─────────────────────────────────────────────────────┤
│              后台进程 (非实时)                         │
│                                                     │
│  ┌──────────────┐    ┌──────────────────┐           │
│  │ Nudge Engine │    │  整合 Pass (新增)  │           │
│  │ (实时轻量反思)│    │ (周期性深度重组织)  │           │
│  └──────────────┘    └──────────────────┘           │
│                                                     │
│  ┌──────────────────────────────────────┐           │
│  │        安全审计 (新增)                 │           │
│  │  一致性校验 / 置信度管理 / 过期淘汰    │           │
│  └──────────────────────────────────────┘           │
└─────────────────────────────────────────────────────┘
```

---

## 五、方案对照总结

| 论文缺陷 | Hermes 已有方案 | 增量补充方案 | 模拟的认知机制 |
|----------|----------------|-------------|---------------|
| 信息≠能力 | 有界热记忆强制提炼 | — | 新皮层抽象化 |
| 检索依赖相似度 | 热记忆直接注入 prompt | — | 内隐记忆 |
| 程序性知识 | SKILL.md 自动沉淀 | — | 程序性记忆 |
| 组合泛化不足 | ❌ | 技能图谱 + 主动组合生成 | 规则组合推理 |
| 整合不够深入 | Nudge（实时轻量） | 离线整合 pass（周期性深度） | 睡眠期巩固 |
| 无自动过期 | ❌ | 元数据衰减 + 审查淘汰 | 遗忘曲线 |
| 记忆投毒 | ❌ | 置信度 + 观察期 + 审计 | 免疫系统 |

---

## 六、局限性与诚实评估

**这些方案不能完全等价于真正的权重学习**：
- 上下文窗口仍是硬约束，无论怎么优化记忆组织
- 「有界热记忆」的 3,575 字符意味着信息必然丢失
- 所有提炼/压缩/整合的质量上限取决于 LLM 本身的能力
- 技能图谱的关系标注可能引入错误关联

**但在工程实践中**：
- Hermes 的分层设计已证明：好的工程约束可以逼出类似「学习」的行为
- 技能沉淀 + 渐进披露是极其务实的程序性记忆方案
- 有界设计比无限扩容更健康——迫使系统保持高信噪比

---

## 七、后续研究方向

### 7.1 技能图谱的关系索引格式设计

**目标**：在 Hermes 现有 SKILL.md 格式基础上，增加技能间关系的结构化表达。

**具体格式提案**：在每个 SKILL.md 末尾追加关系块：

```markdown
## Relations
- composable_with: [nginx-ssl-setup, docker-port-mapping]
- depends_on: [linux-file-permissions]
- mutually_exclusive: [systemd-service, docker-compose-service]
- composition_hints:
  - nginx-ssl-setup: "配置 HTTPS 时先完成证书申请，再修改 server block"
  - docker-port-mapping: "确认宿主机端口未占用后再配置容器映射"
```

**全局索引文件**：`~/.hermes/skills/_graph.json`，存储所有技能间的关系边，供召回时快速查询邻居节点，避免逐文件扫描。

**关系标注来源**：
- 初始标注：技能首次生成时由 LLM 根据操作步骤推断
- 动态发现：整合 pass 中检测到两个技能频繁在同一 session 内被连续触发 → 自动标记为 `composable_with` 候选
- 人工确认：候选关系通过 Nudge 提示用户确认或拒绝

---

### 7.2 离线整合 Pass 的设计

**触发策略**：
- 时间触发：每 7 天执行一次完整整合
- 阈值触发：SQLite 新增记录超过 500 条时立即触发
- 空闲触发：检测到用户超过 2 小时无交互时执行轻量整合

**Prompt 设计框架**（整合 pass 的 LLM 指令结构）：

```
你是一个记忆整理助手。以下是过去 7 天新增的 {n} 条会话记录摘要。

任务：
1. 识别语义重复的条目，合并为一条，保留最完整的表述
2. 识别互相矛盾的条目，标记矛盾对并建议保留哪条（附理由）
3. 识别可以抽象为通用规则的具体案例集合，生成规则候选
4. 识别与现有 MEMORY.md 内容重复或已过时的条目，标记为淘汰候选
5. 识别频繁共现的操作模式（在同一 session 中出现 ≥3 次），标记为技能图谱候选关系

输出格式：JSON，包含 merged[], contradictions[], rules[], deprecated[], relations[]
```

**安全约束**：整合结果需经过一致性校验后才写入，不直接覆盖现有记忆。

---

### 7.3 元数据衰减的实现路径

**SQLite Schema 扩展**：

```sql
ALTER TABLE conversation_archive ADD COLUMN recall_count INTEGER DEFAULT 0;
ALTER TABLE conversation_archive ADD COLUMN last_recalled_at TIMESTAMP;
ALTER TABLE conversation_archive ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE conversation_archive ADD COLUMN decay_status TEXT DEFAULT 'active';
-- decay_status: active | candidate_expire | archived | deleted
```

**FTS5 检索时的衰减加权**：

```sql
-- 原始 FTS5 查询
SELECT *, rank FROM conversation_archive WHERE conversation_archive MATCH ?

-- 加权后的查询（recency_weight 随时间衰减）
SELECT *,
  rank * (1.0 / (1.0 + 0.01 * julianday('now') - julianday(last_recalled_at)))
  * (0.5 + 0.5 * min(recall_count, 10) / 10.0)
  AS weighted_rank
FROM conversation_archive
WHERE conversation_archive MATCH ? AND decay_status = 'active'
ORDER BY weighted_rank DESC
```

**衰减状态机**：
```
active → (recall_count=0 且 age>30天) → candidate_expire
candidate_expire → (整合pass审查：仍有价值) → active (降低优先级)
candidate_expire → (整合pass审查：无价值) → archived
archived → (超过90天无召回) → deleted
```

---

### 7.4 记忆安全防御的集成方案

**MEMORY.md 条目格式扩展**：

```markdown
§ 项目使用 TypeScript + React [source:user_explicit] [confidence:0.95] [verified:2026-05-15]
§ 用户偏好 4 空格缩进 [source:behavior_inferred] [confidence:0.7] [verified:2026-05-10]
§ 部署目标为 AWS cn-north-1 [source:conversation] [confidence:0.6] [observed_since:2026-05-01]
```

**一致性校验的实现逻辑**：
- 写入前将新条目与所有现有条目做语义相似度计算（cosine > 0.85 视为相关）
- 对相关条目让 LLM 判断：一致/补充/矛盾
- 矛盾时：若新条目 source 优先级更高 → 替换旧条目；否则 → 拒绝写入并提示用户

**观察期机制**：
- `source:conversation` 和 `source:external` 的记忆写入后 30 天内标记为 `[probation]`
- 观察期内的记忆在召回时权重降低 50%
- 观察期结束且被成功召回 ≥2 次 → 转为正式记忆
- 观察期结束且从未被召回 → 进入候选淘汰

---

### 7.5 组合案例自动生成的评估方法

**覆盖率指标**：
- 设有 k 个独立技能，理论组合空间为 C(k,2) = k(k-1)/2
- 实际生成的有效组合数 / 理论组合空间 = 组合覆盖率
- 目标：对高频技能（recall_count 前 20%）达到 80% 覆盖率

**质量评估**：
- 自动评估：生成的组合案例是否能通过 LLM 的自我验证（给定组合场景，能否正确执行）
- 反馈评估：组合案例被实际召回后，用户是否接受其建议（接受率）
- 淘汰机制：被召回 3 次以上且接受率 < 30% 的组合案例自动删除

**生成策略**：
- 不对所有 C(k,2) 对都生成——仅对满足以下条件的对生成：
  - 两个技能在过去 30 天内各被使用 ≥3 次
  - 两个技能曾在同一 session 内（间隔 < 5 轮对话）分别被触发
  - 两个技能的操作对象有交集（如都涉及文件系统、都涉及网络配置）

---

### 7.6 Honcho 用户建模与记忆整合的协同

**核心思路**：Honcho 的行为推断结果作为记忆整合的优先级信号。

**协同机制**：

| Honcho 输出 | 对记忆系统的影响 |
|-------------|-----------------|
| 推断出用户偏好变化（如从 tabs 转向 spaces） | 触发 MEMORY.md 中相关条目的更新，旧偏好降级 |
| 假设被连续 3 次交互验证 | 该假设从 Honcho 模型提升为 MEMORY.md 正式条目 |
| 假设被否定 | 清除相关的置信度标记，防止错误记忆固化 |
| 检测到用户行为模式转变（如开始使用新技术栈） | 触发一次定向整合 pass，重新评估相关技能和记忆的时效性 |

**实现接口**：
- Honcho 每次更新用户画像时，同时输出一个 `memory_signals` 结构
- 记忆系统订阅该信号，决定是否触发写入/更新/淘汰操作
- 避免 Honcho 直接写入记忆——它只提供信号，记忆系统自行决策（解耦）