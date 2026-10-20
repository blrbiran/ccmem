import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// `admin daemon stop`/`restart` send SIGTERM as soon as the lock row is there.
// A daemon that holds the lock before it handles SIGTERM dies by the default
// action and leaves its lock row, so stop waits out its whole budget and
// reports stop_timeout (seen on 2026-10-21 in the lifecycle test: the second
// daemon of a restart had taken the lock but not yet installed its handler).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = path.join(ROOT, 'scripts/daemon/main.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockRow(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare('SELECT holder_pid FROM daemon_lock WHERE id = 1').get() ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

test('a daemon SIGTERMed the moment its lock appears still releases the lock', async () => {
  const runs = 10;
  let leftover = 0;

  for (let i = 0; i < runs; i += 1) {
    const root = mkdtempSync(path.join(tmpdir(), 'ccmem-sigterm-'));
    writeFileSync(path.join(root, 'config.json'), '{}');
    const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: root };
    delete env.CCMEM_CONFIG_PATH;
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', MAIN], { env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const dbPath = path.join(root, 'global.db');

    let row = null;
    for (let t = 0; t < 2000 && !row; t += 1) {
      row = lockRow(dbPath);
      if (!row) await sleep(2);
    }
    assert.equal(row?.holder_pid, child.pid, 'the daemon took the lock (the condition under test was reached)');

    child.kill('SIGTERM');
    await exited;
    if (lockRow(dbPath)) leftover += 1;
  }

  assert.equal(leftover, 0, `${leftover}/${runs} daemons died holding the lock`);
});

test('the daemon installs its SIGTERM handler before it takes the lock', () => {
  // The behavioural test above samples a window; this pins the order itself.
  const source = readFileSync(MAIN, 'utf8');
  const handler = source.indexOf("process.on('SIGTERM'");
  const acquire = source.indexOf('acquireDaemonLock(db)');
  assert.ok(handler >= 0 && acquire >= 0);
  assert.ok(handler < acquire, 'no moment may exist where the lock is held and SIGTERM still has its default action');
});
