import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-loop-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { mainLoop } = await import('../../scripts/daemon/loop.mjs');

test('mainLoop dispatches queued tasks', async () => {
  const db = openDb();
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('demo', '{}', ?, ?, 'queued')`
  ).run(Date.now() - 1000, Date.now() - 1000);

  const seen = [];
  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (_db, task) => {
      seen.push(task.type);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  assert.deepEqual(seen, ['demo']);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
