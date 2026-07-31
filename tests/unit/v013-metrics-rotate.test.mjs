import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
