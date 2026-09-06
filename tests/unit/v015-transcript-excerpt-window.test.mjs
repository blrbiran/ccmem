import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

/**
 * How much of the session transcript summarize_pending is allowed to look at.
 *
 * WHY this matters, not just what it does (Rule 9): the window is a TAIL, and
 * consecutive calls on one session almost never overlap -- measured over 99
 * sessions / 768 production calls, the new text between adjacent calls has
 * p50 = 3541 chars and only 4.6% of calls saw a gap under 1000. So a 1000-char
 * window did not merely truncate; it left 85% of the transcript unread by any
 * call, permanently.
 *
 * Widening was measured, not assumed (handoff XXXIII, 18 paired endpoints,
 * production-shaped inputs, arm = production flags):
 *   - distinct KEPT ideas per call 6.00 -> 9.11 (paired Wilcoxon p = 0.000412)
 *   - keep-rate 91.7% -> 92.1%: the extra memories are not dilution
 *   - $/kept idea $0.02452 -> $0.02473, i.e. the same unit price
 * Dropping back toward 1000 would trade away half the yield for no unit-price
 * gain, which is why the floor -- not the exact value -- is what is asserted.
 * Raising it further is a judgement call this test must not block.
 */
const MEASURED_WINDOW_CHARS = 4000;

test('summarize_pending reads a transcript window wide enough to be worth its cost', () => {
  const window = DEFAULT_CONFIG.summarize?.transcript_excerpt_max;

  assert.equal(typeof window, 'number', 'summarize must carry its own excerpt window');
  assert.ok(
    window >= MEASURED_WINDOW_CHARS,
    `excerpt window ${window} chars is under the measured ${MEASURED_WINDOW_CHARS}; ` +
      'narrowing it drops distinct kept memories per call without lowering the price of one'
  );
});

test('the shipped config file carries the same excerpt window as the code default', () => {
  const shipped = JSON.parse(readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));

  // v013-config-sync compares key PATHS across the two defaults, never values,
  // so a value can drift on one side alone and every other test stays green.
  // The typeof assertion keeps this test from passing vacuously when BOTH
  // sides are missing the key.
  assert.equal(typeof shipped.summarize?.transcript_excerpt_max, 'number');
  assert.equal(
    shipped.summarize?.transcript_excerpt_max,
    DEFAULT_CONFIG.summarize?.transcript_excerpt_max,
    'a user who copies config.default.json into place must get the window the code was measured with'
  );
});
