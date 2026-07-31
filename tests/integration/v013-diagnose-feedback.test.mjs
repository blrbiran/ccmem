import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-diagfb-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdDiagnoseFeedback } = await import('../../scripts/lib/admin/diagnose.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function captureStdout(work) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { work(); } finally { process.stdout.write = original; }
  return chunks.join('');
}

function probeRow(overrides) {
  return JSON.stringify({
    ts: Date.now(),
    hook: 'stop',
    l25_probe: true,
    session_id: 's-1',
    prompt_idx: 1,
    turn_aligned: true,
    mem_id: 1,
    mem_type: 'rule',
    mem_source: 'auto_inferred',
    l25_cov: 0.1,
    l25_lcp: 1,
    l25_id_literal: false,
    l25_legacy_hit: false,
    has_cjk: false,
    mem_len: 40,
    mem_tokens: 6,
    reply_len: 200,
    ...overrides
  });
}

// Reset both candidate files between tests so a wrong-file bug in one test
// can't be masked by leftover state from a previous one.
function resetFiles() {
  writeFileSync(path.join(dataRoot, 'l25-probe.jsonl'), '', 'utf8');
  writeFileSync(path.join(dataRoot, 'metrics.jsonl'), '', 'utf8');
}

function withConfig(configObj, work) {
  const configPath = path.join(dataRoot, `config-${Math.floor(Math.random() * 1e9)}.json`);
  writeFileSync(configPath, JSON.stringify(configObj), 'utf8');
  const previous = process.env.CCMEM_CONFIG_PATH;
  process.env.CCMEM_CONFIG_PATH = configPath;
  try {
    return work();
  } finally {
    if (previous == null) delete process.env.CCMEM_CONFIG_PATH;
    else process.env.CCMEM_CONFIG_PATH = previous;
  }
}

test('diagnose --feedback (decision stream, default config): reads l25-probe.jsonl, segments turn_aligned and has_cjk, never metrics.jsonl', () => {
  resetFiles();

  // Decision stream: 4 rows — 2 turn-aligned non-CJK, 1 turn-aligned CJK, 1 negative control.
  const decisionRows = [
    probeRow({ mem_id: 1, l25_cov: 0.10, l25_lcp: 1, l25_id_literal: false, l25_legacy_hit: false, has_cjk: false, turn_aligned: true }),
    probeRow({ mem_id: 2, l25_cov: 0.20, l25_lcp: 2, l25_id_literal: false, l25_legacy_hit: false, has_cjk: false, turn_aligned: true }),
    probeRow({ mem_id: 3, l25_cov: 0.95, l25_lcp: 9, l25_id_literal: true, l25_legacy_hit: true, has_cjk: true, turn_aligned: true }),
    probeRow({ mem_id: 4, l25_cov: 0.05, l25_lcp: 1, l25_id_literal: false, l25_legacy_hit: false, has_cjk: false, turn_aligned: false })
  ];
  writeFileSync(path.join(dataRoot, 'l25-probe.jsonl'), `${decisionRows.join('\n')}\n`, 'utf8');

  // A DIFFERENT sample count in metrics.jsonl. If cmdDiagnoseFeedback ever
  // read this file instead of (or in addition to) the decision stream, the
  // "samples: 4 total" assertion below would fail — this is the bait that
  // catches a wrong-file regression.
  const wrongFileRows = [probeRow({ mem_id: 999, l25_cov: 0.5, l25_lcp: 3 })];
  writeFileSync(path.join(dataRoot, 'metrics.jsonl'), `${wrongFileRows.join('\n')}\n`, 'utf8');

  const out = captureStdout(() => cmdDiagnoseFeedback(openDb(), { days: 7 }));

  assert.match(out, /l25-probe\.jsonl/);
  assert.match(out, /samples:\s*4 total \(3 turn-aligned, 1 negative-control\)/);
  assert.match(out, /Negative control/);
  assert.match(out, /\d+ bytes/); // decision file size is surfaced

  // Cohort headers, anchored to the exact 4-space indent + label so
  // "non-CJK (n=1)" (negative control) can never satisfy an assertion meant
  // for "CJK (n=1)" (aligned) via unanchored substring matching — both
  // strings legitimately appear in this output.
  assert.match(out, /^ {4}non-CJK \(n=2\)$/m); // aligned non-CJK: rows 1,2
  assert.match(out, /^ {4}CJK \(n=1\)$/m); // aligned CJK: row 3
  assert.match(out, /^ {4}non-CJK \(n=1\)$/m); // negative-control non-CJK: row 4
  assert.match(out, /^ {4}CJK \(n=0\)$/m); // negative-control CJK: none

  assert.match(out, /legacy hits:\s*0\/2/); // non-CJK aligned cohort
  assert.match(out, /legacy hits:\s*1\/1/); // CJK aligned cohort
  assert.match(out, /no legacy hits/i);

  // Exact quantile lines, pinned per cohort. These close three failure
  // modes that pure count/ratio assertions above cannot see:
  //  - quantile() collapsing to the min (e.g. `sorted[0]` for every
  //    percentile): the 2-row non-CJK cohort's max (0.200/2.000) would
  //    incorrectly read the same as its p50 (0.100/1.000).
  //  - l25_cov/l25_lcp field labels swapped: the CJK cohort's cov line
  //    (0.950) is numerically distinguishable from its lcp line (9.000),
  //    so a swap prints the wrong number under each label.
  //  - `Number(r[field]) || 0` silently zeroed: every value below is
  //    non-zero, so a always-0 mutation cannot produce any of these lines.
  assert.match(
    out,
    /non-CJK \(n=2\)\n {6}l25_cov: p50=0\.100 p75=0\.100 p90=0\.100 p95=0\.100 max=0\.200\n {6}l25_lcp: p50=1\.000 p75=1\.000 p90=1\.000 p95=1\.000 max=2\.000/
  );
  assert.match(
    out,
    /CJK \(n=1\)\n {6}l25_cov: p50=0\.950 p75=0\.950 p90=0\.950 p95=0\.950 max=0\.950\n {6}l25_lcp: p50=9\.000 p75=9\.000 p90=9\.000 p95=9\.000 max=9\.000/
  );
});

