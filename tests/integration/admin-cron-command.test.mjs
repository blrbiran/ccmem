import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-cron-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const CLI = '/Users/biran/code/skills/ccmem/scripts/cli.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminCron } = await import('../../scripts/lib/admin/cron.mjs');

function resetCronTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function seedCronFixture(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(9876, 'cron-host', now - 5000, now - 700);

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES
     ('daily_maintenance', '2026-06-01', ?, ?, 'failed', 'manual'),
     ('daily_maintenance', '2026-06-02', ?, ?, 'completed', 'daemon'),
     ('weekly_synthesis', '2026-W23', ?, NULL, 'running', 'daemon')`
  ).run(now - 12000, now - 11000, now - 9000, now - 8000, now - 4000);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('weekly_synthesis', '{}', ?, ?, 'queued')`
  ).run(now - 300, now - 300, now - 200, now - 200, now - 100, now - 100);
}

test('cmdAdminCron returns latest runs and queued counts', async () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);

  const result = await cmdAdminCron(db, { verb: 'list' });
  const byType = Object.fromEntries(result.items.map((item) => [item.type, item]));

  assert.equal(result.daemon_alive, true);
  assert.equal(byType.daily_maintenance.queued, 0);
  assert.equal(byType.daily_maintenance.last_run.status, 'completed');
  assert.equal(byType.summarize_pending.queued, 2);
  assert.equal(byType.summarize_pending.last_run, null);
  assert.equal(byType.weekly_synthesis.queued, 1);
  assert.equal(byType.weekly_synthesis.last_run.status, 'running');
  db.close();
});

test('cmdAdminCron run enqueues supported cron tasks immediately', async () => {
  const db = openDb();
  resetCronTables(db);

  const result = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
  const task = db.prepare(
    `SELECT type, scheduled_for, status
     FROM tasks
     WHERE id = ?`
  ).get(result.task_id);

  assert.equal(result.type, 'daily_maintenance');
  assert.equal(task.type, 'daily_maintenance');
  assert.equal(task.scheduled_for, 0);
  assert.equal(task.status, 'queued');
  db.close();
});

test('cmdAdminCron list returns bounded history for one task type', async () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);

  const result = await cmdAdminCron(db, { verb: 'list', taskType: 'daily_maintenance', history: 1 });

  assert.equal(result.type, 'daily_maintenance');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, 'completed');
  assert.equal(result.history[0].date_key, '2026-06-02');
  db.close();
});

test('cli admin cron list --history prints task history lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list', '--history', '2', '--task', 'daily_maintenance'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: cron history daily_maintenance/);
  assert.match(output, /completed@2026-06-02 by=daemon/);
  assert.match(output, /failed@2026-06-01 by=manual/);
});

test('cli admin cron list prints compact status lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon alive/);
  assert.match(output, /daily_maintenance queued=0 last=completed@2026-06-02/);
  assert.match(output, /summarize_pending queued=2 last=none/);
  assert.match(output, /weekly_synthesis queued=1 last=running@2026-W23/);
});

test('cli admin cron list prints not running daemon state', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon not running/);
});

test('cli admin cron run enqueues supported tasks', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'weekly_synthesis'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const task = verifyDb.prepare(
    `SELECT type, scheduled_for, status
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /ccmem: enqueued weekly_synthesis as task#\d+/);
  assert.equal(task.scheduled_for, 0);
  assert.equal(task.status, 'queued');
});

test('cmdAdminCron run rejects unsupported tasks', async () => {
  const db = openDb();
  resetCronTables(db);

  await assert.rejects(
    cmdAdminCron(db, { verb: 'run', taskType: 'security_audit' }),
    /unsupported cron task: security_audit/
  );

  db.close();
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
