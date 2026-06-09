import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-db-'));

const { createMigrationBackup, listMigrationBackups, openDb, getDbPath, getSchemaVersion } = await import('../../scripts/lib/db.mjs');
const { getMode, setMode } = await import('../../scripts/lib/mode.mjs');

test('openDb creates DB file and applies the latest schema', () => {
  const db = openDb();
  assert.equal(existsSync(getDbPath()), true);
  assert.equal(getSchemaVersion(db), 6);
  db.close();
});

test('createMigrationBackup reuses a same-size backup created within the dedupe window', () => {
  const db = openDb();
  db.close();

  const first = createMigrationBackup();
  const second = createMigrationBackup();

  assert.equal(typeof first, 'string');
  assert.equal(second, first);
  assert.equal(listMigrationBackups().length, 1);
});

test('mode defaults to active and can be updated', () => {
  const db = openDb();
  assert.equal(getMode(db), 'active');
  setMode(db, 'shadow');
  assert.equal(getMode(db), 'shadow');
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
