import test from 'node:test';
import assert from 'node:assert/strict';

import { argsSelectJson, extractUsage } from '../../scripts/lib/claude-p-usage.mjs';

test('argsSelectJson: the text default does not select json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format', 'text']), false);
});

test('argsSelectJson: an explicit json output format selects json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format', 'json']), true);
});

// This is the whole point of the function: CCMEM_CLAUDE_P_ARGS_JSON can select
// json with no jsonSchema in sight, so keying off opts.jsonSchema mis-records.
test('argsSelectJson: json selected without any jsonSchema still counts', () => {
  assert.equal(argsSelectJson(['--output-format', 'json']), true);
});

test('argsSelectJson: a trailing --output-format with no value is not json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format']), false);
});

test('argsSelectJson: a non-array is not json', () => {
  assert.equal(argsSelectJson(undefined), false);
});

test('extractUsage: pulls tokens and cost off the result envelope', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: '{"synthesized":[]}',
    usage: { input_tokens: 1200, output_tokens: 340 },
    total_cost_usd: 0.0123
  });

  assert.deepEqual(extractUsage(stdout), {
    input_tokens: 1200,
    output_tokens: 340,
    total_cost_usd: 0.0123
  });
});

// The text path has no envelope at all. It must read as "not measured",
// never as zero — a zero here would silently understate the weekly cost.
test('extractUsage: plain text yields nulls, not zeros', () => {
  const got = extractUsage('just some prose the model wrote');
  assert.deepEqual(got, { input_tokens: null, output_tokens: null, total_cost_usd: null });
});

test('extractUsage: a json envelope missing usage yields nulls', () => {
  const stdout = JSON.stringify({ type: 'result', result: 'ok' });
  assert.deepEqual(extractUsage(stdout), {
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null
  });
});

test('extractUsage: non-numeric usage values are rejected, not coerced', () => {
  const stdout = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 'lots', output_tokens: null },
    total_cost_usd: 'free'
  });
  assert.deepEqual(extractUsage(stdout), {
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null
  });
});
