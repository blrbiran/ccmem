import { isDaemonAlive } from '../../daemon/lock.mjs';
import { getDbPath, getSchemaVersion } from '../db.mjs';
import { fallbackProjectKey, resolveProjectKey } from '../project-key.mjs';

const SESSION_LIMIT = 10;
const RECENT_INJECTION_LIMIT = 3;

function firstValue(row) {
  if (!row) {
    return null;
  }

  const key = Object.keys(row)[0];
  return key ? row[key] : null;
}

function parseMemIds(memIds) {
  try {
    const parsed = JSON.parse(memIds ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDetails(details) {
  try {
    return JSON.parse(details ?? '{}');
  } catch {
    return {};
  }
}

function loadSessionDiagnostics(db) {
  const sessions = db.prepare(
    `SELECT session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
     FROM session_context
     ORDER BY updated_at DESC, session_id ASC
     LIMIT ?`
  ).all(SESSION_LIMIT);

  return sessions.map((session) => ({
    session_id: session.session_id,
    project_key: session.project_key,
    tool_calls: session.tool_calls,
    message_count: session.message_count,
    duration_ms: session.duration_ms,
    last_seq: session.last_seq,
    updated_at: session.updated_at,
    recent_injections: db
      .prepare(
        `SELECT prompt_idx, inject_source, mem_ids, created_at
         FROM recent_injections
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(session.session_id, RECENT_INJECTION_LIMIT)
      .map((row) => ({
        prompt_idx: row.prompt_idx,
        inject_source: row.inject_source,
        mem_ids: parseMemIds(row.mem_ids),
        created_at: row.created_at
      }))
  }));
}

function loadSecurityDiagnostics(db) {
  const lastRun = db.prepare(
    `SELECT ts, details
     FROM audit_log
     WHERE action = 'security_audit_run'
     ORDER BY ts DESC, id DESC
     LIMIT 1`
  ).get();
  const details = parseDetails(lastRun?.details);
  const byReasonRows = db.prepare(
    `SELECT json_extract(a.details, '$.reason') AS reason, COUNT(*) AS n
     FROM audit_log a
     JOIN audit_log_targets t ON t.audit_id = a.id
     JOIN memories m ON m.id = t.mem_id
     WHERE a.action = 'security_quarantine_in'
       AND m.decay_status = 'quarantine'
     GROUP BY reason
     ORDER BY n DESC, reason ASC`
  ).all();
  const oldest = db.prepare(
    `SELECT id, quarantined_at
     FROM memories
     WHERE decay_status = 'quarantine' AND quarantined_at IS NOT NULL
     ORDER BY quarantined_at ASC, id ASC
     LIMIT 1`
  ).get();
  const alertCounts = db.prepare(
    `SELECT
       SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged
     FROM cross_scope_alerts`
  ).get();
  const quarantineCount = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE decay_status = 'quarantine'`
  ).get();

  return {
    last_run_at: lastRun?.ts ?? null,
    pattern_version: details.pattern_version ?? null,
    last_run: lastRun
      ? {
          candidates_scanned: Number(details.candidates_scanned ?? 0),
          quarantined: Number(details.quarantined ?? 0),
          alerts_emitted: Number(details.alerts_emitted ?? 0),
          llm_calls: Number(details.llm_calls ?? 0),
          duration_ms: Number(details.duration_ms ?? 0),
          pool_a: Number(details.pool_a ?? 0),
          pool_b: Number(details.pool_b ?? 0),
          pool_c: Number(details.pool_c ?? 0)
        }
      : null,
    quarantine_pool: {
      total: Number(quarantineCount?.n ?? 0),
      by_reason: byReasonRows.map((row) => ({
        reason: row.reason ?? 'unknown',
        count: Number(row.n ?? 0)
      })),
      oldest: oldest
        ? {
            id: oldest.id,
            quarantined_at: oldest.quarantined_at,
            age_days: Math.floor((Date.now() - oldest.quarantined_at) / 86400000)
          }
        : null
    },
    alerts: {
      pending: Number(alertCounts?.pending ?? 0),
      acknowledged: Number(alertCounts?.acknowledged ?? 0)
    }
  };
}

export async function cmdAdminDiagnose(
  db,
  { cwd = process.cwd(), migrations = false, key = false, sessions = false, security = false } = {}
) {
  const quickCheck = db.prepare('PRAGMA quick_check').get();
  const lock = db.prepare(
    `SELECT holder_pid, hostname, heartbeat_at
     FROM daemon_lock
     WHERE id = 1`
  ).get();
  const migrationRows = migrations
    ? db.prepare(
        `SELECT from_version, to_version, description, applied_at, applied_by
         FROM schema_migrations
         ORDER BY id ASC`
      ).all()
    : [];
  const projectKey = resolveProjectKey(cwd);
  const fallbackKey = fallbackProjectKey(cwd);
  const daemonAlive = isDaemonAlive(db);

  return {
    db: {
      path: getDbPath(),
      health: String(firstValue(quickCheck) ?? 'unknown'),
      schema_version: getSchemaVersion(db)
    },
    daemon: {
      alive: daemonAlive,
      pid: lock?.holder_pid ?? null,
      hostname: lock?.hostname ?? null,
      heartbeat_age_ms: lock ? Math.max(0, Date.now() - lock.heartbeat_at) : null
    },
    project_key: {
      value: projectKey,
      source: projectKey === fallbackKey ? 'fallback' : 'git_remote',
      cwd: key ? cwd : null,
      fallback_value: key ? fallbackKey : null
    },
    tier2: {
      available: daemonAlive
    },
    sessions: sessions ? loadSessionDiagnostics(db) : null,
    security: security ? loadSecurityDiagnostics(db) : null,
    migrations: migrations
      ? migrationRows.map((row) => ({
          from_version: row.from_version,
          to_version: row.to_version,
          description: row.description,
          applied_at: row.applied_at,
          applied_by: row.applied_by
        }))
      : null
  };
}
