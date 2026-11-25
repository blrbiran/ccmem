import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../lib/db.mjs';

const WAKE_PATH = () => path.join(getDataRoot(), 'daemon.wake');
// Tester #475: a wake that must not wait out the Stop debounce (a person ran `admin cron run`).
// A second file rather than file content, so a Stop hook writing daemon.wake in the same
// poll window cannot overwrite an immediate wake into a debounced one.
const WAKE_NOW_PATH = () => path.join(getDataRoot(), 'daemon.wake.now');
let lastWakeTs = 0;

// Tester #475: how often an idle sleep looks at the wake files. Two stat() calls, nothing else:
// the main tick (scheduleCronTasks + the due query, a full scan of `tasks`) keeps its own pace.
export const WAKE_POLL_MS = 3000;
// Stop fires on every turn. Acting at the first Stop's mtime + 30 s lets the turns that follow
// queue their newer snapshots, so runSummarizePending's ordering retires the older rows instead
// of the daemon summarizing each snapshot as it lands.
export const STOP_WAKE_DEBOUNCE_MS = 30000;

export function touchWakeFile({ immediate = false } = {}) {
  writeFileSync(WAKE_PATH(), String(Date.now()));
  if (immediate) {
    writeFileSync(WAKE_NOW_PATH(), String(Date.now()));
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Newest wake of either kind, or null when none was ever written (for `admin daemon status`).
export function lastWakeAt() {
  return Math.max(mtimeOf(WAKE_PATH()), mtimeOf(WAKE_NOW_PATH())) || null;
}

export function wakeRecently() {
  try {
    lastWakeTs = Math.max(lastWakeTs, statSync(WAKE_PATH()).mtimeMs);
  } catch {
    // ignore missing wake file
  }

  return Date.now() - lastWakeTs < 60000;
}

// Tester #475: the idle sleep used to be one uncancellable setTimeout, so a wake written while it
// ran waited out the rest of it (242 s measured). Sleep in pollMs slices instead and look at the
// wake files between them. `since` is when the tick that found nothing to do began: a wake newer
// than that is one the tick did not see.
//   daemon.wake.now newer  -> return now.
//   daemon.wake newer      -> return at that wake's mtime + debounceMs (never later than ms).
// The first Stop wake sets the deadline; later ones do not push it back, so steady turns cannot
// starve the queue.
export async function idleSleep(ms, {
  shouldStop = () => false,
  since = Date.now(),
  pollMs = WAKE_POLL_MS,
  debounceMs = STOP_WAKE_DEBOUNCE_MS
} = {}) {
  let deadline = Date.now() + ms;
  let slice = Math.min(pollMs, ms);
  while (!shouldStop()) {
    await new Promise((resolve) => setTimeout(resolve, slice));
    if (mtimeOf(WAKE_NOW_PATH()) > since) {
      return;
    }
    const stopWake = mtimeOf(WAKE_PATH());
    if (stopWake > since) {
      deadline = Math.min(deadline, stopWake + debounceMs);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    slice = Math.min(pollMs, remaining);
  }
}
