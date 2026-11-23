import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-task-status-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runTask } = await import('../../scripts/daemon/loop.mjs');
const { cmdAdminCron } = await import('../../scripts/lib/admin/cron.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function enqueue(db, type = 'summarize_pending') {
  return Number(db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES (?, '{}', ?, ?, 'queued') RETURNING id`
  ).get(type, Date.now(), Date.now()).id);
}

function row(db, id) {
  return db.prepare('SELECT status, finished_at, error_excerpt FROM tasks WHERE id=?').get(id);
}

// #444: the success path wrote 'completed', a word the v0.1 spec's `tasks` CHECK never
// allowed (it allows 'success'), so on any database built with that constraint the
// UPDATE threw, fell into the catch, and a task that SUCCEEDED was recorded 'failed'
// with `error_excerpt = 'CHECK constraint failed…'`. Every health read ("did the
// daemon finish its work? why did the last run fail?") then reads success as failure.
test('a task that succeeded is recorded success, not completed', async () => {
  const db = openDb();
  const id = enqueue(db);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  await runTask(db, task, async () => {});
  assert.equal(row(db, id).status, 'success');
});

// The failure must stay distinguishable from a bookkeeping failure: a dispatch that
// throws is 'failed' with its own message, never masked by the status write.
test('a task whose dispatch threw is recorded failed with its message', async () => {
  const db = openDb();
  const id = enqueue(db);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  await runTask(db, task, async () => { throw new Error('dispatch blew up'); });
  const stored = row(db, id);
  assert.equal(stored.status, 'failed');
  assert.match(String(stored.error_excerpt), /dispatch blew up/);
});

// `admin cron list` shows the last run per type, and it reads the lease table
// (task_runs) — which summarize_pending never writes. A success that only exists in
// `tasks` must still be reported: otherwise the one job that extracts memories from
// transcripts reads `last=none` forever (tester #447).
test('cron list reports a last run for a task type that never takes a lease', async () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  const id = enqueue(db);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  await runTask(db, task, async () => {});
  const answer = await cmdAdminCron(db, { verb: 'list' });
  const item = answer.items.find((entry) => entry.type === 'summarize_pending');
  assert.ok(item, 'summarize_pending is listed');
  assert.ok(item.last_run, 'its last run comes from tasks when no lease row exists');
  assert.equal(item.last_run.status, 'completed');
});
