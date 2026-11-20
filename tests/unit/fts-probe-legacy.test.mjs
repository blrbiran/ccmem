import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Issue 415, second half: an older build could be killed between CREATE and DROP of the probe table,
// leaving `ccmem_fts_probe` in the main database. The probe still owns that cleanup -- in its own
// process so the support cache is cold and the probe path really runs.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-fts-probe-legacy-'));

const { openDb, hasUsableFts } = await import('../../scripts/lib/db.mjs');

test('a probe table a crash left in the main database is removed', () => {
  const db = openDb();
  db.exec("CREATE VIRTUAL TABLE ccmem_fts_probe USING fts5(content, tokenize='trigram')");
  assert.equal(hasUsableFts(db), true);
  assert.equal(Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'ccmem_fts_probe' LIMIT 1").get()), false);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));