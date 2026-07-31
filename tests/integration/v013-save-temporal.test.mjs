import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-savetmp-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('the INSERT names temporal_type and summary_meta explicitly', () => {
  // A column-list assertion, not a behavioural one: on a fresh test DB the
  // column has no stray DEFAULT, so omitting it would also yield NULL and the
  // bug would hide. The live DB's DEFAULT 'temporary' is what makes the
  // explicit NULL necessary, and only the source can prove it is there.
  const src = readFileSync('scripts/lib/cmd/save.mjs', 'utf8');
  const insert = src.slice(src.indexOf('INSERT INTO memories'));
  assert.match(insert.slice(0, 400), /temporal_type/,
    'save.mjs must name temporal_type in its INSERT column list');
  assert.match(insert.slice(0, 400), /summary_meta/,
    'save.mjs must name summary_meta in its INSERT column list');
});

test('a memory saved through cmdSave has temporal_type NULL and summary_meta NULL', async () => {
  const db = openDb();

  await cmdSave(db, { cwd: process.cwd(), content: 'this project standardises on pnpm for dependency management' });

  const row = db.prepare(
    `SELECT temporal_type, summary_meta FROM memories ORDER BY id DESC LIMIT 1`
  ).get();
  assert.equal(row.temporal_type, null, 'NULL means untagged; only synthesis may tag');
  assert.equal(row.summary_meta, null);
});

test('an explicit NULL beats a column DEFAULT', () => {
  // Direct proof of the mechanism, independent of save.mjs: a table whose
  // column carries DEFAULT 'temporary' still stores NULL when NULL is named.
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS t_default_probe (
             id INTEGER PRIMARY KEY, temporal_type TEXT DEFAULT 'temporary')`);
  db.prepare(`INSERT INTO t_default_probe (id) VALUES (1)`).run();
  db.prepare(`INSERT INTO t_default_probe (id, temporal_type) VALUES (2, ?)`).run(null);

  assert.equal(db.prepare(`SELECT temporal_type FROM t_default_probe WHERE id=1`).get().temporal_type,
    'temporary', 'omitting the column lets the DEFAULT win — this is the live-DB bug');
  assert.equal(db.prepare(`SELECT temporal_type FROM t_default_probe WHERE id=2`).get().temporal_type,
    null, 'naming the column with NULL defeats the DEFAULT — this is the fix');
});
