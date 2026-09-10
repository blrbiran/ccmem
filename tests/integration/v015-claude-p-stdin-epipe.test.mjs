import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-stdin-epipe-'));

const STUB_DIR = mkdtempSync(path.join(tmpdir(), 'ccmem-stdin-epipe-stub-'));

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
test.after(() => rmSync(STUB_DIR, { recursive: true, force: true }));

/**
 * WHY this guard exists (Rule 9).
 *
 * `runClaudeP` writes the whole prompt with `child.stdin.end(prompt)` and
 * attaches no 'error' listener to that stream. A stream that emits 'error'
 * with no listener throws, and `scripts/` installs no
 * process.on('uncaughtException') anywhere -- so the throw takes the daemon
 * process down with it, in the middle of whatever task it was running.
 *
 * That is not hypothetical. The production `tasks` table carries six rows
 * whose error_excerpt is "daemon exited while this task was running" (five
 * summarize_pending, one vec_backfill), a signature nothing else in the
 * codebase attributes.
 *
 * The trigger is a child that exits before the parent has finished writing:
 * the read end of the pipe goes away mid-write and the write fails EPIPE.
 * Real causes seen in production: the `claude` binary not being executable
 * (22 rows of `spawn ... EACCES`), an unknown CLI flag (5 rows of
 * `unknown option '--json-schema'`), and 7 rows of `claude -p exit N:` with
 * an empty stderr -- every one of them a fast exit.
 *
 * The prompt has to exceed the pipe buffer (64 KiB on macOS) for the race to
 * be deterministic rather than load-dependent: a prompt that fits is handed
 * to the kernel in one shot and is already gone before the child dies. This
 * test is the deterministic form of a flake that reproduced 2 times in 10
 * runs of tests/integration/admin-cron-command.test.mjs under CPU load.
 */

// Exits before reading a byte of stdin. `process.exit` rather than falling off
// the end, so the exit does not wait on an open stdin.
const FAST_EXIT_STUB = path.join(STUB_DIR, 'stub-exit-immediately.mjs');
writeFileSync(FAST_EXIT_STUB, `process.exit(3);\n`);

// 4 MiB: far past any platform's pipe buffer, so `stdin.end()` cannot complete
// in a single write and is guaranteed to still be writing when the child dies.
const OVERSIZED_PROMPT = 'x'.repeat(4 * 1024 * 1024);

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');

function withStub(stub) {
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub]);
}

// Capturing uncaughtException is what makes the defect assertable: without a
// listener the throw kills the test process, which is a red that says nothing
// about WHICH error escaped. Asserting the captured list is empty keeps the
// criterion pointed at the defect rather than at the crash.
async function captureUncaught(fn) {
  const seen = [];
  const capture = (error) => seen.push(error);
  const previous = process.listeners('uncaughtException');
  for (const listener of previous) process.removeListener('uncaughtException', listener);
  process.on('uncaughtException', capture);
  try {
    await fn();
    // The EPIPE lands on a later tick than the promise settles: the child's
    // 'close' event resolves the call while the parent's write is still in
    // flight. Without this the assertion races the very event it is guarding.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    process.removeListener('uncaughtException', capture);
    for (const listener of previous) process.on('uncaughtException', listener);
  }
  return seen;
}

test('a child that exits mid-write must not take the daemon down with an unhandled stdin EPIPE', async () => {
  withStub(FAST_EXIT_STUB);

  let settled = 'never';
  let rejection = null;
  const uncaught = await captureUncaught(async () => {
    await callClaudeP(OVERSIZED_PROMPT, { taskType: 'summarize_pending', timeoutMs: 15000 })
      .then(() => { settled = 'resolved'; }, (error) => { settled = 'rejected'; rejection = error; });
  });

  // Asserting on the code, not just the count: a different escaping error
  // would mean this test is guarding something other than what it documents.
  assert.deepEqual(
    uncaught.map((error) => error?.code),
    [],
    `stdin must not throw; escaped: ${uncaught.map((e) => `${e?.code}/${e?.syscall}`).join(', ')}`
  );

  // The call still has to fail, and it has to fail with the child's real exit
  // reason -- not with EPIPE, which is a symptom of the exit, not its cause.
  assert.equal(settled, 'rejected', 'a child exiting 3 must still reject the call');

  // Pins the EPIPE branch specifically. Without this the guard is satisfied by
  // any handler that merely stops the crash -- including one that rejects the
  // call WITH the EPIPE -- and the caller would be told the pipe broke instead
  // of that the child exited 3. Verified: widening the code check to something
  // other than EPIPE leaves every assertion above green and only this one red.
  assert.match(
    String(rejection?.message ?? ''),
    /claude -p exit 3/,
    `the call must fail with the child's exit reason, not the pipe symptom; got: ${rejection?.message}`
  );
});
