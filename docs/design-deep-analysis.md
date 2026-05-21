# ccmem 设计深入分析

> 针对设计评审中需要深入分析的问题，提供详细方案。

---

## A6: Embedding Model 唯一性防御方案

### 问题背景

当前设计提到 "5 层唯一性防御"，但实现细节分散在多处，缺乏统一视角。主要风险：
1. HuggingFace 模型命名碰撞（不同组织可能有同名模型）
2. 用户手动编辑 registry 导致不一致
3. 模型切换时残留数据

### 现有防御（散落各处）

| 层 | 位置 | 防御 |
|----|------|------|
| 1 | §4.1 | `CHECK (model_id GLOB '[a-z0-9]*')` |
| 2 | §4.1 | `vec_table_name TEXT NOT NULL UNIQUE` |
| 3 | §12.5 | repair-registry 诊断命令 |
| 4 | 未明确 | validate → hash suffix |
| 5 | 未明确 | 运行时活检 |

### 改进方案：统一 Model Identity 模块

```javascript
// lib/model-identity.mjs

/**
 * 5-layer uniqueness defense for embedding models
 * 
 * Layer 1 (Validate): Canonical model ID format
 * Layer 2 (Namespace): Source prefix prevents cross-origin collision
 * Layer 3 (Hash): Content-based suffix ensures same name = same model
 * Layer 4 (Schema): DB constraints enforce uniqueness
 * Layer 5 (Runtime): Health check detects drift
 */

// Layer 1: Canonical format validation
const MODEL_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const RESERVED_PREFIXES = ['vec_', 'ccmem_', 'test_'];

export function validateModelId(rawId) {
  const id = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new InvalidModelIdError(`Invalid model ID format: ${rawId}`);
  }
  if (RESERVED_PREFIXES.some(p => id.startsWith(p))) {
    throw new InvalidModelIdError(`Reserved prefix in model ID: ${rawId}`);
  }
  return id;
}

// Layer 2: Source-namespaced ID (prevents HuggingFace org collision)
export function namespacedModelId(source, modelName) {
  // source: 'hf' (HuggingFace), 'local', 'custom'
  // Example: hf/xenova/bge-small-zh-v1.5 → hf_xenova_bge_small_zh_v1_5
  const normalized = `${source}_${modelName}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48);
  return validateModelId(normalized);
}

// Layer 3: Content-hash suffix (same name = same model guarantee)
export function vecTableName(modelId, configHash) {
  // configHash: SHA256(dim + vocab_size + model_type) 的前 8 位
  // 确保即使同名模型，配置不同也会分开存储
  const suffix = configHash.slice(0, 8);
  return `vec_${modelId}_${suffix}`;
}

// Layer 4: Schema constraint (见 §4.1 已有)
// CREATE TABLE embedding_model_registry (
//   model_id TEXT PRIMARY KEY,
//   vec_table_name TEXT NOT NULL UNIQUE,
//   ...
// );

