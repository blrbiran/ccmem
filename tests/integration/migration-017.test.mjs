import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-mig017-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb, getSchemaVersion } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const cols = (db, table) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot }
  });
}

test('migration 017 brings a fresh root to 17 with the new columns and tables', () => {
  const db = openDb();
  assert.equal(getSchemaVersion(db), 17);
  assert.ok(cols(db, 'memories').includes('origin_agent'));
  assert.ok(cols(db, 'session_context').includes('agent'));
  assert.deepEqual(cols(db, 'llm_backend_state'), ['backend', 'exhausted_until', 'last_error', 'updated_at']);
  assert.deepEqual(cols(db, 'llm_switch_proposals'),
    ['id', 'from_backend', 'to_backend', 'reason', 'created_at', 'approved_at', 'superseded_at']);
  const row = db.prepare(`SELECT description FROM schema_migrations WHERE from_version = 16 AND to_version = 17`).get();
  assert.ok(row, 'schema_migrations must contain a 16->17 row');
  db.close();
});

test('migration 017 is idempotent across reopens', () => {
  openDb().close();
  const db = openDb();
  assert.equal(getSchemaVersion(db), 17);
  const n = db.prepare(`SELECT COUNT(*) c FROM schema_migrations WHERE to_version = 17`).get().c;
  assert.equal(n, 1);
  db.close();
});

test('a v16 database is upgraded to 17 using the documented rollback as the downgrade', () => {
  const db = openDb();
  // Apply the rollback steps from the migration header to reach a real v16 shape.
  db.exec(`
    DROP TABLE llm_switch_proposals;
    DROP TABLE llm_backend_state;
    ALTER TABLE session_context DROP COLUMN agent;
    ALTER TABLE memories DROP COLUMN origin_agent;
    DELETE FROM schema_migrations WHERE to_version = 17;
    UPDATE schema_meta SET version = 16;
  `);
  assert.equal(getSchemaVersion(db), 16);
  assert.ok(!cols(db, 'memories').includes('origin_agent'));
  db.close();

  const upgraded = openDb();
  assert.equal(getSchemaVersion(upgraded), 17);
  assert.ok(cols(upgraded, 'memories').includes('origin_agent'));
  assert.ok(cols(upgraded, 'session_context').includes('agent'));
  upgraded.close();
});

test('origin_agent CHECK rejects ids outside claude-code/codex/omp', () => {
  const db = openDb();
  const bad = db.prepare(
    `INSERT INTO memories (scope, type, content, source, tags, created_at, updated_at, last_touched_at)
     VALUES ('global', 'fact', 'x', 'user_explicit', '[]', 1, 1, 1)`
  ).run().lastInsertRowid;
  assert.throws(() => db.prepare(`UPDATE memories SET origin_agent = 'gemini' WHERE id = ?`).run(bad), /CHECK/);
  db.prepare(`UPDATE memories SET origin_agent = 'omp' WHERE id = ?`).run(bad);
  db.close();
});

test('insertMemory persists originAgent and defaults to NULL', async () => {
  const db = openDb();
  const a = await insertMemory(db, { cwd: ROOT, content: 'codex wrote this fact alpha', scope: 'global', originAgent: 'codex', embedSync: false });
  const b = await insertMemory(db, { cwd: ROOT, content: 'nobody tagged this fact beta', scope: 'global', embedSync: false });
  assert.equal(db.prepare('SELECT origin_agent FROM memories WHERE id = ?').get(a.id).origin_agent, 'codex');
  assert.equal(db.prepare('SELECT origin_agent FROM memories WHERE id = ?').get(b.id).origin_agent, null);
  db.close();
});

test('ccmem show prints origin_agent for a tagged memory', async () => {
  const db = openDb();
  const m = await insertMemory(db, { cwd: ROOT, content: 'show me the codex origin gamma', scope: 'global', originAgent: 'codex', embedSync: false });
  db.close();
  const out = cli('show', String(m.id));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^origin_agent: codex$/m);
});

test('ccmem list marks codex-origin rows and leaves NULL-origin rows unchanged', async () => {
  const db = openDb();
  await insertMemory(db, { cwd: ROOT, content: 'list marker codex row delta', scope: 'global', originAgent: 'codex', embedSync: false });
  await insertMemory(db, { cwd: ROOT, content: 'list marker plain row epsilon', scope: 'global', embedSync: false });
  db.close();
  const out = cli('list', '--limit', '200');
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.split('\n');
  assert.match(lines.find((l) => l.includes('codex row delta')), / \| origin_agent=codex$/);
  assert.doesNotMatch(lines.find((l) => l.includes('plain row epsilon')), /origin_agent/);
});
