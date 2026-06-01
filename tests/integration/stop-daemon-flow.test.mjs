import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-daemon-'));

const { touchWakeFile } = await import('../../scripts/daemon/wake.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');
const { acquireDaemonLock, isDaemonAlive } = await import('../../scripts/daemon/lock.mjs');

test('wake file is created and daemon lock is live', () => {
  const db = openDb();
  acquireDaemonLock(db);
  touchWakeFile();

  assert.equal(isDaemonAlive(db), true);
  assert.equal(existsSync(path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake')), true);

  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
