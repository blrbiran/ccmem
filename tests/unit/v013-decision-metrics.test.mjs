import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// I7. This function rewrites the release's central artifact. Reading the whole
// file and writeFileSync-ing over the original means a crash or a full disk
// mid-write destroys the entire decision stream — the data v0.14's threshold
// depends on, which recent_injections' retention already destroyed once.
test('pruneDecisionMetrics never truncates the original: it writes a temp file and renames', () => {
  const cfg = { enabled: true, file: 'decision-atomic.jsonl' };
  const target = path.join(dataRoot, cfg.file);
  const now = Date.now();
  writeFileSync(target, [
    JSON.stringify({ ts: now - (10 * 86400000), tag: 'old' }),
    JSON.stringify({ ts: now, tag: 'keep' })
  ].join('\n') + '\n', 'utf8');

  // A directory at the temp path makes writeFileSync fail. If the
  // implementation wrote to the target first, the stream would already be gone
  // by the time it threw; writing to a temp file first means the original is
  // still intact.
  mkdirSync(`${target}.tmp`, { recursive: true });
  try {
    assert.throws(() => pruneDecisionMetrics(cfg, now - (5 * 86400000)),
      'a failed prune must surface, not silently leave a half-written stream');
  } finally {
    rmSync(`${target}.tmp`, { recursive: true, force: true });
  }

  const survived = readLines(cfg.file);
  assert.equal(survived.length, 2,
    'the original stream must be byte-intact after a failed prune — this is the whole point of the temp-file write');

  // And the happy path still prunes.
  pruneDecisionMetrics(cfg, now - (5 * 86400000));
  assert.deepEqual(readLines(cfg.file).map((r) => r.tag), ['keep']);
  assert.throws(() => statSync(`${target}.tmp`), 'the temp file must not be left behind');
});

test('pruneDecisionMetrics reports unparseable lines instead of deleting them silently', () => {
  const cfg = { enabled: true, file: 'decision-torn.jsonl' };
  const now = Date.now();
  // A line torn by a concurrent appendFileSync. Dropping it without a word
  // means permanent, invisible data loss from the one file that must not lose
  // data.
  writeFileSync(path.join(dataRoot, cfg.file), [
    JSON.stringify({ ts: now, tag: 'good' }),
    '{"ts":17600000000',
    JSON.stringify({ ts: now, tag: 'also-good' })
  ].join('\n') + '\n', 'utf8');

  const original = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    pruneDecisionMetrics(cfg, now - 86400000);
  } finally {
    process.stderr.write = original;
  }

  const warning = captured.join('');
  assert.match(warning, /1 unparseable line/,
    'the count of dropped lines must be stated, not swallowed');
  assert.match(warning, /decision-torn\.jsonl/, 'the warning must name the file it damaged');
  assert.deepEqual(readLines(cfg.file).map((r) => r.tag), ['good', 'also-good']);
});
