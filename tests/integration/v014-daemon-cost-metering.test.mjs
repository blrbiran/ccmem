import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-int-'));

const STUB_DIR = mkdtempSync(path.join(tmpdir(), 'ccmem-stub-'));

// A stub that impersonates `claude -p --output-format json`. We drive it
// through CCMEM_CLAUDE_P_COMMAND / CCMEM_CLAUDE_P_ARGS_JSON because that is
// the ONLY seam that reaches runClaudeP: callClaudeP returns on opts.mockOutput
// at claude-p.mjs:180-182, before the recording point ever runs.
const JSON_STUB = path.join(STUB_DIR, 'stub-json.mjs');
writeFileSync(JSON_STUB, `
process.stdin.resume();
process.stdout.write(JSON.stringify({
  type: 'result',
  result: '{"ok":true}',
  usage: { input_tokens: 900, output_tokens: 120 },
  total_cost_usd: 0.0042
}));
process.exit(0);
`);

const TEXT_STUB = path.join(STUB_DIR, 'stub-text.mjs');
writeFileSync(TEXT_STUB, `
process.stdin.resume();
process.stdout.write('plain prose, no envelope');
process.exit(0);
`);

const FAIL_STUB = path.join(STUB_DIR, 'stub-fail.mjs');
writeFileSync(FAIL_STUB, `
process.stdin.resume();
process.stderr.write('boom');
process.exit(3);
`);

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');

function rows() {
  if (!existsSync(daemonCostFile())) return [];
  return readFileSync(daemonCostFile(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function withStub(stub, extraArgs = []) {
  process.env.CCMEM_CLAUDE_P_COMMAND = '/usr/local/bin/node';
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub, ...extraArgs]);
}

test('a json-path call records tokens and cost', async () => {
  const before = rows().length;
  withStub(JSON_STUB, ['--output-format', 'json']);

  await callClaudeP('prompt', { taskType: 'weekly_synthesis' });

  const row = rows().at(-1);
  assert.equal(rows().length, before + 1);
  assert.equal(row.task_type, 'weekly_synthesis');
  assert.equal(row.output_format, 'json');
  assert.equal(row.input_tokens, 900);
  assert.equal(row.output_tokens, 120);
  assert.equal(row.total_cost_usd, 0.0042);
  assert.equal(row.exit_code, 0);
  assert.equal(row.timed_out, false);
  assert.ok(typeof row.wall_clock_ms === 'number' && row.wall_clock_ms >= 0);
  assert.ok(typeof row.queue_wait_ms === 'number' && row.queue_wait_ms >= 0);
});

test('a text-path call records null tokens, never zero', async () => {
  withStub(TEXT_STUB);

  await callClaudeP('prompt', { taskType: 'security_audit' });

  const row = rows().at(-1);
  assert.equal(row.output_format, 'text');
  // Zero here would silently understate the weekly cost. It must read as
  // "not measured".
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.total_cost_usd, null);
});

test('a non-zero exit still records a row, with its exit code', async () => {
  withStub(FAIL_STUB);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'contradiction_audit' }));

  const row = rows().at(-1);
  assert.equal(row.task_type, 'contradiction_audit');
  assert.equal(row.exit_code, 3);
  assert.equal(row.timed_out, false);
});

test('a timeout records timed_out with a null exit code', async () => {
  const HANG_STUB = path.join(STUB_DIR, 'stub-hang.mjs');
  writeFileSync(HANG_STUB, 'process.stdin.resume(); setTimeout(() => {}, 60000);');
  withStub(HANG_STUB);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'monthly_meta_synthesis', timeoutMs: 300 }));

  const row = rows().at(-1);
  assert.equal(row.timed_out, true);
  // SIGTERM leaves no exit code. Recording 0 here would read as success.
  assert.equal(row.exit_code, null);
});

test('a mockOutput call records nothing', async () => {
  const before = rows().length;

  await callClaudeP('prompt', { taskType: 'weekly_synthesis', mockOutput: 'canned' });

  assert.equal(rows().length, before, 'mocked calls never spawn, so they have no cost to record');
});
