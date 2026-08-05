import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { RAN_BY, tryClaimLease } from '../lib/task-runs.mjs';
import { wakeRecently } from './wake.mjs';

const ERROR_EXCERPT_MAX = 200;
const RETRY_DELAY_BASE_MS = 60_000;
const RETRY_ATTEMPTS_MAX = 3;

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function weekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function parseClock(value, fallbackHour, fallbackMinute, invalidHour = 0, invalidMinute = 0) {
  if (value == null || value === '') {
    return { hour: fallbackHour, minute: fallbackMinute };
  }

  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: invalidHour, minute: invalidMinute };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: invalidHour, minute: invalidMinute };
  }

  return { hour, minute };
}

export function parseDailyAt(value) {
  return parseClock(value, 2, 17);
}

export function parseWeeklyAt(value) {
  if (value == null || value === '') {
    return { weekday: 0, hour: 3, minute: 17 };
  }

  const match = String(value).trim().match(/^([A-Za-z]{3})\s+(\d{1,2}:\d{2})$/);
  if (!match) {
    return { weekday: 0, hour: 0, minute: 0 };
  }

  const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const weekday = weekdayMap[match[1].toLowerCase()];
  if (weekday == null) {
    return { weekday: 0, hour: 0, minute: 0 };
  }

  const clock = parseClock(match[2], 3, 17);
  return { weekday, hour: clock.hour, minute: clock.minute };
}

function weeklyLeaseAnchor(date, weekday, hour, minute) {
  const anchor = new Date(date.getTime());
  const dayOffset = (anchor.getDay() - weekday + 7) % 7;
  anchor.setDate(anchor.getDate() - dayOffset);
  anchor.setHours(hour, minute, 0, 0);

  if (date < anchor) {
    anchor.setDate(anchor.getDate() - 7);
  }

  return anchor;
}

export function weeklyLeaseKey(date, weeklyAt = null) {
  const parsed = typeof weeklyAt === 'string' || weeklyAt == null
    ? parseWeeklyAt(weeklyAt ?? loadConfig().cron?.weekly_at)
    : weeklyAt;
  return weekKey(weeklyLeaseAnchor(date, parsed.weekday, parsed.hour, parsed.minute));
}

export function securityAuditLeaseKey(date, hour = 3, minute = 47) {
  return weekKey(weeklyLeaseAnchor(date, 0, hour, minute));
}

export function contradictionAuditLeaseKey(date, hour = 4, minute = 17) {
  return weekKey(weeklyLeaseAnchor(date, 0, hour, minute));
}