// Layer 5: Runtime health check
export async function verifyModelIntegrity(db, modelId) {
  const registry = await db.get(`
    SELECT * FROM embedding_model_registry WHERE model_id = ?
  `, [modelId]);
  
  if (!registry) return { ok: false, error: 'not_in_registry' };
  
  // Check physical table exists
  const table = await db.get(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name = ?
  `, [registry.vec_table_name]);
  
  if (!table) return { ok: false, error: 'table_missing' };
  
  // Check dimension consistency
  const tableInfo = await db.all(`PRAGMA table_info(${registry.vec_table_name})`);
  const embeddingCol = tableInfo.find(c => c.name === 'embedding');
  // Parse FLOAT[N] to extract dimension
  const dimMatch = embeddingCol?.type.match(/FLOAT\[(\d+)\]/);
  const actualDim = dimMatch ? parseInt(dimMatch[1]) : null;
  
  if (actualDim !== registry.dim) {
    return { ok: false, error: 'dim_mismatch', expected: registry.dim, actual: actualDim };
  }
  
  // Check embedding count consistency
  const embCount = await db.get(`
    SELECT COUNT(*) as n FROM memory_embedding WHERE model_id = ?
  `, [modelId]);
  const vecCount = await db.get(`
    SELECT COUNT(*) as n FROM ${registry.vec_table_name}
  `);
  
  if (embCount.n !== vecCount.n) {
    return { ok: false, error: 'count_mismatch', embedding: embCount.n, vec: vecCount.n };
  }
  
  return { ok: true };
}

// Registration workflow (atomic)
export async function registerModel(db, modelConfig) {
  const modelId = namespacedModelId(modelConfig.source, modelConfig.name);
  const configHash = sha256(`${modelConfig.dim}:${modelConfig.vocab_size}:${modelConfig.type}`);
  const tableName = vecTableName(modelId, configHash);
  
  await db.transaction(async (tx) => {
    // Check for ID collision with different config
    const existing = await tx.get(`
      SELECT * FROM embedding_model_registry WHERE model_id = ?
    `, [modelId]);
    
    if (existing && existing.vec_table_name !== tableName) {
      throw new ModelCollisionError(
        `Model ${modelId} already registered with different config. ` +
        `Existing: ${existing.vec_table_name}, New: ${tableName}`
      );
    }
    
    if (!existing) {
      await tx.run(`
        INSERT INTO embedding_model_registry 
        (model_id, vec_table_name, dim, registered_at, status)
        VALUES (?, ?, ?, ?, 'downloading')
      `, [modelId, tableName, modelConfig.dim, now()]);
      
      // Create physical table
      await tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
        USING vec0(embedding FLOAT[${modelConfig.dim}])
      `);
    }
  });
  
  return { modelId, tableName };
}
```

### 配置示例

```json
{
  "embedding": {
    "models": {
      "bge-small-zh": {
        "source": "hf",
        "name": "Xenova/bge-small-zh-v1.5",
        "dim": 384,
        "vocab_size": 21128,
        "type": "bert"
      }
    }
  }
}
```

### 完整防御链流程图

```
用户请求启用模型
       │
       ▼
┌─────────────────┐
│ Layer 1: 格式校验 │ ─── 非法字符/保留前缀 → 拒绝
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Layer 2: 命名空间 │ ─── hf/xenova/bge-small → hf_xenova_bge_small
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Layer 3: 配置哈希 │ ─── vec_hf_xenova_bge_small_a1b2c3d4
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Layer 4: DB约束  │ ─── UNIQUE(vec_table_name) 拦截重复
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ Layer 5: 运行时活检  │ ─── 每次启用时验证 dim/count 一致
└─────────────────────┘
```

---

## A7: Cerebrum.md 同步去重方案

### 问题背景

当前设计：
> 同步是单向的:ccmem 只读 cerebrum,不写

风险场景：
1. 用户手动在 cerebrum.md 添加 ccmem 已有的内容 → 重复记忆
2. ccmem 自动提取的规则与 cerebrum 手写的相似但措辞不同 → 语义重复
3. 同一内容 trust 分数不一致

### 改进方案：三阶段去重

```javascript
// lib/cerebrum-sync.mjs

/**
 * Cerebrum.md sync with 3-stage deduplication
 * 
 * Stage 1: Exact match (fast, cheap)
 * Stage 2: Normalized match (handle formatting differences)
 * Stage 3: Semantic similarity (optional, requires embedding)
 */

const SIMILARITY_THRESHOLD = 0.85;  // Stage 3 threshold

