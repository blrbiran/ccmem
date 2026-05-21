# Claude Code 行为验证清单

> 本文档记录 ccmem 设计中依赖 Claude Code 内部实现的不确定点。
> 基于 `reference/claudecode/` 源码分析已验证。

---

## U1: PreCompact Hook 压缩边界

**位置**: ccmem-design.md §6.3

**原假设**: 
```javascript
const compactBoundary = Math.floor(messages.length * 0.7);
```
假设 Claude Code 压缩时丢弃前 70% 的消息，且 PreCompact hook 收到 messages 数组。

**验证结果**: ❌ **假设错误**

PreCompact hook **不接收 messages 数组**。实际 schema (`coreSchemas.ts:569-577`):
```typescript
PreCompactHookInputSchema = {
  hook_event_name: 'PreCompact',
  trigger: 'manual' | 'auto',
  custom_instructions: string | null,
  // + BaseHookInput fields
}
```

PreCompact 设计用途是让 hook 注入 `custom_instructions` 来指导压缩，而非直接访问消息。

**影响与调整**:
- ccmem PreCompact hook 无法直接分析即将被压缩的消息
- 改为使用 `transcript_path` 读取 transcript 文件进行分析
- 或者在 Stop hook 中持续追踪重要内容，PreCompact 时从本地存储读取

---

## U2: hookData 完整契约

**位置**: ccmem-design.md §6.4, §6.5

**验证结果**: ✅ **已确认完整 schema**

### BaseHookInput (所有 hook 共有) - `coreSchemas.ts:387-411`
```typescript
{
  session_id: string,           // ✅ 始终存在
  transcript_path: string,      // ✅ 始终存在
  cwd: string,                  // ✅ 当前工作目录
  permission_mode?: string,     // 可选
  agent_id?: string,            // 仅 subagent 调用时存在
  agent_type?: string,          // agent 类型名
}
```

### SessionStart - `coreSchemas.ts:493-501`
```typescript
{
  hook_event_name: 'SessionStart',
  source: 'startup' | 'resume' | 'clear' | 'compact',
  agent_type?: string,
  model?: string,
}
```

### UserPromptSubmit - `coreSchemas.ts:484-491`
```typescript
{
  hook_event_name: 'UserPromptSubmit',
  prompt: string,               // ✅ 用户输入的 prompt
}
```

### Stop - `coreSchemas.ts:513-527`
```typescript
{
  hook_event_name: 'Stop',
  stop_hook_active: boolean,
  last_assistant_message?: string,  // ✅ 最后助手消息文本
}
```

### SessionEnd - `coreSchemas.ts:758-764`
```typescript
{
  hook_event_name: 'SessionEnd',
  reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 
          'other' | 'bypass_permissions_disabled',
}
```

### PreCompact - `coreSchemas.ts:569-577`
```typescript
{
  hook_event_name: 'PreCompact',
  trigger: 'manual' | 'auto',
  custom_instructions: string | null,
}
```

**原假设对比**:
- ❌ `tool_call_count` - 不存在
- ❌ `message_count` - 不存在  
- ❌ `duration_ms` - 不存在
- ✅ `transcript_path` - 始终存在
- ✅ `session_id` - 始终存在
- ✅ `prompt` - UserPromptSubmit 有
- ❌ `messages` - PreCompact 不包含

---

## U3: Prompt Cache 行为

**位置**: ccmem-design.md §18 Known unknowns

**验证结果**: ⚠️ **部分确认**

Claude Code 支持 prompt caching (`bootstrap/state.ts`, `utils/api.ts`):
```typescript
// state.ts:221-225
promptCache1hAllowlist: string[] | null
promptCache1hEligible: boolean | null

// api.ts:129, 228-229
cacheControl?: { type: 'ephemeral' }
```

- Claude Code 使用 1 小时缓存 allowlist 机制
- `cacheControl` 通过 API 调用传递
- 缓存读写有不同定价 (modelCost.ts)

**TTL**: 由 Anthropic API 控制，非 Claude Code 配置。当前 API 默认 5 分钟 TTL。

**对 ccmem 影响**: 
- 频繁变化的 `additionalContext` 可能导致 cache miss
- 设计已明确不依赖 cache 优化，影响有限

---

## U4: Hook Timeout 行为

**位置**: ccmem-design.md §6.5, §6.7

**验证结果**: ✅ **已确认**

**Timeout 单位**: 配置中为**秒**，内部转换为毫秒 (`hooks.ts:877-879`):
```typescript
const hookTimeoutMs = hook.timeout
  ? hook.timeout * 1000
  : TOOL_HOOK_EXECUTION_TIMEOUT_MS
```

**默认超时** (`hooks.ts:166-181`):
- 一般 hook: `TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000` (10 分钟)
- SessionEnd hook: `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500` (1.5 秒)
- 可通过环境变量覆盖: `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`

