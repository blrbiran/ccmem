import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-timeout-vis-'));

const STUB_DIR = mkdtempSync(path.join(tmpdir(), 'ccmem-timeout-stub-'));

/**
 * WHY these two fields exist on the cost row (Rule 9).
 *
 * Both come from reading the live daemon-cost.jsonl on 2026-09-07 (n=529
 * summarize_pending rows), where the recorded telemetry could NOT answer the
 * question it was collected for -- "does the wall-clock budget need raising?".
 *
 * 1. `timeout_ms` -- `timed_out: true` conflates two unrelated events. Five
 *    production rows carry wall clocks of 151s / 172s / 1008s / 1318s / 1974s
 *    under budgets of 60s and 120s. A budget cannot be exceeded by 30 minutes:
 *    those are calls whose setTimeout could not fire on time because the
 *    machine slept, not calls that generated too much. Without the budget
 *    stored beside the wall clock, no consumer can separate "the cap bit" from
 *    "the timer was starved", and the cap decision has to fall back on probe
 *    data instead of production. Recording it makes the split mechanical:
 *    wall_clock_ms ~= timeout_ms is a real kill, wall_clock_ms >> timeout_ms
 *    is a starved timer.
 *
 * 2. `stdout_chars` -- all 93 timed-out rows carry `total_cost_usd: null`,
 *    because usage only exists inside the result envelope the child never got
 *    to finish printing. But a killed call has already been billed for every
 *    output token it produced. The number of characters that did arrive is the
 *    only surviving evidence that the call cost anything at all, and it is the
 *    difference between "the cap discarded nothing" and "the cap discarded
 *    four thousand characters of paid-for output".
 */

// A stub that impersonates `claude -p` and then hangs, so the timeout path is
// the one under test. It prints first, so the parent has bytes in hand when
// the timer fires.
const PRINTED_CHARS = 4321;
const HANG_STUB = path.join(STUB_DIR, 'stub-print-then-hang.mjs');
writeFileSync(HANG_STUB, `
process.stdin.resume();
process.stdout.write('x'.repeat(${PRINTED_CHARS}));
setTimeout(() => {}, 60000);
`);

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

function rows() {
  if (!existsSync(daemonCostFile())) return [];
  return readFileSync(daemonCostFile(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

// CCMEM_CLAUDE_P_ARGS_JSON is the only seam that reaches runClaudeP: a
// mockOutput call returns before anything is recorded. process.execPath rather
// than a hard-coded interpreter path so the stub runs under whatever node is
// running the suite.
function withStub(stub, extraArgs = []) {
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub, ...extraArgs]);
}

async function withConfig(config, fn) {
  const previous = process.env.CCMEM_CONFIG_PATH;
  const configPath = path.join(process.env.CCMEM_DATA_ROOT, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  process.env.CCMEM_CONFIG_PATH = configPath;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.CCMEM_CONFIG_PATH;
    else process.env.CCMEM_CONFIG_PATH = previous;
  }
}

test('a killed call records the budget that killed it', async () => {
  withStub(HANG_STUB, ['--output-format', 'json']);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'weekly_synthesis', timeoutMs: 700 }));

  const row = rows().at(-1);
  assert.equal(row.timed_out, true);
  assert.equal(
    row.timeout_ms,
    700,
    'without the budget on the row, a kill at the cap and a timer starved by machine sleep are indistinguishable'
  );
});

test('the recorded budget is the one that actually fired, not the shipped default', async () => {
  const OVERRIDE_MS = 700;
  assert.notEqual(
    DEFAULT_CONFIG.llm.claude_p_timeout_per_task.summarize_pending,
    OVERRIDE_MS,
    'this test is only meaningful while the override differs from the shipped budget'
  );

  await withConfig({ llm: { claude_p_timeout_per_task: { summarize_pending: OVERRIDE_MS } } }, async () => {
    withStub(HANG_STUB, ['--output-format', 'json']);

    await assert.rejects(() => callClaudeP('prompt', { taskType: 'summarize_pending' }));

    const row = rows().at(-1);
    // Reading the shipped default back out instead of the value the timer was
    // armed with would leave every row looking correct while the split above
    // silently used the wrong threshold.
    assert.equal(row.timeout_ms, OVERRIDE_MS);
    assert.ok(
      row.wall_clock_ms < 5000,
      `call ran ${row.wall_clock_ms}ms, so the ${OVERRIDE_MS}ms budget it reported is not the one that fired`
    );
  });
});

test('a killed call records the output it had already generated', async () => {
  withStub(HANG_STUB, ['--output-format', 'json']);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'weekly_synthesis', timeoutMs: 700 }));

  const row = rows().at(-1);
  assert.equal(row.output_format, 'json');
  // Even on the json path the usage never arrives: it lives in an envelope the
  // child was killed before completing. That is exactly why the character
  // count has to stand in for it.
  assert.equal(row.total_cost_usd, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.stdout_chars, PRINTED_CHARS);
});

test.after(() => {
  rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});
