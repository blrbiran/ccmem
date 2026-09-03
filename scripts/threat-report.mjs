import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPayloads } from '../tests/fixtures/threat-payloads/load.mjs';
import { evaluateTier1, evaluateTier2, evaluateTier3 } from './lib/threat-scan.mjs';

const ATTACKS = new URL('../tests/fixtures/threat-payloads/attacks.jsonl', import.meta.url);
const BENIGN = new URL('../tests/fixtures/threat-payloads/benign.jsonl', import.meta.url);
const BASELINE = new URL('../tests/fixtures/threat-payloads/baseline.json', import.meta.url);
const DEFAULT_CONFIG = new URL('../config.default.json', import.meta.url);

/**
 * save.mjs 的写入路径，逐步对齐：:59 evaluateTier1 → :71 evaluateTier2 → :72 evaluateTier3。
 *
 * secretScan 刻意不调 —— 它只在 revalidation.mjs:94 出现，且仅对 scope==='global'，
 * 不在写入路径上。把它塞进来会让"最终写入行为"这个口径名不副实。
 *
 * tier3 这一步显式假定 cfg.security.tier3.enabled === true（也是 config.default.json 的默认值）。
 * save.mjs:75 那道门在这里是绕过的：enabled=false 时真实写入走三元短路直接 allow，
 * 根本不调 tier3。所以报告里的"最终动作"严格读作"tier3 开启时的最终判定"，
 * 抬头必须把这个前提打印出来。
 *
 * 🔴 第二个前提（W1 之后才存在，预检补）：evaluateTier3 现在的签名是
 * (t2Result, source, options = {})，第三个参数由 save.mjs 从
 * security.quarantine_all_sources_at_write 读出后传入。这里刻意只传两个参数，
 * 等价于把它钉死成出厂默认 false —— 基线要可复现，就不能随读脚本的人的配置而变。
 * 这个前提同样要打进抬头，否则"最终写入行为"这个口径是缺一半的。
 */
export function finalAction(row) {
  if (!evaluateTier1(row.content).ok) {
    return 'reject';
  }
  return evaluateTier3(evaluateTier2(row.content, row.source), row.source).action;
}

export function isOk(row, action) {
  return row.expect === 'allow' ? action === 'allow' : action !== 'allow';
}

export function runCorpus(rows) {
  return rows.map((row) => {
    const action = finalAction(row);
    return { id: row.id, class: row.class, expect: row.expect, action, ok: isOk(row, action) };
  });
}

export function summarize(results) {
  const byClass = new Map();

  for (const result of results) {
    const bucket = byClass.get(result.class) ?? { n: 0, detected: 0 };
    bucket.n += 1;
    if (result.action !== 'allow') {
      bucket.detected += 1;
    }
    byClass.set(result.class, bucket);
  }

  return [...byClass.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, bucket]) => ({
      class: name,
      n: bucket.n,
      detected: bucket.detected,
      rate: bucket.n === 0 ? 0 : Number((bucket.detected / bucket.n).toFixed(3))
    }));
}

export function benignFpRate(results) {
  const benign = results.filter((result) => result.expect === 'allow');
  const fp = benign.filter((result) => result.action !== 'allow').length;
  return { n: benign.length, fp, rate: benign.length === 0 ? 0 : Number((fp / benign.length).toFixed(3)) };
}

export function diffBaseline(results, baseline) {
  const prior = baseline?.actions ?? {};
  const diff = { fixed: [], broken: [], same: [], new: [], gone: [] };
  const seen = new Set();

  for (const result of results) {
    seen.add(result.id);
    if (!Object.hasOwn(prior, result.id)) {
      diff.new.push(result.id);
      continue;
    }
    const priorOk = isOk(result, prior[result.id]);
    if (!priorOk && result.ok) {
      diff.fixed.push(result.id);
    } else if (priorOk && !result.ok) {
      diff.broken.push(result.id);
    } else {
      diff.same.push(result.id);
    }
  }

  for (const id of Object.keys(prior)) {
    if (!seen.has(id)) {
      diff.gone.push(id);
    }
  }

  return diff;
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function loadCorpus() {
  const rows = [...loadPayloads(ATTACKS), ...loadPayloads(BENIGN)];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`id "${row.id}" appears in both attacks.jsonl and benign.jsonl; baseline keys must be unique`);
    }
    seen.add(row.id);
  }
  return rows;
}

