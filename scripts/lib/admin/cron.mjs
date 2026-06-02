import { isDaemonAlive } from '../../daemon/lock.mjs';

const TRACKED_TYPES = ['daily_maintenance', 'summarize_pending', 'weekly_synthesis'];

function listCronState(db) {
  const queuedRows = db.prepare(
    `SELECT type, COUNT(*) AS n
     FROM tasks
     WHERE status = 'queued'
     GROUP BY type`
  ).all();
  const latestRunRows = db.prepare(
    `SELECT id, type, date_key, started_at, completed_at, status, ran_by
     FROM task_runs
     ORDER BY type ASC, started_at DESC, id DESC`
  ).all();

  const queuedByType = new Map(queuedRows.map((row) => [row.type, Number(row.n ?? 0)]));
  const latestByType = new Map();

  for (const row of latestRunRows) {
    if (TRACKED_TYPES.includes(row.type) && !latestByType.has(row.type)) {
      latestByType.set(row.type, {
        id: row.id,
        date_key: row.date_key,
        started_at: row.started_at,
        completed_at: row.completed_at,
        status: row.status,
        ran_by: row.ran_by
      });
    }
  }

  return {
    daemon_alive: isDaemonAlive(db),
    items: TRACKED_TYPES.map((type) => ({
      type,
      queued: queuedByType.get(type) ?? 0,
      last_run: latestByType.get(type) ?? null
    }))
  };
}

function listCronHistory(db, taskType, limit) {
  if (!TRACKED_TYPES.includes(taskType)) {
    throw new Error(`unsupported cron task: ${taskType}`);
  }

  const history = db.prepare(
    `SELECT id, type, date_key, started_at, completed_at, status, ran_by
     FROM task_runs
     WHERE type = ?
     ORDER BY started_at DESC, id DESC
     LIMIT ?`
  ).all(taskType, limit);

  return {
    type: taskType,
    history: history.map((row) => ({
      id: row.id,
      date_key: row.date_key,
      started_at: row.started_at,
      completed_at: row.completed_at,
      status: row.status,
      ran_by: row.ran_by
    }))
  };
}

function clampHistoryLimit(limit) {
  const n = Number(limit ?? 10);
  if (!Number.isFinite(n)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.trunc(n)));
}

function resolveHistoryTask(taskType) {
  return typeof taskType === 'string' ? taskType : '';
}

function runCronTask(db, taskType) {
  if (!TRACKED_TYPES.includes(taskType)) {
    throw new Error(`unsupported cron task: ${taskType}`);
  }

  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES (?, '{}', 0, ?, 'queued')`
  ).run(taskType, now);

  return {
    task_id: Number(result.lastInsertRowid),
    type: taskType,
    scheduled_for: 0,
    enqueued_at: now,
    status: 'queued'
  };
}

export async function cmdAdminCron(db, { verb, taskType = null, history = null } = {}) {
  if (verb === 'list') {
    if (history) {
      return listCronHistory(db, resolveHistoryTask(taskType), clampHistoryLimit(history));
    }

    return listCronState(db);
  }

  if (verb === 'run') {
    return runCronTask(db, taskType);
  }

  throw new Error(`unsupported admin cron verb: ${verb}`);
}
