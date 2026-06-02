import { RAN_BY, tryClaimLease } from '../lib/task-runs.mjs';
import { wakeRecently } from './wake.mjs';

const ERROR_EXCERPT_MAX = 200;

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function weekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function scheduleCronTasks(db, now = new Date()) {
  const nowMs = now.getTime();

  if (now.getHours() > 2 || (now.getHours() === 2 && now.getMinutes() >= 17)) {
    if (tryClaimLease(db, 'daily_maintenance', dayKey(now), RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('daily_maintenance', '{}', ?, ?, 'queued')`
      ).run(nowMs, nowMs);
    }
  }

  if (now.getDay() === 0 && (now.getHours() > 3 || (now.getHours() === 3 && now.getMinutes() >= 17))) {
    if (tryClaimLease(db, 'weekly_synthesis', weekKey(now), RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('weekly_synthesis', '{}', ?, ?, 'queued')`
      ).run(nowMs, nowMs);
    }
  }
}

export { dayKey, weekKey };

export async function runTask(db, task, dispatch) {
  db.prepare(
    `UPDATE tasks
     SET status = 'running', started_at = ?, attempts = attempts + 1
     WHERE id = ?`
  ).run(Date.now(), task.id);

  try {
    await dispatch(db, task);
    db.prepare(
      `UPDATE tasks
       SET status = 'completed', finished_at = ?, error_excerpt = NULL
       WHERE id = ? AND status = 'running'`
    ).run(Date.now(), task.id);
  } catch (error) {
    db.prepare(
      `UPDATE tasks
       SET status = 'failed', finished_at = ?, error_excerpt = ?
       WHERE id = ?`
    ).run(Date.now(), String(error?.message ?? error).slice(0, ERROR_EXCERPT_MAX), task.id);
  }
}

export async function mainLoop(db, shouldStop, dispatch) {
  while (!shouldStop()) {
    scheduleCronTasks(db);

    const due = db.prepare(
      `SELECT *
       FROM tasks
       WHERE status = 'queued' AND scheduled_for < ?
       ORDER BY scheduled_for ASC`
    ).all(Date.now());

    if (!due.length) {
      await new Promise((resolve) => setTimeout(resolve, wakeRecently() ? 30000 : 300000));
      continue;
    }

    for (const task of due) {
      if (shouldStop()) {
        break;
      }

      await runTask(db, task, dispatch);
    }
  }
}