export function monthlyMetaLeaseKey(date, scope) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}_${scope}`;
}

function timeReached(date, hour, minute) {
  return date.getHours() > hour || (date.getHours() === hour && date.getMinutes() >= minute);
}

/**
 * Deliberately NOT a task_runs lease. Leases exist for cross-process
 * idempotency (daemon / opportunistic / manual can race for one period) — a
 * guarantee a probe that is only ever initiated by the daemon, under a lock
 * that admits one daemon process, can never use. That, and only that, is the
 * reason: task_runs growth is NOT an argument here, because task_runs IS
 * pruned (tier15.mjs runs `DELETE FROM task_runs WHERE date_key < 30 days ago`
 * at two sites), so a 5-minute probe's leases would be bounded at ~8.6k rows.
 * Paying that for an unused guarantee is pointless, not dangerous.
 *
 * The growth this does NOT avoid, disclosed here because it is real: each
 * probe inserts a row into `tasks`, and no `DELETE FROM tasks` exists anywhere
 * in scripts/. At interval_ms=300000 that is ~288 rows/day, ~105k/year, in a
 * table whose only index is uniq_tasks_summarize_session_seq — so mainLoop's
 * due-query below scans it. Not fixed here on purpose: adding a `tasks` pruner
 * is a repo-wide retention decision, out of scope for this probe.
 *
 * Seeded from daemon start, NOT from 0. With the activity gate below, a 0 seed
 * would make `MAX(session_context.updated_at) > lastProbeAtMs` true on the
 * strength of any session that has ever existed, so every restart would emit
 * exactly the nobody-was-using-it sample the gate exists to remove.
 *
 * The cost of the seed, stated because it is invisible otherwise: no probe
 * fires in the first interval_ms after any restart, including a restart in the
 * middle of dense work. Five minutes, and restarts are rare.
 */
let lastProbeAtMs = Date.now();
let warnedBadProbeInterval = false;

const DEFAULT_PROBE_INTERVAL_MS = 300000;

/**
 * Both bad values fail invisibly, which is why this one warns where the repo's
 * other numeric config reads (claude-p.mjs, vec-backfill.mjs, openai.mjs) fall
 * back silently: a non-numeric interval makes `nowMs - lastProbeAtMs >= NaN`
 * false forever, so the probe never runs while `enabled: true` says it does;
 * a zero or negative one enqueues on every loop iteration — real billable
 * OpenAI requests from a typo. One line per process, not per iteration.
 */
function resolveProbeIntervalMs(raw) {
  const value = Number(raw ?? DEFAULT_PROBE_INTERVAL_MS);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  if (!warnedBadProbeInterval) {
    warnedBadProbeInterval = true;
    process.stderr.write(
      `ccmem: embedding.latency_probe.interval_ms=${JSON.stringify(raw)} is not a positive number — using ${DEFAULT_PROBE_INTERVAL_MS}ms\n`
    );
  }
  return DEFAULT_PROBE_INTERVAL_MS;
}

/**
 * Test seam only. Takes the instant to treat as daemon start, because tests
 * drive scheduleCronTasks from a fixed fake clock: seeding from the real
 * Date.now() would put lastProbeAtMs in their future and make the rate-cap
 * check unsatisfiable. The default mirrors the module initialiser so the two
 * sites cannot drift into describing different starting states.
 */
export function _resetProbeSchedule(startMs = Date.now()) {
  lastProbeAtMs = startMs;
  warnedBadProbeInterval = false;
}

export function scheduleCronTasks(db, now = new Date()) {
  const nowMs = now.getTime();
  const cfg = loadConfig();
  const dailyCfg = parseDailyAt(cfg.cron?.daily_at);
  const weeklyCfg = parseWeeklyAt(cfg.cron?.weekly_at);
  const auditCfg = cfg.security?.audit ?? {};
  const auditHour = Number(auditCfg.schedule_hour ?? 3);
  const auditMinute = Number(auditCfg.schedule_minute ?? 47);
  const catchUpDays = Number(auditCfg.catch_up_days ?? 7);
  const contradictionCfg = cfg.contradiction?.audit ?? {};
  const contradictionHour = Number(contradictionCfg.schedule_hour ?? 4);
  const contradictionMinute = Number(contradictionCfg.schedule_minute ?? 17);
  const crossProjectCfg = cfg.cross_project?.audit ?? {};

  const probeCfg = cfg.embedding?.latency_probe ?? {};
  if (probeCfg.enabled === true) {
    const probeIntervalMs = resolveProbeIntervalMs(probeCfg.interval_ms);
    // All three hooks bump session_context.updated_at (prompt-submit on every
    // prompt, session-start, stop), so this is the hook path telling the daemon
    // it is worth sampling — without the daemon touching the hook path. One row
    // per session, a few hundred rows, so MAX is a negligible scan and no index
    // is warranted.
    const lastActivityMs = db.prepare(
      `SELECT MAX(updated_at) AS t FROM session_context`
    ).get()?.t ?? 0;
    if (lastActivityMs > lastProbeAtMs && nowMs - lastProbeAtMs >= probeIntervalMs) {
      lastProbeAtMs = nowMs;
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('embed_latency_probe', '{}', ?, ?, 'queued')`
      ).run(nowMs, nowMs);
    }
  }

  if (timeReached(now, dailyCfg.hour, dailyCfg.minute)) {
    const leaseKey = dayKey(now);

    if (tryClaimLease(db, 'daily_maintenance', leaseKey, RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('daily_maintenance', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({ lease_key: leaseKey }), nowMs, nowMs);
    }
  }

  if (now.getDay() === weeklyCfg.weekday && timeReached(now, weeklyCfg.hour, weeklyCfg.minute)) {
    const leaseKey = weeklyLeaseKey(now, weeklyCfg);

    if (tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({ lease_key: leaseKey }), nowMs, nowMs);
    }
  }

  const securityAnchor = weeklyLeaseAnchor(now, 0, auditHour, auditMinute);
  const withinCatchUpWindow = !Number.isFinite(catchUpDays)
    || catchUpDays <= 0
    || (nowMs - securityAnchor.getTime()) < (catchUpDays * 86400000);

  if (timeReached(now, auditHour, auditMinute) && withinCatchUpWindow) {
    const leaseKey = securityAuditLeaseKey(now, auditHour, auditMinute);

    if (tryClaimLease(db, 'security_audit', leaseKey, RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('security_audit', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({ lease_key: leaseKey }), nowMs, nowMs);
    }
  }

  if (
    contradictionCfg.enabled !== false
    && now.getDay() === Number(contradictionCfg.schedule_weekday ?? 0)
    && timeReached(now, contradictionHour, contradictionMinute)
  ) {
    const leaseKey = contradictionAuditLeaseKey(now, contradictionHour, contradictionMinute);

    if (tryClaimLease(db, 'contradiction_audit', leaseKey, RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('contradiction_audit', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({ lease_key: leaseKey }), nowMs, nowMs);
    }
  }

  if (
    crossProjectCfg.enabled !== false
    && now.getDay() === Number(crossProjectCfg.schedule_weekday ?? 0)
    && timeReached(now, Number(crossProjectCfg.schedule_hour ?? 4), Number(crossProjectCfg.schedule_minute ?? 47))
  ) {
    const leaseKey = weeklyLeaseKey(now, {
      weekday: Number(crossProjectCfg.schedule_weekday ?? 0),
      hour: Number(crossProjectCfg.schedule_hour ?? 4),
      minute: Number(crossProjectCfg.schedule_minute ?? 47)
    });

    if (tryClaimLease(db, 'cross_project_patterns', leaseKey, RAN_BY.DAEMON)) {
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('cross_project_patterns', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({ lease_key: leaseKey }), nowMs, nowMs);
    }
  }
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

function isRetryableTaskError(error) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return true;
  }

  return /claude -p timeout after \d+ms/.test(errorMessage(error));
}

