import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
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
