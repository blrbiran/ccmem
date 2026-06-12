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

export async function runTask(db, task, dispatch, { afterTask } = {}) {
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
    const finishedAt = Date.now();
    const message = errorMessage(error).slice(0, ERROR_EXCERPT_MAX);
    const currentAttempt = Number(task.attempts ?? 0) + 1;

    db.prepare(
      `UPDATE tasks
       SET status = 'failed', finished_at = ?, error_excerpt = ?
       WHERE id = ?`
    ).run(finishedAt, message, task.id);

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
