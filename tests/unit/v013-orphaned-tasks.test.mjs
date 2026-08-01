import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-orphan-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { reclaimOrphanedTasks } = await import('../../scripts/daemon/loop.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function insertTask(db, type, status, startedAt = Date.now()) {
  return Number(db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, started_at)
     VALUES (?, '{}', ?, ?, ?, ?) RETURNING id`
  ).get(type, startedAt, startedAt, status, status === 'queued' ? null : startedAt).id);
}

// Finding 11. A `running` row whose owner died is never reclaimed by anything, and
// two guards that are each individually correct then deadlock on it:
//
//   vec-backfill.mjs enqueueContinuation counts only 'queued' — deliberately, or
//     the run doing the counting would make the condition permanently true
//   daemon/main.mjs counts 'queued' OR 'running' — so an orphan makes it believe
//     work is already scheduled
//
// Observed live: `admin daemon restart` killed the daemon mid-batch, leaving one
// vec_backfill row 'running'. The backfill chain stopped with 1159 rows pending and
// stayed there — no error, no log line, `semantic status` simply frozen. Four
// summarize_pending orphans had accumulated the same way over the day, so this is a
// tasks-table property, not a vec_backfill one.
//
// acquireDaemonLock throws unless the previous lock is stale, so by the time this
// runs no other daemon exists: every 'running' row is provably ownerless.
test('startup reclaims running tasks whose owner died', () => {
  const db = openDb();
  try {
    const orphan = insertTask(db, 'vec_backfill', 'running');
    const otherOrphan = insertTask(db, 'summarize_pending', 'running');
    const queued = insertTask(db, 'vec_backfill', 'queued');
    const done = insertTask(db, 'vec_backfill', 'completed');

    const reclaimed = reclaimOrphanedTasks(db);

    assert.equal(reclaimed, 2, 'both ownerless rows are reclaimed, whatever their type');

    const read = (id) => db.prepare(`SELECT status, error_excerpt FROM tasks WHERE id = ?`).get(id);
    assert.equal(read(orphan).status, 'failed', 'a task whose process died did fail — say so');
    assert.match(read(orphan).error_excerpt ?? '', /daemon/i, 'the reason must be legible, not blank');
    assert.equal(read(otherOrphan).status, 'failed');

    assert.equal(read(queued).status, 'queued', 'queued work is untouched — it never had an owner');
    assert.equal(read(done).status, 'completed', 'terminal rows are untouched');
  } finally {
    db.close();
  }
});

// The point of reclaiming is that the startup re-queue guard stops seeing phantom
// work. Without this the guard in daemon/main.mjs (queued OR running) never fires
// again and the chain cannot restart, which is the whole failure.
test('after reclaiming, no phantom vec_backfill blocks the startup re-queue', () => {
  const db = openDb();
  try {
    db.prepare(`DELETE FROM tasks`).run();
    insertTask(db, 'vec_backfill', 'running');

    const blockedBefore = Number(db.prepare(
      `SELECT COUNT(*) n FROM tasks WHERE type = 'vec_backfill' AND status IN ('queued', 'running')`
    ).get().n);
    assert.equal(blockedBefore, 1, 'precondition: the orphan looks like scheduled work');

    reclaimOrphanedTasks(db);

    const blockedAfter = Number(db.prepare(
      `SELECT COUNT(*) n FROM tasks WHERE type = 'vec_backfill' AND status IN ('queued', 'running')`
    ).get().n);
    assert.equal(blockedAfter, 0, 'the startup guard must be free to queue a fresh batch');
  } finally {
    db.close();
  }
});
