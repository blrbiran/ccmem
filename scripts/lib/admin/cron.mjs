import { isDaemonAlive } from '../../daemon/lock.mjs';
import { contradictionAuditLeaseKey, dayKey, weeklyLeaseKey } from '../../daemon/loop.mjs';
import { loadConfig } from '../config.mjs';
import { RAN_BY, tryClaimLease } from '../task-runs.mjs';
import { touchWakeFile } from '../../daemon/wake.mjs';

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
const MANUAL_RUN_TYPES = ['daily_maintenance', 'summarize_pending', 'weekly_synthesis', 'security_audit', 'contradiction_audit', 'cross_project_patterns', 'monthly_meta_synthesis', 'revalidation_audit', 'vec_backfill'];
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

/** The word a `tasks` row is shown with, as a lease row's 'success' already is. */
function normalizeTaskStatus(status) {
  return status === 'running' || status === 'queued' ? status : normalizeStatus(status);
}

/**
 * Tester #447: `summarize_pending` never takes a lease — the Stop hook queues it, and
 * no lease row exists for it — so `last=`, `--history` and `--issues` read
 * `none`/empty forever for the one job that extracts memories. Where no lease row
 * answers, the task rows do: one row per tracked type, the newest by start then id,
 * shaped like a lease row so callers read one shape.
 */
function loadLatestTaskRows(db) {
  // Only a row that started is a run: a queued task is the queued count's business,
  // not a last result (the shape `last=none` still means "nothing has run yet").
  const rows = db.prepare(
    `SELECT id, type, started_at, finished_at, status, duration_ms
     FROM tasks
     WHERE started_at IS NOT NULL
     ORDER BY type ASC, started_at DESC, id DESC`
  ).all();
  const latestByType = new Map();
  for (const row of rows) {
    if (!TRACKED_TYPES.includes(row.type) || latestByType.has(row.type)) continue;
    latestByType.set(row.type, {
      id: row.id,
      date_key: row.started_at == null ? null : dayKey(new Date(row.started_at)),
      started_at: row.started_at,
      completed_at: row.finished_at,
      status: normalizeTaskStatus(row.status),
      ran_by: RAN_BY.DAEMON,
      duration_ms: row.duration_ms
    });
  }
  return latestByType;
}

function taskHistory(db, taskType, limit) {
  const rows = db.prepare(
    `SELECT id, started_at, finished_at, status, duration_ms
     FROM tasks
     WHERE type = ?
     ORDER BY started_at DESC, id DESC
     LIMIT ?`
  ).all(taskType, limit);
  return rows.map((row) => ({
    id: row.id,
    date_key: row.started_at == null ? null : dayKey(new Date(row.started_at)),
    started_at: row.started_at,
    completed_at: row.finished_at,
    status: normalizeTaskStatus(row.status),
    ran_by: RAN_BY.DAEMON,
    duration_ms: row.duration_ms
  }));
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

  // Tester #447: a type that never takes a lease still ran; its task rows answer.
  for (const [type, row] of loadLatestTaskRows(db)) {
    if (!latestByType.has(type)) latestByType.set(type, row);
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
    // Tester #447: a type with no lease rows at all (`summarize_pending`) reports its
    // task rows, so `--history` is not blank for the job that extracts memories.
    history: history.length > 0 ? history.map((row) => ({
      id: row.id,
      date_key: row.date_key,
      started_at: row.started_at,
      completed_at: row.completed_at,
      status: normalizeStatus(row.status),
      ran_by: row.ran_by,
      duration_ms: row.duration_ms
    })) : taskHistory(db, taskType, limit)
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

function runCronTask(db, taskType, sessionId = null) {
  if (!TRACKED_TYPES.includes(taskType)) {
    throw new Error(`unsupported cron task: ${taskType}`);
  }
  if (!MANUAL_RUN_TYPES.includes(taskType)) {
    throw new Error(`unsupported manual cron task: ${taskType}`);
  }

  const now = new Date();
  const nowMs = now.getTime();

  // Tester #447: `summarize_pending` extracts memories from ONE session's transcript,
  // so a manual run needs the session it is for. The Stop hook already recorded
  // everything the payload needs on `session_context`; a session it never saw is
  // refused by name rather than queued as a bad payload the daemon would skip.
  if (taskType === 'summarize_pending') {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('summarize_pending needs --session <id> (ccmem admin cron list shows queued summaries)');
    }
    const context = db.prepare(
      `SELECT session_id, transcript_path, last_seq, agent
       FROM session_context
       WHERE session_id = ?`
    ).get(sessionId);
    if (!context) {
      throw new Error(`no session context for ${sessionId}`);
    }
    if (typeof context.transcript_path !== 'string' || context.transcript_path === '') {
      throw new Error(`session ${sessionId} has no transcript recorded (its Stop has not run since the upgrade)`);
    }
    const payload = {
      session_id: context.session_id,
      transcript_path: context.transcript_path,
      last_message_seq: Number(context.last_seq ?? 0),
      ...(context.agent ? { agent: context.agent } : {})
    };
    const inserted = db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES (?, ?, ?, ?, 'queued')`
    ).run(taskType, JSON.stringify(payload), nowMs, nowMs);
    touchWakeFile();
    return { task_id: Number(inserted.lastInsertRowid), type: taskType, scheduled_for: nowMs, enqueued_at: nowMs, status: 'queued' };
  }

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

  // Tester #447: enqueueing without waking the daemon left a manual run waiting out
  // the idle tick -- 300 s idle, observed live as 21:42:43 enqueued, 21:48 claimed.
  touchWakeFile();

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

export async function cmdAdminCron(db, { verb, taskType = null, history = null, issues = false, verbose = false, sessionId = null } = {}) {
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
    return runCronTask(db, taskType, sessionId);
  }

  throw new Error(`unsupported admin cron verb: ${verb}`);
}
