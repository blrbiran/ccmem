import { markLeaseComplete } from '../../lib/task-runs.mjs';

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function runDailyMaintenance(db, task) {
  const now = Date.now();
  const payload = JSON.parse(task?.payload ?? '{}');
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : dayKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : now));

  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE trust_score < 0.1 AND decay_status != 'archived'`
  ).run(now);

  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(now - (14 * 86400000));

  db.prepare(
    `DELETE FROM ccmem_blacklisted_sessions
     WHERE expires_at < ?`
  ).run(now);

  markLeaseComplete(db, 'daily_maintenance', leaseKey);
}
