import os from 'node:os';

export function acquireDaemonLock(db) {
  const existing = db.prepare(`SELECT * FROM daemon_lock WHERE id = 1`).get();
  const now = Date.now();

  if (existing?.holder_pid === process.pid) {
    return { acquired: true, reentry: true };
  }

  if (existing && (now - existing.heartbeat_at) > 60000) {
    db.prepare(
      `UPDATE daemon_lock
       SET holder_pid = ?, hostname = ?, acquired_at = ?, heartbeat_at = ?, alive = 1
       WHERE id = 1`
    ).run(process.pid, os.hostname(), now, now);

    return { acquired: true, forced: true };
  }

  if (existing) {
    throw new Error('daemon already running');
  }

  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(process.pid, os.hostname(), now, now);

  return { acquired: true, fresh: true };
}

export function refreshHeartbeat(db) {
  db.prepare(
    `UPDATE daemon_lock
     SET heartbeat_at = ?
     WHERE id = 1 AND holder_pid = ?`
  ).run(Date.now(), process.pid);
}

export function isDaemonAlive(db) {
  const row = db.prepare(`SELECT heartbeat_at FROM daemon_lock WHERE id = 1`).get();
  return Boolean(row && (Date.now() - row.heartbeat_at) < 60000);
}
