import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.CCMEM_TEST_MODE = '1';
const roots = [];
const initialDataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-v2-'));
roots.push(initialDataRoot);
process.env.CCMEM_DATA_ROOT = initialDataRoot;

const { openDb, getDbPath, getSchemaVersion } = await import('../../scripts/lib/db.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function createDataRoot(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test.afterEach(() => {
  process.env.CCMEM_DATA_ROOT = initialDataRoot;
});

test('migration upgrades schema to latest version', () => {
  const db = openDb();
  assert.equal(getSchemaVersion(db), 15);
  assert.ok(columns(db, 'memories').includes('temporal_type'));
  assert.ok(columns(db, 'memories').includes('summary_meta'));
  assert.ok(columns(db, 'metrics_daily_rollup').includes('embed_error_rate'));
  const cache = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_embedding_cache'").get();
  assert.ok(cache);
  db.close();
});

test('partial schema-14 database is repaired to schema 15', () => {
  process.env.CCMEM_DATA_ROOT = createDataRoot('ccmem-v012-repair-');

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
    INSERT INTO memories(scope, project_key, type, content, temporal_type, created_at, updated_at, last_touched_at, status, decay_status)
    VALUES ('project', 'demo', 'fact', 'temporary tag should be cleared', 'temporary', 0, 0, 0, 'active', 'active');
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE temporal_type = 'temporary'").get().n, 0);
  db.close();

  db = openDb();
  assert.equal(getSchemaVersion(db), 15);
  assert.ok(columns(db, 'metrics_daily_rollup').includes('path_b_circuit_count'));
  db.close();
});

test('stop hook writes session_context, summarize task, and wake file', async () => {
  process.env.CCMEM_DATA_ROOT = createDataRoot('ccmem-v2-stop-');
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  const db = openDb();
  await handleStop(db, { session_id: 's1', transcript_path: transcript, cwd: process.cwd() });
  const task = db.prepare("SELECT type FROM tasks WHERE type='summarize_pending'").get();
  const ctx = db.prepare("SELECT session_id FROM session_context WHERE session_id='s1'").get();
  assert.equal(task.type, 'summarize_pending');
  assert.equal(ctx.session_id, 's1');
  assert.equal(existsSync(path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake')), true);
  db.close();
});

test.after(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});
