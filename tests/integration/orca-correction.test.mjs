// Orca writes the person's closed corrections into ccmem (spec
// docs/superpowers/specs/2026-10-21-orca-correction-import-design.md). What has
// to hold for that to be safe: re-sending never duplicates, withdrawal never
// deletes, and the rows reach the person only through per-prompt retrieval —
// never through the session-start stable section (human: "只在文档相关内容时才被检索出来").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-orca-corr-'));

const NODE = '/usr/local/bin/node';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const PROJECT_KEY = 'github.com/example/orca-corr-target';

const repo = mkdtempSync(path.join(tmpdir(), 'ccmem-orca-corr-repo-'));
spawnSync('git', ['init', '-q', repo]);
spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://${PROJECT_KEY}.git`]);

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdExport } = await import('../../scripts/lib/cmd/export.mjs');
const { selectStableRows } = await import('../../scripts/lib/context-file.mjs');
const { ftsSearch } = await import('../../scripts/lib/retrieval.mjs');
const { selectBatch } = await import('../../scripts/daemon/tasks/weekly-synthesis.mjs');
const { loadProjectRows } = await import('../../scripts/daemon/tasks/cross-project-patterns.mjs');

process.on('exit', () => {
  rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function runCorrection(subcommand, input) {
  const result = spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, 'orca-correction', subcommand], {
    cwd: repo,
    env: { ...process.env, CCMEM_TEST_MODE: '1' },
    encoding: 'utf8',
    input: typeof input === 'string' ? input : JSON.stringify(input)
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function rowsWithRef(id) {
  const db = openDb();
  try {
    return db.prepare(
      `SELECT m.id, m.content, m.decay_status, m.source, m.trust_score, m.scope, m.project_key, m.type, m.tags
       FROM memories m
       WHERE EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)
       ORDER BY m.id`
    ).all(`orca:correction:${id}`);
  } finally {
    db.close();
  }
}

function auditActions(memId) {
  const db = openDb();
  try {
    return db.prepare(
      `SELECT a.action FROM audit_log a JOIN audit_log_targets t ON t.audit_id = a.id WHERE t.mem_id = ? ORDER BY a.id`
    ).all(memId).map((row) => row.action);
  } finally {
    db.close();
  }
}

test('upsert inserts one project rule with the external ref, trust 0.8, source external', () => {
  const out = runCorrection('upsert', { version: 1, id: 'c-1', content: 'Use median of a copy; never sort the caller array in place.' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.action, 'inserted');
  assert.equal(out.json.externalRef, 'orca:correction:c-1');
  assert.equal(out.json.projectKey, PROJECT_KEY);
  const rows = rowsWithRef('c-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, out.json.memoryId);
  assert.equal(rows[0].scope, 'project');
  assert.equal(rows[0].project_key, PROJECT_KEY);
  assert.equal(rows[0].type, 'rule');
  assert.equal(rows[0].source, 'external');
  assert.equal(rows[0].trust_score, 0.8);
  assert.deepEqual(JSON.parse(rows[0].tags).sort(), ['orca-correction', 'orca:correction:c-1', 'retrieval_only']);
});

test('re-sending identical content is unchanged and writes nothing', () => {
  const first = runCorrection('upsert', { version: 1, id: 'c-2', content: 'Prefer explicit exports over default exports here.' });
  assert.equal(first.status, 0, first.stderr);
  const again = runCorrection('upsert', { version: 1, id: 'c-2', content: 'Prefer explicit exports over default exports here.' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.action, 'unchanged');
  assert.equal(again.json.memoryId, first.json.memoryId);
  assert.equal(rowsWithRef('c-2').length, 1);
});

test('changed content supersedes: old row archived (not deleted) with an audit row, new row current', () => {
  const first = runCorrection('upsert', { version: 1, id: 'c-3', content: 'Retry the flaky step once.' });
  const second = runCorrection('upsert', { version: 1, id: 'c-3', content: 'Never retry the flaky step; fix its timeout instead.' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.action, 'superseded');
  assert.notEqual(second.json.memoryId, first.json.memoryId);
  const rows = rowsWithRef('c-3');
  assert.deepEqual(rows.map((row) => [row.id, row.decay_status]), [
    [first.json.memoryId, 'archived'],
    [second.json.memoryId, 'active']
  ]);
  assert.ok(auditActions(first.json.memoryId).includes('orca_correction_superseded'));
});

test('withdraw archives every current row for the ref, never deletes, and repeats as absent', () => {
  const up = runCorrection('upsert', { version: 1, id: 'c-4', content: 'Keep the CLI output in English.' });
  assert.equal(up.status, 0, up.stderr);
  const out = runCorrection('withdraw', { version: 1, id: 'c-4' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.action, 'withdrawn');
  assert.deepEqual(out.json.memoryIds, [up.json.memoryId]);
  const rows = rowsWithRef('c-4');
  assert.deepEqual(rows.map((row) => row.decay_status), ['archived']);
  assert.ok(auditActions(up.json.memoryId).includes('orca_correction_withdrawn'));
  const again = runCorrection('withdraw', { version: 1, id: 'c-4' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.action, 'absent');
  assert.deepEqual(again.json.memoryIds, []);
});

test('a correction never enters the stable section, an ordinary project memory does, and per-prompt retrieval finds it', async () => {
  const up = runCorrection('upsert', { version: 1, id: 'c-5', content: 'zebrafjord rule: the ledger directory is append only.' });
  assert.equal(up.status, 0, up.stderr);
  const db = openDb();
  try {
    const ordinary = await cmdSave(db, { cwd: repo, content: 'quokkaplain fact: the build uses tsc.', scope: 'project' });
    const stableIds = selectStableRows(db, PROJECT_KEY).map((row) => row.id);
    assert.ok(stableIds.includes(ordinary.id), 'positive control: an ordinary project memory is in the stable section');
    assert.ok(!stableIds.includes(up.json.memoryId), 'the correction must not be in the stable section');
    const hits = ftsSearch(db, 'zebrafjord', PROJECT_KEY, 10).map((row) => row.id);
    assert.ok(hits.includes(up.json.memoryId), 'per-prompt retrieval must find the correction');
  } finally {
    db.close();
  }
});

test('daemon selectors that could carry it into stable context skip retrieval_only rows', async () => {
  const up = runCorrection('upsert', { version: 1, id: 'c-6', content: 'retrievalonly selector probe correction.' });
  assert.equal(up.status, 0, up.stderr);
  const db = openDb();
  try {
    const ordinary = await cmdSave(db, { cwd: repo, content: 'selector probe ordinary memory.', scope: 'project' });
    db.prepare(`UPDATE memories SET embedding = X'00000000' WHERE id IN (?, ?)`).run(up.json.memoryId, ordinary.id);
    const batchIds = selectBatch(db, PROJECT_KEY, 1000).map((row) => row.id);
    assert.ok(batchIds.includes(ordinary.id));
    assert.ok(!batchIds.includes(up.json.memoryId));
    const crossIds = loadProjectRows(db, PROJECT_KEY, 0).map((row) => row.id);
    assert.ok(crossIds.includes(ordinary.id));
    assert.ok(!crossIds.includes(up.json.memoryId));
  } finally {
    db.close();
  }
});

test('export keeps the v0.7 shape: source external, tags carry the ref', () => {
  runCorrection('upsert', { version: 1, id: 'c-7', content: 'Export shape probe correction.' });
  const db = openDb();
  try {
    const payload = cmdExport(db, { scope: 'project', projectKey: PROJECT_KEY });
    assert.equal(payload.version, '0.7');
    const row = payload.memories.find((memory) => JSON.parse(memory.tags ?? '[]').includes('orca:correction:c-7'));
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ['content', 'created_at', 'id', 'pinned', 'project_key', 'scope', 'source', 'tags', 'trust_score', 'type', 'updated_at']);
    assert.equal(row.source, 'external');
  } finally {
    db.close();
  }
});

test('input refusals exit 64 and write nothing; the refusal names the problem', () => {
  const cases = [
    ['not json', '{'],
    ['wrong version', { version: 2, id: 'r-1', content: 'x' }],
    ['unknown key', { version: 1, id: 'r-2', content: 'x', extra: true }],
    ['id with whitespace', { version: 1, id: 'r 3', content: 'x' }],
    ['empty content', { version: 1, id: 'r-4', content: '' }],
    ['over the length limit', { version: 1, id: 'r-5', content: 'y'.repeat(501) }]
  ];
  for (const [label, input] of cases) {
    const out = runCorrection('upsert', input);
    assert.equal(out.status, 64, `${label}: ${out.stderr}`);
    assert.match(out.stderr, /ccmem: orca-correction/, label);
  }
  for (const id of ['r-1', 'r-2', 'r 3', 'r-4', 'r-5']) {
    assert.equal(rowsWithRef(id).length, 0, id);
  }
  const withdrawBad = runCorrection('withdraw', { version: 1, id: 'w-1', content: 'not allowed here' });
  assert.equal(withdrawBad.status, 64);
  const unknownSub = runCorrection('frobnicate', { version: 1, id: 'w-2' });
  assert.equal(unknownSub.status, 64);
});
