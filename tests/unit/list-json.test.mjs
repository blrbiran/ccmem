import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #418: one read query instead of two full exports. The JSON shape is a new contract
// (version 1), so these criteria pin both the shape and the operator-token cases (#414) that
// used to make the FTS query throw.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-list-json-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave, insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdListJson } = await import('../../scripts/lib/cmd/list.mjs');

const CLI = path.join(ROOT, 'scripts/cli.mjs');
const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot };

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

function runJson(args) {
  const out = runCli(args);
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const EXPORT_KEYS = ['content', 'created_at', 'id', 'pinned', 'project_key', 'scope', 'source', 'tags', 'trust_score', 'type', 'updated_at'];

test.before(async () => {
  const db = openDb();
  await cmdSave(db, { cwd: ROOT, content: 'text default memory', scope: 'global' });
  await cmdSave(db, { cwd: ROOT, content: 'C++ headers are banned in this repository; use plain C.', scope: 'global' });
  await cmdSave(db, { cwd: ROOT, content: 'Pass foo -bar to the linter when you need warnings.', scope: 'global' });
  await cmdSave(db, { cwd: ROOT, content: 'project scoped memory', scope: 'project' });
  // Another repository's row: never part of this cwd's read contract.
  await insertMemory(db, { cwd: ROOT, content: 'another project secret', scope: 'project', projectKey: 'other.invalid/x/y', embedSync: false });
  db.close();
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('list --json is one object with export-shaped rows and null scores', () => {
  const payload = runJson(['list', '--json']);
  assert.equal(payload.version, 1);
  assert.equal(payload.query, null);
  assert.equal(payload.scope, 'project');
  assert.equal(typeof payload.project_key, 'string');
  assert.equal(payload.total, 4);
  assert.equal(payload.memories.length, 4);
  assert.ok(!payload.memories.some((row) => row.content === 'another project secret'));
  for (const row of payload.memories) {
    assert.deepEqual(Object.keys(row).filter((key) => key !== 'score').sort(), EXPORT_KEYS);
    assert.equal(row.score, null);
  }
});

test('operator queries return JSON instead of throwing (#414)', () => {
  const cpp = runJson(['list', 'C++', '--json']);
  assert.equal(cpp.query, 'C++');
  assert.equal(cpp.total, 1);
  assert.match(cpp.memories[0].content, /C\+\+/);
  assert.deepEqual(Object.keys(cpp.memories[0].score).sort(), ['fts', 'fused', 'jaccard', 'semantic']);

  const flags = runJson(['list', 'foo -bar', '--json']);
  assert.equal(flags.query, 'foo -bar');
  assert.equal(flags.total, 1);
  assert.match(flags.memories[0].content, /foo -bar/);
});

test('--limit and --offset page the same order, with total reported before the page', () => {
  const first = runJson(['list', '--json', '--limit', '2']);
  const second = runJson(['list', '--json', '--limit', '2', '--offset', '2']);
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
  assert.equal(first.memories.length, 2);
  assert.equal(second.memories.length, 2);
  const ids = [...first.memories, ...second.memories].map((row) => row.id).sort();
  assert.deepEqual(ids, [1, 2, 3, 4]);

  const query = runJson(['list', 'memory', '--json', '--limit', '1', '--offset', '1']);
  assert.ok(query.total >= 2);
  assert.equal(query.memories.length, 1);
});

test('cmdListJson returns the same contract in-process', async () => {
  const db = openDb();
  const payload = await cmdListJson(db, { cwd: ROOT, query: 'C++', limit: 5, offset: 0 });
  db.close();
  assert.equal(payload.version, 1);
  assert.equal(payload.query, 'C++');
  assert.equal(payload.memories.length, 1);
});

test('show --json returns a visible memory and hides another project\'s row', () => {
  const db = openDb();
  const otherId = db.prepare('SELECT id FROM memories WHERE content = ?').get('another project secret').id;
  db.close();

  const own = runJson(['show', '1', '--json']);
  assert.equal(own.version, 1);
  assert.equal(own.memory.id, 1);
  assert.equal(own.memory.content, 'text default memory');
  assert.equal(own.memory.score, null);

  assert.equal(runJson(['show', String(otherId), '--json']).memory, null);
  assert.equal(runJson(['show', '999999', '--json']).memory, null);
});

test('the default text output is unchanged', () => {
  const out = runCli(['list']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^\[m\d+\] fact \| global text default memory$/m);
  assert.doesNotMatch(out.stdout, /^\{/);
});