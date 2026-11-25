import { loadConfig } from '../lib/config.mjs';
import { isDatabaseBusy } from '../lib/db.mjs';
import { writeAudit } from '../lib/audit.mjs';
import { getMode } from '../lib/mode.mjs';
import { RAN_BY, tryClaimLease } from '../lib/task-runs.mjs';
import { idleSleep, wakeRecently } from './wake.mjs';
import { EXHAUSTED_RETRY_MARK } from './backend-state.mjs';

const ERROR_EXCERPT_MAX = 200;
const RETRY_DELAY_BASE_MS = 60_000;
const RETRY_ATTEMPTS_MAX = 3;
// Pause after a tick lost to another connection's write lock, so codes that
// return without waiting (BUSY_RECOVERY, BUSY_SNAPSHOT) cannot spin the loop.
const BUSY_BACKOFF_MS = 1000;

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
 * probe inserts a row into `tasks`, and daemon maintenance never prunes tasks.
 * With the activity gate below, that is ≈44 rows/day (≈16k/year)
 * — derived from a frozen `metrics.jsonl` snapshot taken 2026-08-05, so treat
 * it as a dated measurement of an ongoing process, not a constant — in a
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

  // claude-p.mjs flags every backend's timeout; the message match keeps
  // errors that only carry the text retryable as before.
  if (error?.timedOut === true) {
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

function summarizeSnapshotIsStale(db, task) {
  if (task.type !== 'summarize_pending') {
    return false;
  }

  const payload = JSON.parse(task.payload ?? '{}');
  const observedAt = Number(payload.snapshot_observed_at);
  if (Number.isFinite(observedAt)) {
    return Boolean(db.prepare(
      `SELECT id
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status IN ('queued', 'running')
         AND id <> ?
         AND json_extract(payload, '$.session_id') = ?
         AND json_extract(payload, '$.snapshot_observed_at') > ?
       LIMIT 1`
    ).get(task.id, payload.session_id, observedAt));
  }

  const lastMessageSeq = Number(payload.last_message_seq ?? 0);
  return Boolean(db.prepare(
    `SELECT id
     FROM tasks
     WHERE type = 'summarize_pending'
       AND status IN ('queued', 'running')
       AND id <> ?
       AND json_extract(payload, '$.session_id') = ?
       AND json_extract(payload, '$.snapshot_observed_at') IS NULL
       AND json_extract(payload, '$.last_message_seq') > ?
     LIMIT 1`
  ).get(task.id, payload.session_id, lastMessageSeq));
}

function supersedeWinningSummarizeTask(db, taskId, sessionId) {
  db.prepare(
    `UPDATE tasks
     SET status = 'superseded', finished_at = ?
     WHERE id = ?
       AND status = 'running'`
  ).run(Date.now(), taskId);
  writeAudit(db, 'summarize_pending_superseded', null, {
    task_id: taskId,
    session_id: sessionId,
    reason: 'retry_snapshot_stale'
  });
}

function insertRetryTask(db, task, enqueuedAt, delayMs, currentAttempt, mark) {
  const payload = JSON.parse(task.payload ?? '{}');
  if (task.type === 'summarize_pending' && summarizeSnapshotIsStale(db, task)) {
    if (task.status === 'running') {
      supersedeWinningSummarizeTask(db, task.id, payload.session_id);
    }
    return;
  }

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts, error_excerpt)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`
  ).run(task.type, task.payload ?? null, enqueuedAt + delayMs, enqueuedAt, currentAttempt, mark);
}

function scheduleRetry(db, task, error, currentAttempt) {
  // An exhausted backend (claude-p.mjs sets error.exhaustion) is not the
  // task's fault: it waits for the reset or the human's approval however many
  // times that takes (spec G5: no queued work lost), spaced by retryAfter.
  const exhausted = error?.exhaustion != null;
  if (!isRetryableTaskError(error) || (currentAttempt > RETRY_ATTEMPTS_MAX && !exhausted)) {
    return false;
  }

  const enqueuedAt = Date.now();
  const delayMs = resolveRetryDelayMs(task, error, currentAttempt);
  // A retry waiting on an exhausted backend is marked with it, so approving
  // a switch away from that backend can run it at once (approveProposal).
  const backend = exhausted ? String(error.exhaustion.backend ?? '') : '';
  const mark = backend
    ? `${EXHAUSTED_RETRY_MARK}${backend}: ${errorMessage(error)}`.slice(0, ERROR_EXCERPT_MAX)
    : null;
  // A summarize retry re-queues the same payload, so it carries the ORIGINAL
  // snapshot_observed_at and transcript_window. insertRetryTask refuses to
  // queue it when a newer Stop already supersedes that snapshot, and marks a
  // running row superseded: the retry must never look newer than it is.
  insertRetryTask(db, task, enqueuedAt, delayMs, currentAttempt, mark);
  return true;
}

/**
 * Reclaim tasks left by a dead daemon so an orphan does not block a new batch.
 * The interval to reclaim is diagnostic age, not measured execution time.
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
         duration_ms = 0,
         reclaimed_ms = CASE
           WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
           ELSE NULL
         END,
         error_excerpt = 'daemon exited while this task was running'
     WHERE status = 'running'`
  ).run(finishedAt, finishedAt, finishedAt);

  return Number(result?.changes ?? 0);
}

