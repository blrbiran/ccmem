// Orca writes one terminal run outcome into ccmem and reads the recorded rows
// back (spec docs/superpowers/specs/2026-11-21-run-outcome-writeback-design.md
// §2 transport, §4 read). What has to hold for phase 1 to be safe:
//   - one outcome per (project, run), immutable once recorded;
//   - the project key is ccmem's, derived from cwd, never the payload's;
//   - a refused payload is per-run input, not a global switch;
//   - the outcome table is NOT a memory: export, trust, recent_injections and
//     retrieval stay untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-orca-outcome-'));

const NODE = process.execPath;
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

const PROJECT_A = 'github.com/example/orca-outcome-a';
const PROJECT_B = 'github.com/example/orca-outcome-b';
const PROJECT_C = 'github.com/example/orca-outcome-c';

function makeRepo(name, projectKey) {
  const dir = mkdtempSync(path.join(tmpdir(), `ccmem-orca-outcome-${name}-`));
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://${projectKey}.git`]);
  return dir;
}

const repoA = makeRepo('a', PROJECT_A);
const repoB = makeRepo('b', PROJECT_B);
const repoC = makeRepo('c', PROJECT_C);

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { selectStableRows } = await import('../../scripts/lib/context-file.mjs');
const { ftsSearch } = await import('../../scripts/lib/retrieval.mjs');

process.on('exit', () => {
  rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true });
  for (const dir of [repoA, repoB, repoC]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function payload(runId, overrides = {}) {
  return {
    version: 1,
    runId,
    taskId: 'T3',
    attempt: 2,
    outcome: 'succeeded',
    abandoned: false,
    memoryIds: [1],
    observedAt: 1795194943994,
    ...overrides
  };
}

function runOutcome(subcommand, input, { cwd = repoA, extraArgs = [] } = {}) {
  const result = spawnSync(
    NODE,
    ['--no-warnings', '--experimental-sqlite', CLI, 'orca-outcome', subcommand, ...extraArgs],
    {
      cwd,
      env: { ...process.env, CCMEM_TEST_MODE: '1' },
      encoding: 'utf8',
      input: input === undefined ? undefined : (typeof input === 'string' ? input : JSON.stringify(input))
    }
  );
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function outcomeRow(runId) {
  const db = openDb();
  try {
    return db.prepare('SELECT * FROM orca_run_outcomes WHERE run_id = ?').all(runId);
  } finally {
    db.close();
  }
}

function allOutcomeRows() {
  const db = openDb();
  try {
    return db.prepare('SELECT * FROM orca_run_outcomes ORDER BY rowid').all();
  } finally {
    db.close();
  }
}

// 1. One row per (project, run); replay is unchanged; a changed body is
//    refused and the stored row does not move.
test('upsert records, replay is unchanged, a changed body is refused and the row is byte-identical', () => {
  const body = payload('run-1', { taskId: 'T3', attempt: 2, outcome: 'succeeded', memoryIds: [1042, 1057] });

  const first = runOutcome('upsert', body);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json, { version: 1, state: 'recorded', projectKey: PROJECT_A });

  const rows = outcomeRow('run-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_key, PROJECT_A);
  assert.equal(rows[0].run_id, 'run-1');
  assert.equal(rows[0].task_id, 'T3');
  assert.equal(rows[0].attempt, 2);
  assert.equal(rows[0].outcome, 'succeeded');
  assert.equal(rows[0].abandoned, 0);
  assert.equal(rows[0].memory_ids, '[1042,1057]');
  assert.equal(rows[0].observed_at, 1795194943994);
  assert.equal(typeof rows[0].recorded_at, 'number');

  const storedBefore = JSON.stringify(rows[0]);

  const again = runOutcome('upsert', body);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json, { version: 1, state: 'unchanged', projectKey: PROJECT_A });
  assert.equal(outcomeRow('run-1').length, 1);

  const changed = runOutcome('upsert', { ...body, outcome: 'failed' });
  assert.equal(changed.status, 64, changed.stderr);
  assert.deepEqual(changed.json, { version: 1, state: 'refused', projectKey: PROJECT_A });
  assert.equal(JSON.stringify(outcomeRow('run-1')[0]), storedBefore, 'a run outcome is immutable');
});

// 2. Malformed ids, extra keys and an oversized list are refused per run; a
//    well-formed payload in the same process still records.
test('bad ids, an extra key and more than 64 ids exit 64 and write nothing', () => {
  const cases = [
    ['not json', '{', 'run-bad-json'],
    ['wrong version', { ...payload('run-bad-version'), version: 2 }, 'run-bad-version'],
    ['zero id', payload('run-bad-zero', { memoryIds: [0] }), 'run-bad-zero'],
    ['negative id', payload('run-bad-neg', { memoryIds: [-3] }), 'run-bad-neg'],
    ['fractional id', payload('run-bad-frac', { memoryIds: [1.5] }), 'run-bad-frac'],
    ['string id', payload('run-bad-str', { memoryIds: ['1'] }), 'run-bad-str'],
    ['null id', payload('run-bad-null', { memoryIds: [null] }), 'run-bad-null'],
    ['empty ids', payload('run-bad-empty', { memoryIds: [] }), 'run-bad-empty'],
    ['too many ids', payload('run-bad-many', { memoryIds: Array.from({ length: 65 }, (_, i) => i + 1) }), 'run-bad-many'],
    ['extra key', payload('run-bad-extra', { text: 'an outcome is not a memory' }), 'run-bad-extra'],
    ['attempt zero', payload('run-bad-attempt', { attempt: 0 }), 'run-bad-attempt'],
    ['taskId not string', payload('run-bad-task', { taskId: 7 }), 'run-bad-task']
  ];

  for (const [label, input, runId] of cases) {
    const out = runOutcome('upsert', input);
    assert.equal(out.status, 64, `${label}: ${out.stderr}`);
    assert.match(out.stderr, /ccmem: orca-outcome/, label);
    assert.equal(out.json, null, label);
    if (!label.startsWith('not json') && !label.startsWith('wrong version')) {
      assert.equal(outcomeRow(runId).length, 0, label);
    }
  }
  assert.equal(allOutcomeRows().filter((row) => row.run_id.startsWith('run-bad-')).length, 0);

  // Positive control: the same process still records a well-formed payload,
  // so a 64 is a per-run refusal, not a global switch.
  const ok = runOutcome('upsert', payload('run-bad-control'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.state, 'recorded');
});

// 3. The project key is ccmem's resolveProjectKey(cwd); the payload cannot set it.
test('projectKey comes from cwd, and a projectKey in the payload is refused', () => {
  const withKey = runOutcome('upsert', { ...payload('run-3-key'), projectKey: 'github.com/attacker/fake' });
  assert.equal(withKey.status, 64);
  assert.equal(withKey.json, null);
  assert.equal(outcomeRow('run-3-key').length, 0);

  const a = runOutcome('upsert', payload('run-3-a'), { cwd: repoA });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.projectKey, PROJECT_A);
  assert.equal(outcomeRow('run-3-a')[0].project_key, PROJECT_A);

  const b = runOutcome('upsert', payload('run-3-b'), { cwd: repoB });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.json.projectKey, PROJECT_B);
  assert.equal(outcomeRow('run-3-b')[0].project_key, PROJECT_B);

  // Idempotency is (project_key, run_id): the same run id under another
  // project is a distinct row, not a replay of the first.
  const sameRunOtherProject = runOutcome('upsert', payload('run-3-a'), { cwd: repoB });
  assert.equal(sameRunOtherProject.status, 0, sameRunOtherProject.stderr);
  assert.equal(sameRunOtherProject.json.state, 'recorded');
});

