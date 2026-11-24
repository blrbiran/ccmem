import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tester #461: 54 `Promise.race` guards around `mainLoop` each armed their own 1000 ms
 * `setTimeout(() => reject(new Error('loop timeout')))`. Under `npm test`'s default concurrency a
 * loaded machine missed that budget (43 failures in one run) although every file was green alone.
 * They now share `raceLoop` (tests/helpers/loop-timeout.mjs): one budget, overridable by
 * CCMEM_TEST_LOOP_TIMEOUT_MS, which `scripts/run-tests.sh` raises to 5000 for a suite run.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'tests/helpers/loop-timeout.mjs');
const { raceLoop } = await import(HELPER);

test('raceLoop rejects with the stable loop timeout prefix when the loop does not finish (#461)', async () => {
  await assert.rejects(raceLoop(new Promise(() => {}), 20), /^Error: loop timeout after 20ms$/);
});

test('raceLoop returns the loop result and leaves no timer behind (#461)', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timers();
  assert.equal(await raceLoop(Promise.resolve('done'), 60_000), 'done');
  // mutation: drop the clearTimeout in finally -> a 60 s timer stays armed, red
  assert.equal(timers(), before, 'the guard must not keep the event loop alive after the loop finished');
});

// The test's own timeout: a guard that followed the mock would never fire, and the row must fail, not hang.
test('raceLoop keeps its budget while a test has replaced global setTimeout (#461)', { timeout: 5000 }, async () => {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = () => 0; // a mock that never fires, like the daemon-loop tests install
  try {
    // mutation: arm the guard through globalThis.setTimeout at call time -> it never fires, the row times out, red
    await assert.rejects(raceLoop(new Promise(() => {}), 20), /loop timeout/);
  } finally {
    globalThis.setTimeout = original;
  }
});

function budgetUnder(env) {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(HELPER)}).then((m) => process.stdout.write(String(m.LOOP_TIMEOUT_MS)))`], {
    env, encoding: 'utf8'
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test('the budget is 1000 ms by default and CCMEM_TEST_LOOP_TIMEOUT_MS overrides it (#461)', () => {
  const env = { ...process.env };
  delete env.CCMEM_TEST_LOOP_TIMEOUT_MS;
  assert.equal(budgetUnder(env), '1000', 'a single file run directly keeps the original 1000 ms');
  assert.equal(budgetUnder({ ...env, CCMEM_TEST_LOOP_TIMEOUT_MS: '2500' }), '2500');
  assert.equal(budgetUnder({ ...env, CCMEM_TEST_LOOP_TIMEOUT_MS: 'nonsense' }), '1000', 'an unusable value falls back');
});

test('run-tests.sh gives a suite run 5000 ms unless the caller chose a budget (#461)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccmem-loop-budget-'));
  try {
    const probe = path.join(dir, 'probe.test.mjs');
    writeFileSync(probe, "import test from 'node:test';\ntest('budget', () => { process.stdout.write(`budget=${process.env.CCMEM_TEST_LOOP_TIMEOUT_MS}\\n`); });\n");
    // Spawned as `npm test` would spawn it: an inherited NODE_TEST_CONTEXT silences the inner runner.
    const env = { ...process.env, CCMEM_TEST_MODE: '1' };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.CCMEM_TEST_LOOP_TIMEOUT_MS;
    const run = (extra) => execFileSync('/bin/sh', [path.join(ROOT, 'scripts/run-tests.sh'), probe], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: { ...env, ...extra } });
    // mutation: drop the export from run-tests.sh -> budget=undefined, red
    assert.match(run({}), /budget=5000/);
    assert.match(run({ CCMEM_TEST_LOOP_TIMEOUT_MS: '1500' }), /budget=1500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
