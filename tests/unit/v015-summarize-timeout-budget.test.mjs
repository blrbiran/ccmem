import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

/**
 * The wall-clock budget for summarize_pending.
 *
 * WHY this matters, not just what it does (Rule 9): killing the call does not
 * refund it. Cost is metered purely on tokens -- a least-squares fit over 20
 * production-shaped calls recovered $10.00/$0.50/$25.00 per Mtok for
 * cache_creation/cache_read/output with ZERO residual -- so a call SIGTERM'd
 * mid-generation has already paid for its input and for every output token it
 * produced, and yields nothing. A budget below the real tail therefore buys
 * silence, not savings.
 *
 * Measured (handoff XXXII, n=20, arm = production config): 5/20 calls exceeded
 * 60s, 0/20 exceeded 120s, p100 = 116.2s. Raising 60s -> 120s moved effective
 * extraction from 5.75 to 8.20 items per attempt (+43%) for +5% spend per
 * attempt, and cut $/item by 26%.
 *
 * The floor is asserted rather than the exact value: raising it further is a
 * judgement call this test must not block, but dropping back under the
 * measured tail re-creates the pay-and-discard regime this change removed.
 */
const MEASURED_TAIL_MS = 120_000;

test('summarize_pending is budgeted past its measured wall-clock tail', () => {
  const budget = DEFAULT_CONFIG.llm?.claude_p_timeout_per_task?.summarize_pending;

  assert.equal(typeof budget, 'number', 'summarize_pending must carry its own budget');
  assert.ok(
    budget >= MEASURED_TAIL_MS,
    `budget ${budget}ms is under the measured p100 of ${MEASURED_TAIL_MS}ms; ` +
      'calls cut off there are billed for the output they already generated and return zero memories'
  );
});

test('the shipped config file carries the same budget as the code default', () => {
  const shipped = JSON.parse(readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));

  // v013-config-sync compares key PATHS across the two defaults, never values,
  // so a value can drift on one side alone and every other test stays green.
  assert.equal(
    shipped.llm?.claude_p_timeout_per_task?.summarize_pending,
    DEFAULT_CONFIG.llm?.claude_p_timeout_per_task?.summarize_pending,
    'a user who copies config.default.json into place must get the budget the code was measured with'
  );
});
