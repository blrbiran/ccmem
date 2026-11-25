import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-summarize-pending-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');
const { runTask } = await import('../../scripts/daemon/loop.mjs');
const { dispatchTask } = await import('../../scripts/daemon/dispatch.mjs');
const { describeExtractionHealth } = await import('../../scripts/lib/admin/daemon.mjs');

function reset(db) {
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function countTasks(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n);
}

function statusOf(db, id) {
  return db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id)?.status;
}

function enqueueSummarize(db, payload) {
  return Number(
    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('summarize_pending', ?, ?, ?, 'queued') RETURNING id`
    ).get(JSON.stringify(payload), Date.now(), Date.now()).id
  );
}

// One daemon tick over the oldest queued row: the same runTask + dispatchTask
// pair mainLoop uses, so the settle of the terminal status is the real one.
async function runDaemonTick(db) {
  const task = db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1`).get();
  assert.ok(task, 'expected a queued task');
  await runTask(db, task, dispatchTask);
  return task.id;
}

// Tester #496: the Stop hook enqueued a summarize task even when it had no
// transcript_path at all. Nothing could ever be extracted from it, yet the
// daemon recorded it 'success' -- the one thing it was not.
test('a Stop with no transcript_path does not enqueue a summarize task (#496)', async () => {
  const db = openDb();
  reset(db);
  const before = countTasks(db);
  await handleStop(db, { session_id: 'probe', transcript_path: null });
  assert.equal(countTasks(db), before);
  db.close();
});

test('a bad-payload summarize task is not recorded as success (#496)', async () => {
  const db = openDb();
  reset(db);
  const id = enqueueSummarize(db, { session_id: 'x', transcript_path: null, last_message_seq: 0 });
  // The daemon entry point must forward the dispatcher result to the loop.
  const main = fileURLToPath(new URL('../../scripts/daemon/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [main], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try {
    const deadline = Date.now() + 10000;
    let status = statusOf(db, id);
    while (['queued', 'running'].includes(status) && child.exitCode === null && Date.now() < deadline) {
      await delay(20);
      status = statusOf(db, id);
    }
    assert.equal(status, 'skipped', stderr);
    const health = describeExtractionHealth(db);
    assert.equal(health.bad_payload_24h, 1);
    assert.equal(health.skipped_24h, 1);
    assert.equal(health.last_success_at, null);
  } finally {
    child.kill('SIGTERM');
    await exited;
    db.close();
  }
});

// The audit row is what `daemon status` counts; the terminal status above must
// not have replaced it.
test('a bad-payload summarize task still writes its audit row (#496)', async () => {
  const db = openDb();
  reset(db);
  const id = enqueueSummarize(db, { session_id: 'y', transcript_path: null, last_message_seq: 0 });
  await runDaemonTick(db);
  const audit = db.prepare(
    `SELECT details FROM audit_log WHERE action = 'summarize_pending_bad_payload' ORDER BY id DESC LIMIT 1`
  ).get();
  assert.ok(audit, 'the bad-payload audit row is still written');
  assert.equal(JSON.parse(audit.details).task_id, id);
  db.close();
});

// A database built from the v0.1 spec carries `tasks.status CHECK (…, 'success', …)`
// and cannot store the new terminal value (that is the #444 history in loop.mjs).
// A skip there must not crash the loop and must not turn green: it is recorded
// 'failed' with the reason, which is what every health read surfaces.
test('a skip on a store whose tasks.status CHECK predates it is recorded failed, not success (#496)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT,
      scheduled_for INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      error_excerpt TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      CHECK (status IN ('queued', 'running', 'success', 'failed', 'superseded'))
    );
  `);
  const id = Number(legacy.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', '{}', 0, 0, 'queued') RETURNING id`
  ).get().id);
  const task = legacy.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

  await runTask(legacy, task, async () => ({ skipped: 'no-transcript' }));

  const settled = legacy.prepare('SELECT status, error_excerpt FROM tasks WHERE id = ?').get(id);
  assert.equal(settled.status, 'failed');
  assert.match(String(settled.error_excerpt), /skipped: no-transcript/);
  legacy.close();
});
