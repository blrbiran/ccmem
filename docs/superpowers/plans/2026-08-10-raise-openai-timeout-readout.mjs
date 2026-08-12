#!/usr/bin/env node
//
// Task 5 read-out for the openai_timeout_ms 800 -> 1200 measurement window.
//
// WHY THIS FILE EXISTS, AND WHY IT IS COMMITTED BEFORE THE DATA IS READ:
// every choice this script makes — which rows are excluded, which z, which
// threshold, what counts as an attempt — is a researcher degree of freedom. A
// pre-registration removes those freedoms only if the analysis is fixed while
// the outcome is still unknown. So this file is written and committed at raw
// n = 137, before the n >= 150 gate opens and before any truncation rate,
// B-fail count, or Wilson interval has ever been computed or displayed.
//
// It implements, and does not extend:
//   …-prereg.md            the frozen pre-registration (byte-unchanged)
//   …-prereg-addendum.md   addenda 1-4 (all ruled and in effect)
//   …-raise-openai-timeout.md  the batch-window table and the daily inspections
//
// If you find yourself editing a constant below at read-out time, stop: that is
// the exact move the pre-registration exists to prevent. Open a new addendum.
//
// Usage:
//   node <this> --selfcheck          run addendum 1's mandatory self-check only
//   node <this> <frozen-snapshot>    run the read-out against a frozen snapshot
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Frozen constants. Every one carries its source. None may be edited here.
// ---------------------------------------------------------------------------

// Addendum 1: exact z, no continuity correction. 1.96 is explicitly forbidden —
// the two differ by <=1.5e-4 pp, but there are 146 (k,n) pairs in n=150..400
// where that flips the first decimal, and the primary outcome is a threshold
// test against 40.3%.
const Z = 1.959963984540054;

// prereg "基线": 66/136 = 48.5%, Wilson95 [40.3%, 56.9%]. Not recomputed here —
// it is the frozen comparator and the self-check target.
const BASELINE_K = 66;
const BASELINE_N = 136;
const SELFCHECK_LO = 0.4028624249;
const SELFCHECK_HI = 0.5685337545;
const SELFCHECK_TOL = 1e-9;

// Addendum 1: compare the upper bound against BOTH readings of the primary
// outcome — the literal "40.3%" and the unrounded baseline lower bound. They
// differ by 0.0139pp; agreement is required before any verdict is allowed.
const THRESHOLD_LITERAL = 0.403;
const THRESHOLD_UNROUNDED = SELFCHECK_LO;

// Addendum 4: sensitivity check against the POST-exclusion baseline's lower
// bound (59/125 = 47.2%, [38.7%, 55.9%], handoff XI.3). Taken from the frozen
// table verbatim — deliberately NOT recomputed, or the check would itself
// become a new degree of freedom.
const THRESHOLD_SENSITIVITY = 0.387;

// prereg "样本量": n >= 150, extended to 300 if the interval still straddles.
const N_GATE = 150;
const N_GATE_EXTENDED = 300;

// Window start, fixed at merge time. Addendum/XII.5: selection is by ts, NOT by
// line number — both select the same rows, but the report must say which.
const WINDOW_START = new Date('2026-08-10T01:53:30+08:00').getTime();

// Abort criterion 2's bar. Criterion 1 is any prompt_submit row with a non-null
// error. Criterion 3 is NOT implemented — see reportCriterion3().
const C2_BAR_MS = 3000;

// Addendum 3: narrow-sense exclusion — full-suite runtime plus >= 60s of
// slack on each side. Handoff I's whole-day rule is for the PROBE and is
// explicitly not applicable here; applying it would exclude 100% of the rows,
// since prompt_submit writes one row per prompt and so every row is by
// construction produced inside an active session.
const EXCLUSION_BUFFER_MS = 60_000;

// The batch windows themselves, recorded as they happened (never reconstructed
// from memory — prereg forbids that). Coverage over the whole window was
// verified on 2026-08-12: 08-10 and the 08-11 daytime genuinely ran no suite,
// so the absence of entries there is real, not a missing record.
const BATCH_WINDOWS = [
  ['2026-08-11T21:09:58+08:00', '2026-08-11T21:10:15+08:00'],
  ['2026-08-11T21:31:32+08:00', '2026-08-11T21:31:49+08:00'],
  ['2026-08-11T21:43:23+08:00', '2026-08-11T21:43:40+08:00'],
  ['2026-08-11T22:03:49+08:00', '2026-08-11T22:04:06+08:00'],
  ['2026-08-11T22:22:40+08:00', '2026-08-11T22:22:57+08:00'],
  ['2026-08-11T22:24:59+08:00', '2026-08-11T22:25:15+08:00']
].map(([from, to]) => ({
  from: new Date(from).getTime() - EXCLUSION_BUFFER_MS,
  to: new Date(to).getTime() + EXCLUSION_BUFFER_MS
}));

