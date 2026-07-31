import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-decisionmetrics-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const {
  recordDecisionMetric,
  decisionDataSizeBytes,
  pruneDecisionMetrics,
  MAX_METRICS_BYTES
} = await import('../../scripts/lib/metrics.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function readLines(file) {
  return readFileSync(path.join(dataRoot, file), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('recordDecisionMetric writes to the decision file when enabled', () => {
  recordDecisionMetric({ tag: 'a' }, { enabled: true, file: 'decision-a.jsonl' });
  const rows = readLines('decision-a.jsonl');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, 'a');
  assert.ok(Number.isFinite(rows[0].ts));
});

test('recordDecisionMetric falls back to metrics.jsonl when disabled, never dropping the row', () => {
  recordDecisionMetric({ tag: 'b-unique' }, { enabled: false, file: 'decision-b.jsonl' });

  const metricsRows = readLines('metrics.jsonl');
  assert.ok(metricsRows.some((r) => r.tag === 'b-unique'),
    'a disabled decision stream must still record via the ordinary rotated path, not drop the event');
  assert.throws(() => readLines('decision-b.jsonl'),
    'the decision file must not be created at all when disabled');
});

test('the decision file never rotates, even past MAX_METRICS_BYTES', () => {
  const file = 'decision-c.jsonl';
  writeFileSync(path.join(dataRoot, file), `${'x'.repeat(MAX_METRICS_BYTES + 1000)}\n`, 'utf8');

  recordDecisionMetric({ tag: 'c' }, { enabled: true, file });

  assert.throws(() => statSync(path.join(dataRoot, `${file}.1`)),
    'no rotated generation must ever be created for the decision stream');
  const size = statSync(path.join(dataRoot, file)).size;
  assert.ok(size > MAX_METRICS_BYTES, 'the decision file must be allowed to exceed the runtime-hygiene cap');
});

test('decisionDataSizeBytes reports 0 before any write and the real size after', () => {
  const cfg = { enabled: true, file: 'decision-d.jsonl' };
  assert.equal(decisionDataSizeBytes(cfg), 0);

  recordDecisionMetric({ tag: 'd' }, cfg);

  assert.ok(decisionDataSizeBytes(cfg) > 0);
});

test('pruneDecisionMetrics removes rows older than the cutoff and keeps recent ones', () => {
  const cfg = { enabled: true, file: 'decision-e.jsonl' };
  const now = Date.now();
  writeFileSync(
    path.join(dataRoot, cfg.file),
    [
      JSON.stringify({ ts: now - (10 * 86400000), tag: 'old' }),
      JSON.stringify({ ts: now - (1 * 86400000), tag: 'recent' })
    ].join('\n') + '\n',
    'utf8'
  );

  pruneDecisionMetrics(cfg, now - (5 * 86400000));

  const rows = readLines(cfg.file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, 'recent');
});