**超时处理**:
- 使用 `AbortSignal` 取消 hook
- 超时后 hook 被终止，返回 aborted 状态
- Hook 间并行执行，各有独立超时

**ccmem 配置建议**:
```json
{
  "SessionStart": { "timeout": 2 },      // 2秒足够
  "UserPromptSubmit": { "timeout": 3 },  // 需要 embedding，稍长
  "PreCompact": { "timeout": 5 },        // 可能读 transcript
  "Stop": { "timeout": 2 }               // 快速收尾
}
```

---

## U5: Session 生命周期

**位置**: ccmem-design.md §6.1, §6.4

**验证结果**: ✅ **已确认**

**SessionStart sources** (`coreSchemas.ts:497`):
- `'startup'` - 新会话启动
- `'resume'` - 恢复会话
- `'clear'` - 清空后重新开始
- `'compact'` - 压缩后继续

**SessionEnd reasons** (`coreSchemas.ts:747-754`):
- `'clear'` - 用户执行 /clear
- `'resume'` - 切换到其他会话
- `'logout'` - 用户登出
- `'prompt_input_exit'` - 用户在输入时退出
- `'other'` - 其他原因
- `'bypass_permissions_disabled'` - 权限绕过被禁用

**生命周期保证** (`gracefulShutdown.ts`, `conversation.ts`):
- Ctrl+C 触发 graceful shutdown，**会执行** SessionEnd hooks
- SessionEnd hook 异常被捕获并忽略（best-effort）
- 执行后清理 session hooks (`clearSessionHooks`)
- 崩溃时无 cleanup hook（无保证）

**ccmem 影响**:
- 反馈闭环大部分情况可靠
- 崩溃场景需要 `pending_summarize` 表处理孤儿记录

---

## U6: additionalContext 注入位置

**位置**: ccmem-design.md §6.1, §6.2

**验证结果**: ✅ **已确认**

**注入方式** (`messages.ts:4040-4054`, `types/hooks.ts:77-95`):
```typescript
// 从 hook response 提取
if (response.hookSpecificOutput?.additionalContext) {
  messages.push(
    createUserMessage({
      content: response.hookSpecificOutput.additionalContext,
      isMeta: true,  // 标记为元消息
    }),
  )
}
```

**注入位置**:
- 作为 `UserMessage` 注入
- `isMeta: true` 标记
- 被 `wrapInSystemReminder()` 包裹为 `<system-reminder>` 标签
- 对 SessionStart 和 UserPromptSubmit hook 有效

**多 hook 处理**:
- 多个 hook 的 `additionalContext` 被收集到数组
- 依次注入为独立的 system-reminder 消息

**长度限制**: 
- 代码中未见显式长度限制
- 建议保持在 2000 tokens 以内避免影响 LLM 性能

**对用户可见性**:
- 不直接显示给用户
- 但用户可通过 transcript 或调试看到

---

## U7: Hook 执行模型 (并行)

**位置**: ccmem-design.md §6 整体

**验证结果**: ✅ **已确认 - 并行执行**

**执行模型** (`hooks.ts:2142, 2743, 3083, 3380`):
```typescript
// Run all hooks in parallel with individual timeouts
const hookPromises = matchingHooks.map(async function* (...) { ... })
return await Promise.all(hookPromises)
```

**关键行为**:
- 同一 event 的多个 hooks **并行执行** (`Promise.all`)
- 每个 hook 有独立 timeout，不互相阻塞
- 一个 hook 失败不影响其他 hooks 执行

**ccmem 影响**:
- 如果 SessionStart 和 UserPromptSubmit 各注册一个 hook，它们在各自 event 触发时独立执行，无问题
- 如果同一 event 注册多个 hook 且有顺序依赖，需要合并为单个 hook 或在 hook 内部处理

---

## U8: Transcript JSONL 格式

**位置**: ccmem-design.md §6.3 (parseTranscript 调用)

**验证结果**: ⚠️ **需注意复杂格式**

**实际格式** (`sessionStorage.ts:2289-2356`):
```typescript
// JSONL 文件结构复杂，不是简单的消息数组
const {
  messages,              // Map<UUID, TranscriptMessage>
  summaries,             // Map<UUID, string>
  customTitles,          // Map<UUID, string>
  tags,                  // Map<UUID, string>
  fileHistorySnapshots,  // Map<UUID, ...>
  attributionSnapshots,  // Map<UUID, ...>
  contextCollapseCommits,
  contextCollapseSnapshot,
  leafUuids,             // Set<UUID> - 用于找最新消息
  contentReplacements,
  worktreeStates,
} = await loadTranscriptFile(filePath)

// 需要从 leafUuids 找到最新消息，然后反向构建对话链
const leafMessage = findLatestMessage(messages.values(), msg => leafUuids.has(msg.uuid))
const transcript = buildConversationChain(messages, leafMessage)
```