test('diagnose --feedback degrades gracefully with no decision-stream samples', () => {
  resetFiles();
  const out = captureStdout(() => cmdDiagnoseFeedback(openDb(), { days: 7 }));
  assert.match(out, /no L2\.5 probe samples/i);
});

test('diagnose --feedback (decision_data.enabled=false): falls back to readMetricsLines(days), ignores l25-probe.jsonl, applies the day window', () => {
  resetFiles();

  // l25-probe.jsonl has a DIFFERENT sample count (3, vs. 1 expected from the
  // metrics.jsonl window below). With decision_data disabled the report must
  // NOT read this file — a count mismatch is what catches a file-selection
  // bug here, not just an equal-by-coincidence total.
  writeFileSync(
    path.join(dataRoot, 'l25-probe.jsonl'),
    [
      probeRow({ mem_id: 777, l25_cov: 0.5, l25_lcp: 3 }),
      probeRow({ mem_id: 778, l25_cov: 0.6, l25_lcp: 4 }),
      probeRow({ mem_id: 779, l25_cov: 0.7, l25_lcp: 5 })
    ].join('\n') + '\n',
    'utf8'
  );

  const now = Date.now();
  const inWindow = JSON.parse(probeRow({ mem_id: 1, l25_cov: 0.3, l25_lcp: 2, has_cjk: false }));
  inWindow.ts = now;
  const outOfWindow = JSON.parse(probeRow({ mem_id: 2, l25_cov: 0.9, l25_lcp: 5, has_cjk: false }));
  outOfWindow.ts = now - (10 * 86400000); // 10 days ago, outside a 7-day window
  writeFileSync(
    path.join(dataRoot, 'metrics.jsonl'),
    `${JSON.stringify(inWindow)}\n${JSON.stringify(outOfWindow)}\n`,
    'utf8'
  );

  const out = withConfig(
    { metrics: { decision_data: { enabled: false } } },
    () => captureStdout(() => cmdDiagnoseFeedback(openDb(), { days: 7 }))
  );

  assert.match(out, /metrics\.jsonl fallback/);
  // If the decision-stream row (mem_id 777) had leaked in, or the
  // out-of-window row had not been filtered by `days`, this would read
  // "2 total" instead of "1 total" — that's the proof this reads the right
  // file AND applies the day window, unlike the decision-stream path.
  assert.match(out, /samples:\s*1 total \(1 turn-aligned, 0 negative-control\)/);
});
