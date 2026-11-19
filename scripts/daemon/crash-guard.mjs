import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../lib/paths.mjs';

// launchd's KeepAlive restarts the daemon forever. A daemon that dies before it
// can do anything (the 2026-11 move of this repo left a plist exec'ing a
// main.mjs that no longer existed) therefore appends one MODULE_NOT_FOUND per
// retry to daemon.err.log — 83 MB / 1.98 M lines in the tester's report, 609 MB
// on the machine it was filed from. ThrottleInterval in the plist slows that
// down; this file is the hard ceiling: an hour may not contain more than
// DEFAULT_MAX_STARTS_PER_HOUR daemon starts.
//
// The log itself is the human's data: nothing here rotates, truncates or
// deletes it.
export const DEFAULT_MAX_STARTS_PER_HOUR = 10;
export const START_WINDOW_MS = 60 * 60 * 1000;
export const START_HISTORY_FILE = 'daemon-start-history.json';

export function getStartHistoryPath(dataRoot = getDataRoot()) {
  return path.join(dataRoot, START_HISTORY_FILE);
}

function readStarts(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!Array.isArray(parsed?.starts)) return [];
    return parsed.starts.filter((value) => Number.isFinite(value));
  } catch {
    // A missing, unparsable or half-written file must not keep the daemon down:
    // the guard is a backstop, not the source of truth for whether to run.
    return [];
  }
}

/**
 * Record one daemon start, unless the trailing window already holds the limit.
 * Timestamps outside the window are pruned, so the file stays small.
 *
 * A refused call records nothing: if it did, a crash loop would keep the
 * window full forever and the daemon could never come back after the operator
 * fixed the cause.
 */
export function recordDaemonStart({
  now = Date.now(),
  statePath = getStartHistoryPath(),
  maxStarts = DEFAULT_MAX_STARTS_PER_HOUR,
  windowMs = START_WINDOW_MS
} = {}) {
  const recent = readStarts(statePath)
    .filter((startedAt) => startedAt > now - windowMs && startedAt <= now)
    .sort((a, b) => a - b);

  if (recent.length >= maxStarts) {
    return {
      allowed: false,
      starts: recent.length,
      limit: maxStarts,
      statePath,
      retry_after_ms: Math.max(0, recent[0] + windowMs - now)
    };
  }

  recent.push(now);
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  // mode applies only on creation; an existing file keeps its own mode.
  writeFileSync(statePath, JSON.stringify({ starts: recent }), { mode: 0o600 });
  return { allowed: true, starts: recent.length, limit: maxStarts, statePath };
}

/**
 * Explicit operator actions (`admin daemon install` / `restart`) call this:
 * the human asked for a start, so history from an unattended crash loop must
 * not swallow it. launchd's own retries never clear it.
 */
export function clearStartHistory({ statePath = getStartHistoryPath() } = {}) {
  try {
    rmSync(statePath, { force: true });
  } catch {
    // Best effort: a start history that cannot be removed only means the next
    // start may have to wait out the window; it cannot corrupt anything.
  }
}
