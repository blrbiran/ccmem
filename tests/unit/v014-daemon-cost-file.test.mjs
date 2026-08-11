import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-'));

const { daemonCostFile, recordDaemonCost, recordMetric, metricsFile, MAX_METRICS_BYTES } =
  await import('../../scripts/lib/metrics.mjs');

test('the cost stream is its own file, not metrics.jsonl', () => {
  // The live pre-registered measurement window reads metrics.jsonl. Daemon cost
  // rows landing there would add rotation pressure to the file that window is
  // anchored in, so this separation is load-bearing, not cosmetic.
  assert.notEqual(daemonCostFile(), metricsFile());
  assert.equal(path.basename(daemonCostFile()), 'daemon-cost.jsonl');
});

test('a recorded row is one json line carrying ts plus the event', () => {
  recordDaemonCost({ task_type: 'weekly_synthesis', wall_clock_ms: 1234 });

  const lines = readFileSync(daemonCostFile(), 'utf8').trim().split('\n');
  const row = JSON.parse(lines.at(-1));

  assert.equal(row.task_type, 'weekly_synthesis');
  assert.equal(row.wall_clock_ms, 1234);
  assert.equal(typeof row.ts, 'number');
});

test('an oversized cost file rotates to .1 instead of growing forever', () => {
  const file = daemonCostFile();
  writeFileSync(file, 'x'.repeat(MAX_METRICS_BYTES + 1));

  recordDaemonCost({ task_type: 'security_audit', wall_clock_ms: 1 });

  assert.ok(existsSync(`${file}.1`), 'the oversized generation must be kept as .1');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'the live file must restart with just the new row');
});

// The shared helper is extracted out of recordMetric while a pre-registered
// measurement window is reading metrics.jsonl. If this rotation stops working,
// hook telemetry is silently lost and the window is ruined -- so it gets a
// positive test of its own, on the ORIGINAL writer, not just the new one.
test('recordMetric still rotates metrics.jsonl after the extraction', () => {
  const file = metricsFile();
  writeFileSync(file, 'x'.repeat(MAX_METRICS_BYTES + 1));

  recordMetric({ hook: 'prompt_submit', ms_total: 1 });

  assert.ok(existsSync(`${file}.1`), 'metrics.jsonl must still rotate to .1');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('a write failure never throws at the caller', () => {
  // The daemon tasks must not fail because telemetry could not be written.
  const dir = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-ro-'));
  const prevRoot = process.env.CCMEM_DATA_ROOT;
  process.env.CCMEM_DATA_ROOT = path.join(dir, 'nested');
  chmodSync(dir, 0o500);

  try {
    assert.doesNotThrow(() => recordDaemonCost({ task_type: 't', wall_clock_ms: 1 }));
  } finally {
    chmodSync(dir, 0o700);
    process.env.CCMEM_DATA_ROOT = prevRoot;
  }
});
