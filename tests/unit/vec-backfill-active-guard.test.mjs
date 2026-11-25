import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-vec-backfill-guard-'));
const configPath = path.join(dataRoot, 'config.json');
writeFileSync(configPath, JSON.stringify({}));
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_CONFIG_PATH = configPath;

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const {
  runVecBackfill,
  enqueueVecBackfill
} = await import('../../scripts/daemon/tasks/vec-backfill.mjs');
const { _resetProviderCache } = await import('../../scripts/lib/embedding/provider.mjs');

const now = Date.now();

function resetTasks(db) {
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM config_kv WHERE key LIKE 'vec_backfill.%'`).run();
}

function setEmbeddingEnabled(db, enabled) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(enabled ? 'true' : 'false', now);
}

function insertTask(db, status) {
  return Number(db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, started_at)
     VALUES ('vec_backfill', '{}', ?, ?, ?, ?) RETURNING id`
  ).get(now, now, status, status === 'running' ? now : null).id);
}

function countVecTasks(db, status = null) {
  const sql = status == null
    ? `SELECT COUNT(*) AS n FROM tasks WHERE type = 'vec_backfill'`
    : `SELECT COUNT(*) AS n FROM tasks WHERE type = 'vec_backfill' AND status = ?`;
  return Number(status == null
    ? db.prepare(sql).get().n
    : db.prepare(sql).get(status).n);
}

function seedPendingMemories(db, count) {
  const insert = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
    ) VALUES ('project', 'guard/repo', 'fact', ?, 0, 'user_explicit', 0.5,
      'active', 0, 0, ?, ?, ?)`
  );
  for (let i = 0; i < count; i += 1) {
    insert.run(`guard fixture memory ${i} with enough words to embed`, now, now, now);
  }
}

// #507: the two guards disagreed. enqueueContinuation counted only 'queued',
// so it could add a second chain next to an orphan 'running' row left by a
// killed daemon; daemon/main.mjs counted 'queued' OR 'running' and therefore
// believed work was already scheduled. Both now use this one predicate.
// The startup side is exactly `enqueueVecBackfill` — the guard's action — so a
// stray running row must make it add nothing.
test('queued=0 / running=1 at startup queues no new vec_backfill row (#507)', () => {
  const db = openDb();
  try {
    resetTasks(db);
    insertTask(db, 'running');

    assert.equal(enqueueVecBackfill(db), false, 'the startup guard must not add a second chain');
    assert.equal(countVecTasks(db), 1, 'no new vec_backfill row may appear');
  } finally {
    db.close();
  }
});

// The predicate must not become permanently true for the task that is asking:
// that is why the old comment excluded 'running' wholesale. Excluding only the
// caller's own id keeps the chain alive while a genuinely different running
// row (an orphan, or a duplicate from an old build) still blocks a second one.
test('a run excludes its own running row but an orphan running row blocks a duplicate (#507)', () => {
  const db = openDb();
  try {
    resetTasks(db);
    const self = insertTask(db, 'running');
    assert.equal(enqueueVecBackfill(db, { excludeTaskId: self }), true);
    assert.equal(countVecTasks(db, 'queued'), 1);

    resetTasks(db);
    const self2 = insertTask(db, 'running');
    insertTask(db, 'running'); // orphan from a dead process
    assert.equal(enqueueVecBackfill(db, { excludeTaskId: self2 }), false);
    assert.equal(countVecTasks(db), 2, 'the orphan must not grow a second chain');
  } finally {
    db.close();
  }
});

test('a queued continuation plus an orphan running row produces no duplicate rows (#507)', () => {
  const db = openDb();
  try {
    resetTasks(db);
    insertTask(db, 'queued');
    insertTask(db, 'running');
    assert.equal(enqueueVecBackfill(db), false);
    assert.equal(countVecTasks(db), 2);
  } finally {
    db.close();
  }
});

// The predicate is only half the fix: a real batch must pass its own id to it.
// Without that, the running row it is under would make enqueueContinuation
// always answer "already queued" and the chain would never continue; with the
// old queued-only guard and an orphan present it would grow a second chain.
test('a finished batch under an orphan running row queues no continuation (#507)', async () => {
  const db = openDb();
  try {
    resetTasks(db);
    db.prepare(`DELETE FROM memories`).run();
    setEmbeddingEnabled(db, true);
    seedPendingMemories(db, 55);
    _resetProviderCache();

    const self = insertTask(db, 'running');
    insertTask(db, 'running'); // orphan
    const before = countVecTasks(db);

    const result = await runVecBackfill(db, { id: self, type: 'vec_backfill' });

    assert.ok(result.embedded > 0, 'fixture sanity: the batch must embed');
    assert.ok(result.remaining > 0, 'fixture sanity: one batch must not finish the store');
    assert.equal(countVecTasks(db, 'queued'), 0, 'the orphan running row must suppress a duplicate continuation');
    assert.equal(countVecTasks(db), before, 'no vec_backfill rows were added');
  } finally {
    _resetProviderCache();
    db.close();
  }
});

// A store with embedding switched off is not a failing batch that deserves
// another attempt: the old path returned "success, embedded 0" and the daemon
// queued it again, which is how one incident produced 41k failed rows. The run
// must stop with a named reason and leave the queue alone.
test('a run with no provider configured stops with why=no-provider and queues nothing (#507)', async () => {
  const db = openDb();
  try {
    resetTasks(db);
    setEmbeddingEnabled(db, false);
    _resetProviderCache();

    const result = await runVecBackfill(db, null);

    assert.equal(result.embedded, 0);
    assert.equal(result.why, 'no-provider', 'the result must name the reason instead of looking like a healthy run');
    assert.equal(countVecTasks(db), 0, 'no continuation may be queued when there is no provider');
    const row = db.prepare(
      `SELECT details FROM audit_log WHERE action = 'vec_backfill_run' ORDER BY id DESC LIMIT 1`
    ).get();
    assert.ok(row, 'the stop must be recorded');
    assert.equal(JSON.parse(row.details).why, 'no-provider', 'the audit row must carry the same named reason');
  } finally {
    _resetProviderCache();
    db.close();
  }
});

test('an OpenAI provider without credentials stops instead of scheduling retries (#507)', async () => {
  const db = openDb();
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    resetTasks(db);
    setEmbeddingEnabled(db, true);
    db.prepare(`INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.active_provider', 'openai', ?)`)
      .run(now);
    const self = insertTask(db, 'running');
    const result = await runVecBackfill(db, { id: self, type: 'vec_backfill' });
    assert.equal(result.why, 'no-provider');
    assert.equal(countVecTasks(db), 1, 'missing credentials must not schedule a retry');
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    _resetProviderCache();
    db.close();
  }
});