// 4. list returns the recorded rows and the per-memory counts, and each flag works.
test('list counts by outcome; --project, --since and --json each filter/format', () => {
  const projectRows = [
    payload('run-4-succeeded', { outcome: 'succeeded', memoryIds: [10, 20] }),
    payload('run-4-failed', { outcome: 'failed', memoryIds: [10] }),
    payload('run-4-exhausted', { outcome: 'exhausted', memoryIds: [10, 30] })
  ];
  for (const body of projectRows) {
    const out = runOutcome('upsert', body, { cwd: repoC });
    assert.equal(out.status, 0, out.stderr);
  }

  const listed = runOutcome('list', undefined, { extraArgs: ['--json', '--project', PROJECT_C] });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.json.rows.map((row) => row.runId).sort(),
    ['run-4-exhausted', 'run-4-failed', 'run-4-succeeded']);
  assert.equal(listed.json.version, 1);

  const byId = new Map(listed.json.memories.map((entry) => [entry.memoryId, entry]));
  assert.deepEqual(byId.get(10), {
    memoryId: 10, carried: 3, succeeded: 1, failed: 1, exhausted: 1, cancelled: 0, blocked_waiting_human: 0
  });
  assert.deepEqual(byId.get(20), {
    memoryId: 20, carried: 1, succeeded: 1, failed: 0, exhausted: 0, cancelled: 0, blocked_waiting_human: 0
  });
  assert.deepEqual(byId.get(30), {
    memoryId: 30, carried: 1, succeeded: 0, failed: 0, exhausted: 1, cancelled: 0, blocked_waiting_human: 0
  });

  const otherProject = runOutcome('list', undefined, { extraArgs: ['--json', '--project', 'github.com/example/nowhere'] });
  assert.equal(otherProject.status, 0, otherProject.stderr);
  assert.deepEqual(otherProject.json.rows, []);
  assert.deepEqual(otherProject.json.memories, []);

  // --since filters on recorded_at: move one row ten days back, then ask for
  // everything recorded in the last five days.
  const db = openDb();
  try {
    db.prepare('UPDATE orca_run_outcomes SET recorded_at = ? WHERE project_key = ? AND run_id = ?')
      .run(Date.now() - (10 * 86400000), PROJECT_C, 'run-4-succeeded');
  } finally {
    db.close();
  }
  const since = new Date(Date.now() - (5 * 86400000)).toISOString();
  const filtered = runOutcome('list', undefined, { extraArgs: ['--json', '--project', PROJECT_C, '--since', since] });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(filtered.json.rows.map((row) => row.runId).sort(), ['run-4-exhausted', 'run-4-failed']);

  const badSince = runOutcome('list', undefined, { extraArgs: ['--since', 'not-a-date'] });
  assert.equal(badSince.status, 64, badSince.stderr);

  const text = runOutcome('list', undefined, { extraArgs: ['--project', PROJECT_C] });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /run run-4-succeeded/);
  assert.match(text.stdout, /memory 10: carried=3 succeeded=1 failed=1 exhausted=1 cancelled=0 blocked_waiting_human=0/);
});

