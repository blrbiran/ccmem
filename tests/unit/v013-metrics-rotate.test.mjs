import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Helper to capture stderr during test execution
function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  const captured = [];

  process.stderr.write = function (str, ...args) {
    captured.push(str);
    return originalWrite.call(process.stderr, str, ...args);
  };

  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }

  return captured.join('');
}

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-metrics-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { recordMetric, MAX_METRICS_BYTES } = await import('../../scripts/lib/metrics.mjs');

const metricsFile = path.join(dataRoot, 'metrics.jsonl');
const rotatedFile = `${metricsFile}.1`;

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('recordMetric writes without a rotated file present', () => {
  recordMetric({ hook: 'test', n: 1 });
  assert.ok(existsSync(metricsFile));
  assert.equal(existsSync(rotatedFile), false);
  const line = JSON.parse(readFileSync(metricsFile, 'utf8').trim());
  assert.equal(line.hook, 'test');
  assert.ok(Number.isFinite(line.ts), 'recordMetric must stamp ts');
});

test('recordMetric rotates once the file exceeds the cap', () => {
  // Fill past the cap so the NEXT write triggers rotation.
  writeFileSync(metricsFile, 'x'.repeat(MAX_METRICS_BYTES + 1), 'utf8');

  recordMetric({ hook: 'after-rotate', n: 2 });

  assert.ok(existsSync(rotatedFile), 'oversized file must move to .1');
  assert.ok(statSync(metricsFile).size < MAX_METRICS_BYTES,
    'the live file must be small again after rotation');
  const line = JSON.parse(readFileSync(metricsFile, 'utf8').trim());
  assert.equal(line.hook, 'after-rotate');
});

test('a second rotation overwrites .1 rather than accumulating generations', () => {
  writeFileSync(rotatedFile, 'old-generation\n', 'utf8');
  writeFileSync(metricsFile, 'y'.repeat(MAX_METRICS_BYTES + 1), 'utf8');

  recordMetric({ hook: 'second-rotate', n: 3 });

  assert.equal(readFileSync(rotatedFile, 'utf8').includes('old-generation'), false,
    '.1 must be replaced, not appended to');
  assert.equal(existsSync(`${metricsFile}.2`), false, 'no .2 generation should be created');
});

test('readMetricsLines includes rows from the rotated generation', async () => {
  const { readMetricsLines } = await import('../../scripts/lib/admin/diagnose.mjs');
  const now = Date.now();
  writeFileSync(rotatedFile, `${JSON.stringify({ ts: now, hook: 'from-rotated' })}\n`, 'utf8');
  writeFileSync(metricsFile, `${JSON.stringify({ ts: now, hook: 'from-live' })}\n`, 'utf8');

  const hooks = readMetricsLines(7).map((r) => r.hook);
  assert.ok(hooks.includes('from-rotated'), 'rotated generation must be read');
  assert.ok(hooks.includes('from-live'), 'live file must be read');
});

test('recordMetric logs stderr when rotation fails with non-ENOENT error', () => {
  // Clean up rotatedFile first (may exist from previous test)
  rmSync(rotatedFile, { recursive: true, force: true });

  // Create oversized metrics.jsonl so rotation is actually attempted
  writeFileSync(metricsFile, Buffer.alloc(MAX_METRICS_BYTES + 1, 0x61));

  // Make the rotation target a directory, which will cause renameSync to fail
  // with a non-ENOENT error (ENOTEMPTY, EISDIR, or ENOTDIR depending on platform)
  mkdirSync(rotatedFile, { recursive: true });

  const stderr = captureStderr(() => {
    recordMetric({ hook: 'rotation-fails', n: 5 });
  });

  // Assert the actual stderr from recordMetric, not inline logic
  assert.ok(stderr.includes('rotation failed'), 'stderr must warn about rotation failure');
  assert.ok(stderr.includes('size cap not enforced'), 'stderr must explain the consequence');

  // Clean up: remove the directory so later tests are not affected
  rmSync(rotatedFile, { recursive: true, force: true });
});

test('readMetricsLines rejects rows with string ts even when numerically in range', async () => {
  const { readMetricsLines } = await import('../../scripts/lib/admin/diagnose.mjs');
  const now = Date.now();

  // Clear the metrics files for this test to isolate it
  rmSync(metricsFile, { force: true });
  rmSync(rotatedFile, { force: true });

  // Write test data: a stringy timestamp that IS numerically in range
  // The old buggy Number() coercion would have accepted this; strict typeof rejects it
  writeFileSync(metricsFile,
    `${JSON.stringify({ ts: String(now), hook: 'string-ts' })}\n` +
    `${JSON.stringify({ ts: now, hook: 'numeric-ts' })}\n`, 'utf8');

  const hooks = readMetricsLines(7).map((r) => r.hook);
  assert.equal(hooks.includes('string-ts'), false,
    'a string ts must be rejected even when numerically in range — this is what the old Number() coercion got wrong');
  assert.ok(hooks.includes('numeric-ts'), 'a numeric in-range ts must still be included');
});