export async function syncCerebrumEntry(db, entry, projectKey) {
  const { content, section, lineNumber } = entry;
  
  // Stage 1: Exact content match
  const exactMatch = await db.get(`
    SELECT * FROM memories 
    WHERE content = ? AND (scope = 'global' OR project_key = ?)
    LIMIT 1
  `, [content, projectKey]);
  
  if (exactMatch) {
    return handleExactMatch(db, exactMatch, entry);
  }
  
  // Stage 2: Normalized match (collapse whitespace, lowercase, remove punctuation)
  const normalized = normalizeForComparison(content);
  const candidates = await db.all(`
    SELECT *, 
      LENGTH(content) as len,
      ABS(LENGTH(content) - ?) as len_diff
    FROM memories 
    WHERE decay_status = 'active'
      AND (scope = 'global' OR project_key = ?)
      AND ABS(LENGTH(content) - ?) < 50
    ORDER BY len_diff
    LIMIT 20
  `, [content.length, projectKey, content.length]);
  
  for (const candidate of candidates) {
    if (normalizeForComparison(candidate.content) === normalized) {
      return handleNormalizedMatch(db, candidate, entry);
    }
  }
  
  // Stage 3: Semantic similarity (only if embedding enabled)
  if (await isEmbeddingEnabled(db)) {
    const embedding = await computeEmbedding(content);
    const similar = await findSimilarByEmbedding(db, embedding, projectKey, SIMILARITY_THRESHOLD);
    
    if (similar) {
      return handleSemanticMatch(db, similar, entry);
    }
  }
  
  // No match found: insert new memory
  return insertNewFromCerebrum(db, entry, projectKey);
}

function normalizeForComparison(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s一-鿿]/g, '')  // Keep alphanumeric + Chinese
    .trim();
}

// Match handlers with different strategies

async function handleExactMatch(db, existing, cerebrumEntry) {
  // Exact match: just update source tracking, don't change trust
  await db.run(`
    UPDATE memories 
    SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', ?),
        modified_at = ?
    WHERE id = ?
  `, [`cerebrum_synced:${cerebrumEntry.section}:L${cerebrumEntry.lineNumber}`, now(), existing.id]);
  
  return { action: 'exact_match', existingId: existing.id, inserted: false };
}

async function handleNormalizedMatch(db, existing, cerebrumEntry) {
  // Normalized match: likely same intent, different formatting
  // Keep existing, add cerebrum reference
  const reason = `normalized_match:${cerebrumEntry.section}:L${cerebrumEntry.lineNumber}`;
  
  await db.run(`
    UPDATE memories 
    SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', ?),
        modified_at = ?
    WHERE id = ?
  `, [reason, now(), existing.id]);
  
  await logAudit({
    action: 'cerebrum_sync_normalized_match',
    details: JSON.stringify({
      existing_id: existing.id,
      existing_content: existing.content.slice(0, 100),
      cerebrum_content: cerebrumEntry.content.slice(0, 100),
      section: cerebrumEntry.section,
    }),
  });
  
  return { action: 'normalized_match', existingId: existing.id, inserted: false };
}

async function handleSemanticMatch(db, existing, cerebrumEntry) {
  // Semantic match: similar meaning, may have important differences
  // Strategy: keep both, but link them and lower priority of new one
  
  const newId = await insertNewFromCerebrum(db, cerebrumEntry, existing.project_key, {
    trust_score: Math.min(existing.trust_score, 0.7),  // Cap trust
    tags: ['semantic_duplicate_of:' + existing.id],
  });
  
  // Add reverse link to existing
  await db.run(`
    UPDATE memories 
    SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', ?)
    WHERE id = ?
  `, ['has_semantic_duplicate:' + newId, existing.id]);
  
  await logAudit({
    action: 'cerebrum_sync_semantic_match',
    details: JSON.stringify({
      existing_id: existing.id,
      new_id: newId,
      similarity: existing._similarity,
    }),
  });
  
  return { 
    action: 'semantic_match', 
    existingId: existing.id, 
    newId,
    inserted: true,
    warning: 'semantic_duplicate_created',
  };
}

