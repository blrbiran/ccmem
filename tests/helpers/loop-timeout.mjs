// Tester #461: the guard every daemon-loop test races `mainLoop` against, so a loop that never
// stops fails the test instead of hanging the suite. One budget for all of them: 1000 ms by
// default (what each copy hardcoded), CCMEM_TEST_LOOP_TIMEOUT_MS to change it; scripts/run-tests.sh
// sets 5000 for a suite run, where default concurrency on a loaded machine missed 1000 ms.
//
// The timers are captured at import: some tests replace global setTimeout with a mock, and the
// guard must keep its real budget while they do. The timer is cleared once the race settles, so a
// loop that finishes does not leave the guard holding the event loop open.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const configured = Number(process.env.CCMEM_TEST_LOOP_TIMEOUT_MS);
export const LOOP_TIMEOUT_MS = Number.isFinite(configured) && configured > 0 ? configured : 1000;

export async function raceLoop(loop, ms = LOOP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`loop timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([loop, timeout]);
  } finally {
    realClearTimeout(timer);
  }
}
