import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-mode-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdMode } = await import('../../scripts/lib/cmd/mode.mjs');

test('cmdMode returns current mode and updates mode', async () => {
  const db = openDb();

  const initial = await cmdMode(db, {});
  assert.equal(initial.mode, 'active');

  const updated = await cmdMode(db, { mode: 'shadow' });
  assert.equal(updated.mode, 'shadow');

  const current = await cmdMode(db, {});
  assert.equal(current.mode, 'shadow');

  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
