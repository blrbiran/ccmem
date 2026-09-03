# ccmem v0.12 Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize ccmem v0.12 to the dogfood-corrected end state, including schema repair, retrieval observability, circuit breaking, benchmark tooling, temporal/summary/cache support, and synced docs.

**Architecture:** Keep changes surgical and anchored to current code surfaces: schema changes through `scripts/lib/db.mjs` + migrations, retrieval changes in `scripts/lib/retrieval.mjs` and `scripts/handlers/prompt-submit.mjs`, write-path changes through the existing `scripts/lib/cmd/save.mjs`, and admin exposure through the existing `scripts/cli.mjs` + `commands/admin.md` surface. Implement in dependency order: schema/repair first, then observability, then circuit behavior, then benchmark and the three P2 features, and finish with docs plus a spec/dogfood closure review.

**Tech Stack:** Node.js ESM, built-in `node:sqlite` (`DatabaseSync`), Node built-in test runner (`node --test`), SQLite migrations, Claude Code command markdown, audit-log/metrics JSONL diagnostics.

## Global Constraints

- Follow the approved design at `docs/superpowers/specs/2026-07-08-ccmem-v012-finalization-design.md`.
- Implement against the dogfood-corrected final state when phase spec wording and later dogfood findings disagree.
- Use current code surfaces (`scripts/lib/cmd/save.mjs`, `commands/admin.md`) unless a later task explicitly justifies extraction.
- Keep changes surgical: no unrelated refactors, no speculative modules, no new top-level command files.
- TDD by default: write or update a failing test first, run it to prove RED, then implement the minimum code to make it pass.
- Hook/daemon/runtime code stays English; docs prose stays Chinese.
- Retrieval observability must distinguish `A`, `B-off`, `B-fail`, and `B-circuit`.
- `config_kv.value` is `TEXT NOT NULL`; clearing keys must use delete semantics, not writing SQL NULL.
- Broad sqlite-dependent verification must use `/usr/local/bin/node`.
- Update `docs/ccmem-v0.12-spec.md` and `docs/ccmem-v0.12-dogfood.md` to match the shipped end state.
- After creating or editing files, update OpenWolf artifacts required by the repo rules (`.wolf/memory.md`, `.wolf/anatomy.md`, plus `.wolf/buglog.json` for bugs/failures).

---

## File Map

### Schema and runtime loader

- Modify: `scripts/lib/db.mjs` — extend migration runner so versioned SQL migrations and corrective `.cjs` repairs can both run synchronously and idempotently.
- Create: `scripts/migrations/014_v012.sql` — formal v0.12 schema additions (`summary_meta`, `temporal_type`, `query_embedding_cache`, rollup columns).
- Create: `scripts/migrations/015_v012_repair.cjs` — corrective migration for partial live DB schema-14 states.
- Modify: `tests/integration/migration-v1-to-v2.test.mjs` or create `tests/integration/migration-v012.test.mjs` if the existing file becomes too mixed — cover fresh upgrade, partial-014 repair, idempotent rerun.

### Retrieval observability and circuit breaker

- Modify: `scripts/lib/retrieval.mjs` — return explicit retrieval path, embed error, cache timing, and later query-cache behavior.
- Modify: `scripts/handlers/prompt-submit.mjs` — emit v0.12 retrieval metrics fields into `_metricFields`.
- Modify: `scripts/lib/metrics-rollup.mjs` — aggregate retrieval paths and embed error rate from `metrics.jsonl` into `metrics_daily_rollup`.
- Modify: `scripts/lib/embedding/provider.mjs` — add circuit-state helpers, kv-backed status, open/half-open/close logic.
- Modify: `scripts/lib/admin/diagnose.mjs` — expose retrieval metrics, benchmark summary, embedding-circuit status/control.
- Modify: `tests/integration/prompt-submit-retrieval.test.mjs` — assert path-specific metric fields and file-based/inline retrieval behavior.
- Modify: `tests/integration/admin-diagnose-command.test.mjs` — assert retrieval diagnose output, benchmark last-run visibility, kv override truthfulness, and circuit control.

### Benchmark surface

- Create: `scripts/lib/admin/retrieval-check.mjs` — offline benchmark command implementation.
- Create: `scripts/lib/benchmark/corpus.json` — default retrieval corpus with coding queries and adversarial misses.
- Modify: `scripts/cli.mjs` — add `admin retrieval-check` and `admin embedding-circuit` dispatch/help.
- Modify: `commands/admin.md` — expose new admin subcommands on slash surface.
- Modify: `tests/integration/admin-diagnose-command.test.mjs` and/or add `tests/integration/admin-retrieval-check.test.mjs` — benchmark command output, corpus loading, and audit write.

### Temporal tag, structured summary, and query cache

- Modify: `scripts/daemon/tasks/summarize-pending.mjs` — extend summarize schema/prompt, build `summary_meta`, and persist through the current insert path.
- Modify: `scripts/lib/llm-parse.mjs` — preserve the four structured summary fields through normalization.
- Modify: `scripts/lib/cmd/save.mjs` — extend `insertMemory()` signature and INSERT statement for `temporal_type` / `summary_meta` while keeping current callers working.
- Modify: `scripts/daemon/tasks/weekly-synthesis.mjs` — pass through `temporal_type` on synthesized writes.
- Modify: `scripts/lib/llm-prompts/weekly-synthesis-v2.mjs` — emit `temporal_type` in schema and prompt.
- Modify: `scripts/lib/injection-cache.mjs` — select `temporal_type` into ranking inputs.
- Modify: `scripts/lib/priority.mjs` — apply `temporal_type='permanent'` as non-decaying half-life.
- Modify: `scripts/daemon/tasks/daily-maintenance.mjs` — clear expired query cache rows.
- Modify: `scripts/lib/retrieval.mjs` — add query embedding cache read/write, model keying, and no false circuit-close on cache hits.
- Modify: `tests/integration/daemon-loop.test.mjs` and `tests/integration/admin-diagnose-command.test.mjs` — exercise summarize/weekly/daily end-to-end paths.
- Create or modify targeted unit tests under `tests/unit/` if a single helper needs precise coverage (`llm-parse`, `priority`, cache helpers).

