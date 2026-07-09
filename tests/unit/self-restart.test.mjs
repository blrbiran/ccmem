import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-self-restart-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const {
  _resetForTest,
  checkPendingRestart,
  checkSchemaStaleness,
  getStartupSchemaVersion,
  scheduleGracefulRestart,
  writeDaemonStartupState
} = await import('../../scripts/daemon/self-restart.mjs');

function withConfig(config) {
  const previous = process.env.CCMEM_CONFIG_PATH;
  const configPath = path.join(process.env.CCMEM_DATA_ROOT, `self-restart-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  process.env.CCMEM_CONFIG_PATH = configPath;
  return () => {
    if (previous === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previous;
    }
  };
}

test.afterEach(() => {
  _resetForTest();
  delete process.env.CCMEM_CONFIG_PATH;
});

test('getStartupSchemaVersion and writeDaemonStartupState track daemon startup schema', () => {
  const db = openDb();
  const startupVersion = getStartupSchemaVersion(db);
  writeDaemonStartupState(db, startupVersion, 4321);

  const versionRow = db.prepare(`SELECT value FROM config_kv WHERE key = 'daemon_startup_schema_version'`).get();
  const pidRow = db.prepare(`SELECT value FROM config_kv WHERE key = 'daemon_startup_pid'`).get();

  assert.equal(startupVersion, 15);
  assert.equal(versionRow.value, '15');
  assert.equal(pidRow.value, '4321');
  db.close();
});

test('checkSchemaStaleness detects schema mismatches and respects config gate', () => {
  const db = openDb();
  const startupVersion = getStartupSchemaVersion(db);

  db.prepare(`UPDATE schema_meta SET version = 999`).run();
  const stale = checkSchemaStaleness(db, startupVersion);
  assert.equal(stale.stale, true);
  assert.equal(stale.startup_version, 15);
  assert.equal(stale.current_version, 999);

  const restoreConfig = withConfig({ daemon: { self_restart_on_schema_mismatch: false } });
  try {
    const gated = checkSchemaStaleness(db, startupVersion);
    assert.deepEqual(gated, {
      stale: false,
      current_version: startupVersion,
      startup_version: startupVersion
    });
  } finally {
    restoreConfig();
    db.close();
  }
});

test('scheduleGracefulRestart writes immediate restart audit and signals when idle', () => {
  const db = openDb();
  const signals = [];

  const result = scheduleGracefulRestart(
    db,
    { stale: true, startup_version: 7, current_version: 999 },
    { pid: 1234, uptimeSec: 8, currentTaskId: null, currentTaskType: null },
    { signal: () => signals.push('restart') }
  );

  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'daemon_self_restart'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(result, {
    will_restart: true,
    immediate: true,
    deferred_reason: null
  });
  assert.deepEqual(signals, ['restart']);
  assert.equal(details.from_version, 7);
  assert.equal(details.to_version, 999);
  assert.equal(details.in_flight_task_id, null);
  assert.equal(details.waited_ms, 0);
  db.close();
});

test('scheduleGracefulRestart defers until the running task finishes', () => {
  const db = openDb();
  const signals = [];

  const scheduled = scheduleGracefulRestart(
    db,
    { stale: true, startup_version: 7, current_version: 999 },
    { pid: 5555, uptimeSec: 12, currentTaskId: 77, currentTaskType: 'weekly_synthesis' },
    { now: () => 1000, signal: () => signals.push('restart') }
  );
  const completed = checkPendingRestart(
    db,
    { startupVersion: 7, pid: 5555, startedAt: 0 },
    { id: 77, type: 'weekly_synthesis' },
    { now: () => 9500, signal: () => signals.push('restart') }
  );

  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'daemon_self_restart'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(scheduled, {
    will_restart: true,
    immediate: false,
    deferred_reason: 'in_flight:weekly_synthesis#77'
  });
  assert.deepEqual(completed, { restarted: true });
  assert.deepEqual(signals, ['restart']);
  assert.equal(details.in_flight_task_id, 77);
  assert.equal(details.in_flight_task_type, 'weekly_synthesis');
  assert.equal(details.waited_ms, 8500);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
