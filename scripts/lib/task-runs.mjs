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