/**
 * Returns false, without dispatching, when another connection holds the write
 * lock at the start: the row stays 'queued' with its attempts unchanged, so a
 * later tick picks it up. Live 2026-10-20, this UPDATE threw an uncaught
 * `database is locked` and the daemon process exited with nothing to restart it.
 */
export async function runTask(db, task, dispatch, { afterTask } = {}) {
  try {
    db.prepare(
      `UPDATE tasks
       SET status = 'running', started_at = ?, attempts = attempts + 1
       WHERE id = ?`
    ).run(Date.now(), task.id);
  } catch (error) {
    if (isDatabaseBusy(error)) {
      return false;
    }
    throw error;
  }

  let dispatched = false;
  let dispatchError = null;
  let dispatchResult = null;
  try {
    dispatchResult = await dispatch(db, task);
    dispatched = true;
  } catch (error) {
    dispatchError = error;
  }

  try {
    const finishedAt = Date.now();
    if (dispatched) {
      // Tester #496: a summarize task with no transcript settles without extraction.
      const skippedReason = dispatchResult?.skipped;
      if (task.type === 'summarize_pending' && skippedReason === 'no-transcript') {
        try {
          db.prepare(
            `UPDATE tasks
             SET status = 'skipped',
                 finished_at = ?,
                 duration_ms = CASE
                   WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
                   ELSE 0
                 END,
                 error_excerpt = ?
             WHERE id = ? AND status = 'running'`
          ).run(finishedAt, finishedAt, finishedAt, `skipped: ${skippedReason}`, task.id);
          return true;
        } catch (error) {
          // A database built from the v0.1 spec carries a `tasks.status` CHECK
          // that predates 'skipped' (see the #444 note below). A skip must never
          // crash the loop, and must never become green either: record it failed
          // with the reason, which is what a health read will surface.
          if (!/CHECK constraint failed/.test(String(error?.message))) throw error;
          db.prepare(
            `UPDATE tasks
             SET status = 'failed',
                 finished_at = ?,
                 duration_ms = CASE
                   WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
                   ELSE 0
                 END,
                 error_excerpt = ?
             WHERE id = ? AND status = 'running'`
          ).run(
            finishedAt,
            finishedAt,
            finishedAt,
            `skipped: ${skippedReason} (this tasks.status CHECK cannot store 'skipped')`,
            task.id
          );
          return true;
        }
      }

      // Issue #444: this write is deliberately OUTSIDE the dispatch catch. A database
      // built from the v0.1 spec carries `tasks.status CHECK (…, 'success', …)`; writing
      // 'completed' there threw, the catch then recorded a task that had SUCCEEDED as
      // 'failed' with `CHECK constraint failed…` as its excerpt, and every health read
      // ("did the daemon finish? why did the last run fail?") inverted. 'success' is the
      // word the spec names and both an old and a new database accept it.
      db.prepare(
        `UPDATE tasks
         SET status = 'success',
             finished_at = ?,
             duration_ms = CASE
               WHEN started_at IS NOT NULL AND ? >= started_at THEN ? - started_at
               ELSE 0
             END,
             error_excerpt = NULL
         WHERE id = ? AND status = 'running'`
      ).run(finishedAt, finishedAt, finishedAt, task.id);
      return true;
    }

    const message = errorMessage(dispatchError).slice(0, ERROR_EXCERPT_MAX);
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

    scheduleRetry(db, { ...task, status: 'running' }, dispatchError, currentAttempt);
    return true;
  } catch (error) {
    // A settle that lost the write lock leaves the row 'running'; startup reclaim
    // records it truthfully (reclaimOrphanedTasks). Anything else is a schema or
    // storage fault and must be loud rather than recorded as a task failure.
    if (isDatabaseBusy(error)) {
      return true;
    }
    throw error;
  } finally {
    await afterTask?.(task);
  }
}

// `wake` ({ pollMs, debounceMs }) overrides idleSleep's pacing; tests use it, the daemon does not.
export async function mainLoop(db, shouldStop, dispatch, { afterTask, wake } = {}) {
  while (!shouldStop()) {
    const tickStartedAt = Date.now();
    if (getMode(db) === 'off') {
      await idleSleep(wakeRecently() ? 30000 : 300000, { ...wake, shouldStop, since: tickStartedAt });
      continue;
    }

    let due;
    try {
      scheduleCronTasks(db);

      due = db.prepare(
        `SELECT *
         FROM tasks
         WHERE status = 'queued' AND scheduled_for <= ?
         ORDER BY scheduled_for ASC`
      ).all(Date.now());
    } catch (error) {
      if (!isDatabaseBusy(error)) {
        throw error;
      }
      // Busy is another connection's write; this tick's work waits for the next.
      await new Promise((resolve) => setTimeout(resolve, BUSY_BACKOFF_MS));
      continue;
    }

    if (!due.length) {
      await idleSleep(wakeRecently() ? 30000 : 300000, { ...wake, shouldStop, since: tickStartedAt });
      continue;
    }

    for (const task of due) {
      if (shouldStop()) {
        break;
      }

      if (!(await runTask(db, task, dispatch, { afterTask }))) {
        // The lock is someone else's; the rest of this batch waits a tick.
        await new Promise((resolve) => setTimeout(resolve, BUSY_BACKOFF_MS));
        break;
      }
    }
  }
}

export { dayKey, weekKey, timeReached };
