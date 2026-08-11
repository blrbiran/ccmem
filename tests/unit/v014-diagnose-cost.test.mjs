import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeDaemonCost } from '../../scripts/lib/admin/diagnose.mjs';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function row(over) {
  return {
    ts: NOW - DAY,
    task_type: 'weekly_synthesis',
    output_format: 'json',
    queue_wait_ms: 0,
    wall_clock_ms: 1000,
    exit_code: 0,
    timed_out: false,
    input_tokens: 100,
    output_tokens: 10,
    total_cost_usd: 0.001,
    ...over
  };
}

test('rows outside the window are excluded', () => {
  const got = summarizeDaemonCost([row({ ts: NOW - 30 * DAY }), row()], NOW, 7);
  assert.equal(got.calls, 1);
});

test('tokens and cost are summed across the window', () => {
  const got = summarizeDaemonCost([row(), row({ input_tokens: 400, total_cost_usd: 0.003 })], NOW, 7);
  assert.equal(got.input_tokens, 500);
  assert.equal(got.output_tokens, 20);
  assert.ok(Math.abs(got.total_cost_usd - 0.004) < 1e-9);
});

// The whole reason W4 exists is to answer "what does a steady-state week
// cost". A text-path call contributes a call but no cost, and pretending
// its cost is 0 would understate the answer — so it is counted separately.
test('unmeasured text-path calls are counted, not silently summed as zero', () => {
  const got = summarizeDaemonCost(
    [row(), row({ output_format: 'text', input_tokens: null, output_tokens: null, total_cost_usd: null })],
    NOW,
    7
  );
  assert.equal(got.calls, 2);
  assert.equal(got.unmeasured_calls, 1);
  assert.equal(got.input_tokens, 100);
});

test('a window with no measured call reports null cost, not zero', () => {
  const got = summarizeDaemonCost(
    [row({ output_format: 'text', input_tokens: null, output_tokens: null, total_cost_usd: null })],
    NOW,
    7
  );
  assert.equal(got.total_cost_usd, null);
  assert.equal(got.input_tokens, null);
});

test('calls are broken down by task type', () => {
  const got = summarizeDaemonCost([row(), row({ task_type: 'security_audit' })], NOW, 7);
  assert.deepEqual(got.calls_by_task, { 'weekly_synthesis': 1, 'security_audit': 1 });
});

test('an empty window reports zero calls and null cost rather than throwing', () => {
  const got = summarizeDaemonCost([], NOW, 7);
  assert.equal(got.calls, 0);
  assert.equal(got.total_cost_usd, null);
  assert.equal(got.wall_clock_ms.p50, null);
});
