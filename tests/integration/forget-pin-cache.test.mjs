import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cmds-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdPin } = await import('../../scripts/lib/cmd/pin.mjs');
const { cmdForget } = await import('../../scripts/lib/cmd/forget.mjs');
const { cmdShow } = await import('../../scripts/lib/cmd/show.mjs');

test('pin, show, forget update records and cache', async () => {
  const db = openDb();
  const saved = await cmdSave(db, {
    cwd: process.cwd(),
    content: 'Run pnpm test before commit',
    scope: 'project',
    type: 'rule'
  });

  await cmdPin(db, { id: Number(saved.id), remove: false });
  const shown = await cmdShow(db, { id: Number(saved.id) });
  assert.equal(shown.pinned, 1);

  const forgotten = await cmdForget(db, { id: Number(saved.id) });
  assert.equal(forgotten.id, Number(saved.id));
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
