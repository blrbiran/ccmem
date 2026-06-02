export const RAN_BY = Object.freeze({
  DAEMON: 'daemon',
  OPPORTUNISTIC: 'opportunistic',
  MANUAL: 'manual'
});

export function tryClaimLease(db, type, dateKey, ranBy) {
  try {
    db.prepare(
      `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
       VALUES (?, ?, ?, 'running', ?)`
    ).run(type, dateKey, Date.now(), ranBy);
    return true;
  } catch {
    return false;
  }
}

export function markLeaseComplete(db, type, dateKey) {
  db.prepare(
    `UPDATE task_runs
     SET status = 'completed', completed_at = ?
     WHERE type = ? AND date_key = ? AND status = 'running'`
  ).run(Date.now(), type, dateKey);
}