// 5. The outcome table is not a memory: `export --json` carries the same bytes
//    (apart from its own exported_at clock) before and after a row exists.
test('export --json bytes are unchanged by an outcome row', async () => {
  const db = openDb();
  let memory;
  try {
    memory = await insertMemory(db, {
      cwd: repoA, content: 'export probe memory for the outcome table', scope: 'global', embedSync: false
    });
  } finally {
    db.close();
  }

  const exportJson = () => {
    const out = spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, 'export', '--json', '--scope', 'global'], {
      cwd: repoA,
      env: { ...process.env, CCMEM_TEST_MODE: '1' },
      encoding: 'utf8'
    });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };

  const before = exportJson();
  const recorded = runOutcome('upsert', payload('run-5-export', { memoryIds: [memory.id] }));
  assert.equal(recorded.status, 0, recorded.stderr);
  const after = exportJson();

  assert.deepEqual(after.memories, before.memories);
  assert.equal(after.memories.length, before.memories.length);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  // exported_at is a fresh clock on every call, so the only byte allowed to
  // move is that field; everything else must be identical.
  const frozen = (value) => JSON.stringify({ ...value, exported_at: 0 });
  assert.equal(frozen(after), frozen(before));
});

// 6. Phase 1 records only: trust_score, recent_injections, the stable section
//    and retrieval answers do not move.
test('recording an outcome does not move trust, recent_injections, the stable section or retrieval', async () => {
  const db = openDb();
  let one;
  let two;
  let before;
  try {
    one = await insertMemory(db, {
      cwd: repoA, content: 'phase1 trust probe uniquealpha', scope: 'project', embedSync: false
    });
    two = await insertMemory(db, {
      cwd: repoA, content: 'phase1 trust probe uniquebeta', scope: 'project', embedSync: false
    });
    before = {
      trust: db.prepare('SELECT id, trust_score, helpful_count, unhelpful_count FROM memories WHERE id IN (?, ?) ORDER BY id')
        .all(one.id, two.id),
      injections: db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n,
      stable: selectStableRows(db, PROJECT_A).map((row) => row.id),
      hits: ftsSearch(db, 'uniquealpha', PROJECT_A, 10).map((row) => row.id),
      memoryCount: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
    };
  } finally {
    db.close();
  }

  const recorded = runOutcome('upsert', payload('run-6-trust', {
    outcome: 'succeeded', memoryIds: [one.id, two.id]
  }));
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.json.state, 'recorded');
  // The counters are aggregated from real rows, so the row must exist.
  assert.equal(outcomeRow('run-6-trust')[0].memory_ids, JSON.stringify([one.id, two.id]));

  const db2 = openDb();
  try {
    const after = {
      trust: db2.prepare('SELECT id, trust_score, helpful_count, unhelpful_count FROM memories WHERE id IN (?, ?) ORDER BY id')
        .all(one.id, two.id),
      injections: db2.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n,
      stable: selectStableRows(db2, PROJECT_A).map((row) => row.id),
      hits: ftsSearch(db2, 'uniquealpha', PROJECT_A, 10).map((row) => row.id),
      memoryCount: db2.prepare('SELECT COUNT(*) AS n FROM memories').get().n
    };
    assert.deepEqual(after.trust, before.trust, 'trust_score and its counters must not move');
    assert.equal(after.injections, before.injections, 'recent_injections must not move');
    assert.deepEqual(after.stable, before.stable, 'the stable section must not move');
    assert.deepEqual(after.hits, before.hits, 'retrieval answers must not move');
    assert.equal(after.memoryCount, before.memoryCount);
  } finally {
    db2.close();
  }
});