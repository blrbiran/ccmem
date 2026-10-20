import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A write lock held by another connection (a hook, the CLI, a migration) must
// not kill the daemon. Live, 2026-10-20: an uncaught `database is locked` from
// runTask's start UPDATE ended the daemon process and nothing restarted it.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-loop-busy-'));
const configPath = path.join(process.env.CCMEM_DATA_ROOT, 'config.json');
writeFileSync(configPath, JSON.stringify({}));
process.env.CCMEM_CONFIG_PATH = configPath;

const { getDbPath, openDb } = await import('../../scripts/lib/db.mjs');
const { _resetProbeSchedule, mainLoop, runTask } = await import('../../scripts/daemon/loop.mjs');

function resetTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM config_kv WHERE key = 'mode'`).run();
}

function enqueue(db, type = 'noop_test') {
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES (?, '{}', ?, ?, 'queued')`
  ).run(type, now, now);
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(lastInsertRowid);
}

// Another connection takes the write lock. The daemon's own connection gets a
// zero busy timeout so the conflict is immediate instead of after 5 s.
function holdWriteLock(daemonDb) {
  daemonDb.exec('PRAGMA busy_timeout = 0;');
  const other = new DatabaseSync(getDbPath());
  other.exec('PRAGMA busy_timeout = 0;');
  other.exec('BEGIN IMMEDIATE;');
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    other.exec('ROLLBACK;');
    other.close();
  };
}

function assertLockApplied(db) {
  // The condition must really be in force, or a green below means nothing.
  assert.throws(
    () => db.prepare(`UPDATE tasks SET attempts = attempts WHERE 0`).run(),
    (error) => error?.errcode === 5,
    'the second connection must hold the write lock (errcode 5)'
  );
}

test('runTask leaves the task queued when the database is locked, then runs it once the lock is gone', async () => {
  const db = openDb();
  resetTables(db);
  const task = enqueue(db);
  let dispatched = 0;
  const release = holdWriteLock(db);

  try {
    assertLockApplied(db);
    await runTask(db, task, async () => { dispatched += 1; });
  } finally {
    release();
  }

  try {
    const row = db.prepare(`SELECT status, attempts FROM tasks WHERE id = ?`).get(task.id);
    assert.equal(dispatched, 0, 'a task that could not be marked running must not be dispatched');
    assert.equal(row.status, 'queued', 'the task stays for a later tick — not lost, not failed');
    assert.equal(row.attempts, 0, 'a skipped start is not an attempt');

    await runTask(db, task, async () => { dispatched += 1; });
    assert.equal(dispatched, 1);
    assert.equal(db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(task.id).status, 'completed');
  } finally {
    db.close();
  }
});

test('runTask still throws errors that are not a busy database', async () => {
  const boom = Object.assign(new Error('disk I/O error'), { errcode: 10 });
  const db = { prepare() { throw boom; } };
  await assert.rejects(runTask(db, { id: 1 }, async () => {}), (error) => error === boom);
});

// Counts the start UPDATEs the loop issues, so a loop that retries a busy
// start without pausing (hundreds of tries in the lock window) is visible.
function countingStarts(db) {
  const counter = { starts: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          if (/SET status = 'running'/.test(sql)) counter.starts += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { proxy, counter };
}

test('mainLoop survives a locked database at the task start and runs the task after the lock is released', async () => {
  const db = openDb();
  const { proxy, counter } = countingStarts(db);
  resetTables(db);
  enqueue(db);
  const dispatched = [];
  let stop = false;
  const release = holdWriteLock(db);
  let released = false;
  let timer;

  try {
    assertLockApplied(db);
    timer = setTimeout(() => { release(); released = true; }, 200);
    await mainLoop(proxy, () => stop, async (_loopDb, task) => {
      dispatched.push(task.type);
      stop = true;
    });
  } finally {
    clearTimeout(timer);
    if (!released) release();
  }

  try {
    assert.deepEqual(dispatched, ['noop_test']);
    assert.ok(counter.starts <= 3, `a busy start pauses before the next try (got ${counter.starts} start attempts in a 200 ms lock)`);
  } finally {
    db.close();
  }
});

test('mainLoop survives a locked database while scheduling cron work', async () => {
  const restore = process.env.CCMEM_CONFIG_PATH;
  const probeConfig = path.join(process.env.CCMEM_DATA_ROOT, 'probe-config.json');
  writeFileSync(probeConfig, JSON.stringify({ embedding: { latency_probe: { enabled: true, interval_ms: 1 } } }));
  process.env.CCMEM_CONFIG_PATH = probeConfig;

  const db = openDb();
  resetTables(db);
  _resetProbeSchedule(0);
  // Recent activity makes scheduleCronTasks write a probe task — the write the lock blocks.
  db.prepare(
    `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at)
     VALUES ('busy-session', 'demo/repo', 0, 0, 0, 0, ?)`
  ).run(Date.now());
  const dispatched = [];
  let stop = false;
  const release = holdWriteLock(db);
  let released = false;
  let timer;

  try {
    assertLockApplied(db);
    // The busy tick already advanced the probe clock, so it will not re-enqueue
    // the probe; work queued after the release proves the loop is still alive.
    timer = setTimeout(() => { release(); released = true; enqueue(db); }, 200);
    await mainLoop(db, () => stop, async (_loopDb, task) => {
      dispatched.push(task.type);
      stop = true;
    });
  } finally {
    clearTimeout(timer);
    if (!released) release();
    process.env.CCMEM_CONFIG_PATH = restore;
  }

  try {
    assert.deepEqual(dispatched, ['noop_test'], 'the loop outlived the busy cron tick and ran the next queued task');
  } finally {
    db.close();
  }
});
