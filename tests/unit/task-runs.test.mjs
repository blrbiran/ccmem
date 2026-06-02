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

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
