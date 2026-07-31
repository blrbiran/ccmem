import { readFileSync } from 'node:fs';
import { isDaemonAlive } from '../../daemon/lock.mjs';
import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { getDbPath, getSchemaVersion } from '../db.mjs';
import { getProvider } from '../embedding/provider.mjs';
import { currentEmbeddingSig } from '../embedding/signature.mjs';
import { decisionDataFile, decisionDataSizeBytes } from '../metrics.mjs';
import { fallbackProjectKey, resolveProjectKey } from '../project-key.mjs';
import { collectInjectionRows, countNeverInjected } from '../recent-injections.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

const SESSION_LIMIT = 10;
const RECENT_INJECTION_LIMIT = 3;
const TUNING_WINDOW_DAYS = 30;

function readConfigKv(db, key) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key)?.value ?? null;
}

function resolveEmbeddingEnabled(cfg, db) {
  const kvEnabled = readConfigKv(db, 'embedding.enabled');
  if (kvEnabled != null) {
    return kvEnabled === 'true';
  }
  return cfg?.embedding?.enabled !== false;
}

function resolveEmbeddingProvider(cfg, db) {
  return readConfigKv(db, 'embedding.active_provider')
    ?? cfg?.embedding?.provider
    ?? 'transformers-local';
}

function getRetrievalCheckAudit(db) {
  const row = db.prepare(
    `SELECT ts, details
     FROM audit_log
     WHERE action = 'retrieval_check_run'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  if (!row) {
    return null;
  }
  const details = parseDetails(row.details);
  return {
    ts: row.ts,
    total: Number(details.total ?? 0),
    recall_at_3: details.recall_at_3 == null ? null : Number(details.recall_at_3),
    run_at: details.run_at == null ? null : Number(details.run_at)
  };
}

function getRetrievalDiagnostics(db, cfg = loadConfig(), { days = 14 } = {}) {
  const metrics = getMetricsDiagnostics(db, { days, cfg });
  const circuitOpenUntil = Number(readConfigKv(db, 'embedding.circuit_open_until') ?? NaN);
  const sig = currentEmbeddingSig(getProvider(cfg), cfg);
  // Must match vec_backfill's candidate population (status/decay_status)
  // verbatim — otherwise this counts rows vec_backfill will never touch, and
  // "will be re-embedded by vec_backfill" (cli.mjs) is false for some of them.
  const staleVectors = Number(db.prepare(
    `SELECT COUNT(*) n FROM memories
     WHERE embedding IS NOT NULL AND (embedding_sig IS NULL OR embedding_sig <> ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get(sig)?.n ?? 0);
  return {
    embedding_enabled: resolveEmbeddingEnabled(cfg, db),
    embedding_provider: resolveEmbeddingProvider(cfg, db),
    circuit: Number.isFinite(circuitOpenUntil) && circuitOpenUntil > Date.now() ? 'OPEN' : 'CLOSED',
    circuit_open_until: Number.isFinite(circuitOpenUntil) ? circuitOpenUntil : null,
    stale_vectors: staleVectors,
    metrics
  };
}

function setCircuitState(db, verb) {
  const now = Date.now();
  if (verb === 'status') {
    const openUntil = Number(readConfigKv(db, 'embedding.circuit_open_until') ?? NaN);
    return {
      status: Number.isFinite(openUntil) && openUntil > now ? 'OPEN' : 'CLOSED',
      open_until: Number.isFinite(openUntil) ? openUntil : null
    };
  }

  if (verb === 'open') {
    const until = now + 300000;
    db.prepare(
      `INSERT INTO config_kv (key, value, set_at)
       VALUES ('embedding.circuit_open_until', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
    ).run(String(until), now);
    return { status: 'OPEN', open_until: until };
  }

  if (verb === 'close') {
    db.prepare(`DELETE FROM config_kv WHERE key IN ('embedding.circuit_open_until', 'embedding.consecutive_failures', 'embedding.last_probe_at')`).run();
    return { status: 'CLOSED', open_until: null };
  }

  throw new Error(`unsupported embedding circuit verb: ${verb}`);
}

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

function getContextHistoryDiagnostics(db, { days = 7, sessionId = null, hash = null } = {}) {
  if (hash) {
    const snapshot = db.prepare(
      `SELECT content_hash, content, first_seen_at, hit_count
       FROM context_snapshots
       WHERE content_hash = ?`
    ).get(String(hash));
    return {
      mode: 'hash',
      hash: String(hash),
      snapshot: snapshot
        ? {
            content_hash: snapshot.content_hash,
            content: snapshot.content,
            first_seen_at: snapshot.first_seen_at,
            hit_count: Number(snapshot.hit_count ?? 0)
          }
        : null
    };
  }

  if (sessionId) {
    const writes = db.prepare(
      `SELECT prompt_idx, content_hash, bytes, written, written_at
       FROM context_write_log
       WHERE session_id = ?
       ORDER BY prompt_idx ASC, id ASC`
    ).all(String(sessionId)).map((row) => ({
      prompt_idx: Number(row.prompt_idx ?? 0),
      content_hash: row.content_hash,
      bytes: Number(row.bytes ?? 0),
      written: Number(row.written ?? 0) === 1,
      written_at: row.written_at
    }));

    return {
      mode: 'session',
      session_id: String(sessionId),
      total: writes.length,
      writes
    };
  }

  const cutoff = windowStartMs(days);
  const totals = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN written = 1 THEN 1 ELSE 0 END) AS actual_writes,
       SUM(CASE WHEN written = 0 THEN 1 ELSE 0 END) AS hash_gate_skips
     FROM context_write_log
     WHERE written_at >= ?`
  ).get(cutoff);
  const topHashes = db.prepare(
    `SELECT content_hash,
            COUNT(*) AS n,
            SUM(CASE WHEN written = 1 THEN 1 ELSE 0 END) AS writes,
            SUM(CASE WHEN written = 0 THEN 1 ELSE 0 END) AS skips,
            MAX(bytes) AS bytes,
            MIN(written_at) AS first_at,
            MAX(written_at) AS last_at
     FROM context_write_log
     WHERE written_at >= ?
       AND content_hash != 'empty'
     GROUP BY content_hash
     ORDER BY n DESC, last_at DESC
     LIMIT 10`
  ).all(cutoff).map((row) => ({
    content_hash: row.content_hash,
    count: Number(row.n ?? 0),
    writes: Number(row.writes ?? 0),
    skips: Number(row.skips ?? 0),
    bytes: Number(row.bytes ?? 0),
    first_at: row.first_at,
    last_at: row.last_at
  }));

  const total = Number(totals?.total ?? 0);
  const actualWrites = Number(totals?.actual_writes ?? 0);
  const hashGateSkips = Number(totals?.hash_gate_skips ?? 0);
  return {
    mode: 'summary',
    days,
    total,
    actual_writes: actualWrites,
    hash_gate_skips: hashGateSkips,
    gate_efficiency: total > 0 ? (hashGateSkips / total) : 0,
    top_hashes: topHashes
  };
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

function loadRestartHistory(db, limit = 10) {
  return db.prepare(
    `SELECT ts, details
     FROM audit_log
     WHERE action = 'daemon_self_restart'
     ORDER BY ts DESC, id DESC
     LIMIT ?`
  ).all(limit).map((row) => {
    const details = parseDetails(row.details);
    return {
      ts: row.ts,
      from_version: Number(details.from_version ?? 0),
      to_version: Number(details.to_version ?? 0),
      daemon_pid: details.daemon_pid ?? null,
      daemon_uptime_sec: details.daemon_uptime_sec ?? null,
      in_flight_task_id: details.in_flight_task_id ?? null,
      in_flight_task_type: details.in_flight_task_type ?? null,
      waited_ms: Number(details.waited_ms ?? 0)
    };
  });
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

function computeEmbeddingWeightSuggestion(db, cfg, startMs) {
  const current = Number(cfg.retrieval?.weights?.semantic ?? 0.4);
  const metricsPath = `${getDbPath().replace(/global\.db$/, 'metrics.jsonl')}`;
  let lines = [];

  try {
    lines = readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    lines = [];
  }

  const relevant = lines.filter((row) => (
    row.hook === 'prompt_submit'
    && typeof row.ts === 'number'
    && row.ts >= startMs
    && typeof row.cosine_contribution === 'number'
  ));

  if (relevant.length < 50) {
    return buildKeepSuggestion(
      'retrieval.weights.semantic',
      current,
      formatKeepRationale('prompt_submit cosine samples', relevant.length, 50)
    );
  }

  const avg = relevant.reduce((sum, row) => sum + row.cosine_contribution, 0) / relevant.length;
  if (avg < 0.15) {
    return buildSuggestion(
      'retrieval.weights.semantic',
      current,
      Math.min(0.7, round(current + 0.1, 1)),
      `cosine avg contribution ${round(avg * 100, 0)}% across ${relevant.length} prompt_submit samples`,
      'increase semantic retrieval influence'
    );
  }

  if (avg > 0.6) {
    return buildSuggestion(
      'retrieval.weights.semantic',
      current,
      Math.max(0.2, round(current - 0.1, 1)),
      `cosine avg contribution ${round(avg * 100, 0)}% across ${relevant.length} prompt_submit samples`,
      'reduce semantic dominance in fused retrieval scoring'
    );
  }

  return buildKeepSuggestion(
    'retrieval.weights.semantic',
    current,
    `cosine avg contribution ${round(avg * 100, 0)}% stayed balanced`
  );
}

function computeL1PositiveThresholdSuggestion(db, cfg, startMs) {
  const current = Number(cfg.feedback?.l1_positive?.cosine_threshold ?? 0.65);
  const rows = db.prepare(
    `SELECT json_extract(details, '$.user_action') AS user_action
     FROM audit_log
     WHERE action = 'revalidation_resurrect' AND ts >= ?`
  ).all(startMs);
  const keep = rows.filter((row) => row.user_action === 'keep').length;
  const forget = rows.filter((row) => row.user_action === 'forget' || row.user_action === 'quarantine').length;
  const total = keep + forget;

  if (total < 5) {
    return buildKeepSuggestion(
      'feedback.l1_positive.cosine_threshold',
      current,
      formatKeepRationale('l1_positive revalidation decisions', total, 5)
    );
  }

  const ratio = forget / total;
  if (ratio > 0.6) {
    return buildSuggestion(
      'feedback.l1_positive.cosine_threshold',
      current,
      Math.min(0.9, round(current + 0.05, 2)),
      `${forget}/${total} recent resurrect decisions ended in forget/quarantine`,
      'make positive implicit boosts stricter'
    );
  }

  if (ratio < 0.2) {
    return buildSuggestion(
      'feedback.l1_positive.cosine_threshold',
      current,
      Math.max(0.5, round(current - 0.05, 2)),
      `${forget}/${total} recent resurrect decisions ended in forget/quarantine`,
      'allow more positive implicit boosts'
    );
  }

  return buildKeepSuggestion(
    'feedback.l1_positive.cosine_threshold',
    current,
    `forget/quarantine ratio ${round(ratio, 2)} stayed balanced`
  );
}

export function computeTuningSuggestions(db, cfg = loadConfig()) {
  const startMs = windowStartMs(TUNING_WINDOW_DAYS);

  return [
    computePoolBSuggestion(db, cfg, startMs),
    computeDedupSuggestion(db, cfg, startMs),
    computeSunsetSuggestion(db, cfg, startMs),
    computeTier15ClusterSuggestion(db, cfg, startMs),
    computeRevalidationThresholdSuggestion(db, cfg, startMs),
    computeEmbeddingWeightSuggestion(db, cfg, startMs),
    computeL1PositiveThresholdSuggestion(db, cfg, startMs)
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

export function getSynthesisDiagnostics(db, { days = 30 } = {}) {
  const clampedDays = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
  const since = Date.now() - (clampedDays * 86400000);
  const cleanStats = db.prepare(
    `SELECT COUNT(*) AS runs,
            COALESCE(AVG(CAST(json_extract(details, '$.stripped_pct') AS REAL)), 0) AS avg_pct
     FROM audit_log
     WHERE action = 'transcript_cleaned' AND ts > ?`
  ).get(since);
  const gateStats = db.prepare(
    `SELECT json_extract(details, '$.reason') AS reason, COUNT(*) AS n
     FROM audit_log
     WHERE action = 'quality_gate_reject' AND ts > ?
     GROUP BY reason`
  ).all(since);
  const weeklyRuns = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_run' AND ts > ?`
  ).get(since)?.n ?? 0);
  const synthAgg = db.prepare(
    `SELECT
       COALESCE(SUM(CAST(json_extract(details, '$.synth_proposed') AS INTEGER)), 0) AS proposed,
       COALESCE(SUM(CAST(json_extract(details, '$.synth_accepted') AS INTEGER)), 0) AS accepted,
       COALESCE(SUM(CAST(json_extract(details, '$.synth_rejected') AS INTEGER)), 0) AS rejected,
       COALESCE(AVG(CAST(json_extract(details, '$.llm_calls') AS INTEGER)), 0) AS avg_llm
     FROM audit_log
     WHERE action = 'weekly_synthesis_run' AND ts > ?`
  ).get(since);
  const consolidated = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE type = 'consolidated' AND status = 'active'`
  ).get()?.n ?? 0);
  const superseded = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE type = 'consolidated' AND status = 'superseded'`
  ).get()?.n ?? 0);
  return {
    days: clampedDays,
    cleaner_runs: Number(cleanStats?.runs ?? 0),
    avg_stripped_pct: Number(cleanStats?.avg_pct ?? 0),
    gate_total: gateStats.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
    gate_reasons: gateStats.map((row) => ({ reason: row.reason ?? 'unknown', count: Number(row.n ?? 0) })),
    weekly_runs: weeklyRuns,
    proposed: Number(synthAgg?.proposed ?? 0),
    accepted: Number(synthAgg?.accepted ?? 0),
    rejected: Number(synthAgg?.rejected ?? 0),
    avg_llm_calls: Number(synthAgg?.avg_llm ?? 0),
    consolidated_active: consolidated,
    consolidated_superseded: superseded
  };
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
      embedding: null,
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
  const totalEmbedded = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
  const totalPendingEmbeddings = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
  const avgEmbeddingRate = averageField(currentRows, 'vec_backfill_embedded');

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
      cross_scope_alerts_acknowledged: alertsAcknowledged,
      contradictions_detected: currentRows.reduce((sum, row) => sum + Number(row.contra_detected ?? 0), 0)
    },
    embedding: {
      embedded: totalEmbedded,
      pending: totalPendingEmbeddings,
      avg_rate_per_day: Number.isFinite(avgEmbeddingRate) ? round(avgEmbeddingRate, 1) : 0
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

export function readMetricsLines(days) {
  const cutoff = windowStartMs(days);
  const base = `${getDbPath().replace(/global\.db$/, 'metrics.jsonl')}`;
  const out = [];

  // Oldest generation first so chronological order is preserved.
  for (const file of [`${base}.1`, base]) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;   // missing generation is normal
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.ts === 'number' && parsed.ts >= cutoff) out.push(parsed);
      } catch { /* skip malformed line */ }
    }
  }
  return out;
}

