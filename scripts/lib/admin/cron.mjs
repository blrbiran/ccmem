import { isDaemonAlive } from '../../daemon/lock.mjs';
import { dayKey, weeklyLeaseKey } from '../../daemon/loop.mjs';
import { RAN_BY, tryClaimLease } from '../task-runs.mjs';

const TRACKED_TYPES = ['daily_maintenance', 'summarize_pending', 'weekly_synthesis', 'security_audit', 'revalidation_audit'];
const MANUAL_RUN_TYPES = ['daily_maintenance', 'weekly_synthesis', 'security_audit', 'revalidation_audit'];
const QUEUE_OVERDUE_MS = 5 * 60 * 1000;
const RUNNING_ZOMBIE_MS = 10 * 60 * 1000;

function loadQueuedStats(db) {
  const queuedRows = db.prepare(
    `SELECT type, COUNT(*) AS queued, MIN(scheduled_for) AS oldest_scheduled_for
     FROM tasks
     WHERE status = 'queued'
     GROUP BY type`
  ).all();

  return new Map(
    queuedRows.map((row) => [
      row.type,
      {
        queued: Number(row.queued ?? 0),
        oldest_scheduled_for: row.oldest_scheduled_for ?? null
      }
    ])
  );
}

function loadLatestRuns(db) {
  const latestRunRows = db.prepare(
    `SELECT id, type, date_key, started_at, completed_at, status, ran_by
     FROM task_runs
     ORDER BY type ASC, started_at DESC, id DESC`
  ).all();
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

  return latestByType;
}

function listCronState(db) {
  const queuedByType = loadQueuedStats(db);
  const latestByType = loadLatestRuns(db);

  return {
    daemon_alive: isDaemonAlive(db),
    items: TRACKED_TYPES.map((type) => ({
      type,
      queued: queuedByType.get(type)?.queued ?? 0,
      last_run: latestByType.get(type) ?? null
    }))
  };
}

function listCronIssues(db) {
  const daemonAlive = isDaemonAlive(db);
  const queuedByType = loadQueuedStats(db);
  const latestByType = loadLatestRuns(db);
  const now = Date.now();
  const issues = [];

  for (const type of TRACKED_TYPES) {
    const queued = queuedByType.get(type) ?? { queued: 0, oldest_scheduled_for: null };
    const latest = latestByType.get(type) ?? null;

    if (latest?.status === 'failed') {
      issues.push({
        type,
        kind: 'failed',
        date_key: latest.date_key,
        ran_by: latest.ran_by
      });
    }

    if (latest?.status === 'running' && (!daemonAlive || now - latest.started_at >= RUNNING_ZOMBIE_MS)) {
      issues.push({
        type,
        kind: 'zombie',
        date_key: latest.date_key,
        age_ms: Math.max(0, now - latest.started_at)
      });
    }

    if (
      queued.queued > 0 &&
      queued.oldest_scheduled_for !== null &&
      now - queued.oldest_scheduled_for >= QUEUE_OVERDUE_MS
    ) {
      issues.push({
        type,
        kind: 'overdue',
        queued: queued.queued,
        oldest_age_ms: Math.max(0, now - queued.oldest_scheduled_for)
      });
    }
  }

  return { issues };
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

function manualLeaseKey(taskType, now) {
  if (taskType === 'daily_maintenance') {
    return dayKey(now);
  }

  if (taskType === 'weekly_synthesis' || taskType === 'security_audit') {
    return weeklyLeaseKey(now);
  }

  return null;
}

function runCronTask(db, taskType) {
  if (!TRACKED_TYPES.includes(taskType)) {
    throw new Error(`unsupported cron task: ${taskType}`);
  }

  if (!MANUAL_RUN_TYPES.includes(taskType)) {
    throw new Error(`unsupported manual cron task: ${taskType}`);
  }

  const now = new Date();
  const nowMs = now.getTime();
  const leaseKey = manualLeaseKey(taskType, now);
  const payload = leaseKey ? { lease_key: leaseKey } : {};

  if (leaseKey && !tryClaimLease(db, taskType, leaseKey, RAN_BY.MANUAL)) {
    return {
      task_id: null,
      type: taskType,
      scheduled_for: nowMs,
      enqueued_at: nowMs,
      status: 'skipped',
      reason: 'lease already claimed'
    };
  }

  const result = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES (?, ?, ?, ?, 'queued')`
  ).run(taskType, JSON.stringify(payload), nowMs, nowMs);

  return {
    task_id: Number(result.lastInsertRowid),
    type: taskType,
    scheduled_for: nowMs,
    enqueued_at: nowMs,
    status: 'queued'
  };
}

export async function cmdAdminCron(db, { verb, taskType = null, history = null, issues = false } = {}) {
  if (verb === 'list') {
    if (issues) {
      return listCronIssues(db);
    }

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
