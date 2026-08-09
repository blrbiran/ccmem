import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_SUBMIT_BUDGET_MS, HOOK_BUDGET_MS, LEXICAL_FALLBACK_RESERVE_MS, withHookSafety } from '../../scripts/lib/hook-safety.mjs';
import { openaiConfigFrom } from '../../scripts/lib/embedding/openai.mjs';
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HOOK_EVENTS = {
  session_start: 'SessionStart',
  prompt_submit: 'UserPromptSubmit',
  stop: 'Stop'
};

function hookTimeoutSeconds(event) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'hooks/hooks.json'), 'utf8'));
  const entries = manifest.hooks?.[event] ?? manifest[event];
  return entries[0].hooks[0].timeout;
}

/**
 * withHookSafety() exists so a slow turn degrades to an empty context instead
 * of blocking the prompt: it races the work against its own budget, then still
 * writes stdout and a metrics row. None of that can happen if the harness kills
 * the process at the same instant the internal budget expires — the graceful
 * path needs time to run after it fires. Equal values shipped exactly that:
 * users saw "UserPromptSubmit hook timed out after 2s — output discarded",
 * and because the killed process never wrote its metrics row, the latency data
 * showed zero samples over budget. The overruns were the missing rows.
 */
test('every harness timeout leaves room for its budget to degrade', () => {
  for (const [hook, event] of Object.entries(HOOK_EVENTS)) {
    const externalMs = hookTimeoutSeconds(event) * 1000;
    const budget = HOOK_BUDGET_MS[hook];
    assert.ok(
      externalMs > budget,
      `${event}: harness timeout ${externalMs}ms must exceed the internal budget ${budget}ms`
    );
    // Node startup and module loading happen before the internal timer starts
    // and are not counted by ms_total, so the margin has to cover them too.
    assert.ok(
      externalMs - budget >= 1000,
      `${event}: margin ${externalMs - budget}ms is too thin for process startup`
    );
  }
  assert.equal(PROMPT_SUBMIT_BUDGET_MS, HOOK_BUDGET_MS.prompt_submit);
});

/**
 * Documents a limitation, not a desired property — and it is the reason the
 * margin above cannot be treated as slack.
 *
 * withHookSafety races the work against a setTimeout. A timer only fires when
 * the event loop is free, so synchronous work runs to completion no matter how
 * long it takes. ccmem's hooks are mostly synchronous: node:sqlite is a
 * synchronous API, and the stop hook reads the entire transcript before it
 * touches the database. The evidence that this is not theoretical: across 2547
 * production stop-hook runs, ms_business exceeded the 200ms budget 50.2% of the
 * time and the recorded timeout count was zero.
 *
 * Consequence for anyone sizing these numbers: the harness timeout is the only
 * real limit on synchronous work, so it must be sized against the measured p99
 * of the work itself, not against the budget.
 */
test('the internal budget cannot interrupt synchronous work', async () => {
  const budget = 100;
  const started = Date.now();
  let result = null;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exit.bind(process);
  // The callback matters: withHookSafety awaits it before recording metrics.
  process.stdout.write = (_chunk, cb) => { if (typeof cb === 'function') cb(); return true; };
  process.exit = () => {};
  try {
    await withHookSafety('stop', budget, async () => {
      const end = Date.now() + budget * 4;
      while (Date.now() < end) { /* synchronous, exactly like a run of DB calls */ }
      result = 'completed';
      return {};
    });
  } finally {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
  }

  assert.equal(result, 'completed', 'synchronous work runs past its budget');
  assert.ok(Date.now() - started >= budget * 4, 'and it is not cut short');
});

/**
 * The OpenAI SDK retries twice by default, so a timeout is not a budget: an
 * 800ms cap became up to 2400ms of wall clock on the hook path, which is over
 * the whole hook's allowance on its own. Measured embed_ms of 1683ms on a
 * store configured for 800ms is one timeout plus one retry.
 *
 * Retries are not lost here — the backfill re-queues failures by design, and
 * the circuit breaker handles a provider that is down.
 */
test('the OpenAI client does not silently multiply its own timeout', () => {
  const cfg = openaiConfigFrom({ embedding: { openai_timeout_ms: 800 } });
  assert.equal(cfg.timeoutMs, 800);
  assert.equal(cfg.maxRetries, 0, 'a retry turns the timeout into a multiple of itself');
});

/**
 * Raising openai_timeout_ms is safe right up until the point where a timed-out
 * embed plus its lexical fallback can outlive the harness's own kill. Past that
 * line the failure mode changes character: instead of degrading to lexical
 * retrieval, the hook is killed before it can write stdout or its metrics row,
 * so the incident is also invisible afterwards. The internal 2000ms budget does
 * NOT protect this — it has never fired in 3069 prompt_submit rows because it
 * cannot interrupt synchronous work. The harness timeout is the only real limit.
 */
test('a timed-out embed plus its lexical fallback still fits inside the harness kill', () => {
  const harnessMs = hookTimeoutSeconds(HOOK_EVENTS.prompt_submit) * 1000;
  assert.ok(harnessMs > 0, 'UserPromptSubmit must declare a harness timeout');

  const worstCase = DEFAULT_CONFIG.embedding.openai_timeout_ms + LEXICAL_FALLBACK_RESERVE_MS;
  assert.ok(
    worstCase < harnessMs,
    `an embed that times out at ${DEFAULT_CONFIG.embedding.openai_timeout_ms}ms still owes the `
    + `lexical fallback up to ${LEXICAL_FALLBACK_RESERVE_MS}ms, so the worst case is ${worstCase}ms, `
    + `which must stay under the ${harnessMs}ms harness kill`
  );
});
