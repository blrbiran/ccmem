import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// #415 P3: the daily maintenance runs FTS5's optimize after the day's
// deletes, and audits it only when the index actually shrank. Run the real
// task on a store with churn; a no-op or a missing call leaves no audit row.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-fts-daily-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ embedding: { enabled: false } }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runDailyMaintenance } = await import('../../scripts/daemon/tasks/daily-maintenance.mjs');

test('daily maintenance compacts a churned FTS index and audits the shrink', async (t) => {
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const db = openDb();
  try {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO memories (scope, type, content, source, last_touched_at, created_at, updated_at)
       VALUES ('global', 'rule', ?, 'user_explicit', ?, ?, ?)`
    );
    for (let i = 0; i < 3000; i += 1) insert.run(`daily maintenance row ${i} alpha beta gamma`, now, now, now);
    db.exec('DELETE FROM memories WHERE id > 500');

    await runDailyMaintenance(db, { payload: '{}', scheduled_for: now });

    const audit = db.prepare("SELECT details FROM audit_log WHERE action = 'fts_optimized'").all();
    assert.ok(audit.length >= 1, 'expected the daily pass to audit an FTS optimize');
    const detail = JSON.parse(String(audit.at(-1).details));
    assert.equal(detail.optimized, true);
    assert.ok(detail.bytesAfter < detail.bytesBefore, `expected a shrink (${detail.bytesBefore} → ${detail.bytesAfter})`);
  } finally {
    db.close();
  }
});