async function insertNewFromCerebrum(db, entry, projectKey, overrides = {}) {
  const typeMap = {
    'User Preferences': { type: 'rule', scope: 'global' },
    'Key Learnings':    { type: 'fact', scope: 'project' },
    'Do-Not-Repeat':    { type: 'rule', scope: 'project', tags: ['dnr'] },
  };
  
  const config = typeMap[entry.section] || { type: 'fact', scope: 'project' };
  
  const mem = {
    content: entry.content,
    type: config.type,
    scope: config.scope,
    project_key: config.scope === 'project' ? projectKey : null,
    source: 'cerebrum_import',
    trust_score: overrides.trust_score ?? 0.8,
    tags: [...(config.tags || []), ...(overrides.tags || []), 
           `cerebrum:${entry.section}:L${entry.lineNumber}`],
  };
  
  return await insertMemory(mem);  // Goes through full gate (§10.1)
}
```

### 同步策略配置

```json
{
  "hooks": {
    "cerebrumSync": {
      "enabled": true,
      "deduplication": {
        "exactMatch": true,
        "normalizedMatch": true,
        "semanticMatch": "when_embedding_enabled",
        "semanticThreshold": 0.85
      },
      "onSemanticDuplicate": "create_linked",
      "reportDuplicates": true
    }
  }
}
```

### 用户可见输出

```
ccmem: syncing cerebrum.md...
  - User Preferences: 3 entries
    • "偏好简洁回答" → exact match with m1234 (skipped)
    • "TypeScript 严格模式" → new (m5678)
    • "代码注释用英文" → semantic match with m9abc (linked)
  - Key Learnings: 2 entries
    • "Next.js App Router 结构" → normalized match with m2345 (merged)
    • "API 路由在 /app/api" → new (m6789)
  - Do-Not-Repeat: 1 entry
    • "不要用 any 类型" → new (m0123)

Summary: 6 entries processed, 3 new, 3 deduplicated
```

---

## A11: Daemon Lock 数据库故障容错方案

### 问题背景

当前 `acquireDaemonLock()` 处理了锁过期，但未处理：
- `daemon_lock` 表损坏
- 数据库文件锁定
- 磁盘满
- 权限问题

风险：所有 hook 都会失败，用户完全无法使用 Claude Code + ccmem。

### 改进方案：分层容错

```javascript
// lib/daemon-lock.mjs

/**
 * Daemon lock with graceful degradation
 * 
 * Levels:
 * 1. Normal: Full daemon functionality
 * 2. Degraded: Hook-only mode (no daemon, no async tasks)
 * 3. Safe: Read-only mode (injection only, no writes)
 * 4. Bypass: ccmem completely disabled
 */

const OPERATION_MODES = {
  NORMAL:   'normal',    // Full functionality
  DEGRADED: 'degraded',  // No daemon, hooks still work
  SAFE:     'safe',      // Read-only, injection only
  BYPASS:   'bypass',    // ccmem disabled
};

let currentMode = OPERATION_MODES.NORMAL;
let lastDbError = null;

export async function acquireDaemonLockWithFallback() {
  try {
    // First, verify database is accessible
    await verifyDatabaseHealth();
    
    // Then try normal lock acquisition
    return await acquireDaemonLock();
  } catch (e) {
    return handleLockFailure(e);
  }
}

async function verifyDatabaseHealth() {
  const checks = [
    { name: 'file_exists', fn: checkDbFileExists },
    { name: 'file_writable', fn: checkDbWritable },
    { name: 'schema_valid', fn: checkSchemaIntegrity },
    { name: 'lock_table', fn: checkLockTableAccessible },
  ];
  
  const results = {};
  for (const check of checks) {
    try {
      results[check.name] = await check.fn();
    } catch (e) {
      results[check.name] = { ok: false, error: e.message };
    }
  }
  
  return results;
}

async function checkDbFileExists() {
  const dbPath = getGlobalDbPath();
  try {
    await fs.promises.access(dbPath, fs.constants.F_OK);
    return { ok: true };
  } catch {
    return { ok: false, error: 'db_file_missing' };
  }
}

