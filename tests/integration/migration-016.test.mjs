import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-mig016-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb, getSchemaVersion } = await import('../../scripts/lib/db.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('migration 016 brings schema to 16 and adds embedding_sig', () => {
  const db = openDb();
  assert.equal(getSchemaVersion(db), 16);

  const cols = db.prepare(`SELECT name FROM pragma_table_info('memories')`)
    .all().map((r) => r.name);
  assert.ok(cols.includes('embedding_sig'), 'memories.embedding_sig must exist');
});

test('migration 016 records the 15 -> 16 transition', () => {
  const db = openDb();
  const row = db.prepare(
    `SELECT description FROM schema_migrations WHERE from_version = 15 AND to_version = 16`
  ).get();
  assert.ok(row, 'schema_migrations must contain a 15->16 row');
  assert.match(row.description, /embedding_sig/);
});

test('migration 016 is idempotent across reopens', () => {
  openDb();
  const db = openDb();
  assert.equal(getSchemaVersion(db), 16);
  const n = db.prepare(
    `SELECT COUNT(*) c FROM schema_migrations WHERE from_version = 15 AND to_version = 16`
  ).get().c;
  assert.equal(n, 1, 'the 15->16 row must not be duplicated');
});