// ---------------------------------------------------------------------------
// Wilson score interval — addendum 1's formula, verbatim. No variant.
// ---------------------------------------------------------------------------

function wilson(k, n, z = Z) {
  const p = k / n;
  const d = 1 + ((z * z) / n);
  const center = (p + ((z * z) / (2 * n))) / d;
  const half = (z * Math.sqrt(((p * (1 - p)) / n) + ((z * z) / (4 * n * n)))) / d;
  return { lo: center - half, hi: center + half };
}

// Addendum 1 makes this a precondition, not a test: "对不上就是实现错了，不许继续读数."
function selfCheck() {
  const { lo, hi } = wilson(BASELINE_K, BASELINE_N);
  const loOk = Math.abs(lo - SELFCHECK_LO) < SELFCHECK_TOL;
  const hiOk = Math.abs(hi - SELFCHECK_HI) < SELFCHECK_TOL;
  console.log('addendum-1 self-check (k=66, n=136, z=1.959963984540054):');
  console.log(`  lo = ${lo.toFixed(10)}  expected ${SELFCHECK_LO}  ${loOk ? 'OK' : 'MISMATCH'}`);
  console.log(`  hi = ${hi.toFixed(10)}  expected ${SELFCHECK_HI}  ${hiOk ? 'OK' : 'MISMATCH'}`);
  if (!loOk || !hiOk) {
    console.error('\nABORT: Wilson implementation does not reproduce the frozen baseline endpoints.');
    process.exit(1);
  }
  // Not a gate — reported so the human can see the rounding band that addendum 4
  // inherited but never pinned. See the "unresolved" note at the bottom.
  const post = wilson(59, 125);
  console.log(`  [note] post-exclusion baseline 59/125 lo = ${(post.lo * 100).toFixed(4)}%,`
    + ` addendum 4 pins the displayed 38.7%; band = ${Math.abs((post.lo * 100) - 38.7).toFixed(4)}pp`);
  return true;
}

// ---------------------------------------------------------------------------
// Percentiles. The pre-registration names p99 (criterion 2) and p50/p90
// (secondary outcome) but never pins a method, which is the same class of gap
// addendum 1 closed for z. Rather than silently pick one, compute both and let
// disagreement surface as disagreement.
// ---------------------------------------------------------------------------

function percentiles(sorted, q) {
  if (sorted.length === 0) return { nearestRank: null, linear: null };
  const nearestRank = sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const pos = q * (sorted.length - 1);
  const lowIdx = Math.floor(pos);
  const highIdx = Math.ceil(pos);
  const linear = sorted[lowIdx] + ((sorted[highIdx] - sorted[lowIdx]) * (pos - lowIdx));
  return { nearestRank, linear };
}

// ---------------------------------------------------------------------------
// Snapshot loading. The pre-registration requires a frozen copy: a live file
// grows during the analysis and produces off-by-one inconsistencies.
// ---------------------------------------------------------------------------

function loadSnapshot(snapshotPath) {
  const live = path.join(process.env.CCMEM_DATA_ROOT ?? path.join(os.homedir(), '.claude', 'ccmem'), 'metrics.jsonl');
  if (path.resolve(snapshotPath) === path.resolve(live)) {
    console.error('ABORT: that is the live metrics.jsonl. Copy it to a frozen snapshot first');
    console.error('       (and copy metrics.jsonl.1 alongside it if rotation has happened).');
    process.exit(1);
  }

  const files = [snapshotPath];
  // ts filtering is not immune to rotation: rotation is a renameSync to .1, so
  // rotated rows go silently missing rather than wrong. The guard is reading .1
  // when it exists, plus the freeze.
  if (fs.existsSync(`${snapshotPath}.1`)) files.push(`${snapshotPath}.1`);

  const rows = [];
  let parseFail = 0;
  let lineCount = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      lineCount++;
      try {
        rows.push(JSON.parse(line));
      } catch {
        parseFail++;
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, parseFail, lineCount, files };
}

