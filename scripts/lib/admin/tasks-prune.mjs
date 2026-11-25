import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createMigrationBackup, DB_BUSY_TIMEOUT_MS, getDbPath } from '../db.mjs';

const DAY_MS = 86_400_000;
export const TASKS_PRUNE_USAGE = 'ccmem admin tasks-prune --failed-days N --success-days N [--dry-run|--apply]';

function parseTasksPruneArgs(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (options.has(flag)) throw new Error(`duplicate option ${flag}`);
    if (flag === '--apply' || flag === '--dry-run') {
      options.set(flag, true);
    } else if (flag === '--failed-days' || flag === '--success-days') {
      const value = args[++i];
      const days = Number(value);
      if (!/^\d+$/.test(value ?? '') || days < 1 || !Number.isSafeInteger(days * DAY_MS)) {
        throw new Error(`${flag} requires a positive whole number of days`);
      }
      options.set(flag, days);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (!options.has('--failed-days') || !options.has('--success-days')) {
    throw new Error('both --failed-days and --success-days must be given explicitly');
  }
  if (options.has('--apply') && options.has('--dry-run')) {
    throw new Error('--apply and --dry-run are mutually exclusive');
  }
  return { failedDays: options.get('--failed-days'), successDays: options.get('--success-days'), apply: options.has('--apply') };
}

export function cmdAdminTasksPrune(args) {
  const { failedDays, successDays, apply } = parseTasksPruneArgs(args);
  const file = getDbPath();
  if (!existsSync(file)) throw new Error(`no ccmem database at ${file}`);
  const now = Date.now();
  const cutoffs = [now - failedDays * DAY_MS, now - successDays * DAY_MS];
  const eligible = `(status = 'failed' AND finished_at < ?) OR (status = 'success' AND finished_at < ?)`;
  const db = new DatabaseSync(file, { readOnly: !apply });
  try {
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    if (apply) db.exec('BEGIN IMMEDIATE');
    const counts = db.prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE status = 'success') AS success
       FROM tasks WHERE ${eligible}`
    ).get(...cutoffs);
    let backup = null;
    if (apply) {
      if (counts.failed || counts.success) {
        backup = createMigrationBackup(file, null, { prune: false });
        if (!backup) throw new Error('could not back up the ccmem database');
        db.prepare(`DELETE FROM tasks WHERE ${eligible}`).run(...cutoffs);
      }
      db.exec('COMMIT');
    }
    return { ...counts, apply, backup };
  } finally {
    // Closing also rolls back an uncommitted deletion if backup or SQL failed.
    db.close();
  }
}
