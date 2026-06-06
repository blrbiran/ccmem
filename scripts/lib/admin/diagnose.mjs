import { isDaemonAlive } from '../../daemon/lock.mjs';
import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { getDbPath, getSchemaVersion } from '../db.mjs';
import { fallbackProjectKey, resolveProjectKey } from '../project-key.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

const SESSION_LIMIT = 10;
const RECENT_INJECTION_LIMIT = 3;
const TUNING_WINDOW_DAYS = 30;

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

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }

  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function average(values) {
  const filtered = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!filtered.length) {
    return null;
  }

  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function percentile(values, ratio) {
  const filtered = values.map((value) => Number(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!filtered.length) {
    return null;
  }

  const index = Math.min(filtered.length - 1, Math.max(0, Math.floor(filtered.length * ratio)));
  return filtered[index];
}

function sumJsonField(rows, key) {
  return rows.reduce((sum, row) => sum + Number(parseDetails(row.details)?.[key] ?? 0), 0);
}

function clampMetricsDays(days) {
  const n = Number(days ?? 14);
  if (!Number.isFinite(n)) {
    return 14;
  }

  return Math.max(1, Math.min(90, Math.trunc(n)));
}

function windowStartMs(days) {
  return Date.now() - (days * 86400000);
}

function countRollupDays(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM metrics_daily_rollup`).get()?.n ?? 0);
}

function formatKeepRationale(label, have, need) {
  return `insufficient ${label} (have ${have}, need >=${need})`;
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

function buildKeepSuggestion(key, current, rationale, impact = 'healthy default') {
  return {
    key,
    current,
    suggest: current,
    action: 'keep',
    rationale,
    impact
  };
}

function buildSuggestion(key, current, suggest, rationale, impact) {
  return {
    key,
    current,
    suggest,
    action: suggest > current ? 'increase' : suggest < current ? 'decrease' : 'keep',
    rationale,
    impact
  };
}

function computePoolBSuggestion(db, cfg, startMs) {
  const current = Number(cfg.security.audit.pool_b.clusterMinSize ?? 3);
  const auditRuns = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'security_audit_run' AND ts >= ?`
  ).all(startMs);
  const poolBCandidates = sumJsonField(auditRuns, 'pool_b');
  const quarantined = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'security_quarantine_in'
       AND ts >= ?
       AND json_extract(details, '$.reason') = 'security_audit_llm'
       AND json_extract(details, '$.pool') = 'B'`
  ).get(startMs)?.n ?? 0);

  if (poolBCandidates < 10) {
    return buildKeepSuggestion(
      'security.audit.pool_b.clusterMinSize',
      current,
      formatKeepRationale('pool_b candidates', poolBCandidates, 10)
    );
  }

  const ratio = quarantined / poolBCandidates;
  const lowThreshold = 1 - Number(cfg.tuning_suggest.pool_b_zero_quarantine_ratio ?? 0.7);
  const highThreshold = Number(cfg.tuning_suggest.pool_b_zero_quarantine_ratio ?? 0.7);

  if (ratio < lowThreshold) {
    return buildSuggestion(
      'security.audit.pool_b.clusterMinSize',
      current,
      current + 2,
      `pool_b quarantine ratio ${round(ratio, 2)} from ${quarantined}/${poolBCandidates} candidates`,
      'expect fewer low-yield security audit reviews'
    );
  }

  if (ratio > highThreshold) {
    return buildSuggestion(
      'security.audit.pool_b.clusterMinSize',
      current,
      Math.max(1, current - 1),
      `pool_b quarantine ratio ${round(ratio, 2)} from ${quarantined}/${poolBCandidates} candidates`,
      'expect more aggressive clustering of suspicious auto memories'
    );
  }

  return buildKeepSuggestion(
    'security.audit.pool_b.clusterMinSize',
    current,
    `pool_b quarantine ratio ${round(ratio, 2)} stayed in the healthy middle band`
  );
}

function computeDedupSuggestion(db, cfg, startMs) {
  const current = Number(cfg.security.cross_scope.dedup_window_days ?? 30);
  const rows = db.prepare(
    `SELECT detected_at, acknowledged_at
     FROM cross_scope_alerts
     WHERE acknowledged_at IS NOT NULL
       AND acknowledged_at >= ?`
  ).all(startMs);

  if (rows.length < 5) {
    return buildKeepSuggestion(
      'security.cross_scope.dedup_window_days',
      current,
      formatKeepRationale('acknowledged alerts', rows.length, 5)
    );
  }

  const p90Days = percentile(rows.map((row) => (row.acknowledged_at - row.detected_at) / 86400000), 0.9);
  const threshold = current * Number(cfg.tuning_suggest.dedup_window_p90_ratio ?? 0.5);

  if (Number(p90Days ?? current) < threshold) {
    return buildSuggestion(
      'security.cross_scope.dedup_window_days',
      current,
      Math.max(1, Math.round(current / 2)),
      `acknowledged-alert p90 is ${round(p90Days, 1)}d vs current ${current}d window`,
      'same alerts surface faster after similar drift'
    );
  }

  return buildKeepSuggestion(
    'security.cross_scope.dedup_window_days',
    current,
    `acknowledged-alert p90 is ${round(p90Days, 1)}d within the current ${current}d window`
  );
}

function computeSunsetSuggestion(db, cfg, startMs) {
  const current = Number(cfg.security.quarantine.sunset_days ?? 30);
  const resurrectKeeps = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'security_quarantine_resurrect'
       AND ts >= ?
       AND json_extract(details, '$.user_action') = 'keep'`
  ).get(startMs)?.n ?? 0);
  const sunsetRows = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'security_quarantine_sunset' AND ts >= ?`
  ).all(startMs);
  const sunsetDurations = sunsetRows
    .map((row) => Number(parseDetails(row.details).duration_days))
    .filter(Number.isFinite);
  const sample = resurrectKeeps + sunsetDurations.length;

  if (sample < 5) {
    return buildKeepSuggestion(
      'security.quarantine.sunset_days',
      current,
      formatKeepRationale('resolved quarantines', sample, 5)
    );
  }

  const resurrectRate = resurrectKeeps / sample;
  const avgSunset = average(sunsetDurations) ?? current;

  if (resurrectRate > Number(cfg.tuning_suggest.sunset_resurrect_high_rate ?? 0.5)) {
    return buildSuggestion(
      'security.quarantine.sunset_days',
      current,
      current + 5,
      `quarantine resurrect rate ${round(resurrectRate, 2)} from ${resurrectKeeps}/${sample} resolved items`,
      'keep quarantined memories available for review longer'
    );
  }

  if (avgSunset < current / 2) {
    return buildSuggestion(
      'security.quarantine.sunset_days',
      current,
      Math.max(1, current - 5),
      `average quarantine lifetime ${round(avgSunset, 1)}d is well below current ${current}d`,
      'archive stale quarantines sooner'
    );
  }

  return buildKeepSuggestion(
    'security.quarantine.sunset_days',
    current,
    `quarantine lifetime ${round(avgSunset, 1)}d and resurrect rate ${round(resurrectRate, 2)} look balanced`
  );
}

function computeTier15ClusterSuggestion(db, cfg, startMs) {
  const current = Number(cfg.security.tier1_5_security.cluster_min_size ?? 5);
  const clusterSizes = db.prepare(
    `SELECT CAST(json_extract(details, '$.cluster_size') AS INTEGER) AS cluster_size
     FROM audit_log
     WHERE action = 'security_quarantine_in'
       AND ts >= ?
       AND json_extract(details, '$.reason') = 'tier1_5_heuristic_cluster'`
  ).all(startMs)
    .map((row) => Number(row.cluster_size))
    .filter(Number.isFinite);

  if (clusterSizes.length < 5) {
    return buildKeepSuggestion(
      'security.tier1_5_security.cluster_min_size',
      current,
      formatKeepRationale('tier1_5 clusters', clusterSizes.length, 5)
    );
  }

  const p50 = percentile(clusterSizes, 0.5);

  if (Number(p50 ?? current) >= current * 1.5) {
    return buildSuggestion(
      'security.tier1_5_security.cluster_min_size',
      current,
      current + 2,
      `tier1.5 cluster-size p50 is ${round(p50, 1)} with current threshold ${current}`,
      'reduce noisy opportunistic quarantine clusters'
    );
  }

  if (Number(p50 ?? current) < current) {
    return buildSuggestion(
      'security.tier1_5_security.cluster_min_size',
      current,
      Math.max(1, current - 1),
      `tier1.5 cluster-size p50 is ${round(p50, 1)} below current threshold ${current}`,
      'catch smaller suspicious bursts earlier'
    );
  }

  return buildKeepSuggestion(
    'security.tier1_5_security.cluster_min_size',
    current,
    `tier1.5 cluster-size p50 ${round(p50, 1)} is aligned with threshold ${current}`
  );
}

function computeRevalidationThresholdSuggestion(db, cfg, startMs) {
  const current = Number(cfg.security.revalidation.flag_trust_threshold ?? 0.6);
  const rows = db.prepare(
    `SELECT json_extract(details, '$.user_action') AS user_action
     FROM audit_log
     WHERE action = 'revalidation_resurrect' AND ts >= ?`
  ).all(startMs);
  const keep = rows.filter((row) => row.user_action === 'keep').length;
  const disagree = rows.filter((row) => row.user_action === 'forget' || row.user_action === 'quarantine').length;
  const sample = keep + disagree;

  if (sample < 5) {
    return buildKeepSuggestion(
      'security.revalidation.flag_trust_threshold',
      current,
      formatKeepRationale('revalidation decisions', sample, 5)
    );
  }

  if (keep >= 1) {
    const ratio = disagree / keep;
    if (ratio > 2) {
      return buildSuggestion(
        'security.revalidation.flag_trust_threshold',
        current,
        Math.max(0.1, round(current - 0.1, 1)),
        `${disagree} flag→forget/quarantine vs ${keep} flag→keep (ratio ${round(ratio, 1)})`,
        'more high-trust hits auto-quarantine; fewer manual reviews'
      );
    }

    if (ratio < 0.5) {
      return buildSuggestion(
        'security.revalidation.flag_trust_threshold',
        current,
        Math.min(0.9, round(current + 0.1, 1)),
        `${disagree} flag→forget/quarantine vs ${keep} flag→keep (ratio ${round(ratio, 1)})`,
        'keep more high-trust hits in the manual-review bucket'
      );
    }

    return buildKeepSuggestion(
      'security.revalidation.flag_trust_threshold',
      current,
      `${disagree} flag→forget/quarantine vs ${keep} flag→keep stayed balanced`
    );
  }

  const smoothed = (disagree - keep) / (disagree + keep + 1);
  if (smoothed > 0.6) {
    return buildSuggestion(
      'security.revalidation.flag_trust_threshold',
      current,
      Math.max(0.1, round(current - 0.1, 1)),
      `all ${disagree} recent revalidation decisions disagreed with keep (smoothed ${round(smoothed, 2)})`,
      'move more flagged memories straight into quarantine'
    );
  }

  return buildKeepSuggestion(
    'security.revalidation.flag_trust_threshold',
    current,
    `smoothed disagreement ${round(smoothed, 2)} is not strong enough to move the threshold`
  );
}

export function computeTuningSuggestions(db, cfg = loadConfig()) {
  const startMs = windowStartMs(TUNING_WINDOW_DAYS);

  return [
    computePoolBSuggestion(db, cfg, startMs),
    computeDedupSuggestion(db, cfg, startMs),
    computeSunsetSuggestion(db, cfg, startMs),
    computeTier15ClusterSuggestion(db, cfg, startMs),
    computeRevalidationThresholdSuggestion(db, cfg, startMs)
  ];
}

export function getTuningDiagnostics(db, cfg = loadConfig()) {
  const minDays = Number(cfg.metrics_rollup?.min_days_for_tuning ?? 7);
  const daysAvailable = countRollupDays(db);

  if (daysAvailable < minDays) {
    return {
      insufficient: true,
      days_available: daysAvailable,
      min_days: minDays,
      suggestions: [],
      suggestion_count: 0,
      audit_id: null
    };
  }

  const suggestions = computeTuningSuggestions(db, cfg);
  return {
    insufficient: false,
    days_available: daysAvailable,
    min_days: minDays,
    suggestions,
    suggestion_count: suggestions.filter((item) => item.action !== 'keep').length,
    audit_id: null
  };
}

function dayKeyToStartMs(dayKey) {
  return Date.parse(`${dayKey}T00:00:00Z`);
}

function averageField(rows, key) {
  return average(rows.map((row) => row[key]));
}

function buildHookMetric(currentRows, priorRows, keyPrefix, budget) {
  const p50 = averageField(currentRows, `${keyPrefix}_p50`);
  const p95 = averageField(currentRows, `${keyPrefix}_p95`);
  const priorP50 = averageField(priorRows, `${keyPrefix}_p50`);
  const priorP95 = averageField(priorRows, `${keyPrefix}_p95`);

  let status = 'OK';
  if (Number.isFinite(p50) && p50 > Number(budget?.p50 ?? Infinity)) {
    status = 'WARN p50';
  } else if (Number.isFinite(p95) && p95 > Number(budget?.p95 ?? Infinity)) {
    status = 'WARN p95';
  }

  let trend = null;
  if (Number.isFinite(p50) && Number.isFinite(priorP50) && priorP50 > 0) {
    const delta = p50 - priorP50;
    const ratio = delta / priorP50;
    if (Math.abs(ratio) >= 0.15) {
      trend = {
        metric: 'p50',
        arrow: delta >= 0 ? '↑' : '↓',
        delta_ms: Math.round(delta),
        compare_days: priorRows.length
      };
    }
  }

  if (!trend && Number.isFinite(p95) && Number.isFinite(priorP95) && priorP95 > 0) {
    const delta = p95 - priorP95;
    const ratio = delta / priorP95;
    if (Math.abs(ratio) >= 0.2) {
      trend = {
        metric: 'p95',
        arrow: delta >= 0 ? '↑' : '↓',
        delta_ms: Math.round(delta),
        compare_days: priorRows.length
      };
    }
  }

  return {
    p50: Number.isFinite(p50) ? Math.round(p50) : null,
    p95: Number.isFinite(p95) ? Math.round(p95) : null,
    budget,
    status,
    trend
  };
}

export function getMetricsDiagnostics(db, { days = 14, cfg = loadConfig() } = {}) {
  const clampedDays = clampMetricsDays(days);
  const rows = db.prepare(
    `SELECT *
     FROM metrics_daily_rollup
     ORDER BY day_key DESC
     LIMIT ?`
  ).all(clampedDays * 2);
  const currentRows = rows.slice(0, clampedDays);
  const priorRows = rows.slice(clampedDays, clampedDays * 2);

  if (!currentRows.length) {
    return {
      no_data: true,
      days: clampedDays,
      rows: [],
      hooks: null,
      llm: null,
      flow: null,
      memory_pool: null
    };
  }

  const latestRow = currentRows[0];
  const earliestCurrent = currentRows.reduce((min, row) => (row.day_key < min ? row.day_key : min), currentRows[0].day_key);
  const latestCurrent = currentRows.reduce((max, row) => (row.day_key > max ? row.day_key : max), currentRows[0].day_key);
  const startMs = dayKeyToStartMs(earliestCurrent);
  const endMs = dayKeyToStartMs(latestCurrent) + 86400000;
  const alertsAcknowledged = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'security_alert_acknowledged'
       AND ts >= ?
       AND ts < ?`
  ).get(startMs, endMs)?.n ?? 0);

  return {
    no_data: false,
    days: clampedDays,
    rows: currentRows,
    hooks: {
      session_start: buildHookMetric(currentRows, priorRows, 'hook_session_start', cfg.hook_budget_ms?.session_start),
      prompt_submit: buildHookMetric(currentRows, priorRows, 'hook_prompt_submit', cfg.hook_budget_ms?.prompt_submit),
      stop: buildHookMetric(currentRows, priorRows, 'hook_stop', cfg.hook_budget_ms?.stop)
    },
    llm: {
      total: currentRows.reduce((sum, row) => sum + Number(row.llm_calls ?? 0), 0),
      duration_ms: currentRows.reduce((sum, row) => sum + Number(row.llm_total_duration_ms ?? 0), 0),
      failures: currentRows.reduce((sum, row) => sum + Number(row.llm_failures ?? 0), 0),
      dead_letters: currentRows.reduce((sum, row) => sum + Number(row.llm_dead_letters ?? 0), 0),
      avg_per_day: round(currentRows.reduce((sum, row) => sum + Number(row.llm_calls ?? 0), 0) / currentRows.length, 1),
      avg_duration_s: round((currentRows.reduce((sum, row) => sum + Number(row.llm_total_duration_ms ?? 0), 0) /
        Math.max(1, currentRows.reduce((sum, row) => sum + Number(row.llm_calls ?? 0), 0))) / 1000, 1)
    },
    flow: {
      tier15_clusters: currentRows.reduce((sum, row) => sum + Number(row.tier15_clusters ?? 0), 0),
      security_quarantined: currentRows.reduce((sum, row) => sum + Number(row.sec_quarantined ?? 0), 0),
      revalidation_quarantined: currentRows.reduce((sum, row) => sum + Number(row.reval_quarantined ?? 0), 0),
      revalidation_flagged: currentRows.reduce((sum, row) => sum + Number(row.reval_flagged ?? 0), 0),
      cross_scope_alerts_emitted: currentRows.reduce((sum, row) => sum + Number(row.sec_alerts_emitted ?? 0), 0),
      cross_scope_alerts_acknowledged: alertsAcknowledged
    },
    memory_pool: {
      day_key: latestRow.day_key,
      active: Number(latestRow.mems_active ?? 0),
      probation: Number(latestRow.mems_probation ?? 0),
      quarantine: Number(latestRow.mems_quarantine ?? 0),
      archived: Number(latestRow.mems_archived ?? 0)
    }
  };
}

export async function cmdAdminDiagnose(
  db,
  { cwd = process.cwd(), migrations = false, key = false, sessions = false, security = false, tuning = false, metrics = false, days = 14 } = {}
) {
  if (tuning || metrics) {
    try {
      maybeRunTier15(db);
    } catch {}
  }

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
  const cfg = loadConfig();
  const tuningDiagnostics = tuning ? getTuningDiagnostics(db, cfg) : null;
  const metricsDiagnostics = metrics ? getMetricsDiagnostics(db, { days, cfg }) : null;

  if (tuningDiagnostics && !tuningDiagnostics.insufficient) {
    tuningDiagnostics.audit_id = writeAudit(db, 'tuning_suggestion_emitted', null, {
      suggestion_count: tuningDiagnostics.suggestion_count,
      signals_window_days: TUNING_WINDOW_DAYS
    });
  }

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
    tuning: tuningDiagnostics,
    metrics: metricsDiagnostics,
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
