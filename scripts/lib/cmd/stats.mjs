import { isDaemonAlive } from '../../daemon/lock.mjs';
import { loadConfig } from '../config.mjs';
import { getTuningDiagnostics } from '../admin/diagnose.mjs';
import { transformersLocal } from '../embedding/transformers-local.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

const FEEDBACK_WINDOW_MS = 14 * 86400000;

function toCount(value) {
  return Number(value ?? 0);
}

function toFeedbackMap(rows) {
  const counts = {
    helpful: 0,
    unhelpful: 0,
    unknown: 0
  };

  for (const row of rows) {
    if (row.outcome in counts) {
      counts[row.outcome] = Number(row.n ?? 0);
    }
  }

  return counts;
}

function toPendingMap(rows) {
  const pending = {
    daily_maintenance: 0,
    summarize_pending: 0,
    weekly_synthesis: 0,
    security_audit: 0,
    contradiction_audit: 0,
    monthly_meta_synthesis: 0,
    revalidation_audit: 0,
    vec_backfill: 0,
    total: 0
  };

  for (const row of rows) {
    const n = Number(row.n ?? 0);
    pending.total += n;
    if (row.type in pending) {
      pending[row.type] = n;
    }
  }

  return pending;
}

function semanticRuntimeEnabled(db, cfg) {
  const kv = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.enabled'`).get()?.value ?? null;
  return kv != null ? kv === 'true' : Boolean(cfg.embedding?.enabled);
}

function getSemanticStats(db, cfg) {
  const enabled = semanticRuntimeEnabled(db, cfg);
  const embedded = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
  const pending = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);

  if (!enabled) {
    return {
      status: 'disabled',
      enabled: false,
      loaded: false,
      model: cfg.embedding?.model ?? transformersLocal.modelId,
      dim: transformersLocal.dim,
      embedded,
      pending
    };
  }

  const status = pending > 0 ? 'pending backfill' : embedded > 0 ? 'active' : 'enabled';
  return {
    status,
    enabled: true,
    loaded: transformersLocal.isLoaded(),
    model: cfg.embedding?.model ?? transformersLocal.modelId,
    dim: transformersLocal.dim,
    embedded,
    pending
  };
}

export async function cmdStats(db, { buckets = false } = {}) {
  const tier15 = maybeRunTier15(db);
  const now = Date.now();
  const cfg = loadConfig();

  const memoryRow = db.prepare(
    `SELECT
       SUM(CASE WHEN decay_status = 'active' AND status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN decay_status = 'active' AND status = 'probation' THEN 1 ELSE 0 END) AS probation,
       SUM(CASE WHEN decay_status = 'quarantine' THEN 1 ELSE 0 END) AS quarantined,
       SUM(CASE WHEN decay_status = 'archived' THEN 1 ELSE 0 END) AS archived,
       COUNT(*) AS total,
       AVG(trust_score) AS avg_trust,
       SUM(CASE WHEN decay_status = 'active' AND trust_score >= 0.1 AND trust_score < 0.2 THEN 1 ELSE 0 END) AS grey_zone
     FROM memories`
  ).get();
  const feedbackRows = db.prepare(
    `SELECT outcome, COUNT(*) AS n
     FROM memory_feedback
     WHERE recorded_at >= ?
     GROUP BY outcome`
  ).all(now - FEEDBACK_WINDOW_MS);
  const pendingRows = db.prepare(
    `SELECT type, COUNT(*) AS n
     FROM tasks
     WHERE status = 'queued'
     GROUP BY type`
  ).all();
  const runningTask = db.prepare(
    `SELECT id, type, started_at
     FROM tasks
     WHERE status = 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`
  ).get();
  const lock = db.prepare(
    `SELECT holder_pid, hostname, heartbeat_at
     FROM daemon_lock
     WHERE id = 1`
  ).get();
  const bucketRows = buckets
    ? db.prepare(
        `SELECT decay_status, COUNT(*) AS n
         FROM memories
         GROUP BY decay_status
         ORDER BY decay_status ASC`
      ).all()
    : [];
  const alertsRow = db.prepare(
    `SELECT
       SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged
     FROM cross_scope_alerts`
  ).get();
  const contradictionsRow = db.prepare(
    `SELECT COUNT(*) AS n
     FROM contradiction_alerts
     WHERE acknowledged_at IS NULL`
  ).get();
  const pendingSunsetCutoff = now - ((cfg.security.quarantine.sunset_days - 5) * 86400000);
  const pendingSunsetRow = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE decay_status = 'quarantine'
       AND quarantined_at IS NOT NULL
       AND quarantined_at < ?`
  ).get(pendingSunsetCutoff);
  const tuning = getTuningDiagnostics(db, cfg);
  const semantic = getSemanticStats(db, cfg);

  return {
    tier1: { available: true },
    tier15,
    tier2: {
      alive: isDaemonAlive(db),
      pid: lock?.holder_pid ?? null,
      hostname: lock?.hostname ?? null,
      heartbeat_age_ms: lock ? Math.max(0, now - lock.heartbeat_at) : null,
      running_task: runningTask
        ? { id: runningTask.id, type: runningTask.type, started_at: runningTask.started_at }
        : null,
      pending: toPendingMap(pendingRows)
    },
    semantic,
    memories: {
      active: toCount(memoryRow?.active),
      probation: toCount(memoryRow?.probation),
      quarantined: toCount(memoryRow?.quarantined),
      archived: toCount(memoryRow?.archived),
      total: toCount(memoryRow?.total)
    },
    trust: {
      avg: Number((Number(memoryRow?.avg_trust ?? 0)).toFixed(2)),
      grey_zone: toCount(memoryRow?.grey_zone)
    },
    security: {
      quarantined: toCount(memoryRow?.quarantined),
      pending_sunset: toCount(pendingSunsetRow?.n),
      alerts_pending: toCount(alertsRow?.pending),
      alerts_acknowledged: toCount(alertsRow?.acknowledged),
      contradictions_pending: toCount(contradictionsRow?.n)
    },
    feedback: toFeedbackMap(feedbackRows),
    tuning: {
      insufficient: tuning.insufficient,
      suggestion_count: tuning.suggestion_count,
      days_available: tuning.days_available,
      min_days: tuning.min_days
    },
    buckets: buckets
      ? Object.fromEntries(bucketRows.map((row) => [row.decay_status, Number(row.n ?? 0)]))
      : null
  };
}
