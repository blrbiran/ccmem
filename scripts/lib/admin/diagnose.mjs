import { isDaemonAlive } from '../../daemon/lock.mjs';
import { getDbPath, getSchemaVersion } from '../db.mjs';
import { fallbackProjectKey, resolveProjectKey } from '../project-key.mjs';

function firstValue(row) {
  if (!row) {
    return null;
  }

  const key = Object.keys(row)[0];
  return key ? row[key] : null;
}

export async function cmdAdminDiagnose(db, { cwd = process.cwd(), migrations = false, key = false } = {}) {
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
