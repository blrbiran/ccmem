import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-daemon-'));
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
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');

function resetAdminTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function seedAliveDaemon(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(4321, 'test-host', now - 5000, now - 800);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, started_at, status)
     VALUES ('summarize_pending', '{}', ?, ?, ?, 'running')`
  ).run(now - 2000, now - 2000, now - 1000);
}

test('cmdAdminDaemon returns live daemon status and running task', async () => {
  const db = openDb();
  resetAdminTables(db);
  seedAliveDaemon(db);

  const result = await cmdAdminDaemon(db, { verb: 'status' });

  assert.equal(result.alive, true);
  assert.equal(result.pid, 4321);
  assert.equal(result.hostname, 'test-host');
  assert.equal(result.running_task.type, 'summarize_pending');
  assert.equal(typeof result.heartbeat_age_ms, 'number');
  db.close();
});

test('cli admin daemon status prints live daemon summary', () => {
  const db = openDb();
  resetAdminTables(db);
  seedAliveDaemon(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'status'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon alive pid=4321/);
  assert.match(output, /host=test-host/);
  assert.match(output, /running=summarize_pending#\d+/);
});

test('cli admin daemon status prints not running when daemon lock is absent', () => {
  const db = openDb();
  resetAdminTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'status'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon not running/);
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
