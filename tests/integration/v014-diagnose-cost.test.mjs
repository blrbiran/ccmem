import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-diagcost-'));
const diagnoseCwd = mkdtempSync(path.join(tmpdir(), 'ccmem-diagcost-cwd-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};
delete env.CCMEM_CONFIG_PATH;

const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');

function runCost(extraArgs = []) {
  return execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--cost', ...extraArgs], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
}

function row(over) {
  return {
    ts: Date.now(),
    task_type: 'weekly_synthesis',
    output_format: 'json',
    queue_wait_ms: 5,
    wall_clock_ms: 1000,
    exit_code: 0,
    timed_out: false,
    input_tokens: 100,
    output_tokens: 10,
    total_cost_usd: 0.001,
    ...over
  };
}

function seed(rows) {
  const body = rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
  writeFileSync(daemonCostFile(), body, 'utf8');
}

// (a) no file at all
test('diagnose --cost: no daemon-cost.jsonl on disk yet', () => {
  rmSync(daemonCostFile(), { force: true });
  const out = runCost();
  assert.match(out, /no daemon-cost data yet/);
  assert.match(out, /not found/);
});

// (b) a file whose rows are all outside the window
test('diagnose --cost: rows exist but none fall inside the window', () => {
  seed([row({ ts: Date.now() - 30 * 86_400_000 })]);
  const out = runCost();
  assert.match(out, /no daemon calls in the trailing 7d/);
  assert.match(out, /1 row\(s\) on disk, all outside the window/);
});

// (c) a populated window
test('diagnose --cost: a populated window prints calls, tokens, and cost', () => {
  seed([row(), row({ input_tokens: 400, output_tokens: 40, total_cost_usd: 0.004 })]);
  const out = runCost();
  assert.match(out, /calls: 2 \(0 unmeasured\)/);
  assert.match(out, /tokens: input=500 output=50/);
  assert.match(out, /total_cost_usd: \$0\.0050/);
});

// (d) unparseable lines present
test('diagnose --cost: unparseable lines are counted and reported, not silently dropped', () => {
  writeFileSync(daemonCostFile(), `${JSON.stringify(row())}\nnot valid json\n`, 'utf8');
  const out = runCost();
  assert.match(out, /1 unparseable line\(s\) skipped/);
  assert.match(out, /calls: 1/);
});

// (e) Finding 1 regression — tokens present, total_cost_usd null. Before the
// fix, the gate keyed off input_tokens alone, so this fell into the "else"
// branch and called null.toFixed(4), crashing the whole subcommand with
// `TypeError: Cannot read properties of null (reading 'toFixed')`.
test('diagnose --cost: a row with tokens but no cost does not crash the printer (Finding 1 regression)', () => {
  seed([row({ input_tokens: 900, output_tokens: 120, total_cost_usd: null })]);
  const out = runCost();
  assert.match(out, /tokens: input=900 output=120/);
  assert.match(out, /total_cost_usd: not measured/);
});

// (e, mirror) Finding 1's silent twin — cost present, tokens absent. Before
// the fix, the same input_tokens==null gate was true, so this printed
// "no measured calls in window (all text-path)" and discarded the one
// number this feature exists to report, without ever throwing.
test('diagnose --cost: a row with cost but no tokens is not silently discarded (Finding 1 regression)', () => {
  seed([row({ input_tokens: null, output_tokens: null, total_cost_usd: 0.0042 })]);
  const out = runCost();
  assert.doesNotMatch(out, /no measured calls/);
  assert.match(out, /tokens: input=not measured output=not measured/);
  assert.match(out, /total_cost_usd: \$0\.0042/);
});

// Finding 2 — unmeasured_calls previously keyed off output_format === 'text'
// only. JSON-path calls that time out carry the exact same all-null tokens
// and must count as unmeasured too, and a failed-call count must be visible
// so a week of nothing but timeouts doesn't read as healthy.
test('diagnose --cost: json-path timeouts count as unmeasured and as failed, not hidden as healthy', () => {
  seed([
    row({ timed_out: true, exit_code: null, input_tokens: null, output_tokens: null, total_cost_usd: null }),
    row({ timed_out: true, exit_code: null, input_tokens: null, output_tokens: null, total_cost_usd: null }),
    row({ timed_out: true, exit_code: null, input_tokens: null, output_tokens: null, total_cost_usd: null })
  ]);
  const out = runCost();
  assert.match(out, /calls: 3 \(3 unmeasured\)/);
  assert.match(out, /failed_calls: 3/);
  assert.match(out, /tokens: input=not measured output=not measured/);
  assert.match(out, /total_cost_usd: not measured/);
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(diagnoseCwd, { recursive: true, force: true });
});
