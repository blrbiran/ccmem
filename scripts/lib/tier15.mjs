import { RAN_BY, tryClaimLease } from './task-runs.mjs';

export function maybeRunTier15(db) {
  const today = new Date().toISOString().slice(0, 10);

  if (!tryClaimLease(db, 'daily_maintenance', today, RAN_BY.OPPORTUNISTIC)) {
    return false;
  }

  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE trust_score < 0.1 AND decay_status != 'archived'`
  ).run(Date.now());

  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(Date.now() - (14 * 86400000));

  db.prepare(
    `UPDATE task_runs
     SET status = 'completed', completed_at = ?
     WHERE type = 'daily_maintenance' AND date_key = ?`
  ).run(Date.now(), today);

  return true;
}
