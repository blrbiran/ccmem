import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Issue 414: an FTS5 query built from a prompt with operators ("C++", "foo -bar", "a:b", "x^2")
// used to be handed to MATCH as-is, and SQLite answered "fts5: syntax error". These criteria pin
// the compiled query's shape and the end-to-end path that used to exit 1.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-fts-syntax-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdList } = await import('../../scripts/lib/cmd/list.mjs');
const { retrieveMemories, sanitizeFtsQuery, ftsTokens } = await import('../../scripts/lib/retrieval.mjs');

const LEXICAL_ONLY = { embedding: { enabled: false }, inject: { max_per_prompt: 6 } };

test('sanitizeFtsQuery compiles operator characters into quoted literals', () => {
  assert.equal(sanitizeFtsQuery('C++'), '"c++"');
  assert.equal(sanitizeFtsQuery('foo -bar'), '"foo" "-bar"');
  assert.equal(sanitizeFtsQuery('a:b c^d'), '"a:b" "c^d"');
  assert.equal(sanitizeFtsQuery('say "hi"'), '"say" "hi"');
  // Nothing safe survives: the query is empty, not invalid.
  assert.equal(sanitizeFtsQuery('"'), '');
  assert.equal(sanitizeFtsQuery('++ --'), '');
});

test('ftsTokens drops the quoting so substring callers keep whole tokens', () => {
  assert.deepEqual(ftsTokens('C++ and foo -bar'), ['c++', 'and', 'foo', '-bar']);
});

test('a prompt with FTS operators retrieves instead of throwing', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'C++ headers are banned in this repository; use plain C.', scope: 'global' });
  await cmdSave(db, { cwd: process.cwd(), content: 'Pass foo -bar to the linter when you need warnings.', scope: 'global' });

  const cpp = await retrieveMemories(db, 'C++', 'proj', LEXICAL_ONLY);
  assert.equal(cpp.rows.length, 1);
  assert.match(cpp.rows[0].content, /C\+\+/);

  const flags = await retrieveMemories(db, 'foo -bar', 'proj', LEXICAL_ONLY);
  assert.ok(flags.rows.some((row) => row.content.includes('foo -bar')));

  // The list command takes the same path; it must not throw on either prompt.
  const listed = await cmdList(db, { query: 'C++', limit: 5, cwd: process.cwd() });
  assert.equal(listed.length, 1);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));