import { loadConfig } from './config.mjs';
import { markLeaseComplete, RAN_BY, tryClaimLease } from './task-runs.mjs';

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function dayKeyDaysAgo(days) {
  return dayKey(new Date(Date.now() - (days * 86400000)));
}

export function runSessionStartMiniPrelude(db) {
  const today = dayKey(new Date());
  if (!tryClaimLease(db, 'tier1_5_mini_prelude', today, RAN_BY.OPPORTUNISTIC)) {
    return false;
  }

  const cfg = loadConfig();
  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(Date.now() - (cfg.recent_injections.retention_days * 86400000));

  db.prepare(
    `DELETE FROM recent_injections
     WHERE id IN (
       SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id
                  ORDER BY created_at DESC, id DESC
                ) AS rn
         FROM recent_injections
       )
       WHERE rn > ?
     )`
  ).run(cfg.recent_injections.max_per_session);

  db.prepare(
    `DELETE FROM task_runs
     WHERE date_key < ?`
  ).run(dayKeyDaysAgo(30));

  markLeaseComplete(db, 'tier1_5_mini_prelude', today);
  return true;
}

export function maybeRunTier15(db) {
  const today = dayKey(new Date());

  if (!tryClaimLease(db, 'daily_maintenance', today, RAN_BY.OPPORTUNISTIC)) {
    return false;
  }

  const cfg = loadConfig();
  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE trust_score < 0.1 AND decay_status != 'archived'`
  ).run(Date.now());

  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(Date.now() - (cfg.recent_injections.retention_days * 86400000));

  db.prepare(
    `DELETE FROM task_runs
     WHERE date_key < ?`
  ).run(dayKeyDaysAgo(30));

  markLeaseComplete(db, 'daily_maintenance', today);
  return true;
}