### Documentation and closure

- Modify: `docs/ccmem-v0.12-spec.md` — sync to shipped behavior and schema-15 reality.
- Modify: `docs/ccmem-v0.12-dogfood.md` — record delivered fixes, remaining manual dogfood, and corrected end-state notes.
- Modify: `.wolf/anatomy.md` — index any newly created files.
- Modify: `.wolf/memory.md` — append session/task lines.
- Modify: `.wolf/buglog.json` — log any failed tests, runtime errors, or bugs fixed during execution.

---

### Task 1: Ship schema 14 + schema 15 repair and prove both upgrade paths

**Files:**
- Create: `scripts/migrations/014_v012.sql`
- Create: `scripts/migrations/015_v012_repair.cjs`
- Modify: `scripts/lib/db.mjs`
- Test: `tests/integration/migration-v1-to-v2.test.mjs`

**Interfaces:**
- Consumes: `openDb()`, `getSchemaVersion(db)` from `scripts/lib/db.mjs`
- Produces:
  - migration file `014_v012.sql`
  - repair migration `015_v012_repair.cjs`
  - synchronous migration runner support for `.sql` and `.cjs`
  - schema state after upgrade includes:
    - `memories.temporal_type TEXT`
    - `memories.summary_meta TEXT`
    - `query_embedding_cache(prompt_hash TEXT PRIMARY KEY, embedding BLOB, model TEXT, prompt_len INTEGER, created_at INTEGER, hit_count INTEGER)`
    - rollup columns `embed_error_rate`, `path_a_count`, `path_b_fail_count`, `path_b_off_count`, `path_b_circuit_count`

