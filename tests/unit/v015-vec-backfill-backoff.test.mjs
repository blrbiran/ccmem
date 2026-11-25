import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-vec-backfill-backoff-'));
const configPath = path.join(dataRoot, 'config.json');
writeFileSync(configPath, JSON.stringify({
  embedding: { enabled: true, provider: 'openai', openai_api_key: null, backfill_timeout_ms: 5000 }
}));
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_CONFIG_PATH = configPath;

const previousOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

test.after(() => {
  if (previousOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
  rmSync(dataRoot, { recursive: true, force: true });
});

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runVecBackfill } = await import('../../scripts/daemon/tasks/vec-backfill.mjs');
const { openaiEmbedding } = await import('../../scripts/lib/embedding/openai.mjs');
const { _resetProviderCache } = await import('../../scripts/lib/embedding/provider.mjs');

function seedPendingMemory(db) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
    ) VALUES ('project', 'demo/repo', 'fact', 'needs a vector', 0, 'user_explicit', 0.5,
      'active', 0, 0, ?, ?, ?)`
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(now);
}

function queuedContinuation(db) {
  return db.prepare(
    `SELECT id, scheduled_for, enqueued_at FROM tasks
     WHERE type = 'vec_backfill' AND status = 'queued'
     ORDER BY id DESC LIMIT 1`
  ).get() ?? null;
}

function kv(db, key) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key)?.value ?? null;
}

// #396 / the 429 flood: an account out of credits makes every batch fail, and
// the old catch path queued the next continuation for immediately — every few
// seconds, forever, with one stderr line per attempt. The daemon.err.log grew
// by tens of MB per hour. A repeated failure must space the next attempt out
// (30s, doubling, capped at 1h) and stop writing a line per attempt.
test('the second consecutive failure schedules the continuation later and logs nothing', async () => {
  const db = openDb();
  const load = mock.method(openaiEmbedding, 'load', async () => { throw new Error('429 rate limited'); });
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };

  try {
    db.prepare(`DELETE FROM tasks WHERE type = 'vec_backfill'`).run();
    db.prepare(`DELETE FROM config_kv WHERE key LIKE 'vec_backfill.%'`).run();
    seedPendingMemory(db);
    _resetProviderCache();

    await assert.rejects(runVecBackfill(db), /429 rate limited/);

    const first = queuedContinuation(db);
    assert.ok(first, 'the first failure must still queue a continuation');
    assert.equal(first.scheduled_for - first.enqueued_at, 30_000, 'the first backoff is ~30s');
    assert.equal(kv(db, 'vec_backfill.consecutive_failures'), '1');
    assert.equal(
      Number(kv(db, 'vec_backfill.next_attempt_at')),
      first.scheduled_for,
      'the persisted next-attempt time must match the queued continuation'
    );
    assert.equal(
      written.filter((line) => line.includes('vec_backfill')).length,
      1,
      'the first failure is reported'
    );

    // The loop claims the queued row before running it; simulate that so the
    // second call is the continuation's next attempt, not a duplicate run.
    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(first.id);
    const loggedAfterFirst = written.length;

    await assert.rejects(runVecBackfill(db, { id: first.id, type: 'vec_backfill' }), /429 rate limited/);

    const second = queuedContinuation(db);
    assert.ok(second, 'a repeated failure must still queue the next continuation');
    assert.equal(second.scheduled_for - second.enqueued_at, 60_000, 'the delay doubles to 60s');
    assert.equal(kv(db, 'vec_backfill.consecutive_failures'), '2');
    assert.equal(
      written.length,
      loggedAfterFirst,
      'the second consecutive failure must not add another stderr line'
    );
  } finally {
    load.mock.restore();
    process.stderr.write = realWrite;
    db.close();
    _resetProviderCache();
  }
});

test('the delay doubles up to the one-hour cap', async () => {
  const db = openDb();
  const load = mock.method(openaiEmbedding, 'load', async () => { throw new Error('429 rate limited'); });
  const realWrite = process.stderr.write.bind(process.stderr);
  // This test is about spacing, not lines; the previous test covers the log.
  process.stderr.write = () => true;

  try {
    db.prepare(`DELETE FROM tasks WHERE type = 'vec_backfill'`).run();
    db.prepare(`DELETE FROM config_kv WHERE key LIKE 'vec_backfill.%'`).run();
    _resetProviderCache();

    let lastDelay = 0;
    let current = null;
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await assert.rejects(runVecBackfill(db, current), /429 rate limited/);
      if (current) db.prepare(`UPDATE tasks SET status = 'failed' WHERE id = ?`).run(current.id);
      const task = queuedContinuation(db);
      assert.ok(task, `attempt ${attempt} must queue its continuation`);
      lastDelay = task.scheduled_for - task.enqueued_at;
      if (attempt < 9) {
        db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(task.id);
        current = { id: task.id, type: 'vec_backfill' };
      }
    }

    assert.equal(kv(db, 'vec_backfill.consecutive_failures'), '9');
    assert.equal(lastDelay, 60 * 60 * 1000, 'the delay stops growing at one hour');
  } finally {
    load.mock.restore();
    process.stderr.write = realWrite;
    db.close();
    _resetProviderCache();
  }
});