async function checkDbWritable() {
  const dbPath = getGlobalDbPath();
  try {
    await fs.promises.access(dbPath, fs.constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, error: 'db_not_writable' };
  }
}

async function checkSchemaIntegrity() {
  try {
    const result = await db.get(`PRAGMA integrity_check`);
    if (result.integrity_check !== 'ok') {
      return { ok: false, error: 'integrity_check_failed', details: result };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'pragma_failed', details: e.message };
  }
}

async function checkLockTableAccessible() {
  try {
    await db.get(`SELECT 1 FROM daemon_lock LIMIT 1`);
    return { ok: true };
  } catch (e) {
    if (e.message.includes('no such table')) {
      return { ok: false, error: 'table_missing' };
    }
    return { ok: false, error: 'query_failed', details: e.message };
  }
}

function handleLockFailure(error) {
  lastDbError = error;
  
  // Classify error and determine degradation level
  const classification = classifyDbError(error);
  
  switch (classification.type) {
    case 'corruption':
      currentMode = OPERATION_MODES.SAFE;
      logDegradation('Database corruption detected, entering safe mode', error);
      return { mode: currentMode, reason: 'corruption' };
      
    case 'permission':
      currentMode = OPERATION_MODES.SAFE;
      logDegradation('Database permission denied, entering safe mode', error);
      return { mode: currentMode, reason: 'permission' };
      
    case 'disk_full':
      currentMode = OPERATION_MODES.SAFE;
      logDegradation('Disk full, entering safe mode', error);
      return { mode: currentMode, reason: 'disk_full' };
      
    case 'locked':
      currentMode = OPERATION_MODES.DEGRADED;
      logDegradation('Database locked by another process, entering degraded mode', error);
      return { mode: currentMode, reason: 'locked' };
      
    case 'missing':
      // Database doesn't exist yet - this is OK for first run
      return { mode: OPERATION_MODES.NORMAL, firstRun: true };
      
    default:
      currentMode = OPERATION_MODES.DEGRADED;
      logDegradation('Unknown database error, entering degraded mode', error);
      return { mode: currentMode, reason: 'unknown' };
  }
}

function classifyDbError(error) {
  const msg = error.message.toLowerCase();
  
  if (msg.includes('malformed') || msg.includes('corrupt') || msg.includes('integrity')) {
    return { type: 'corruption' };
  }
  if (msg.includes('permission') || msg.includes('eacces') || msg.includes('readonly')) {
    return { type: 'permission' };
  }
  if (msg.includes('disk full') || msg.includes('no space') || msg.includes('enospc')) {
    return { type: 'disk_full' };
  }
  if (msg.includes('locked') || msg.includes('busy')) {
    return { type: 'locked' };
  }
  if (msg.includes('no such file') || msg.includes('enoent')) {
    return { type: 'missing' };
  }
  
  return { type: 'unknown' };
}

function logDegradation(message, error) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    error: error.message,
    stack: error.stack,
    mode: currentMode,
  };
  
  // Write to stderr (visible to user)
  process.stderr.write(`ccmem [${currentMode}]: ${message}\n`);
  
  // Try to write to audit log (may fail in corruption scenario)
  try {
    appendToFallbackLog(logEntry);
  } catch { /* ignore */ }
}

// Fallback log when DB is inaccessible
function appendToFallbackLog(entry) {
  const fallbackPath = path.join(getDataRoot(), 'degradation.log');
  fs.appendFileSync(fallbackPath, JSON.stringify(entry) + '\n');
}

// Mode-aware operation wrappers
export function canWrite() {
  return currentMode === OPERATION_MODES.NORMAL || currentMode === OPERATION_MODES.DEGRADED;
}

export function canRunDaemon() {
  return currentMode === OPERATION_MODES.NORMAL;
}

export function canInject() {
  return currentMode !== OPERATION_MODES.BYPASS;
}

export function getOperationMode() {
  return currentMode;
}

export function getLastDbError() {
  return lastDbError;
}