const inExcluded = (ts) => BATCH_WINDOWS.some((w) => ts >= w.from && ts <= w.to);
const pct = (x) => `${(x * 100).toFixed(4)}%`;

// ---------------------------------------------------------------------------
// Read-out
// ---------------------------------------------------------------------------

function readout(snapshotPath) {
  selfCheck();
  const { rows, parseFail, lineCount, files } = loadSnapshot(snapshotPath);

  const inWindow = rows.filter((r) => r.ts >= WINDOW_START);
  const kept = inWindow.filter((r) => !inExcluded(r.ts));
  const dropped = inWindow.length - kept.length;

  console.log('\n=== provenance (the read-out report MUST carry all of this) ===');
  console.log(`snapshot            : ${files.join(', ')}`);
  console.log(`rotation            : ${files.length > 1 ? 'PRESENT — .1 read alongside' : 'no .1 present'}`);
  console.log(`lines / parse fails : ${lineCount} / ${parseFail}`);
  console.log(`row selection       : ts >= ${WINDOW_START} (2026-08-10 01:53:30), NOT by line number`);
  console.log(`exclusion           : narrow sense (addendum 3), ${BATCH_WINDOWS.length} batch windows +/- ${EXCLUSION_BUFFER_MS / 1000}s`);
  console.log(`rows in window      : ${inWindow.length} -> ${kept.length} after exclusion (${dropped} dropped)`);

  // --- attempts, on the POST-exclusion set (addendum 3) ---------------------
  const ps = kept.filter((r) => r.hook === 'prompt_submit');
  const aRows = ps.filter((r) => r.retrieval_path === 'A');
  const aCacheHits = aRows.filter((r) => r.retrieval_embed_ms === 0);
  const aReal = aRows.filter((r) => r.retrieval_embed_ms !== 0);
  const bFail = ps.filter((r) => r.retrieval_path === 'B-fail');
  // IV.23: 真实尝试 = (A − 缓存命中) + B-fail; B-circuit / B-off never enter the
  // denominator. Cache hits never reached the provider.
  const n = aReal.length + bFail.length;

  console.log('\n=== unlock gate ===');
  console.log(`n (post-exclusion)  : ${n}   gate ${N_GATE}`);

  reportCriteria(kept, ps);

  if (n < N_GATE) {
    console.log('\n=== primary / secondary outcome ===');
    console.log(`数据不足 — n = ${n} < ${N_GATE}. Per the pre-registration, no truncation rate and`);
    console.log('no interval may be computed, displayed, or inferred. Nothing further is printed.');
    return;
  }

  // --- primary outcome ------------------------------------------------------
  const k = bFail.length;
  const rate = k / n;
  const ci = wilson(k, n);
  console.log('\n=== primary outcome (止血) ===');
  console.log(`truncation rate     : ${k}/${n} = ${pct(rate)}`);
  console.log(`Wilson 95%          : [${pct(ci.lo)}, ${pct(ci.hi)}]`);
  console.log(`upper bound         : ${pct(ci.hi)}   (4 decimals, never the rounded display)`);

  const vsLiteral = ci.hi < THRESHOLD_LITERAL;
  const vsUnrounded = ci.hi < THRESHOLD_UNROUNDED;
  const vsSensitivity = ci.hi < THRESHOLD_SENSITIVITY;
  console.log(`  vs 40.3% literal        : ${vsLiteral ? 'below' : 'not below'}`);
  console.log(`  vs 40.2862% unrounded   : ${vsUnrounded ? 'below' : 'not below'}`);
  console.log(`  vs 38.7% sensitivity    : ${vsSensitivity ? 'below' : 'not below'}  (addendum 4)`);

  const straddles = ci.lo <= THRESHOLD_LITERAL && THRESHOLD_LITERAL <= ci.hi;
  if (vsLiteral !== vsUnrounded) {
    console.log('\nVERDICT: 不可判定 — the two readings of the primary threshold disagree');
    console.log('         (addendum 1: 一致才判，不一致就上交). Escalate to the human.');
  } else if (vsLiteral !== vsSensitivity) {
    console.log('\nVERDICT: 不可判定 — the primary threshold and the 38.7% sensitivity check');
    console.log('         disagree (addendum 4 ③). Escalate to the human; do not pick one.');
  } else if (vsLiteral) {
    console.log('\nVERDICT: 达成 — 抬超时确实止住了血 (upper bound below every threshold read).');
  } else if (straddles && n < N_GATE_EXTENDED) {
    console.log(`\nVERDICT: 延长 — the interval still straddles 40.3% and n = ${n} < ${N_GATE_EXTENDED}.`);
    console.log('         The pre-registration requires extending the window, NOT concluding now.');
  } else {
    console.log('\nVERDICT: 未达成 — 效果不足以与基线区分。不许改读点估计。');
  }

  // --- secondary outcome (the round's real product) -------------------------
  const embedMs = aReal.map((r) => r.retrieval_embed_ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const inBand = embedMs.filter((v) => v > 800 && v <= 1200);
  const p50 = percentiles(embedMs, 0.5);
  const p90 = percentiles(embedMs, 0.9);
  console.log('\n=== secondary outcome: A-path embedMs ===');
  console.log(`n (A minus cache hits): ${embedMs.length}   [cache hits excluded: ${aCacheHits.length}]`);
  if (embedMs.length > 0) {
    console.log(`min / max             : ${embedMs[0]} / ${embedMs[embedMs.length - 1]}`);
    console.log(`p50                   : nearest-rank ${p50.nearestRank}, linear ${p50.linear}`);
    console.log(`p90                   : nearest-rank ${p90.nearestRank}, linear ${p90.linear}`);
    console.log(`P(800 < embedMs <= 1200): ${inBand.length}/${embedMs.length} = ${pct(inBand.length / embedMs.length)}`);
  }
  console.log('⚠️  Anything above 1200 is still truncated. Do NOT extrapolate any quantile past 1200.');
}

function reportCriteria(kept, ps) {
  console.log('\n=== abort criteria ===');
  const c1 = ps.filter((r) => r.error !== null && r.error !== undefined);
  console.log(`criterion 1 (error!==null): ${c1.length} hit(s)`);

  const ms = kept.map((r) => r.ms_total).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const p99 = percentiles(ms, 0.99);
  console.log(`criterion 2 (p99 > ${C2_BAR_MS}ms): nearest-rank ${p99.nearestRank}, linear ${p99.linear}`);
  if (p99.nearestRank !== null && ((p99.nearestRank > C2_BAR_MS) !== (p99.linear > C2_BAR_MS))) {
    console.log('  🔴 the two percentile methods land on OPPOSITE sides of the bar, and the');
    console.log('     pre-registration never pinned a method => 不可判定, escalate to the human.');
  }
  reportCriterion3();
}

// Addendum 2, ruled 2026-08-10: criterion 3 pins a field that is constantly
// true on a healthy baseline (additional_context_empty measures which channel
// was used, not emptiness), and all three candidate proxies fire at 6.9%-100%
// on healthy data. The ruling was NOT to swap it: it is recorded as
// un-operationalizable and never executed. The report must say so out loud —
// silence would read as "it passed".
function reportCriterion3() {
  console.log('criterion 3               : 不可操作化、未执行 (addendum 2 ruling, 2026-08-10).');
  console.log('  NOT executed, NOT silently replaced, and NOT to be assumed passed.');
}

const arg = process.argv[2];
if (arg === '--selfcheck') {
  selfCheck();
  console.log('\nself-check only — no window data was read.');
} else if (!arg) {
  console.error('usage: node <this> --selfcheck | node <this> <frozen-snapshot-path>');
  process.exit(1);
} else {
  readout(arg);
}

// ---------------------------------------------------------------------------
// 🔴 UNRESOLVED, surfaced rather than silently decided (candidates for an
//    addendum 5, to be ruled BEFORE this script is run against real data):
//
// 1. Percentile method is not pinned anywhere in the pre-registration, yet
//    criterion 2 is a threshold test on p99. This is the same class of gap
//    addendum 1 closed for z. Handled here by computing both nearest-rank and
//    linear interpolation and escalating if they straddle the bar — but that is
//    a report-time guard, not a ruling.
// 2. Addendum 4 pins the sensitivity threshold as the displayed "38.7%", which
//    inherits exactly the rounding band addendum 1 identified for 40.3%. The
//    band is printed by the self-check. Nobody has ruled which value binds if
//    the upper bound lands inside it.
// ---------------------------------------------------------------------------