function aggregateRetrievalTiming(days) {
  const rows = readMetricsLines(days).filter((row) => row.hook === 'prompt_submit');

  if (!rows.length) {
    return null;
  }

  const embed = rows.map((row) => Number(row.retrieval_embed_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const dbRead = rows.map((row) => Number(row.retrieval_db_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const cosine = rows.map((row) => Number(row.retrieval_cosine_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const pools = rows.map((row) => Number(row.retrieval_pool)).filter(Number.isFinite);

  if (!embed.length && !dbRead.length && !cosine.length) {
    return null;
  }

  return {
    embed: {
      p50: round(percentile(embed, 0.5) ?? 0, 1),
      p95: round(percentile(embed, 0.95) ?? 0, 1)
    },
    db: {
      p50: round(percentile(dbRead, 0.5) ?? 0, 1),
      p95: round(percentile(dbRead, 0.95) ?? 0, 1)
    },
    cosine: {
      p50: round(percentile(cosine, 0.5) ?? 0, 1),
      p95: round(percentile(cosine, 0.95) ?? 0, 1)
    },
    avgPool: round(average(pools) ?? 0, 1)
  };
}

function getInjectionDiagnostics(db, { days = 14, cfg = loadConfig() } = {}) {
  const rows = collectInjectionRows(db, days);
  const promptMetrics = readMetricsLines(days).filter((row) => row.hook === 'prompt_submit');
  const total = rows.length;
  const empty = rows.filter((row) => row.mem_ids.length === 0).length;
  const activeCount = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);

  const distinctMems = new Set(rows.flatMap((row) => row.mem_ids.map((id) => Number(id)).filter(Number.isFinite)));
  const fusedValues = rows.flatMap((row) => row.scores.map((score) => Number(score?.f)).filter(Number.isFinite));
  const aggregate = new Map();

  for (const row of rows) {
    for (const score of row.scores) {
      const id = Number(score?.id);
      if (!Number.isFinite(id)) {
        continue;
      }
      const current = aggregate.get(id) ?? { id, count: 0, fusedSum: 0 };
      current.count += 1;
      current.fusedSum += Number(score?.f ?? 0);
      aggregate.set(id, current);
    }
  }

  const memIds = [...aggregate.keys()];
  const memMeta = new Map(
    memIds.length
      ? db.prepare(
          `SELECT id, type, scope, content
           FROM memories
           WHERE id IN (${memIds.map(() => '?').join(',')})`
        ).all(...memIds).map((row) => [Number(row.id), row])
      : []
  );

  const decorated = [...aggregate.values()].map((item) => ({
    ...item,
    avgFused: item.count > 0 ? item.fusedSum / item.count : 0,
    ...(memMeta.get(item.id) ?? { type: 'unknown', scope: 'unknown', content: '' })
  }));
  decorated.sort((a, b) => b.count - a.count || b.avgFused - a.avgFused || a.id - b.id);

  const lowThreshold = Number(cfg.injection_observability?.low_quality_threshold ?? 0.30);
  const perf = aggregateRetrievalTiming(days);
  const emptyAcCount = promptMetrics.filter((row) => row.additional_context_empty === true).length;
  const fileWrites = promptMetrics.filter((row) => row.context_file_written === true).length;
  const totalBytes = promptMetrics.reduce((sum, row) => sum + Number(row.context_file_bytes ?? 0), 0);

  return {
    days,
    total,
    empty,
    active_count: activeCount,
    distinct_mems: distinctMems.size,
    fused_p50: round(percentile([...fusedValues].sort((a, b) => a - b), 0.5) ?? 0, 2),
    fused_p95: round(percentile([...fusedValues].sort((a, b) => a - b), 0.95) ?? 0, 2),
    top10: decorated.slice(0, 10),
    low_threshold: lowThreshold,
    low_quality: decorated.filter((item) => item.avgFused < lowThreshold).slice(0, 10),
    never_count: countNeverInjected(db, 30),
    perf,
    cache: {
      total_prompts: promptMetrics.length,
      empty_additional_context: emptyAcCount,
      context_file_writes: fileWrites,
      total_file_bytes: totalBytes,
      additional_context_all_empty: promptMetrics.length === 0 || emptyAcCount === promptMetrics.length
    }
  };
}

export async function cmdAdminDiagnose(
  db,
  {
    cwd = process.cwd(),
    migrations = false,
    key = false,
    sessions = false,
    security = false,
    tuning = false,
    metrics = false,
    retrieval = false,
    embeddingCircuit = false,
    embeddingCircuitVerb = 'status',
    synthesis = false,
    restartHistory = false,
    injections = false,
    contextHistory = false,
    sessionId = null,
    contentHash = null,
    days = 14
  } = {}
) {
  if (tuning || metrics || retrieval || synthesis || injections || contextHistory) {
    try {
      maybeRunTier15(db);
    } catch {}
  }

  const quickCheck = db.prepare('PRAGMA quick_check').get();
  const lock = db.prepare(
    `SELECT holder_pid, hostname, acquired_at, heartbeat_at
     FROM daemon_lock
     WHERE id = 1`
  ).get();
  const startupSchemaRow = db.prepare(
    `SELECT value
     FROM config_kv
     WHERE key = 'daemon_startup_schema_version'`
  ).get();
  const startupSchemaVersion = startupSchemaRow?.value == null ? null : Number(startupSchemaRow.value);
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
  const retrievalDiagnostics = retrieval ? getRetrievalDiagnostics(db, cfg, { days }) : null;
  const embeddingCircuitStatus = embeddingCircuit ? setCircuitState(db, embeddingCircuitVerb) : null;
  const retrievalCheckAudit = retrieval ? getRetrievalCheckAudit(db) : null;
  const synthesisDiagnostics = synthesis ? getSynthesisDiagnostics(db, { days: 30 }) : null;
  const injectionDiagnostics = injections ? getInjectionDiagnostics(db, { days, cfg }) : null;
  const contextHistoryDiagnostics = contextHistory
    ? getContextHistoryDiagnostics(db, { days, sessionId, hash: contentHash })
    : null;

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
      heartbeat_age_ms: lock ? Math.max(0, Date.now() - lock.heartbeat_at) : null,
      startup_schema_version: Number.isFinite(startupSchemaVersion) ? startupSchemaVersion : null,
      uptime_sec: lock?.acquired_at ? Math.max(0, Math.floor((Date.now() - lock.acquired_at) / 1000)) : null
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
    retrieval: retrievalDiagnostics == null ? null : {
      ...retrievalDiagnostics,
      benchmark: retrievalCheckAudit
    },
    embedding_circuit: embeddingCircuitStatus,
    synthesis: synthesisDiagnostics,
    injections: injectionDiagnostics,
    context_history: contextHistoryDiagnostics,
    restart_history: restartHistory ? loadRestartHistory(db) : null,
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

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.floor(p * (sorted.length - 1))];
}

function readDecisionProbeRows(decisionCfg) {
  let raw;
  try {
    raw = readFileSync(decisionDataFile(decisionCfg), 'utf8');
  } catch {
    return []; // file not created yet is normal (no probes recorded)
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.l25_probe === true) out.push(parsed);
    } catch { /* skip malformed line */ }
  }
  return out;
}

function formatFeedbackCohort(label, rows) {
  if (!rows.length) {
    return [`    ${label} (n=0)`];
  }

  const lines = [`    ${label} (n=${rows.length})`];
  for (const field of ['l25_cov', 'l25_lcp']) {
    const vals = rows.map((r) => Number(r[field]) || 0).sort((a, b) => a - b);
    lines.push(
      `      ${field}: p50=${quantile(vals, 0.5).toFixed(3)} p75=${quantile(vals, 0.75).toFixed(3)} ` +
      `p90=${quantile(vals, 0.90).toFixed(3)} p95=${quantile(vals, 0.95).toFixed(3)} ` +
      `max=${quantile(vals, 1).toFixed(3)}`
    );
  }

  const legacy = rows.filter((r) => r.l25_legacy_hit === true).length;
  const idLit = rows.filter((r) => r.l25_id_literal === true).length;
  lines.push(`      legacy hits: ${legacy}/${rows.length}`);
  lines.push(`      id literal: ${idLit}/${rows.length}`);

  if (legacy === 0) {
    lines.push('      WARNING: no legacy hits recorded in this cohort — either the v0.12');
    lines.push('               matcher genuinely never fired here, or the probe is dropping');
    lines.push('               signal turns. Seed a memory that appears verbatim in a reply');
    lines.push('               before trusting this distribution.');
  }

  return lines;
}

/**
 * v0.13 A1 read side: report the L2.5 probe's observed distributions.
 * OBSERVE-ONLY — computes and prints nothing that feeds trust, scoring, or
 * decay. v0.14 decides a threshold from this data; this command must not
 * pre-judge one.
 *
 * Where the rows live (ccmem v0.13 task-4 ruling): probe rows go to the
 * durable decision stream at <dataRoot>/l25-probe.jsonl whenever
 * metrics.decision_data.enabled is not explicitly false (the default). That
 * file has no day-based rotation (retention_days: 0 means never
 * auto-delete), so it is read in full rather than windowed by `days`. Only
 * when decision_data is explicitly disabled does this fall back to
 * readMetricsLines(days), because that is where recordDecisionMetric's own
 * fallback writes rows in that case — and the `days` window applies there.
 *
 * Segmentation (never filtering): turn_aligned=false rows are a negative
 * control — a memory injected for an earlier turn, scored against this
 * turn's unrelated reply — and are printed as their own section rather than
 * mixed into or dropped from the main distribution. has_cjk further splits
 * BOTH the turn-aligned rows and the negative-control rows, because CJK
 * text does not word-segment: it saturates l25_lcp and skews l25_cov toward
 * binary for Chinese memories, which means the CJK noise floor is
 * structurally different (higher) from the non-CJK noise floor. Blending
 * them into one negative-control number would let non-CJK volume drag the
 * floor down and make the CJK main distribution look like it clears a noise
 * floor it was never compared against — achievability is decided per
 * cohort, so the floor has to be reported per cohort too.
 *
 * This command is read-only: it deliberately does NOT call
 * maybeRunTier15(db) the way its sibling diagnose subcommands do, so that
 * "v0.13 writes no decay/trust state" holds without a carve-out for this
 * report. `db` is accepted (and unused) only to keep the call signature
 * uniform with those siblings for CLI routing.
 */
export function cmdDiagnoseFeedback(db, { days = 7 } = {}) {
  const cfg = loadConfig();
  const decisionCfg = cfg.metrics?.decision_data;
  const decisionEnabled = decisionCfg?.enabled !== false;
  const sizeBytes = decisionDataSizeBytes(decisionCfg);

  const rows = decisionEnabled
    ? readDecisionProbeRows(decisionCfg)
    : readMetricsLines(days).filter((r) => r.l25_probe === true);

  if (!rows.length) {
    process.stdout.write(
      decisionEnabled
        ? `no L2.5 probe samples in the decision stream (l25-probe.jsonl, ${sizeBytes} bytes)\n`
        : `no L2.5 probe samples in the last ${days} days (metrics.jsonl fallback — decision_data disabled)\n`
    );
    return;
  }

  const aligned = rows.filter((r) => r.turn_aligned === true);
  const negControl = rows.filter((r) => r.turn_aligned === false);

  const lines = [];
  lines.push(
    decisionEnabled
      ? `L2.5 probe — decision stream l25-probe.jsonl (${sizeBytes} bytes on disk, unbounded — all recorded samples, no day window)`
      : `L2.5 probe — metrics.jsonl fallback, last ${days} days (decision_data.enabled=false; decision file on disk: ${sizeBytes} bytes, not used for this report)`
  );
  lines.push(`  samples: ${rows.length} total (${aligned.length} turn-aligned, ${negControl.length} negative-control)`);
  lines.push('');
  lines.push('  Turn-aligned (main distribution — memory was injected for this turn)');
  lines.push(...formatFeedbackCohort('non-CJK', aligned.filter((r) => r.has_cjk !== true)));
  lines.push(...formatFeedbackCohort('CJK', aligned.filter((r) => r.has_cjk === true)));
  lines.push('');
  lines.push('  Negative control (turn_aligned=false — earlier-turn memory scored against an unrelated reply; noise floor)');
  lines.push(...formatFeedbackCohort('non-CJK', negControl.filter((r) => r.has_cjk !== true)));
  lines.push(...formatFeedbackCohort('CJK', negControl.filter((r) => r.has_cjk === true)));

  process.stdout.write(`${lines.join('\n')}\n`);
}
