import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-w2-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { ftsSearch, likeSearch, legacySubstringSearch } = await import('../../scripts/lib/retrieval.mjs');

// eval.disable_scope_isolation lets the eval harness build a true control
// group: with the switch on, retrieval must cross project boundaries; with
// it off (the default), it must not. seed() plants one memory per scope
// (own project, other project, global), all sharing the word "zebrafish" so
// every lane — FTS, LIKE, and the legacy substring fallback — can match all
// three rows if isolation is not applied.
//
// `memories.id` is an autoincrement INTEGER PK, not a label, so seed()
// returns a db plus a rowid -> label map; tests translate returned rows
// back to labels before asserting, keeping the assertions readable as
// 'own' / 'other' / 'glob' per the brief.
function seed() {
  const db = openDb();
  // openDb() opens the on-disk db file at CCMEM_DATA_ROOT; it is not a fresh
  // in-memory db per call. Without this, rows from an earlier test in this
  // file would still be present and inflate later assertions' result sets.
  db.exec('DELETE FROM memories');
  const now = Date.now();
  const rows = [
    ['own', 'project', 'proj-a'],
    ['other', 'project', 'proj-b'],
    ['glob', 'global', null]
  ];

  const labelById = new Map();
  for (const [label, scope, projectKey] of rows) {
    const result = db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES (?, ?, 'fact', ?, 'auto_inferred', 0.5, 'active', 'active', ?, ?, ?)`
    ).run(scope, projectKey, `a note about zebrafish for ${label}`, now, now, now);
    labelById.set(Number(result.lastInsertRowid), label);
  }

  return { db, labelById };
}

// WHY: 这三条 lane 各自独立地拼 SQL，历史上 review 已经在其中一条上抓到过
// "改完了但不起作用"。逐条直调 helper，是为了让某一条漏改时，红的是那一条，
// 而不是被另外两条的绿色盖过去。
for (const [name, call] of [
  ['ftsSearch', (db, off) => ftsSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['likeSearch', (db, off) => likeSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['legacySubstringSearch', (db, off) => legacySubstringSearch(db, 'zebrafish', 'proj-a', 50, off)]
]) {
  test(`${name} isolates by project when the switch is off`, () => {
    const { db, labelById } = seed();
    try {
      const labels = call(db, false).map((r) => labelById.get(Number(r.id))).sort();
      assert.deepEqual(labels, ['glob', 'own']);
    } finally {
      db.close();
    }
  });

  test(`${name} crosses projects when the switch is on`, () => {
    const { db, labelById } = seed();
    try {
      const labels = call(db, true).map((r) => labelById.get(Number(r.id))).sort();
      assert.deepEqual(labels, ['glob', 'other', 'own']);
    } finally {
      db.close();
    }
  });
}
