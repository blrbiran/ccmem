import { markLeaseComplete } from '../../lib/task-runs.mjs';

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export function runDailyMaintenance(db) {
  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE trust_score < 0.1 AND decay_status != 'archived'`
  ).run(Date.now());

  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(Date.now() - (14 * 86400000));

  markLeaseComplete(db, 'daily_maintenance', dayKey(new Date()));
}
