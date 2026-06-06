import { loadConfig } from '../../lib/config.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { writeMetricsDailyRollup } from '../../lib/metrics-rollup.mjs';
import { revalidationAuditCore } from '../../lib/revalidation.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

let inflightDaily = false;

export function runDailyMaintenance(db, task) {
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

    try {
      revalidationAuditCore(db, { trigger: 'daily' });
    } catch (error) {
      writeAudit(db, 'revalidation_daily_error', null, {
        error: String(error?.message ?? error).slice(0, 200)
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

    markLeaseComplete(db, 'daily_maintenance', leaseKey);
  } finally {
    inflightDaily = false;
  }
}
