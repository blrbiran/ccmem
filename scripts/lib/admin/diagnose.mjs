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

export async function cmdAdminDiagnose(
  db,
  { cwd = process.cwd(), migrations = false, key = false, sessions = false } = {}
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
