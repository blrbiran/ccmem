import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../lib/db.mjs';

const WAKE_PATH = () => path.join(getDataRoot(), 'daemon.wake');
let lastWakeTs = 0;

export function touchWakeFile() {
  writeFileSync(WAKE_PATH(), String(Date.now()));
}

export function wakeRecently() {
  try {
    lastWakeTs = Math.max(lastWakeTs, statSync(WAKE_PATH()).mtimeMs);
  } catch {
    // ignore missing wake file
  }

  return Date.now() - lastWakeTs < 60000;
}
