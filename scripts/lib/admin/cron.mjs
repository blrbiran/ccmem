import { isDaemonAlive } from '../../daemon/lock.mjs';
import { contradictionAuditLeaseKey, dayKey, weeklyLeaseKey } from '../../daemon/loop.mjs';
import { loadConfig } from '../config.mjs';
import { RAN_BY, tryClaimLease } from '../task-runs.mjs';

const TRACKED_TYPES = [
  'daily_maintenance',
  'summarize_pending',
  'weekly_synthesis',
  'security_audit',
  'contradiction_audit',
  'cross_project_patterns',
  'monthly_meta_synthesis',
  'revalidation_audit',
  'vec_backfill'
];
const MANUAL_RUN_TYPES = ['daily_maintenance', 'weekly_synthesis', 'security_audit', 'contradiction_audit', 'cross_project_patterns', 'monthly_meta_synthesis', 'revalidation_audit', 'vec_backfill'];
const QUEUE_OVERDUE_MS = 5 * 60 * 1000;
const RUNNING_ZOMBIE_MS = 10 * 60 * 1000;
const RUN_AUDIT_BY_TASK = Object.freeze({
  summarize_pending: 'summarize_pending_applied',
  weekly_synthesis: 'weekly_synthesis_run',
  security_audit: 'security_audit_run',
  contradiction_audit: 'contradiction_audit_run',
  cross_project_patterns: 'cross_project_run',
  monthly_meta_synthesis: 'monthly_meta_run',
  revalidation_audit: 'revalidation_audit_run',
  vec_backfill: 'vec_backfill_run'
});

function normalizeStatus(status) {
  return status === 'success' ? 'completed' : status;
}

function parseDetails(details) {
  try {
    return JSON.parse(details ?? '{}');
  } catch {
    return {};
  }
}

function summarizeAudit(taskType, details) {
  switch (taskType) {
    case 'summarize_pending':
      return `inserted=${Number(details.inserted_count ?? 0)} skipped=${Number(details.skipped_count ?? 0)}`;
    case 'weekly_synthesis':
      return `proposed=${Number(details.synth_proposed ?? 0)} accepted=${Number(details.synth_accepted ?? 0)} rejected=${Number(details.synth_rejected ?? 0)} llm_calls=${Number(details.llm_calls ?? 0)}`;
    case 'security_audit':
      return `scanned=${Number(details.candidates_scanned ?? 0)} quarantined=${Number(details.quarantined ?? 0)} alerts=${Number(details.alerts_emitted ?? 0)} llm_calls=${Number(details.llm_calls ?? 0)}`;
    case 'contradiction_audit':
      return `pairs=${Number(details.pairs_scanned ?? 0)} found=${Number(details.contradictions_found ?? 0)} llm_calls=${Number(details.llm_calls ?? 0)}`;
    case 'cross_project_patterns':
      return `projects=${Number(details.projects_scanned ?? 0)} pairs=${Number(details.pairs_checked ?? 0)} candidates=${Number(details.candidates_found ?? 0)} clusters=${Number(details.clusters_formed ?? 0)}`;
    case 'monthly_meta_synthesis':
      return `input=${Number(details.input_count ?? 0)} output=${Number(details.output_count ?? 0)} superseded=${Number(details.superseded_count ?? 0)}`;
    case 'revalidation_audit':
      return `trigger=${details.trigger ?? 'unknown'} scanned=${Number(details.scanned ?? 0)} quarantined=${Number(details.quarantined ?? 0)} flagged=${Number(details.flagged ?? 0)}`;
    case 'vec_backfill':
      return `embedded=${Number(details.embedded ?? 0)} remaining=${Number(details.remaining ?? 0)} duration_ms=${Number(details.duration_ms ?? 0)}`;
    default:
      return null;
  }
}

function loadLatestRunAudit(db, taskType) {
  const action = RUN_AUDIT_BY_TASK[taskType];
  if (!action) {
    return null;
  }

  const row = db.prepare(
    `SELECT ts, details
     FROM audit_log
     WHERE action = ?
     ORDER BY ts DESC, id DESC
     LIMIT 1`
  ).get(action);
  if (!row) {
    return null;
  }

  return {
    action,
    ts: row.ts,
    summary: summarizeAudit(taskType, parseDetails(row.details))
  };
}

function loadQueuedStats(db) {
  const queuedRows = db.prepare(
    `SELECT type, COUNT(*) AS queued, MIN(scheduled_for) AS oldest_scheduled_for
     FROM tasks
     WHERE status = 'queued'
     GROUP BY type`
  ).all();

  return new Map(queuedRows.map((row) => [row.type, {
    queued: Number(row.queued ?? 0),
    oldest_scheduled_for: row.oldest_scheduled_for ?? null
  }]));
}

function loadLatestRuns(db) {
  const latestRunRows = db.prepare(
    `SELECT id, type, date_key, started_at, completed_at, status, ran_by, duration_ms
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
        status: normalizeStatus(row.status),
        ran_by: row.ran_by,
        duration_ms: row.duration_ms
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

    if (queued.queued > 0 && queued.oldest_scheduled_for !== null && now - queued.oldest_scheduled_for >= QUEUE_OVERDUE_MS) {
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
    `SELECT id, type, date_key, started_at, completed_at, status, ran_by, duration_ms
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
      status: normalizeStatus(row.status),
      ran_by: row.ran_by,
      duration_ms: row.duration_ms
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
  if (taskType === 'contradiction_audit') {
    return contradictionAuditLeaseKey(now);
  }
  if (taskType === 'cross_project_patterns') {
    const cfg = loadConfig().cross_project?.audit ?? {};
    return weeklyLeaseKey(now, {
      weekday: Number(cfg.schedule_weekday ?? 0),
      hour: Number(cfg.schedule_hour ?? 4),
      minute: Number(cfg.schedule_minute ?? 47)
    });
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

function attachVerboseState(db, result) {
  return {
    ...result,
    items: result.items.map((item) => ({
      ...item,
      last_audit: loadLatestRunAudit(db, item.type)
    }))
  };
}

function attachVerboseHistory(db, result) {
  return {
    ...result,
    last_audit: loadLatestRunAudit(db, result.type)
  };
}

export async function cmdAdminCron(db, { verb, taskType = null, history = null, issues = false, verbose = false } = {}) {
  if (verb === 'list') {
    if (issues) {
      return listCronIssues(db);
    }
    if (history) {
      const result = listCronHistory(db, resolveHistoryTask(taskType), clampHistoryLimit(history));
      return verbose ? attachVerboseHistory(db, result) : result;
    }
    const result = listCronState(db);
    return verbose ? attachVerboseState(db, result) : result;
  }

  if (verb === 'run') {
    return runCronTask(db, taskType);
  }

  throw new Error(`unsupported admin cron verb: ${verb}`);
}
