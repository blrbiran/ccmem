import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Issue 415: the FTS availability probe used to CREATE/DROP a virtual table in the main database on
// every short process (hook, CLI call). It must be answered without touching the main DB's schema.
// The probe runs through a second, cache-cold copy of the module so this measures the probe itself.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-fts-probe-'));

const { openDb, getDbPath } = await import('../../scripts/lib/db.mjs');
const cold = await import('../../scripts/lib/db.mjs?cold=1');

test('the FTS probe leaves the main database schema untouched', () => {
  openDb().close();
  const raw = new DatabaseSync(getDbPath());
  const before = raw.prepare('PRAGMA schema_version').get().schema_version;
  assert.equal(cold.hasUsableFts(raw), true);
  const after = raw.prepare('PRAGMA schema_version').get().schema_version;
  assert.equal(after, before);
  assert.equal(Boolean(raw.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'ccmem_fts_probe' LIMIT 1").get()), false);
  assert.equal(Boolean(raw.prepare("SELECT 1 FROM temp.sqlite_master WHERE name = 'ccmem_fts_probe' LIMIT 1").get()), false);
  raw.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));