**ccmem 影响**:
- `parseTranscript()` 实现需要处理 JSONL 复杂结构
- 不能简单按行解析，需要使用 `buildConversationChain` 逻辑
- 建议：复用 Claude Code 的 `loadTranscriptFile` 或实现兼容解析器

---

## U9: 压缩比例 (70% 假设)

**位置**: ccmem-design.md §6.3 `boundaryIdx = transcript.length * 0.7`

**验证结果**: ⚠️ **假设可能不准确**

**实际行为** (`compact.ts`):
- Claude Code 的压缩是 **LLM 驱动**，不是固定比例
- 压缩后保留的内容取决于 LLM 摘要，而非机械截断
- `CompactBoundaryMessage` 标记压缩点，但不是按 70% 切分

**ccmem 影响**:
- 70% 是启发式估算，实际压缩边界可能不同
- 更稳妥的策略：在 Stop hook 持续追踪重要内容，而非 PreCompact 时猜测边界
- PreCompact 可作为"最后机会"补救，但不应是主要依赖

---

## U10: Session ID 格式

**位置**: ccmem-design.md 各处 session_id 使用

**验证结果**: ✅ **已确认为 UUID**

**格式** (`bootstrap/state.ts:331, 447`):
```typescript
sessionId: randomUUID() as SessionId
STATE.sessionId = randomUUID() as SessionId
```

**特性**:
- 标准 UUID v4 格式
- 每次 `resetSessionId()` 调用会生成新 UUID
- 在 clear/resume 时会重置

**ccmem 影响**: 无需调整，当前设计已按 UUID 处理

---

## 验证状态追踪

| ID | 问题 | 状态 | 验证人 | 日期 |
|----|------|------|--------|------|
| U1 | PreCompact 压缩边界 | ❌ 假设错误 | Claude | 2026-05-21 |
| U2 | hookData 契约 | ✅ 已确认 | Claude | 2026-05-21 |
| U3 | Prompt Cache | ⚠️ 部分确认 | Claude | 2026-05-21 |
| U4 | Hook Timeout | ✅ 已确认 | Claude | 2026-05-21 |
| U5 | Session 生命周期 | ✅ 已确认 | Claude | 2026-05-21 |
| U6 | additionalContext 注入 | ✅ 已确认 | Claude | 2026-05-21 |
| U7 | Hook 执行模型 | ✅ 并行执行 | Claude | 2026-05-21 |
| U8 | Transcript JSONL 格式 | ⚠️ 复杂格式 | Claude | 2026-05-21 |
| U9 | 压缩比例 70% | ⚠️ 启发式 | Claude | 2026-05-21 |
| U10 | Session ID 格式 | ✅ UUID | Claude | 2026-05-21 |

---

## 需要更新的 ccmem-design.md 部分

基于验证结果，以下设计需要调整：

### 1. §6.3 PreCompact Hook ✅ 已更新
- **问题**: 假设能访问 `messages` 数组
- **调整**: 改为读取 `transcript_path` 或使用 Stop hook 预存重要内容

### 2. §6.4 Stop Hook ✅ 已更新
- **问题**: 假设有 `tool_call_count`, `message_count`, `duration_ms`
- **调整**: 这些字段不存在，改为从 transcript 统计或自行追踪

### 3. Hook 配置 timeout 单位
- **确认**: timeout 单位是秒，当前配置正确

### 4. SessionEnd 触发条件
- **确认**: 正常退出会触发 SessionEnd hook
- **补充**: 崩溃时不触发，需要 pending_summarize 兜底

### 5. parseTranscript 实现 (新增)
- **问题**: spec 中 `parseTranscript()` 未定义实现
- **建议**: 需要处理 JSONL 复杂格式，参考 `sessionStorage.ts:loadTranscriptFile`
- **关键**: 使用 `leafUuids` + `buildConversationChain` 构建对话链

### 6. 压缩边界策略 (新增)
- **问题**: 70% 是启发式，实际压缩是 LLM 驱动
- **建议**: PreCompact 作为补救，主要依赖 Stop hook 持续追踪

---

## 参考源码路径

- Hook schemas: `reference/claudecode/src/entrypoints/sdk/coreSchemas.ts`
- Hook execution: `reference/claudecode/src/utils/hooks.ts`
- Hook types: `reference/claudecode/src/types/hooks.ts`
- Message handling: `reference/claudecode/src/utils/messages.ts`
- Graceful shutdown: `reference/claudecode/src/utils/gracefulShutdown.ts`
- Compact service: `reference/claudecode/src/services/compact/compact.ts`
