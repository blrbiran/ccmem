import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-daemon-health-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { describeExtractionHealth } = await import('../../scripts/lib/admin/daemon.mjs');
const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');
const { writeAudit } = await import('../../scripts/lib/audit.mjs');

const HOUR = 60 * 60 * 1000;

function reset(db) {
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function insertTask(db, { now, type = 'summarize_pending', status, finishedAt, error = null }) {
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, started_at, finished_at, status, error_excerpt)
     VALUES (?, '{}', ?, ?, ?, ?, ?, ?)`
  ).run(type, now, now, finishedAt, finishedAt, status, error);
}

// Tester #496: `success` used to be written for a summarize task with no
// transcript. Now that it is 'skipped', the health read must not let it pass for
// an extraction, and must name both the new status and the old audit trail.
test('a skipped summarize task is counted, and is never the last success (#496)', () => {
  const now = Date.now();
  const db = openDb();
  reset(db);
  insertTask(db, { now, status: 'skipped', finishedAt: now - HOUR, error: 'skipped: no-transcript' });
  insertTask(db, { now, status: 'failed', finishedAt: now - 2 * HOUR, error: 'exit 1' });
  writeAudit(db, 'summarize_pending_bad_payload', null, { task_id: 1, reason: 'no-transcript' });

  const health = describeExtractionHealth(db, now);
  assert.equal(health.bad_payload_24h, 1);
  assert.equal(health.skipped_24h, 1);
  assert.equal(health.failed_24h, 1);
  assert.equal(health.last_success_at, null, 'a skipped row is not an extraction that happened');
  db.close();
});

test('the bad-payload and skipped counts are 24h windows, not totals (#496)', () => {
  const now = Date.now();
  const db = openDb();
  reset(db);
  insertTask(db, { now, status: 'skipped', finishedAt: now - 30 * HOUR });
  writeAudit(db, 'summarize_pending_bad_payload', null, { task_id: 1 });
  // Age the audit row the way an old build would have left it.
  db.prepare(`UPDATE audit_log SET ts = ? WHERE action = 'summarize_pending_bad_payload'`)
    .run(now - 30 * HOUR);

  const health = describeExtractionHealth(db, now);
  assert.equal(health.skipped_24h, 0);
  assert.equal(health.bad_payload_24h, 0);

  insertTask(db, { now, status: 'skipped', finishedAt: now - HOUR });
  writeAudit(db, 'summarize_pending_bad_payload', null, { task_id: 2 });
  const fresh = describeExtractionHealth(db, now);
  assert.equal(fresh.skipped_24h, 1);
  assert.equal(fresh.bad_payload_24h, 1);
  db.close();
});

test('a success is still a success (#496)', () => {
  const now = Date.now();
  const db = openDb();
  reset(db);
  insertTask(db, { now, status: 'success', finishedAt: now - HOUR });

  const health = describeExtractionHealth(db, now);
  assert.equal(health.last_success_at, now - HOUR);
  assert.equal(health.skipped_24h, 0);
  assert.equal(health.bad_payload_24h, 0);
  db.close();
});

test('extraction timeout counts use the last 24 hours across cost log rotation (#445)', () => {
  const now = Date.now();
  const db = openDb();
  const file = daemonCostFile();
  const timeout = (ts, task_type = 'summarize_pending') => ({ ts, task_type, timed_out: true });
  const rows = (events) => events.map((event) => JSON.stringify(event)).join('\n');
  try {
    writeFileSync(`${file}.1`, rows([timeout(now - 30 * HOUR), timeout(now - 24 * HOUR)]));
    writeFileSync(file, `${rows([
      timeout(now - HOUR), timeout(now - HOUR, 'security_audit'), timeout(now + HOUR),
      { ...timeout(now - HOUR), timed_out: false }
    ])}\ninvalid JSON\n`);
    assert.equal(describeExtractionHealth(db, now).timeouts_24h, 2);
  } finally {
    db.close();
  }
});


test('an unreadable cost log leaves the rest of extraction health available (#445)', () => {
  const db = openDb();
  const file = daemonCostFile();
  try {
    rmSync(file, { force: true });
    mkdirSync(file); // Reading a directory as a file gives EISDIR.
    reset(db);
    const now = Date.now();
    insertTask(db, { now, status: 'success', finishedAt: now - HOUR });
    const health = describeExtractionHealth(db, now);
    assert.equal(health.timeouts_24h, null);
    assert.equal(health.last_success_at, now - HOUR);
  } finally {
    db.close();
  }
});