- [ ] **Step 1: Write the failing migration tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('fresh upgrade reaches schema 15 with v0.12 columns and tables', async () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-v012-fresh-'));
  process.env.CCMEM_DATA_ROOT = dataRoot;
  const { openDb, getSchemaVersion } = await import('../../scripts/lib/db.mjs');
  const db = openDb();

  assert.equal(getSchemaVersion(db), 15);
  assert.ok(columns(db, 'memories').includes('temporal_type'));
  assert.ok(columns(db, 'memories').includes('summary_meta'));
  assert.ok(columns(db, 'metrics_daily_rollup').includes('embed_error_rate'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_embedding_cache'").get());

  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

test('schema-14 partial live DB is repaired to schema 15 idempotently', async () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-v012-repair-'));
  process.env.CCMEM_DATA_ROOT = dataRoot;
  const { DatabaseSync } = await import('node:sqlite');
  const { getDbPath, openDb, getSchemaVersion } = await import('../../scripts/lib/db.mjs');

  const seed = new DatabaseSync(getDbPath());
  seed.exec(`
    CREATE TABLE schema_meta (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_meta(version, applied_at) VALUES (14, 0);
    CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_version INTEGER,
      to_version INTEGER NOT NULL,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      applied_by TEXT NOT NULL
    );
    INSERT INTO schema_migrations(from_version, to_version, description, applied_at, applied_by)
    VALUES (13, 14, 'partial v0.12 rc', 0, 'test');
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT,
      project_key TEXT,
      type TEXT,
      content TEXT,
      temporal_type TEXT DEFAULT 'temporary',
      created_at INTEGER,
      updated_at INTEGER,
      last_touched_at INTEGER,
      status TEXT DEFAULT 'active',
      decay_status TEXT DEFAULT 'active'
    );
    CREATE TABLE metrics_daily_rollup (
      day_key TEXT PRIMARY KEY,
      written_at INTEGER
    );
  `);
  seed.close();

  let db = openDb();
  assert.equal(getSchemaVersion(db), 15);
  assert.ok(columns(db, 'memories').includes('summary_meta'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_embedding_cache'").get());
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memories WHERE temporal_type='temporary'").get().n,
    0
  );
  db.close();

  db = openDb();
  assert.equal(getSchemaVersion(db), 15);
  assert.ok(columns(db, 'metrics_daily_rollup').includes('path_b_circuit_count'));
  db.close();

  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the migration tests to verify they fail**

Run: `/usr/local/bin/node --test tests/integration/migration-v1-to-v2.test.mjs`

Expected: FAIL because schema version stops at 13, `014_v012.sql`/`015_v012_repair.cjs` do not exist, and repair logic is missing.

- [ ] **Step 3: Write the minimal migration and runner implementation**

```sql
-- scripts/migrations/014_v012.sql
ALTER TABLE memories ADD COLUMN temporal_type TEXT;
ALTER TABLE memories ADD COLUMN summary_meta TEXT;

CREATE TABLE query_embedding_cache (
  prompt_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  prompt_len INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_qec_created ON query_embedding_cache(created_at);

ALTER TABLE metrics_daily_rollup ADD COLUMN embed_error_rate REAL;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_a_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_off_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_circuit_count INTEGER NOT NULL DEFAULT 0;

UPDATE schema_meta SET version = 14, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (13, 14, 'v0.12: temporal_type + summary_meta + query_embedding_cache', strftime('%s','now') * 1000, 'ccmem-cli');
```

```javascript
// scripts/migrations/015_v012_repair.cjs
module.exports = function runV015Repair(db) {
  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

  db.exec('BEGIN');
  try {
    if (!hasColumn('memories', 'summary_meta')) {
      db.exec('ALTER TABLE memories ADD COLUMN summary_meta TEXT');
    }
    if (!hasTable('query_embedding_cache')) {
      db.exec(`
        CREATE TABLE query_embedding_cache (
          prompt_hash TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          prompt_len INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.exec('CREATE INDEX idx_qec_created ON query_embedding_cache(created_at)');
    }
    for (const column of ['embed_error_rate', 'path_a_count', 'path_b_fail_count', 'path_b_off_count', 'path_b_circuit_count']) {
      if (!hasColumn('metrics_daily_rollup', column)) {
        const type = column === 'embed_error_rate' ? 'REAL' : 'INTEGER NOT NULL DEFAULT 0';
        db.exec(`ALTER TABLE metrics_daily_rollup ADD COLUMN ${column} ${type}`);
      }
    }
    if (hasColumn('memories', 'temporal_type')) {
      db.prepare("UPDATE memories SET temporal_type = NULL WHERE temporal_type = 'temporary'").run();
    }
    db.prepare('UPDATE schema_meta SET version = 15, applied_at = ?').run(Date.now());
    db.prepare(`
      INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
      VALUES (14, 15, 'v0.12 repair: summary_meta + query_embedding_cache + rollup columns', ?, 'ccmem-cli')
    `).run(Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
```

```javascript
// scripts/lib/db.mjs (new helper and migration dispatch shape)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function runJsMigration(db, file) {
  const migration = require(path.join(MIGRATIONS_DIR, file));
  if (typeof migration !== 'function') {
    throw new Error(`Invalid JS migration: ${file}`);
  }
  migration(db);
}

function runVersionedMigration(db, file) {
  if (file.endsWith('.sql')) return runSqlMigration(db, file);
  if (file.endsWith('.cjs')) return runJsMigration(db, file);
  throw new Error(`Unsupported migration type: ${file}`);
}
```

- [ ] **Step 4: Run the migration tests to verify they pass**

Run: `/usr/local/bin/node --test tests/integration/migration-v1-to-v2.test.mjs`

Expected: PASS with the new fresh-upgrade and partial-014 repair assertions green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/db.mjs scripts/migrations/014_v012.sql scripts/migrations/015_v012_repair.cjs tests/integration/migration-v1-to-v2.test.mjs
git commit -m "feat: repair v0.12 upgrade chain"
```

### Task 2: Add retrieval observability end-to-end before circuit logic

**Files:**
- Modify: `scripts/lib/retrieval.mjs`
- Modify: `scripts/handlers/prompt-submit.mjs`
- Modify: `scripts/lib/metrics-rollup.mjs`
- Modify: `tests/integration/prompt-submit-retrieval.test.mjs`
- Modify: `tests/integration/admin-diagnose-command.test.mjs`

**Interfaces:**
- Consumes:
  - `retrieveMemories(db, prompt, projectKey, config)`
  - `handlePromptSubmit(hookData)`
  - `writeMetricsDailyRollup(db)`
- Produces:
  - `retrieveMemories(...) => { rows, queryVec, cosineContribution, timing, retrievalPath }`
  - `timing.embedError?: string`
  - prompt-submit metric fields: `retrieval_path`, `retrieval_embed_error`, `retrieval_fallback`
  - rollup helper `aggregateRetrievalPaths(startMs, endMs)` returning `{ total, fallback, A, 'B-fail', 'B-off', 'B-circuit' }`

- [ ] **Step 1: Write the failing observability tests**

```javascript
// tests/integration/prompt-submit-retrieval.test.mjs

test('prompt-submit reports B-off metrics when embedding is disabled', async () => {
  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 'sess-b-off',
    prompt: 'pnpm workspace layout'
  });

  assert.equal(result.additionalContext, '');
  assert.equal(result._metricFields.retrieval_path, 'B-off');
  assert.equal(result._metricFields.retrieval_embed_error, null);
  assert.equal(result._metricFields.retrieval_fallback, false);
});
```

```javascript
// tests/integration/admin-diagnose-command.test.mjs

test('metrics rollup persists v0.12 retrieval path counts', async () => {
  const db = openDb();
  recordMetric({ hook: 'prompt_submit', ts: Date.now() - 1000, ms_total: 10, retrieval_path: 'A', retrieval_fallback: false });
  recordMetric({ hook: 'prompt_submit', ts: Date.now() - 900, ms_total: 11, retrieval_path: 'B-fail', retrieval_fallback: true });
  writeMetricsDailyRollup(db);

  const row = db.prepare(`SELECT path_a_count, path_b_fail_count, embed_error_rate FROM metrics_daily_rollup ORDER BY written_at DESC LIMIT 1`).get();
  assert.equal(row.path_a_count, 1);
  assert.equal(row.path_b_fail_count, 1);
  assert.equal(row.embed_error_rate, 0.5);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `/usr/local/bin/node --test tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs`

Expected: FAIL because `_metricFields` does not include v0.12 retrieval fields and rollup ignores retrieval path data.

- [ ] **Step 3: Write the minimal observability implementation**

```javascript
// scripts/lib/retrieval.mjs
if (!useEmbedding) {
  const lexical = lexicalRetrieve(db, promptText, promptTokens, projectKey, config, limit, useFts, ftsQuery);
  return {
    rows: lexical.rows,
    queryVec: null,
    cosineContribution: null,
    timing: lexical.timing,
    retrievalPath: 'B-off'
  };
}

try {
  [queryVec] = await provider.embed([promptText], config);
} catch (error) {
  const lexical = lexicalRetrieve(db, promptText, promptTokens, projectKey, config, limit, useFts, ftsQuery);
  return {
    rows: lexical.rows,
    queryVec: null,
    cosineContribution: null,
    retrievalPath: 'B-fail',
    timing: {
      ...(lexical.timing ?? {}),
      embedMs: Date.now() - tEmbed,
      embedError: String(error.message ?? error)
    }
  };
}

return {
  rows: selected.map((row) => renderRow(row, { fused: row.fused, fts: row.ftsScore, jaccard: row.jaccardScore, semantic: row.cosineScore })),
  queryVec,
  cosineContribution,
  retrievalPath: 'A',
  timing: { embedMs, dbReadMs, cosineMs, candidatePool: allVecs.length }
};
```

```javascript
// scripts/handlers/prompt-submit.mjs
const path = retrieval.retrievalPath ?? (retrieval.timing?.embedError ? 'B-fail' : (retrieval.timing ? 'A' : 'B-off'));
const embedError = retrieval.timing?.embedError ?? null;
const fallback = path === 'B-fail';

return {
  additionalContext: useFileBased ? '' : (rows.length ? renderRetrievedBlock(rows) : ''),
  _metricFields: {
    matched: rows.length,
    fused_count: rows.filter((row) => row.score).length,
    cosine_contribution: retrieval.cosineContribution ?? null,
    retrieval_embed_ms: retrieval.timing?.embedMs ?? null,
    retrieval_db_ms: retrieval.timing?.dbReadMs ?? null,
    retrieval_cosine_ms: retrieval.timing?.cosineMs ?? null,
    retrieval_pool: retrieval.timing?.candidatePool ?? null,
    retrieval_path: path,
    retrieval_embed_error: embedError,
    retrieval_fallback: fallback,
    context_file_written: useFileBased ? contextFileWritten : false,
    context_file_bytes: useFileBased ? contextFileBytes : null,
    additional_context_empty: useFileBased
  }
};
```

```javascript
// scripts/lib/metrics-rollup.mjs
export function aggregateRetrievalPaths(startMs, endMs) {
  const metricsPath = path.join(getDataRoot(), 'metrics.jsonl');
  const buckets = { total: 0, fallback: 0, A: 0, 'B-fail': 0, 'B-off': 0, 'B-circuit': 0 };
  if (!fs.existsSync(metricsPath)) return buckets;

  for (const line of fs.readFileSync(metricsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.hook !== 'prompt_submit' || typeof row.ts !== 'number' || row.ts < startMs || row.ts >= endMs) continue;
    buckets.total += 1;
    if (row.retrieval_fallback === true) buckets.fallback += 1;
    if (row.retrieval_path && row.retrieval_path in buckets) buckets[row.retrieval_path] += 1;
  }
  return buckets;
}
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `/usr/local/bin/node --test tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs`

Expected: PASS with B-off/B-fail path assertions and rollup counts green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/retrieval.mjs scripts/handlers/prompt-submit.mjs scripts/lib/metrics-rollup.mjs tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs
git commit -m "feat: add retrieval path observability"
```

### Task 3: Add kv-backed embedding circuit breaker and retrieval diagnose/control

**Files:**
- Modify: `scripts/lib/embedding/provider.mjs`
- Modify: `scripts/lib/retrieval.mjs`
- Modify: `scripts/lib/admin/diagnose.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `commands/admin.md`
- Test: `tests/integration/prompt-submit-retrieval.test.mjs`
- Test: `tests/integration/admin-diagnose-command.test.mjs`

**Interfaces:**
- Consumes:
  - `getProvider(config)` current provider selection
  - `retrieveMemories(...)`
  - `cmdAdminDiagnose(db, options)`
- Produces:
  - `getProviderWithCircuit(db, config) => { provider: Provider|null, circuit: 'closed'|'open'|'half-open' }`
  - `recordEmbedFailure(db, config)`
  - `recordEmbedSuccess(db)`
  - diagnose support for `--retrieval` and `embedding-circuit <open|close|status>`

- [ ] **Step 1: Write the failing circuit tests**

```javascript
// tests/integration/prompt-submit-retrieval.test.mjs

test('prompt-submit reports B-circuit and skips embed while circuit is open', async () => {
  const db = openDb();
  db.prepare(`INSERT INTO config_kv(key, value) VALUES ('embedding.circuit_open_until', ?)`)
    .run(String(Date.now() + 60_000));

  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 'sess-b-circuit',
    prompt: 'previous auth retry strategy'
  });

  assert.equal(result._metricFields.retrieval_path, 'B-circuit');
  assert.equal(result._metricFields.retrieval_fallback, false);
  assert.equal(result._metricFields.retrieval_embed_error, null);
});
```

```javascript
// tests/integration/admin-diagnose-command.test.mjs

test('cli admin diagnose --retrieval shows kv-aware embedding status and circuit state', async () => {
  const db = openDb();
  db.prepare(`INSERT INTO config_kv(key, value) VALUES ('embedding.enabled', 'false')`).run();
  db.prepare(`INSERT INTO config_kv(key, value) VALUES ('embedding.circuit_open_until', ?)`)
    .run(String(Date.now() + 60_000));

  const { stdout } = runCli(['admin', 'diagnose', '--retrieval']);
  assert.match(stdout, /Embedding: disabled/);
  assert.match(stdout, /Circuit: OPEN/);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `/usr/local/bin/node --test tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs`

Expected: FAIL because no `B-circuit` path exists and diagnose has no retrieval/circuit view.

- [ ] **Step 3: Write the minimal circuit implementation**

```javascript
// scripts/lib/embedding/provider.mjs
const CIRCUIT_KEYS = {
  openUntil: 'embedding.circuit_open_until',
  failures: 'embedding.consecutive_failures',
  lastProbe: 'embedding.last_probe_at'
};

function readConfigKv(key) {
  let db;
  try {
    db = openDb();
    return db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key)?.value ?? null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function writeConfigKv(db, key, value) {
  db.prepare(`INSERT INTO config_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

function clearConfigKv(db, key) {
  db.prepare(`DELETE FROM config_kv WHERE key = ?`).run(key);
}

export function getProviderWithCircuit(db, config = null) {
  const provider = getProvider(config);
  if (!provider) return { provider: null, circuit: 'closed' };

  const openUntil = Number(readConfigKv(CIRCUIT_KEYS.openUntil));
  if (!Number.isFinite(openUntil)) return { provider, circuit: 'closed' };

  const now = Date.now();
  if (now < openUntil) return { provider: null, circuit: 'open' };

  const probeInterval = Number(config?.embedding?.circuit?.probe_interval_ms ?? 60_000);
  const lastProbe = Number(readConfigKv(CIRCUIT_KEYS.lastProbe) ?? 0);
  if ((now - lastProbe) < probeInterval) return { provider: null, circuit: 'open' };

  writeConfigKv(db, CIRCUIT_KEYS.lastProbe, now);
  return { provider, circuit: 'half-open' };
}

export function recordEmbedFailure(db, config = null) {
  const threshold = Number(config?.embedding?.circuit?.failure_threshold ?? 3);
  const cooldownMs = Number(config?.embedding?.circuit?.cooldown_ms ?? 300_000);
  const openUntil = Number(readConfigKv(CIRCUIT_KEYS.openUntil));
  if (Number.isFinite(openUntil)) {
    writeConfigKv(db, CIRCUIT_KEYS.openUntil, Date.now() + cooldownMs);
    return;
  }
  const failures = Number(readConfigKv(CIRCUIT_KEYS.failures) ?? 0) + 1;
  writeConfigKv(db, CIRCUIT_KEYS.failures, failures);
  if (failures >= threshold) {
    const until = Date.now() + cooldownMs;
    writeConfigKv(db, CIRCUIT_KEYS.openUntil, until);
    writeAudit(db, 'embedding_circuit_open', null, { failures, cooldown_ms: cooldownMs, open_until: until });
  }
}

export function recordEmbedSuccess(db) {
  const wasOpen = readConfigKv(CIRCUIT_KEYS.openUntil);
  clearConfigKv(db, CIRCUIT_KEYS.failures);
  clearConfigKv(db, CIRCUIT_KEYS.openUntil);
  clearConfigKv(db, CIRCUIT_KEYS.lastProbe);
  if (wasOpen != null) {
    writeAudit(db, 'embedding_circuit_close', null, { reason: 'probe_success' });
  }
}
```

```javascript
// scripts/lib/retrieval.mjs
const { provider, circuit } = getProviderWithCircuit(db, config);
...
if (!useEmbedding) {
  const lexical = lexicalRetrieve(...);
  return {
    rows: lexical.rows,
    queryVec: null,
    cosineContribution: null,
    timing: lexical.timing,
    retrievalPath: circuit === 'open' ? 'B-circuit' : 'B-off'
  };
}
```

```javascript
// scripts/cli.mjs help additions
'  admin retrieval-check [--corpus <path>] [--k 1,3,5]\n' +
'  admin embedding-circuit <open|close|status>\n' +
'  admin diagnose [--retrieval|--migrations|--key|--sessions|--security|--tuning|--metrics|--synthesis|--restart-history|--injections|--context-history] ...\n'
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `/usr/local/bin/node --test tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs`

Expected: PASS with `B-circuit`, kv-aware diagnose, and circuit audit behavior green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/embedding/provider.mjs scripts/lib/retrieval.mjs scripts/lib/admin/diagnose.mjs scripts/cli.mjs commands/admin.md tests/integration/prompt-submit-retrieval.test.mjs tests/integration/admin-diagnose-command.test.mjs
git commit -m "feat: harden embedding retrieval with circuit breaker"
```

### Task 4: Add offline retrieval benchmark and expose it on admin CLI/slash surface

**Files:**
- Create: `scripts/lib/admin/retrieval-check.mjs`
- Create: `scripts/lib/benchmark/corpus.json`
- Modify: `scripts/cli.mjs`
- Modify: `commands/admin.md`
- Test: `tests/integration/admin-diagnose-command.test.mjs`

**Interfaces:**
- Consumes:
  - `retrieveMemories(db, prompt, projectKey, config)`
  - `writeAudit(db, action, memId, details)`
  - current admin CLI dispatch in `scripts/cli.mjs`
- Produces:
  - `cmdRetrievalCheck(db, { corpus, k })`
  - audit action `retrieval_check_run` with details `{ total, recall_at_3, run_at }`
  - CLI/slash admin help for `retrieval-check`

- [ ] **Step 1: Write the failing benchmark tests**

```javascript
// tests/integration/admin-diagnose-command.test.mjs

test('cli admin retrieval-check prints recall/precision and writes retrieval_check_run audit', async () => {
  const corpusPath = new URL('../../scripts/lib/benchmark/corpus.json', import.meta.url);
  const { stdout } = runCli(['admin', 'retrieval-check', '--corpus', corpusPath.pathname, '--k', '1,3']);

  assert.match(stdout, /recall@1:/);
  assert.match(stdout, /precision@3:/);
  const audit = openDb().prepare(`SELECT action, details FROM audit_log WHERE action='retrieval_check_run' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(audit.action, 'retrieval_check_run');
});
```

- [ ] **Step 2: Run the benchmark test to verify it fails**

Run: `/usr/local/bin/node --test tests/integration/admin-diagnose-command.test.mjs`

Expected: FAIL because `admin retrieval-check` is not parsed and the corpus file does not exist.

- [ ] **Step 3: Write the minimal benchmark implementation**

```javascript
// scripts/lib/admin/retrieval-check.mjs
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { writeAudit } from '../audit.mjs';
import { retrieveMemories } from '../retrieval.mjs';

export async function cmdRetrievalCheck(db, { corpus, k }) {
  const corpusPath = corpus ?? new URL('../benchmark/corpus.json', import.meta.url).pathname;
  const items = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const ks = String(k ?? '1,3,5').split(',').map((value) => Number(value));
  const base = loadConfig();
  const offlineConfig = { ...base, embedding: { ...base.embedding, enabled: false } };
  const projectKey = resolveProjectKey(process.cwd());
  const results = [];

  for (const item of items) {
    const { rows } = await retrieveMemories(db, item.prompt, projectKey, offlineConfig);
    const expected = new Set(item.expected_ids ?? []);
    const firstHit = rows.findIndex((row) => expected.has(row.id));
    results.push({ expectedSize: expected.size, firstHit: firstHit >= 0 ? firstHit + 1 : null });
  }

  for (const K of ks) {
    const hitCount = results.filter((row) => row.firstHit && row.firstHit <= K).length;
    const recall = results.length ? hitCount / results.length : 0;
    const precision = results.length ? hitCount / (K * results.length) : 0;
    process.stdout.write(`recall@${K}: ${(recall * 100).toFixed(1)}%\n`);
    process.stdout.write(`precision@${K}: ${(precision * 100).toFixed(1)}%\n`);
  }

  writeAudit(db, 'retrieval_check_run', null, {
    total: items.length,
    recall_at_3: ks.includes(3) ? Number((results.filter((row) => row.firstHit && row.firstHit <= 3).length / results.length).toFixed(4)) : null,
    run_at: Date.now()
  });
}
```

```json
// scripts/lib/benchmark/corpus.json
[
  { "prompt": "pnpm workspace install command", "expected_ids": [1], "note": "workspace tooling" },
  { "prompt": "how do we handle auth retry failures", "expected_ids": [2], "note": "semantic-ish" },
  { "prompt": "totally unrelated adversarial query", "expected_ids": [], "note": "adversarial miss" }
]
```

- [ ] **Step 4: Run the benchmark test to verify it passes**

Run: `/usr/local/bin/node --test tests/integration/admin-diagnose-command.test.mjs`

Expected: PASS with recall/precision output and `retrieval_check_run` audit assertions green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/admin/retrieval-check.mjs scripts/lib/benchmark/corpus.json scripts/cli.mjs commands/admin.md tests/integration/admin-diagnose-command.test.mjs
git commit -m "feat: add retrieval benchmark tooling"
```

### Task 5: Extend the existing write path for `summary_meta` and `temporal_type`

**Files:**
- Modify: `scripts/lib/cmd/save.mjs`
- Modify: `scripts/lib/llm-parse.mjs`
- Modify: `scripts/daemon/tasks/summarize-pending.mjs`
- Modify: `scripts/daemon/tasks/weekly-synthesis.mjs`
- Modify: `scripts/lib/llm-prompts/weekly-synthesis-v2.mjs`
- Test: `tests/integration/admin-diagnose-command.test.mjs`
- Test: `tests/integration/daemon-loop.test.mjs`
- Test: `tests/unit/llm-parse.test.mjs`

**Interfaces:**
- Consumes:
  - `insertMemory(db, options)` from `scripts/lib/cmd/save.mjs`
  - `parseLlmJson(raw, options)` and `parseRawLlmOutput(raw)` from `scripts/lib/llm-parse.mjs`
- Produces:
  - `insertMemory(..., { summaryMeta = null, temporalType = null })`
  - parsed summarize items preserve `investigated`, `learned`, `completed`, `next_steps`
  - weekly synthesis prompt/schema includes `temporal_type: 'permanent' | 'temporary' | 'time-bound' | null`

- [ ] **Step 1: Write the failing parser and write-path tests**

```javascript
// tests/unit/llm-parse.test.mjs

test('parseLlmJson preserves structured summary fields', () => {
  const raw = JSON.stringify({
    synthesized: [{
      content: 'Investigated auth retries and closed the timeout gap',
      type: 'episode',
      scope: 'project',
      tags: ['auth'],
      investigated: 'auth retry timeout',
      learned: 'openai timeout must be bounded',
      completed: 'bounded retry path',
      next_steps: 'dogfood with live endpoint'
    }]
  });

  const [item] = parseLlmJson(raw, { skipTruncate: true });
  assert.equal(item.investigated, 'auth retry timeout');
  assert.equal(item.next_steps, 'dogfood with live endpoint');
});
```

```javascript
// tests/integration/admin-diagnose-command.test.mjs

test('summarize-pending writes summary_meta into memories', async () => {
  const db = openDb();
  await runSummarizePending(db, {
    id: 1,
    payload: JSON.stringify({
      session_id: 'sess-summary-meta',
      transcript_path: transcriptPath,
      last_message_seq: 1,
      llm_output: JSON.stringify({
        synthesized: [{
          content: 'Investigated auth retries and closed the timeout gap',
          type: 'episode',
          scope: 'project',
          tags: ['auth'],
          investigated: 'auth retry timeout',
          learned: 'openai timeout must be bounded',
          completed: 'bounded retry path',
          next_steps: 'dogfood with live endpoint'
        }]
      })
    })
  });

  const row = db.prepare(`SELECT summary_meta FROM memories WHERE summary_meta IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
  const meta = JSON.parse(row.summary_meta);
  assert.equal(meta.learned, 'openai timeout must be bounded');
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `/usr/local/bin/node --test tests/unit/llm-parse.test.mjs tests/integration/admin-diagnose-command.test.mjs tests/integration/daemon-loop.test.mjs`

Expected: FAIL because `parseLlmJson()` drops the four fields and `insertMemory()` has no `summary_meta`/`temporal_type` columns.

- [ ] **Step 3: Write the minimal summary/temporal implementation**

```javascript
// scripts/lib/llm-parse.mjs
return normalized
  .map((item) => ({
    content: skipTruncate ? String(item?.content ?? '') : String(item?.content ?? '').slice(0, maxContentChars),
    type: ['rule', 'fact', 'episode'].includes(item?.type) ? item.type : 'fact',
    scope: item?.scope === 'global' ? 'global' : 'project',
    tags: Array.isArray(item?.tags) ? item.tags.slice(0, 10).map((tag) => String(tag)) : [],
    investigated: item?.investigated == null ? undefined : String(item.investigated).slice(0, 200),
    learned: item?.learned == null ? undefined : String(item.learned).slice(0, 200),
    completed: item?.completed == null ? undefined : String(item.completed).slice(0, 200),
    next_steps: item?.next_steps == null ? undefined : String(item.next_steps).slice(0, 200),
    temporal_type: ['permanent', 'temporary', 'time-bound'].includes(item?.temporal_type) ? item.temporal_type : null,
    source_ids: Array.isArray(item?.source_ids) ? item.source_ids.filter(Number.isInteger) : [],
    output_type: ['rule', 'consolidated'].includes(item?.output_type) ? item.output_type : 'consolidated'
  }))
```

```javascript
// scripts/lib/cmd/save.mjs
export async function insertMemory(db, {
  cwd,
  content,
  scope = 'project',
  type = null,
  source = 'user_explicit',
  projectKey = null,
  pinned = 0,
  tags = [],
  embedSync = true,
  trust = null,
  consolidationDepth = null,
  parentIds = null,
  lastTouchedAt = null,
  status = 'active',
  decayStatus = null,
  quarantinedAt = null,
  embeddingBlob = undefined,
  summaryMeta = null,
  temporalType = null
}) {
  ...
  const result = db.prepare(`
    INSERT INTO memories (
      scope, project_key, type, content, embedding, pinned, source, trust_score,
      consolidation_depth, parent_ids, status, tags, decay_status, quarantined_at,
      temporal_type, summary_meta, last_touched_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resolvedScope,
    resolvedProjectKey,
    resolvedType,
    content,
    embedding,
    Number(pinned) ? 1 : 0,
    source,
    trustScore,
    resolvedDepth,
    resolvedParentIds,
    status,
    JSON.stringify(resolvedTags),
    resolvedDecayStatus,
    resolvedQuarantinedAt,
    ['permanent', 'temporary', 'time-bound'].includes(temporalType) ? temporalType : null,
    summaryMeta == null ? null : JSON.stringify(summaryMeta),
    touchedAt,
    now,
    now
  );
}
```

```javascript
// scripts/daemon/tasks/summarize-pending.mjs
function buildSummaryMeta(item) {
  if (!item.investigated && !item.learned && !item.completed && !item.next_steps) return null;
  return {
    investigated: item.investigated ?? null,
    learned: item.learned ?? null,
    completed: item.completed ?? null,
    next_steps: item.next_steps ?? null
  };
}
...
const inserted = await insertMemory(db, {
  cwd: process.cwd(),
  content: item.content,
  scope,
  type: item.type,
  source: 'auto_inferred',
  projectKey,
  tags: uniqueTags(item.tags),
  embedSync: false,
  embeddingBlob,
  summaryMeta: buildSummaryMeta(item)
});
```

```javascript
// scripts/daemon/tasks/weekly-synthesis.mjs
const inserted = await insertMemory(db, {
  cwd: process.cwd(),
  content: syn.content,
  scope,
  type: syn.output_type,
  source: 'cron_consolidated',
  projectKey: scope === 'global' ? null : scope,
  consolidationDepth: 1,
  parentIds: syn.source_ids,
  embedSync: false,
  embeddingBlob,
  temporalType: syn.temporal_type ?? null
});
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `/usr/local/bin/node --test tests/unit/llm-parse.test.mjs tests/integration/admin-diagnose-command.test.mjs tests/integration/daemon-loop.test.mjs`

Expected: PASS with preserved summary fields, persisted `summary_meta`, and temporal passthrough assertions green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/cmd/save.mjs scripts/lib/llm-parse.mjs scripts/daemon/tasks/summarize-pending.mjs scripts/daemon/tasks/weekly-synthesis.mjs scripts/lib/llm-prompts/weekly-synthesis-v2.mjs tests/unit/llm-parse.test.mjs tests/integration/admin-diagnose-command.test.mjs tests/integration/daemon-loop.test.mjs
git commit -m "feat: persist v0.12 summary and temporal metadata"
```

### Task 6: Wire temporal ranking and query embedding cache into retrieval + maintenance

**Files:**
- Modify: `scripts/lib/priority.mjs`
- Modify: `scripts/lib/injection-cache.mjs`
- Modify: `scripts/lib/retrieval.mjs`
- Modify: `scripts/daemon/tasks/daily-maintenance.mjs`
- Test: `tests/unit/priority.test.mjs`
- Test: `tests/integration/prompt-submit-retrieval.test.mjs`
- Test: `tests/integration/daemon-loop.test.mjs`

**Interfaces:**
- Consumes:
  - `computePriority(mem)` in `scripts/lib/priority.mjs`
  - current candidate ranking in `scripts/lib/injection-cache.mjs`
  - retrieval embedding path in `scripts/lib/retrieval.mjs`
  - `runDailyMaintenance(db, task)`
- Produces:
  - `effectiveHalfLifeDays(mem)` inside `priority.mjs`
  - injection-cache rows include `temporal_type`
  - query cache helpers keyed by `prompt_hash` and `model`
  - daily maintenance deletes query cache rows older than 30 days

- [ ] **Step 1: Write the failing ranking/cache tests**

```javascript
// tests/unit/priority.test.mjs

test('permanent temporal_type does not decay', () => {
  const score = computePriority({
    type: 'consolidated',
    trust_score: 0.9,
    helpful_count: 0,
    unhelpful_count: 0,
    half_life_days: 7,
    temporal_type: 'permanent',
    last_touched_at: Date.now() - (200 * 86400000),
    consolidation_depth: 0,
    pinned: 0
  });

  assert.ok(score > 0.5, `expected non-decayed priority, got ${score}`);
});
```

```javascript
// tests/integration/prompt-submit-retrieval.test.mjs

test('query embedding cache hit does not close an open circuit and increments hit_count', async () => {
  const db = openDb();
  db.prepare(`INSERT INTO query_embedding_cache(prompt_hash, embedding, model, prompt_len, created_at, hit_count) VALUES (?, ?, ?, ?, ?, 1)`).run('abc123', existingVecBlob, 'openai:text-embedding-3-small', 22, Date.now());
  db.prepare(`INSERT INTO config_kv(key, value) VALUES ('embedding.circuit_open_until', ?)`)
    .run(String(Date.now() + 60_000));

  await retrieveMemories(db, 'cached prompt content', resolveProjectKey(process.cwd()), loadConfig());

  assert.equal(db.prepare(`SELECT value FROM config_kv WHERE key='embedding.circuit_open_until'`).get().value.length > 0, true);
  assert.equal(db.prepare(`SELECT hit_count FROM query_embedding_cache WHERE prompt_hash='abc123'`).get().hit_count, 2);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `/usr/local/bin/node --test tests/unit/priority.test.mjs tests/integration/prompt-submit-retrieval.test.mjs tests/integration/daemon-loop.test.mjs`

Expected: FAIL because `temporal_type` is not selected into ranking and query cache is not used or cleaned.

- [ ] **Step 3: Write the minimal ranking/cache implementation**

```javascript
// scripts/lib/priority.mjs
function effectiveHalfLifeDays(mem) {
  if (mem.temporal_type === 'permanent') return Infinity;
  return mem.half_life_days;
}

export function computePriority(mem) {
  const days = Math.max(0, (Date.now() - Number(mem.last_touched_at ?? Date.now())) / 86400000);
  const recency = recencyFactor(days, effectiveHalfLifeDays(mem));
  ...
}
```

```javascript
// scripts/lib/injection-cache.mjs (select columns)
const SELECT_COLS = `
  id, scope, project_key, type, content, pinned, trust_score,
  helpful_count, unhelpful_count, half_life_days, temporal_type,
  consolidation_depth, last_touched_at
`;
```

```javascript
// scripts/lib/retrieval.mjs
import { createHash } from 'node:crypto';
import { blobToVec, cosineSimilarity, vecToBlob } from './embedding/cosine.mjs';

function currentModelId(config) {
  const provider = config?.embedding?.provider ?? 'transformers-local';
  const model = config?.embedding?.model ?? 'default';
  return `${provider}:${model}`;
}

function promptHash(promptText) {
  return createHash('sha256').update(promptText).digest('hex').slice(0, 16);
}

...
const hash = promptHash(promptText);
const cached = db.prepare(`SELECT embedding, model FROM query_embedding_cache WHERE prompt_hash = ?`).get(hash);
if (cached && cached.model === currentModelId(config)) {
  queryVec = blobToVec(cached.embedding);
  db.prepare(`UPDATE query_embedding_cache SET hit_count = hit_count + 1 WHERE prompt_hash = ?`).run(hash);
} else {
  [queryVec] = await provider.embed([promptText], config);
  recordEmbedSuccess(db);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash, vecToBlob(queryVec), currentModelId(config), promptText.length, Date.now());
  } catch {}
}
```

```javascript
// scripts/daemon/tasks/daily-maintenance.mjs
const queryCacheCutoff = now - (30 * 86400000);
db.prepare(`DELETE FROM query_embedding_cache WHERE created_at < ?`).run(queryCacheCutoff);
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `/usr/local/bin/node --test tests/unit/priority.test.mjs tests/integration/prompt-submit-retrieval.test.mjs tests/integration/daemon-loop.test.mjs`

Expected: PASS with permanent-memory ranking, cache hit counting, and cache cleanup assertions green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/priority.mjs scripts/lib/injection-cache.mjs scripts/lib/retrieval.mjs scripts/daemon/tasks/daily-maintenance.mjs tests/unit/priority.test.mjs tests/integration/prompt-submit-retrieval.test.mjs tests/integration/daemon-loop.test.mjs
git commit -m "feat: add temporal ranking and query cache"
```

### Task 7: Sync v0.12 docs and write the final closure review

**Files:**
- Modify: `docs/ccmem-v0.12-spec.md`
- Modify: `docs/ccmem-v0.12-dogfood.md`
- Modify: `.wolf/anatomy.md`
- Modify: `.wolf/memory.md`
- Modify: `.wolf/buglog.json`

**Interfaces:**
- Consumes: shipped code and tests from Tasks 1-6
- Produces:
  - docs matching schema 15 and the dogfood-corrected end state
  - closure review table: `implemented`, `deferred`, `needs real infra dogfood`

- [ ] **Step 1: Write the failing review checklist in the docs first**

```markdown
## Closure checklist

- [ ] Spec text matches shipped schema version and migration set
- [ ] Dogfood text distinguishes fixed items from deferred items
- [ ] Manual real-infra checks remain explicitly marked
- [ ] No section still describes `memory-write.mjs` as a shipped file if the implementation stayed on `cmd/save.mjs`
- [ ] Admin command surface matches `scripts/cli.mjs` + `commands/admin.md`
```

- [ ] **Step 2: Run the manual doc review to verify gaps still exist**

Run: `grep -n "memory-write.mjs\|schema 14\|B-circuit\|retrieval-check\|summary_meta" docs/ccmem-v0.12-spec.md docs/ccmem-v0.12-dogfood.md`

Expected: mixed/old references still present before the edits are applied.

- [ ] **Step 3: Update the docs to the shipped end state**

```markdown
## Required edits

- In `docs/ccmem-v0.12-spec.md`, rewrite version/migration sections so the shipped end state is schema 15 (`014_v012.sql` + `015_v012_repair.cjs`) rather than an idealized schema-14-only world.
- In `docs/ccmem-v0.12-spec.md`, update write-path references to the current `scripts/lib/cmd/save.mjs` surface unless a later implementation extracted and shipped a shared helper.
- In `docs/ccmem-v0.12-spec.md`, ensure retrieval observability and benchmark command text matches the actual admin CLI/slash surface.
- In `docs/ccmem-v0.12-dogfood.md`, mark which P0/P1 items were fixed in this implementation and which P2/deferred items remain out of scope.
- In `docs/ccmem-v0.12-dogfood.md`, keep real-infra-only validation items explicitly blocked rather than implying local tests covered them.
```

- [ ] **Step 4: Run the final verification commands**

Run:

```bash
/usr/local/bin/node --test tests/unit/*.test.mjs tests/integration/*.test.mjs
```

Expected: PASS for the full suite.

Run:

```bash
grep -n "schema 15\|015_v012_repair\|B-circuit\|retrieval-check\|summary_meta" docs/ccmem-v0.12-spec.md docs/ccmem-v0.12-dogfood.md
```

Expected: doc references align with the shipped implementation.

- [ ] **Step 5: Commit**

```bash
git add docs/ccmem-v0.12-spec.md docs/ccmem-v0.12-dogfood.md .wolf/anatomy.md .wolf/memory.md .wolf/buglog.json
git commit -m "docs: close v0.12 finalization loop"
```

---

## Spec Coverage Self-Review

- **Schema / repair:** Task 1 covers formal 014, corrective 015, and synchronous loader support.
- **P1.2 observability:** Task 2 covers retrieval four-state telemetry, prompt-submit metrics, rollup aggregation, and diagnose consumers.
- **P1.1 circuit breaker:** Task 3 covers kv-backed open/half-open/close behavior, audit, and retrieval diagnose/control.
- **P1.3 benchmark:** Task 4 covers offline benchmark command, corpus, audit, and CLI/slash exposure.
- **P2.2 structured summary:** Task 5 covers parser preservation, summarize prompt/path, `insertMemory()` write path, and DB persistence.
- **P2.1 temporal tag:** Tasks 5 and 6 cover weekly synthesis emission plus ranking consumption.
- **P2.3 query cache:** Task 6 covers cache read/write/model keying and daily cleanup.
- **Docs / review closure:** Task 7 covers spec/dogfood sync and final validation.

## Placeholder Scan Self-Review

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every task has explicit files, interfaces, code snippets, commands, expected outcomes, and a commit step.
- The only conditional wording is the design-approved guard for extracting a shared write helper later; the plan still names the current implementation surface explicitly.

## Type Consistency Self-Review

- `retrieveMemories()` consistently returns `{ rows, queryVec, cosineContribution, timing, retrievalPath }` after Task 2.
- `insertMemory()` consistently gains `summaryMeta` and `temporalType` in Task 5; later tasks refer to those exact option names.
- Admin surface naming is consistent: `cmdRetrievalCheck`, `cmdAdminDiagnose`, and `embedding-circuit` CLI/slash exposure.

---
