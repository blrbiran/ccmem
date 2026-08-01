import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_SUBMIT_BUDGET_MS } from '../../scripts/lib/hook-safety.mjs';
import { openaiConfigFrom } from '../../scripts/lib/embedding/openai.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
test('the harness timeout leaves room for the internal budget to degrade', () => {
  const externalMs = hookTimeoutSeconds('UserPromptSubmit') * 1000;
  assert.ok(
    externalMs > PROMPT_SUBMIT_BUDGET_MS,
    `harness timeout ${externalMs}ms must exceed the internal budget ${PROMPT_SUBMIT_BUDGET_MS}ms`
  );
  // Node startup and module loading happen before the internal timer starts and
  // are not counted by ms_total, so the margin has to cover them too.
  assert.ok(
    externalMs - PROMPT_SUBMIT_BUDGET_MS >= 1000,
    `margin ${externalMs - PROMPT_SUBMIT_BUDGET_MS}ms is too thin for process startup`
  );
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
