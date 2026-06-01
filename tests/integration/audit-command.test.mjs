import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-audit-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAuditShow } = await import('../../scripts/lib/cmd/audit.mjs');

test('cmdAuditShow returns audit row by id', async () => {
  const db = openDb();
  const inserted = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, ?, ?)`
  ).run(Date.now(), 'save', '[1]', '{"ok":true}');

  const row = await cmdAuditShow(db, { id: Number(inserted.lastInsertRowid) });
  assert.equal(row.action, 'save');
  assert.equal(row.affected_ids, '[1]');

  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