export function main(argv) {
  const wantsBaseline = argv.includes('--baseline');
  const accepts = argv.includes('--accept');
  const rows = loadCorpus();
  const results = runCorpus(rows);
  const version = readJson(DEFAULT_CONFIG).security.scan_patterns_version;

  let baseline = null;
  try {
    baseline = readJson(BASELINE);
  } catch {
    baseline = null;
  }

  const lines = [];
  lines.push('=== ccmem threat-scan bypass report ===');
  lines.push(`scan_patterns_version : ${version} (from config.default.json)`);
  lines.push('pipeline              : evaluateTier1 -> evaluateTier2 -> evaluateTier3');
  lines.push('ASSUMPTION 1          : security.tier3.enabled === true. save.mjs:75 gates tier3 on that');
  lines.push('                        flag; with it false the real write short-circuits to allow and');
  lines.push('                        tier3 is never called. Read every action below as "the verdict');
  lines.push('                        when tier3 is on", not "the write behaviour under any config".');
  lines.push('ASSUMPTION 2          : security.quarantine_all_sources_at_write === false (the factory');
  lines.push('                        default). evaluateTier3 is called with two arguments here, which');
  lines.push('                        pins that switch off, so the baseline stays reproducible no matter');
  lines.push('                        what the reader has in their own config.json. With the switch on,');
  lines.push('                        user_explicit and cron_consolidated rows would read quarantine');
  lines.push('                        instead of force_demote -- still non-allow, so no verdict flips.');
  lines.push('NOT COVERED           : secretScan (revalidation.mjs:94 only, global scope only) is not');
  lines.push('                        in the write path and is not run here.');
  lines.push('');
  lines.push('--- detection by class ---');
  for (const row of summarize(results)) {
    lines.push(`  ${row.class.padEnd(18)} n=${String(row.n).padStart(3)}  detected=${String(row.detected).padStart(3)}  rate=${row.rate}`);
  }
  const fp = benignFpRate(results);
  lines.push('');
  lines.push(`--- benign false positives ---  n=${fp.n}  fp=${fp.fp}  rate=${fp.rate}`);
  for (const result of results.filter((r) => r.expect === 'allow' && r.action !== 'allow')) {
    lines.push(`  FP  ${result.id.padEnd(22)} -> ${result.action}`);
  }
  lines.push('');

  if (baseline === null) {
    lines.push('--- delta vs baseline ---  no baseline.json yet');
  } else {
    const diff = diffBaseline(results, baseline);
    lines.push(`--- delta vs baseline (${baseline.scan_patterns_version} @ ${baseline.generated_at}) ---`);
    for (const key of ['fixed', 'broken', 'new', 'gone']) {
      lines.push(`  ${key.toUpperCase().padEnd(6)} ${diff[key].length}${diff[key].length ? `: ${diff[key].join(', ')}` : ''}`);
    }
    lines.push(`  SAME   ${diff.same.length}`);
  }

  lines.push('');
  lines.push('--- known residual gaps (do not read the five classes above as complete) ---');
  lines.push('  1. cross-save splitting is out of scope: evaluateTier2 is stateless, so that class');
  lines.push('     scores 0 by definition no matter how many patterns are added (design section 8.1).');
  lines.push('  2. secretScan is not normalized: SECRET_PATTERNS.credential_assignment carries');
  lines.push('     .{0,20} and eats the same newline/distance bypass, but it answers a different');
  lines.push('     question and its false-positive surface is unmeasured (design section 8.8).');
  lines.push('  3. the synonym and disguised classes have no matching hardening in this round;');
  lines.push('     whatever they score is a recorded gap, not a regression.');
  lines.push('  4. [resolved by Task 10b] the benign false-positive rate above is measured only');
  lines.push('     over the 17 shapes this corpus contains, which could not see what the chinese');
  lines.push('     patterns cost against real memories. the Task 10 dry-run over a copy of the');
  lines.push('     real store (9945 memories) found 10 W3-attributable false positives, all');
  lines.push('     legitimate security-convention memories: 7 from the Task 8 window widening,');
  lines.push('     3 from the chinese `token`/`校验` nouns added in Task 7. Task 10b narrowed');
  lines.push('     the window back to .{0,80} and dropped those two nouns; the corpus benign_policy');
  lines.push('     class (4 rows) now guards the shapes that were caught. the anchor-distance');
  lines.push('     bypass this trades away is a known, accepted open gap -- see the sentinel test');
  lines.push('     named for it in tests/unit/threat-scan.test.mjs.');

  process.stdout.write(`${lines.join('\n')}\n`);

  if (!wantsBaseline) {
    return 0;
  }

  // 自动写回 = 快照断言永远是绿的，什么也证明不了（设计 §4.4 第 1 条）。
  // 接受一次变化必须是显式动作。
  if (!accepts) {
    process.stderr.write('refusing to write baseline.json without --accept\n');
    return 2;
  }

  const actions = {};
  for (const result of results) {
    actions[result.id] = result.action;
  }
  writeFileSync(BASELINE, `${JSON.stringify({
    scan_patterns_version: version,
    generated_at: new Date().toISOString(),
    tier3_enabled_assumed: true,
    actions
  }, null, 2)}\n`);
  process.stdout.write(`\nwrote baseline.json (${Object.keys(actions).length} rows)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