// Recovery command
export async function attemptRecovery() {
  const health = await verifyDatabaseHealth();
  
  const report = {
    checks: health,
    recommendations: [],
  };
  
  if (!health.file_exists?.ok) {
    report.recommendations.push({
      action: 'init',
      command: '/ccmem:init',
      reason: 'Database file missing, needs initialization',
    });
  }
  
  if (!health.file_writable?.ok) {
    report.recommendations.push({
      action: 'fix_permissions',
      command: `chmod 644 ${getGlobalDbPath()}`,
      reason: 'Database file not writable',
    });
  }
  
  if (!health.schema_valid?.ok) {
    report.recommendations.push({
      action: 'repair',
      command: '/ccmem:repair --from-backup',
      reason: 'Database corruption detected',
    });
  }
  
  if (!health.lock_table?.ok && health.lock_table?.error === 'table_missing') {
    report.recommendations.push({
      action: 'migrate',
      command: '/ccmem:migrate --fix-schema',
      reason: 'Schema incomplete, migration needed',
    });
  }
  
  return report;
}
```

### Hook 入口集成

```javascript
// handlers/session-start.mjs

async function handleSessionStart(hookData) {
  // Try to acquire lock with fallback
  const lockResult = await acquireDaemonLockWithFallback();
  
  if (lockResult.mode === OPERATION_MODES.BYPASS) {
    process.stderr.write('ccmem: disabled due to unrecoverable error\n');
    process.exit(0);
  }
  
  if (lockResult.mode === OPERATION_MODES.SAFE) {
    process.stderr.write(
      `ccmem [safe mode]: read-only, run /ccmem:diagnose for details\n`
    );
    // Continue with injection only, skip all writes
  }
  
  if (lockResult.mode === OPERATION_MODES.DEGRADED) {
    process.stderr.write(
      `ccmem [degraded]: daemon unavailable, async features disabled\n`
    );
    // Continue with hooks, but skip daemon-dependent features
  }
  
  // Rest of handler, with mode-aware branches
  if (canWrite()) {
    await recordFeedback(...);
    await bumpRecallCounters(...);
  }
  
  if (canInject()) {
    // ... injection logic
  }
}
```

### 用户命令

```bash
# 诊断当前状态
/ccmem:diagnose

# 输出示例
=== ccmem health check ===
Operation mode: degraded
Last error: SQLITE_BUSY: database is locked

Database checks:
  ✓ file_exists
  ✓ file_writable  
  ✓ schema_valid
  ✗ lock_table: SQLITE_BUSY

Recommendations:
  1. Another process may be holding the database lock.
     Check: lsof ~/.claude/ccmem/global.db
  2. If stuck, try: /ccmem:daemon restart

# 尝试恢复
/ccmem:recover

# 强制重置（高危）
/ccmem:reset-db --confirm
```

### 降级模式功能矩阵

| 功能 | Normal | Degraded | Safe | Bypass |
|------|--------|----------|------|--------|
| 记忆注入 | ✓ | ✓ | ✓ (cached only) | ✗ |
| 记忆写入 | ✓ | ✓ | ✗ | ✗ |
| 反馈记录 | ✓ | ✓ | ✗ | ✗ |
| Daemon 运行 | ✓ | ✗ | ✗ | ✗ |
| Cron 任务 | ✓ | ✗ | ✗ | ✗ |
| 用户命令 | ✓ | ✓ (部分) | ✓ (只读) | ✗ |

---

## 建议的 Spec 更新

以上三个方案建议整合到 `ccmem-design.md` 的以下位置：

1. **A6 (Model Identity)**: 新增 §4.6 或扩展 §4.1 的 embedding 相关说明
2. **A7 (Cerebrum Dedup)**: 扩展 §9.2 的同步逻辑
3. **A11 (Graceful Degradation)**: 新增 §7.9 或 §16.3

是否需要我直接更新 `ccmem-design.md`？
