import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-savetmp-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

/**
 * Give memories.temporal_type the DEFAULT 'temporary' that the LIVE database
 * carries and a freshly migrated test database does not.
 *
 * This is what the previous version of this file was missing. On a schema with
 * no stray DEFAULT, omitting the column from save.mjs's INSERT also yields
 * NULL, so the test stayed green through exactly the regression it existed to
 * catch — removing temporal_type from save.mjs's column list did not redden it.
 * The only real guard left was a readFileSync + assert.match on the source,
 * plus a companion test asserting SQLite's own DEFAULT semantics against a
 * throwaway table no line under scripts/ participates in. Both are replaced by
 * the behavioural test below.
 *
 * PRAGMA writable_schema is the only way to attach a DEFAULT to an existing
 * column in SQLite (there is no ALTER COLUMN); bumping schema_version forces
 * connections to reparse.
 */
function giveTemporalTypeALiveDefault() {
  const db = openDb();
  const original = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'`
  ).get().sql;
  const patched = original.replace(/temporal_type\s+TEXT/, "temporal_type TEXT DEFAULT 'temporary'");
  assert.notEqual(patched, original, 'fixture sanity: the temporal_type column definition must have been rewritten');

  const version = db.prepare('PRAGMA schema_version').get().schema_version;
  db.exec('PRAGMA writable_schema=ON');
  db.prepare(`UPDATE sqlite_master SET sql = ? WHERE type='table' AND name='memories'`).run(patched);
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec('PRAGMA writable_schema=OFF');
  db.close();
}

giveTemporalTypeALiveDefault();

test('cmdSave writes NULL temporal_type even when the column carries the live DEFAULT', async () => {
  const db = openDb();

  // Control: a writer that does NOT name the column gets 'temporary' on this
  // schema. That is the field bug — a memory silently tagged temporary becomes
  // eligible for fast expiry it was never meant to be subject to — and it is
  // what makes the assertion below meaningful rather than vacuous.
  db.exec(
    `INSERT INTO memories (scope, type, content, source, created_at, updated_at, last_touched_at)
     VALUES ('global', 'fact', 'control row written without naming temporal_type', 'auto_inferred', 1, 1, 1)`
  );
  assert.equal(
    db.prepare(`SELECT temporal_type FROM memories ORDER BY id DESC LIMIT 1`).get().temporal_type,
    'temporary',
    'fixture sanity: on this schema, omitting the column lets the DEFAULT win'
  );

  await cmdSave(db, { cwd: process.cwd(), content: 'this project standardises on pnpm for dependency management' });

  const row = db.prepare(
    `SELECT temporal_type, summary_meta FROM memories ORDER BY id DESC LIMIT 1`
  ).get();
  assert.equal(row.temporal_type, null,
    'NULL means untagged; only synthesis may tag. save.mjs must name the column explicitly to defeat the DEFAULT');
  assert.equal(row.summary_meta, null,
    'same reasoning: an unnamed column is at the mercy of whatever DEFAULT the live schema grew');
});
