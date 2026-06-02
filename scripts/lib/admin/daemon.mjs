import { isDaemonAlive } from '../../daemon/lock.mjs';

export async function cmdAdminDaemon(db, { verb } = {}) {
  if (verb !== 'status') {
    throw new Error(`unsupported admin daemon verb: ${verb}`);
  }

  const lock = db.prepare(
    `SELECT holder_pid, hostname, acquired_at, heartbeat_at
     FROM daemon_lock
     WHERE id = 1`
  ).get();
  const runningTask = db.prepare(
    `SELECT id, type, started_at
     FROM tasks
     WHERE status = 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`
  ).get();

  return {
    alive: isDaemonAlive(db),
    pid: lock?.holder_pid ?? null,
    hostname: lock?.hostname ?? null,
    acquired_at: lock?.acquired_at ?? null,
    heartbeat_at: lock?.heartbeat_at ?? null,
    heartbeat_age_ms: lock ? Math.max(0, Date.now() - lock.heartbeat_at) : null,
    running_task: runningTask
      ? { id: runningTask.id, type: runningTask.type, started_at: runningTask.started_at }
      : null
  };
}
