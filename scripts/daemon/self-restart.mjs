import { writeAudit } from '../lib/audit.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getSchemaVersion } from '../lib/db.mjs';

let pendingRestart = null;

function defaultSignalSelfRestart() {
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    process.exit(0);
  }
}

export function getStartupSchemaVersion(db) {
  return Number(getSchemaVersion(db) ?? 0);
}

export function writeDaemonStartupState(db, startupVersion, pid = process.pid) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('daemon_startup_schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(String(startupVersion), now);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('daemon_startup_pid', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(String(pid), now);
}

export function checkSchemaStaleness(db, startupVersion) {
  if (loadConfig().daemon?.self_restart_on_schema_mismatch === false) {
    return { stale: false, current_version: startupVersion, startup_version: startupVersion };
  }

  const currentVersion = Number(getSchemaVersion(db) ?? 0);
  return {
    stale: currentVersion !== startupVersion,
    current_version: currentVersion,
    startup_version: startupVersion
  };
}

export function scheduleGracefulRestart(db, schemaResult, daemonInfo, { now = Date.now, signal = defaultSignalSelfRestart } = {}) {
  if (pendingRestart) {
    return { will_restart: true, immediate: false, deferred_reason: 'already_scheduled' };
  }

  pendingRestart = {
    scheduled_at: now(),
    startup_version: schemaResult.startup_version,
    current_version: schemaResult.current_version,
    pid: daemonInfo.pid,
    uptime_sec: daemonInfo.uptimeSec
  };

  if (daemonInfo.currentTaskId == null) {
    writeAudit(db, 'daemon_self_restart', null, {
      from_version: schemaResult.startup_version,
      to_version: schemaResult.current_version,
      daemon_pid: daemonInfo.pid,
      daemon_uptime_sec: daemonInfo.uptimeSec,
      in_flight_task_id: null,
      in_flight_task_type: null,
      waited_ms: 0
    });
    pendingRestart = null;
    signal();
    return { will_restart: true, immediate: true, deferred_reason: null };
  }

  return {
    will_restart: true,
    immediate: false,
    deferred_reason: `in_flight:${daemonInfo.currentTaskType}#${daemonInfo.currentTaskId}`
  };
}

export function checkPendingRestart(db, startupCtx, justFinishedTask, { now = Date.now, signal = defaultSignalSelfRestart } = {}) {
  if (!pendingRestart) {
    return { restarted: false };
  }

  writeAudit(db, 'daemon_self_restart', null, {
    from_version: pendingRestart.startup_version,
    to_version: Number(getSchemaVersion(db) ?? pendingRestart.current_version),
    daemon_pid: startupCtx.pid,
    daemon_uptime_sec: Math.floor((now() - startupCtx.startedAt) / 1000),
    in_flight_task_id: justFinishedTask?.id ?? null,
    in_flight_task_type: justFinishedTask?.type ?? null,
    waited_ms: now() - pendingRestart.scheduled_at
  });

  pendingRestart = null;
  signal();
  return { restarted: true };
}

export function _resetForTest() {
  pendingRestart = null;
}
