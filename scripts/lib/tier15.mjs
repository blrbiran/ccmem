import { loadConfig } from './config.mjs';
import { rebuildInjectionCache } from './injection-cache.mjs';
import { writeAudit } from './audit.mjs';
import { markLeaseComplete, RAN_BY, tryClaimLease } from './task-runs.mjs';

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function dayKeyDaysAgo(days) {
  return dayKey(new Date(Date.now() - (days * 86400000)));
}

export function runSessionStartMiniPrelude(db) {
  const today = dayKey(new Date());
  if (!tryClaimLease(db, 'tier1_5_mini_prelude', today, RAN_BY.OPPORTUNISTIC)) {
    return false;
  }

  const cfg = loadConfig();
  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(Date.now() - (cfg.recent_injections.retention_days * 86400000));

  db.prepare(
    `DELETE FROM recent_injections
     WHERE id IN (
       SELECT id
       FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id
                  ORDER BY created_at DESC, id DESC
                ) AS rn
         FROM recent_injections
       )
       WHERE rn > ?
     )`
  ).run(cfg.recent_injections.max_per_session);

  db.prepare(
    `DELETE FROM task_runs
     WHERE date_key < ?`
  ).run(dayKeyDaysAgo(30));

  markLeaseComplete(db, 'tier1_5_mini_prelude', today);
  return true;
}

export function maybeRunTier15(db) {
  const today = dayKey(new Date());

  if (!tryClaimLease(db, 'daily_maintenance', today, RAN_BY.OPPORTUNISTIC)) {
    return false;
  }

  const cfg = loadConfig();
  const now = Date.now();
  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE trust_score < 0.1 AND decay_status != 'archived'`
  ).run(now);

  db.prepare(
    `DELETE FROM recent_injections
     WHERE created_at < ?`
  ).run(now - (cfg.recent_injections.retention_days * 86400000));

  db.prepare(
    `DELETE FROM task_runs
     WHERE date_key < ?`
  ).run(dayKeyDaysAgo(30));

  if (cfg.security.tier1_5_security.enabled) {
    const clusters = db.prepare(
      `SELECT source,
              date(created_at / 1000, 'unixepoch') AS cluster_day,
              COUNT(*) AS n,
              GROUP_CONCAT(id) AS ids
       FROM memories
       WHERE source IN ('auto_inferred', 'external', 'tool_output')
         AND trust_score < ?
         AND decay_status IN ('active', 'probation', 'candidate_expire')
         AND quarantined_at IS NULL
       GROUP BY source, cluster_day
       HAVING COUNT(*) >= ?`
    ).all(
      cfg.security.tier1_5_security.trust_max,
      cfg.security.tier1_5_security.cluster_min_size
    );

    const touchedProjects = new Set();
    let touchedGlobal = false;

    for (const cluster of clusters) {
      const ids = String(cluster.ids ?? '')
        .split(',')
        .map((id) => Number(id))
        .filter(Number.isFinite);

      if (!ids.length) {
        continue;
      }

      const rows = db.prepare(
        `SELECT id, scope, project_key
         FROM memories
         WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);

      const updated = db.prepare(
        `UPDATE memories
         SET decay_status = 'quarantine', quarantined_at = ?, updated_at = ?
         WHERE id IN (${ids.map(() => '?').join(',')})
           AND decay_status != 'quarantine'`
      ).run(now, now, ...ids);

      if (updated.changes === 0) {
        continue;
      }

      for (const row of rows) {
        if (row.scope === 'global') {
          touchedGlobal = true;
        } else if (row.project_key) {
          touchedProjects.add(row.project_key);
        }

        writeAudit(db, 'security_quarantine_in', row.id, {
          reason: 'tier1_5_heuristic_cluster',
          cluster_size: Number(cluster.n ?? 0),
          source: 'heuristic',
          pattern_version: cfg.security.scan_patterns_version,
          cluster_day: cluster.cluster_day,
          source_type: cluster.source
        });
      }
    }

    if (touchedGlobal) {
      rebuildInjectionCache(db, null);
    }
    for (const projectKey of touchedProjects) {
      rebuildInjectionCache(db, projectKey);
    }
  }

  markLeaseComplete(db, 'daily_maintenance', today);
  return true;
}
