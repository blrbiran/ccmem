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

const metricsPath = path.join(dataRoot, 'metrics.jsonl');
const rotatedFile = `${metricsPath}.1`;

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('recordMetric writes without a rotated file present', () => {
  recordMetric({ hook: 'test', n: 1 });
  assert.ok(existsSync(metricsPath));
  assert.equal(existsSync(rotatedFile), false);
  const line = JSON.parse(readFileSync(metricsPath, 'utf8').trim());
  assert.equal(line.hook, 'test');
  assert.ok(Number.isFinite(line.ts), 'recordMetric must stamp ts');
});

test('recordMetric rotates once the file exceeds the cap', () => {
  // Fill past the cap so the NEXT write triggers rotation.
  writeFileSync(metricsPath, 'x'.repeat(MAX_METRICS_BYTES + 1), 'utf8');

  recordMetric({ hook: 'after-rotate', n: 2 });

  assert.ok(existsSync(rotatedFile), 'oversized file must move to .1');
  assert.ok(statSync(metricsPath).size < MAX_METRICS_BYTES,
    'the live file must be small again after rotation');
  const line = JSON.parse(readFileSync(metricsPath, 'utf8').trim());
  assert.equal(line.hook, 'after-rotate');
});

test('a second rotation overwrites .1 rather than accumulating generations', () => {
  writeFileSync(rotatedFile, 'old-generation\n', 'utf8');
  writeFileSync(metricsPath, 'y'.repeat(MAX_METRICS_BYTES + 1), 'utf8');

  recordMetric({ hook: 'second-rotate', n: 3 });

  assert.equal(readFileSync(rotatedFile, 'utf8').includes('old-generation'), false,
    '.1 must be replaced, not appended to');
  assert.equal(existsSync(`${metricsPath}.2`), false, 'no .2 generation should be created');
});

test('readMetricsLines includes rows from the rotated generation', async () => {
  const { readMetricsLines } = await import('../../scripts/lib/admin/diagnose.mjs');
  const now = Date.now();
  writeFileSync(rotatedFile, `${JSON.stringify({ ts: now, hook: 'from-rotated' })}\n`, 'utf8');
  writeFileSync(metricsPath, `${JSON.stringify({ ts: now, hook: 'from-live' })}\n`, 'utf8');

  const hooks = readMetricsLines(7).map((r) => r.hook);
  assert.ok(hooks.includes('from-rotated'), 'rotated generation must be read');
  assert.ok(hooks.includes('from-live'), 'live file must be read');
});

test('recordMetric logs stderr when rotation fails with non-ENOENT error', (t) => {
  // This test deliberately turns `${metricsPath}.1` into a DIRECTORY. Cleanup
  // must run even when an assertion below throws, or every later test that
  // touches that path dies with EISDIR — the reviewer reproduced that cascade
  // twice during mutation testing, each time adding a spurious failure of a
  // DIFFERENT test and sending the debugger to the wrong place.
  t.after(() => rmSync(rotatedFile, { recursive: true, force: true }));
  rmSync(rotatedFile, { recursive: true, force: true });

  // Create oversized metrics.jsonl so rotation is actually attempted
  writeFileSync(metricsPath, Buffer.alloc(MAX_METRICS_BYTES + 1, 0x61));

  // Make the rotation target a directory, which will cause renameSync to fail
  // with a non-ENOENT error (ENOTEMPTY, EISDIR, or ENOTDIR depending on platform)
  mkdirSync(rotatedFile, { recursive: true });

  const stderr = captureStderr(() => {
    recordMetric({ hook: 'rotation-fails', n: 5 });
  });

  // Assert the actual stderr from recordMetric, not inline logic
  assert.ok(stderr.includes('rotation failed'), 'stderr must warn about rotation failure');
  assert.ok(stderr.includes('size cap not enforced'), 'stderr must explain the consequence');
});

test('readMetricsLines rejects rows with string ts even when numerically in range', async () => {
  const { readMetricsLines } = await import('../../scripts/lib/admin/diagnose.mjs');
  const now = Date.now();

  // Clear the metrics files for this test to isolate it. `recursive: true` is
  // load-bearing: an earlier test in this file creates a DIRECTORY at
  // rotatedFile, and rmSync without it throws EISDIR — which surfaces as a
  // failure of THIS test rather than of the one that left the directory behind.
  rmSync(metricsPath, { recursive: true, force: true });
  rmSync(rotatedFile, { recursive: true, force: true });

  // Write test data: a stringy timestamp that IS numerically in range
  // The old buggy Number() coercion would have accepted this; strict typeof rejects it
  writeFileSync(metricsPath,
    `${JSON.stringify({ ts: String(now), hook: 'string-ts' })}\n` +
    `${JSON.stringify({ ts: now, hook: 'numeric-ts' })}\n`, 'utf8');

  const hooks = readMetricsLines(7).map((r) => r.hook);
  assert.equal(hooks.includes('string-ts'), false,
    'a string ts must be rejected even when numerically in range — this is what the old Number() coercion got wrong');
  assert.ok(hooks.includes('numeric-ts'), 'a numeric in-range ts must still be included');
});

// I10. The metrics path was derived two ways — metrics.mjs joined it onto
// getDataRoot(), diagnose.mjs regex-replaced it out of getDbPath(). Equivalent
// today, and the same drift hazard Task 4 fixed for the decision stream: a
// writer and a reader silently pointing at different files. One exported
// definition, both sides.
test('the writer and the reader resolve the same metrics path from one definition', async () => {
  const { metricsFile } = await import('../../scripts/lib/metrics.mjs');
  const diagnoseSrc = readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/lib/admin/diagnose.mjs'),
    'utf8'
  );

  assert.equal(metricsFile(), metricsPath,
    'the exported path must be the one this file has been asserting against all along');
  assert.equal(diagnoseSrc.includes("replace(/global\\.db$/, 'metrics.jsonl')"), false,
    'diagnose must not re-derive the metrics path; it must import metricsFile()');
});
