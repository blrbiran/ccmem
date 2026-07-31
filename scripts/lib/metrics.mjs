import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from './db.mjs';

// Single-generation cap. Diagnostics only ever look at recent data, so keeping
// more than one rotated generation buys nothing and costs disk.
export const MAX_METRICS_BYTES = 8 * 1024 * 1024;

export function recordMetric(event) {
  mkdirSync(getDataRoot(), { recursive: true });
  const file = path.join(getDataRoot(), 'metrics.jsonl');

  try {
    if (statSync(file).size > MAX_METRICS_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch (err) {
    // ENOENT is the expected first-write case. Anything else means rotation is
    // genuinely failing and the cap has stopped being enforced — say so.
    if (err?.code !== 'ENOENT') {
      process.stderr.write(`ccmem: metrics rotation failed (${err?.code ?? err?.message}) — size cap not enforced\n`);
    }
  }

  appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}

const DEFAULT_DECISION_DATA_FILE = 'l25-probe.jsonl';

function decisionDataFile(decisionCfg) {
  return path.join(getDataRoot(), decisionCfg?.file || DEFAULT_DECISION_DATA_FILE);
}

/**
 * Durable decision-data stream: rows this release's central decision depends
 * on. Runtime hygiene (metrics.jsonl's 8MB single-generation rotation, above)
 * and decision data want opposite retention policies, so they get separate
 * files rather than one file with a switch — recent_injections' 14-day
 * retention already destroyed the data this exact decision needed once
 * (that is why v0.13 defers the L2.5 threshold at all); this must not repeat
 * that mistake. NEVER rotates and NEVER caps size while enabled.
 *
 * `decisionCfg.enabled` controls DURABILITY, never EXISTENCE: this function
 * must always be called to record a row. Anything other than an explicit
 * `enabled: false` (including a missing/undefined config) durably records.
 * When `enabled: false`, the row falls back to the ordinary (rotated)
 * recordMetric path rather than being silently dropped — a user who turned
 * this off should still see their events in metrics.jsonl, not lose them.
 */
export function recordDecisionMetric(event, decisionCfg) {
  if (decisionCfg?.enabled === false) {
    recordMetric(event);
    return;
  }

  mkdirSync(getDataRoot(), { recursive: true });
  appendFileSync(decisionDataFile(decisionCfg), `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}

/** Current size of the decision-data file, for diagnose --feedback to report. 0 if it doesn't exist yet. */
export function decisionDataSizeBytes(decisionCfg) {
  try {
    return statSync(decisionDataFile(decisionCfg)).size;
  } catch {
    return 0;
  }
}

/**
 * Prune decision-data rows older than `olderThanMs`. Only called when a user
 * has explicitly opted into bounded retention (retention_days > 0); the
 * default (retention_days: 0) is deliberately unbounded — decision data
 * should be removed by explicit human action, not silently by a background
 * job, which is the inverse of every other retention policy in this codebase
 * on purpose.
 */
export function pruneDecisionMetrics(decisionCfg, olderThanMs) {
  const file = decisionDataFile(decisionCfg);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  const kept = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && Number(row.ts) >= olderThanMs);

  writeFileSync(file, kept.length ? `${kept.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
}
