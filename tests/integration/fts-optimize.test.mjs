import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const { optimizeFts } = await import('../../scripts/lib/db.mjs');

function bytes(db) {
  return Number(db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name LIKE 'memories_fts%'").get().n);
}

test('optimize compacts a churned FTS index and reports the size change', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT)");
    db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='trigram')");
    const insert = db.prepare('INSERT INTO memories(content) VALUES (?)');
    for (let i = 0; i < 3000; i += 1) insert.run(`memory row ${i} with some repeated words alpha beta gamma`);
    db.exec('INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories');
    db.exec('DELETE FROM memories_fts WHERE rowid > 500');
    const before = bytes(db);

    const result = optimizeFts(db);

    assert.equal(result.optimized, true);
    assert.ok(result.bytesBefore >= before);
    assert.ok(result.bytesAfter < result.bytesBefore, `expected the index to shrink (${result.bytesBefore} → ${result.bytesAfter})`);
  } finally {
    db.close();
  }
});

test('optimize is a no-op when the store has no FTS table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const result = optimizeFts(db);
    assert.deepEqual(result, { optimized: false, bytesBefore: 0, bytesAfter: 0 });
  } finally {
    db.close();
  }
});