function resolveRetryDelayMs(task, error, currentAttempt) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }

  return Math.pow(2, currentAttempt - 1) * RETRY_DELAY_BASE_MS;
}

function scheduleRetry(db, task, error, currentAttempt) {
  if (!isRetryableTaskError(error) || currentAttempt > RETRY_ATTEMPTS_MAX) {
    return false;
  }

  const enqueuedAt = Date.now();
  const delayMs = resolveRetryDelayMs(task, error, currentAttempt);
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).run(task.type, task.payload ?? null, enqueuedAt + delayMs, enqueuedAt, currentAttempt);

  return true;
}

/**
 * A 'running' row whose process died is never reclaimed by anything, and two
 * individually-correct guards then deadlock on it: enqueueContinuation counts only
 * 'queued' (counting 'running' would make the condition permanently true for the
 * run doing the counting), while daemon startup counts 'queued' OR 'running' and so
 * reads the orphan as work already scheduled. Observed live: a daemon restart
 * mid-batch froze the backfill chain at 1159 pending with no error and no log line.
 *
 * Safe to do unconditionally at startup: acquireDaemonLock throws unless the
 * previous lock is stale, so once it returns there is no other daemon and every
 * 'running' row is provably ownerless. Marking them 'failed' is the truth — the
 * process did die — and it matches how runTask records a failure, so each task
 * type's ordinary re-queue path takes it from there.
 */
export function reclaimOrphanedTasks(db) {
  const finishedAt = Date.now();
  const result = db.prepare(
    `UPDATE tasks
     SET status = 'failed',
         finished_at = ?,
         duration_ms = CASE
           WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
           ELSE 0
         END,
         error_excerpt = 'daemon exited while this task was running'
     WHERE status = 'running'`
  ).run(finishedAt, finishedAt, finishedAt);

  return Number(result?.changes ?? 0);
}

export async function runTask(db, task, dispatch, { afterTask } = {}) {
  db.prepare(
    `UPDATE tasks
     SET status = 'running', started_at = ?, attempts = attempts + 1
     WHERE id = ?`
  ).run(Date.now(), task.id);

  try {
    await dispatch(db, task);
    const finishedAt = Date.now();
    db.prepare(
      `UPDATE tasks
       SET status = 'completed',
           finished_at = ?,
           duration_ms = CASE
             WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
             ELSE 0
           END,
           error_excerpt = NULL
       WHERE id = ? AND status = 'running'`
    ).run(finishedAt, finishedAt, finishedAt, task.id);
  } catch (error) {
    const finishedAt = Date.now();
    const message = errorMessage(error).slice(0, ERROR_EXCERPT_MAX);
    const currentAttempt = Number(task.attempts ?? 0) + 1;

    db.prepare(
      `UPDATE tasks
       SET status = 'failed',
           finished_at = ?,
           duration_ms = CASE
             WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
             ELSE 0
           END,
           error_excerpt = ?
       WHERE id = ?`
    ).run(finishedAt, finishedAt, finishedAt, message, task.id);

    scheduleRetry(db, task, error, currentAttempt);
  } finally {
    await afterTask?.(task);
  }
}

export async function mainLoop(db, shouldStop, dispatch, { afterTask } = {}) {
  while (!shouldStop()) {
    if (getMode(db) === 'off') {
      await new Promise((resolve) => setTimeout(resolve, wakeRecently() ? 30000 : 300000));
      continue;
    }

    scheduleCronTasks(db);

    const due = db.prepare(
      `SELECT *
       FROM tasks
       WHERE status = 'queued' AND scheduled_for <= ?
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

      await runTask(db, task, dispatch, { afterTask });
    }
  }
}

export { dayKey, weekKey, timeReached };
