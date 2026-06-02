import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RAN_BY, markLeaseComplete, tryClaimLease } from '../../scripts/lib/task-runs.mjs';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-task-runs-'));

const { openDb } = await import('../../scripts/lib/db.mjs');

test('RAN_BY constants are stable', () => {
  assert.deepEqual(RAN_BY, {
    DAEMON: 'daemon',
    OPPORTUNISTIC: 'opportunistic',
    MANUAL: 'manual'
  });
});

test('markLeaseComplete closes a running lease', () => {
  const db = openDb();
  const claimed = tryClaimLease(db, 'daily_maintenance', '2026-06-02', RAN_BY.DAEMON);
  assert.equal(claimed, true);

  markLeaseComplete(db, 'daily_maintenance', '2026-06-02');

  const row = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'daily_maintenance' AND date_key = '2026-06-02'`
  ).get();

  assert.equal(row.status, 'completed');
  assert.equal(typeof row.completed_at, 'number');
  db.close();
});

test('tryClaimLease rejects duplicate claims for the same type and date key', () => {
  const db = openDb();

  assert.equal(tryClaimLease(db, 'daily_maintenance', '2026-06-03', RAN_BY.DAEMON), true);
  assert.equal(tryClaimLease(db, 'daily_maintenance', '2026-06-03', RAN_BY.MANUAL), false);

  const rows = db.prepare(
    `SELECT ran_by, status
     FROM task_runs
     WHERE type = 'daily_maintenance' AND date_key = '2026-06-03'`
  ).all();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ran_by, 'daemon');
  assert.equal(rows[0].status, 'running');
  db.close();
});

test('markLeaseComplete only closes the matching running lease', () => {
  const db = openDb();

  assert.equal(tryClaimLease(db, 'daily_maintenance', '2026-06-04', RAN_BY.DAEMON), true);
  assert.equal(tryClaimLease(db, 'weekly_synthesis', '2026-W23', RAN_BY.DAEMON), true);

  markLeaseComplete(db, 'daily_maintenance', '2026-06-04');

  const daily = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'daily_maintenance' AND date_key = '2026-06-04'`
  ).get();
  const weekly = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = '2026-W23'`
  ).get();

  assert.equal(daily.status, 'completed');
  assert.equal(typeof daily.completed_at, 'number');
  assert.equal(weekly.status, 'running');
  assert.equal(weekly.completed_at, null);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
