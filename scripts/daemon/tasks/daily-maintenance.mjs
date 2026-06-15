import { loadConfig } from '../../lib/config.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { writeMetricsDailyRollup } from '../../lib/metrics-rollup.mjs';
import { revalidationAuditCore } from '../../lib/revalidation.mjs';
import { pruneMigrationBackups } from '../../lib/db.mjs';
import { monthlyMetaLeaseKey } from '../loop.mjs';
import { RAN_BY, markLeaseComplete, tryClaimLease } from '../../lib/task-runs.mjs';
import { runVecBackfill } from './vec-backfill.mjs';

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function projectScopes(db) {
  return db.prepare(
    `SELECT DISTINCT project_key
     FROM memories
     WHERE scope = 'project'
       AND project_key IS NOT NULL
       AND type = 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all().map((row) => row.project_key);
}

let inflightDaily = false;

export async function runDailyMaintenance(db, task) {
  if (inflightDaily) {
    return;
  }

  inflightDaily = true;
  const now = Date.now();
  const cfg = loadConfig();
  const payload = JSON.parse(task?.payload ?? '{}');
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : dayKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : now));

  try {
    db.prepare(
      `UPDATE memories
       SET decay_status = 'candidate_expire', updated_at = ?
       WHERE decay_status = 'active'
         AND pinned = 0
         AND helpful_count = 0
         AND half_life_days IS NOT NULL
         AND ((? - last_touched_at) / 86400000.0) > (half_life_days * 2)`
    ).run(now, now);

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
      `DELETE FROM ccmem_blacklisted_sessions
       WHERE expires_at < ?`
    ).run(now);

    const sunsetCutoff = now - (cfg.security.quarantine.sunset_days * 86400000);
    const sunsetRows = db.prepare(
      `SELECT id, quarantined_at
       FROM memories
       WHERE decay_status = 'quarantine'
         AND quarantined_at IS NOT NULL
         AND quarantined_at < ?`
    ).all(sunsetCutoff);

    for (const row of sunsetRows) {
      const updated = db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ? AND decay_status = 'quarantine'`
      ).run(now, row.id);

      if (updated.changes > 0) {
        writeAudit(db, 'security_quarantine_sunset', row.id, {
          quarantined_at: row.quarantined_at,
          sunset_at: now,
          duration_days: Math.floor((now - row.quarantined_at) / 86400000)
        });
      }
    }

    db.prepare(
      `DELETE FROM cross_scope_alerts
       WHERE detected_at < ?`
    ).run(now - (cfg.security.cross_scope.alert_retention_days * 86400000));

    db.prepare(
      `DELETE FROM contradiction_alerts
       WHERE detected_at < ?`
    ).run(now - (Number(cfg.contradiction?.alert_retention_days ?? 60) * 86400000));

    db.prepare(
      `UPDATE memories
       SET decay_status = 'archived', updated_at = ?
       WHERE decay_status = 'candidate_expire'
         AND ((? - updated_at) / 86400000.0) > ?`
    ).run(now, now, Number(cfg.adaptive_decay?.candidate_expire_archive_days ?? 30));

    db.prepare(
      `UPDATE memories
       SET decay_status = 'candidate_expire', updated_at = ?
       WHERE type = 'consolidated'
         AND decay_status = 'active'
         AND pinned = 0
         AND helpful_count = 0
         AND consolidation_depth <= ?
         AND ((? - created_at) / 86400000.0) > ?`
    ).run(
      now,
      Number(cfg.adaptive_decay?.consolidated_max_depth_for_expire ?? 1),
      now,
      Number(cfg.adaptive_decay?.consolidated_fast_expire_days ?? 60)
    );

    db.prepare(
      `DELETE FROM promote_candidates
       WHERE detected_at < ?`
    ).run(now - (Number(cfg.cross_project?.alert_retention_days ?? 60) * 86400000));

    try {
      revalidationAuditCore(db, { trigger: 'daily' });
    } catch (error) {
      writeAudit(db, 'revalidation_daily_error', null, {
        error: String(error?.message ?? error).slice(0, 200)
      });
    }

    try {
      await runVecBackfill(db, task);
    } catch (error) {
      writeAudit(db, 'vec_backfill_error', null, {
        error: String(error?.message ?? error).slice(0, 200),
        embedded_before_fail: 0
      });
    }

    if (cfg.metrics_rollup?.enabled !== false) {
      try {
        writeMetricsDailyRollup(db);
      } catch (error) {
        writeAudit(db, 'metrics_rollup_error', null, {
          error: String(error?.message ?? error).slice(0, 200)
        });
      }
    }

    if (Number(new Date(now).getDate()) === 1 && cfg.consolidation?.monthly?.enabled !== false) {
      const threshold = Number(cfg.consolidation?.monthly?.min_consolidated ?? 30);
      for (const scope of ['global', ...projectScopes(db)]) {
        const count = Number((scope === 'global'
          ? db.prepare(
              `SELECT COUNT(*) AS n
               FROM memories
               WHERE type = 'consolidated'
                 AND status = 'active'
                 AND decay_status IN ('active', 'probation')
                 AND scope = 'global'`
            ).get()
          : db.prepare(
              `SELECT COUNT(*) AS n
               FROM memories
               WHERE type = 'consolidated'
                 AND status = 'active'
                 AND decay_status IN ('active', 'probation')
                 AND project_key = ?`
            ).get(scope))?.n ?? 0);

        if (count < threshold) {
          continue;
        }

        const metaLeaseKey = monthlyMetaLeaseKey(new Date(now), scope);
        if (!tryClaimLease(db, 'monthly_meta_synthesis', metaLeaseKey, RAN_BY.DAEMON)) {
          continue;
        }

        db.prepare(
          `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
           VALUES ('monthly_meta_synthesis', ?, ?, ?, 'queued')`
        ).run(JSON.stringify({ scope, lease_key: metaLeaseKey }), now, now);
      }
    }

    pruneMigrationBackups();
    markLeaseComplete(db, 'daily_maintenance', leaseKey);
  } finally {
    inflightDaily = false;
  }
}
