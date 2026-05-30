import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from './db.mjs';

export function recordMetric(event) {
  mkdirSync(getDataRoot(), { recursive: true });
  appendFileSync(
    path.join(getDataRoot(), 'metrics.jsonl'),
    `${JSON.stringify({ ts: Date.now(), ...event })}\n`
  );
}
