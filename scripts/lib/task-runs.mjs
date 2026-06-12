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
  const now = Date.now();
  db.prepare(
    `UPDATE task_runs
     SET status = 'completed',
         completed_at = ?,
         duration_ms = CASE
           WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
           ELSE 0
         END
     WHERE type = ? AND date_key = ? AND status = 'running'`
  ).run(now, now, now, type, dateKey);
}
