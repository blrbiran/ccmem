import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-flow-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdList } = await import('../../scripts/lib/cmd/list.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');

test('save -> list -> session start inject works', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  const rows = await cmdList(db, { query: null, limit: 10 });
  assert.equal(rows.length, 1);
  const result = await handleSessionStart({ cwd: process.cwd() });
  assert.match(result.additionalContext, /Prefer concise answers/);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
