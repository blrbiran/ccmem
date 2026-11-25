// Tester #475: a Stop hook's wake sat behind an uncancellable 300 s idle setTimeout, so a queued
// summarize_pending waited 242 s (measured) and `admin cron run` waited the same way. These tests
// put the loop into a real idle sleep (300 s or 30 s planned) and require a wake to end it within
// the test budget: remove the interruption and both time out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { raceLoop } from '../helpers/loop-timeout.mjs';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-wake-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { mainLoop } = await import('../../scripts/daemon/loop.mjs');
const { touchWakeFile } = await import('../../scripts/daemon/wake.mjs');

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

// Cron work the first tick may enqueue (time-of-day dependent) is drained first, so the
// sentinel lands while the loop is in its idle sleep -- not on a tick that would find it anyway.
async function runUntilSentinel(db, wake, enqueueAndWake) {
  let stop = false;
  let dispatchedAt = null;
  const loop = mainLoop(db, () => stop, async (_db, task) => {
    if (task.type === 'wake-sentinel') {
      dispatchedAt = Date.now();
      stop = true;
    }
  }, { wake });
  const driver = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const busy = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running')`).get().n;
      if (busy === 0) break;
      await sleep(10);
    }
    await sleep(50);
    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('wake-sentinel', '{}', ?, ?, 'queued')`
    ).run(Date.now(), Date.now());
    return enqueueAndWake();
  })();
  await raceLoop(Promise.all([loop, driver]));
  return { dispatchedAt, wokeAt: await driver };
}

test('an immediate wake (admin cron run) ends the idle sleep within one poll', async () => {
  const db = openDb();
  db.prepare(`DELETE FROM tasks`).run();
  // A debounce far beyond the test budget: only the immediate path can make this pass.
  const { dispatchedAt, wokeAt } = await runUntilSentinel(db, { pollMs: 10, debounceMs: 60000 }, () => {
    const at = Date.now();
    touchWakeFile({ immediate: true });
    return at;
  });
  assert.ok(dispatchedAt !== null, 'the sentinel was dispatched');
  assert.ok(dispatchedAt - wokeAt < 1000, `dispatched ${dispatchedAt - wokeAt} ms after the wake`);
  db.close();
});

test('a Stop wake ends the idle sleep at its mtime plus the debounce, not before', async () => {
  const db = openDb();
  db.prepare(`DELETE FROM tasks`).run();
  const debounceMs = 200;
  const { dispatchedAt, wokeAt } = await runUntilSentinel(db, { pollMs: 10, debounceMs }, () => {
    touchWakeFile();
    return statSync(path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake')).mtimeMs;
  });
  assert.ok(dispatchedAt !== null, 'the sentinel was dispatched');
  // Not before: newer Stop snapshots get their window to supersede this one.
  assert.ok(dispatchedAt >= wokeAt + debounceMs - 5, `dispatched ${dispatchedAt - wokeAt} ms after the wake (debounce ${debounceMs})`);
  db.close();
});
