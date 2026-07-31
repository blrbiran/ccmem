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
  } catch {
    // File absent (first write) or stat failed — fall through and append.
  }

  appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}
