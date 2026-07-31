import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-qgreject-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { writeAudit } = await import('../../scripts/lib/audit.mjs');
const { getTuningDiagnostics } = await import('../../scripts/lib/admin/diagnose.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function backdate(db, auditId, ageDays) {
  db.prepare(`UPDATE audit_log SET ts = ? WHERE id = ?`)
    .run(Date.now() - (ageDays * 86400000), auditId);
}

// I5. The intake gate's regexes are blunt by design — negative_assertion has no
// length or context qualifier — so they will reject some legitimate constraint
// memories. That is only a defensible trade-off if the rate is actually looked
// at, which means the rejections must surface where a human tuning ccmem reads
// them, not only in raw audit rows nobody queries.
test('diagnose --tuning breaks quality_gate_reject down by reason over the tuning window', () => {
  const db = openDb();

  writeAudit(db, 'quality_gate_reject', null, { reason: 'negative_assertion', content_excerpt: 'a' });
  writeAudit(db, 'quality_gate_reject', null, { reason: 'negative_assertion', content_excerpt: 'b' });
  writeAudit(db, 'quality_gate_reject', null, { reason: 'env_failure', content_excerpt: 'c' });
  // An unrelated action must not be counted as a rejection.
  writeAudit(db, 'vec_backfill_run', null, { reason: 'negative_assertion' });
  // Outside the 30-day tuning window: a rate is only meaningful if it is bounded.
  backdate(db, writeAudit(db, 'quality_gate_reject', null, { reason: 'too_short' }), 60);

  const rejects = getTuningDiagnostics(db).quality_gate_rejects;

  assert.equal(rejects.window_days, 30);
  assert.equal(rejects.total, 3, 'only in-window quality_gate_reject rows count');
  assert.deepEqual(rejects.by_reason, [
    { reason: 'negative_assertion', count: 2 },
    { reason: 'env_failure', count: 1 }
  ], 'ordered most-frequent first — the reason to investigate first is the one at the top');
});

// A young store is exactly when a badly-tuned regex does the most damage, and
// it is also when the tuning command bails for lack of rollup data.
test('the rejection breakdown is reported even when there is too little data to suggest thresholds', () => {
  const db = openDb();
  const diagnostics = getTuningDiagnostics(db);

  assert.equal(diagnostics.insufficient, true, 'fixture sanity: this store has no rollup days');
  assert.ok(diagnostics.quality_gate_rejects, 'the breakdown must survive the insufficient-data early return');
  assert.equal(diagnostics.quality_gate_rejects.total, 3);
});
