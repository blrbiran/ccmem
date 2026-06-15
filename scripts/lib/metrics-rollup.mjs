import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from './db.mjs';
import { loadConfig } from './config.mjs';
import { countNeverInjected, parseInjectionScores } from './recent-injections.mjs';
import { writeAudit } from './audit.mjs';

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) {
    return null;
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * ratio)));
  return sortedValues[index];
}

export function aggregateHookLatencies(startMs, endMs) {
  const metricsPath = path.join(getDataRoot(), 'metrics.jsonl');
  if (!fs.existsSync(metricsPath)) {
    return {};
  }

  const buckets = {
    session_start: [],
    prompt_submit: [],
    prompt_submit_cosine: [],
    stop: []
  };

  try {
    const lines = fs.readFileSync(metricsPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof row.ts !== 'number' || row.ts < startMs || row.ts >= endMs) {
        continue;
      }

      if (!(row.hook in buckets) || typeof row.ms_total !== 'number') {
        continue;
      }

      buckets[row.hook].push(row.ms_total);
      if (row.hook === 'prompt_submit' && typeof row.cosine_contribution === 'number') {
        buckets.prompt_submit_cosine.push(row.cosine_contribution);
      }
    }
  } catch {
    return {};
  }

  const output = {};
  for (const [hook, values] of Object.entries(buckets)) {
    if (!values.length) {
      continue;
    }

    if (hook === 'prompt_submit_cosine') {
      output.prompt_submit = {
        ...(output.prompt_submit ?? {}),
        avg_cosine_contribution: values.reduce((sum, value) => sum + value, 0) / values.length
      };
      continue;
    }

    values.sort((a, b) => a - b);
    output[hook] = {
      ...(output[hook] ?? {}),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95)
    };
  }

  return output;
}

export function detectLLMDeadLetters(db, startMs, endMs) {
  const rows = db.prepare(
    `SELECT type, COUNT(*) AS n
     FROM tasks
     WHERE status = 'failed'
       AND attempts >= 3
       AND finished_at >= ?
       AND finished_at < ?
     GROUP BY type`
  ).all(startMs, endMs);

  return rows.reduce((sum, row) => sum + Number(row.n ?? 0), 0);
}

function yesterdayWindow() {
  const now = new Date();
  const dayEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayStart = dayEnd - 86400000;
  const dayKey = new Date(dayStart).toISOString().slice(0, 10);
  return { dayKey, dayStartMs: dayStart, dayEndMs: dayEnd };
}

export function writeMetricsDailyRollup(db) {
  const { dayKey, dayStartMs, dayEndMs } = yesterdayWindow();
  const hookStats = aggregateHookLatencies(dayStartMs, dayEndMs);
  const llmCalls = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE finished_at >= ? AND finished_at < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);
  const llmDuration = Number(db.prepare(
    `SELECT COALESCE(SUM(finished_at - started_at), 0) AS d
     FROM tasks
     WHERE finished_at >= ? AND finished_at < ? AND started_at IS NOT NULL`
  ).get(dayStartMs, dayEndMs)?.d ?? 0);
  const llmFailures = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE status = 'failed' AND finished_at >= ? AND finished_at < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);
  const llmDeadLetters = detectLLMDeadLetters(db, dayStartMs, dayEndMs);

  const secStats = db.prepare(
    `SELECT
       COALESCE(SUM(CAST(json_extract(details, '$.quarantined') AS INTEGER)), 0) AS q,
       COALESCE(SUM(CAST(json_extract(details, '$.alerts_emitted') AS INTEGER)), 0) AS a
     FROM audit_log
     WHERE action = 'security_audit_run'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs);

  const revalStats = db.prepare(
    `SELECT
       COALESCE(SUM(CAST(json_extract(details, '$.quarantined') AS INTEGER)), 0) AS q,
       COALESCE(SUM(CAST(json_extract(details, '$.flagged') AS INTEGER)), 0) AS f,
       COALESCE(SUM(CAST(json_extract(details, '$.scanned') AS INTEGER)), 0) AS s
     FROM audit_log
     WHERE action = 'revalidation_audit_run'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs);

  const tier15Clusters = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'security_quarantine_in'
       AND json_extract(details, '$.reason') = 'tier1_5_heuristic_cluster'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);

  const vecBackfillEmbedded = Number(db.prepare(
    `SELECT COALESCE(SUM(CAST(json_extract(details, '$.embedded') AS INTEGER)), 0) AS n
     FROM audit_log
     WHERE action = 'vec_backfill_run'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);
  const contraDetected = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'contradiction_detected'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);

  const synthStats = db.prepare(
    `SELECT
       COALESCE(SUM(CAST(json_extract(details, '$.synth_proposed') AS INTEGER)), 0) AS proposed,
       COALESCE(SUM(CAST(json_extract(details, '$.synth_accepted') AS INTEGER)), 0) AS accepted,
       COALESCE(SUM(CAST(json_extract(details, '$.synth_rejected') AS INTEGER)), 0) AS rejected
     FROM audit_log
     WHERE action = 'weekly_synthesis_run'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs);

  const noiseStats = db.prepare(
    `SELECT
       COALESCE(SUM(CAST(json_extract(details, '$.before_chars') AS INTEGER)
         - CAST(json_extract(details, '$.after_chars') AS INTEGER)), 0) AS stripped
     FROM audit_log
     WHERE action = 'transcript_cleaned'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs);

  const gateRejects = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'quality_gate_reject'
       AND ts >= ? AND ts < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);

  const injTotal = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE created_at >= ? AND created_at < ?`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);
  const injEmpty = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE created_at >= ? AND created_at < ?
       AND mem_ids = '[]'`
  ).get(dayStartMs, dayEndMs)?.n ?? 0);
  const scoreRows = db.prepare(
    `SELECT scores
     FROM recent_injections
     WHERE created_at >= ? AND created_at < ?
       AND scores IS NOT NULL`
  ).all(dayStartMs, dayEndMs);
  let fusedSum = 0;
  let fusedCount = 0;
  for (const row of scoreRows) {
    for (const score of parseInjectionScores(row.scores)) {
      const fused = Number(score?.f);
      if (Number.isFinite(fused)) {
        fusedSum += fused;
        fusedCount += 1;
      }
    }
  }
  const injAvgFused = fusedCount > 0 ? fusedSum / fusedCount : null;
  const injNever30d = countNeverInjected(db, 30);

  const memPool = db.prepare(
    `SELECT
       SUM(CASE WHEN decay_status = 'active' AND status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN decay_status = 'active' AND status = 'probation' THEN 1 ELSE 0 END) AS probation,
       SUM(CASE WHEN decay_status = 'quarantine' THEN 1 ELSE 0 END) AS quarantine,
       SUM(CASE WHEN decay_status = 'archived' THEN 1 ELSE 0 END) AS archived
     FROM memories`
  ).get() ?? {};

  db.prepare(
    `INSERT OR REPLACE INTO metrics_daily_rollup (
      day_key,
      hook_session_start_p50, hook_session_start_p95,
      hook_prompt_submit_p50, hook_prompt_submit_p95,
      hook_stop_p50, hook_stop_p95,
      llm_calls, llm_total_duration_ms, llm_failures, llm_dead_letters,
      sec_quarantined, sec_alerts_emitted,
      reval_quarantined, reval_flagged, reval_scanned,
      tier15_clusters, vec_backfill_embedded, contra_detected,
      synth_proposed, synth_accepted, synth_rejected,
      input_noise_stripped_chars, quality_gate_rejected,
      inj_total, inj_empty, inj_avg_fused, inj_never_30d,
      mems_active, mems_probation, mems_quarantine, mems_archived,
      written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dayKey,
    hookStats.session_start?.p50 ?? null,
    hookStats.session_start?.p95 ?? null,
    hookStats.prompt_submit?.p50 ?? null,
    hookStats.prompt_submit?.p95 ?? null,
    hookStats.stop?.p50 ?? null,
    hookStats.stop?.p95 ?? null,
    llmCalls,
    llmDuration,
    llmFailures,
    llmDeadLetters,
    Number(secStats?.q ?? 0),
    Number(secStats?.a ?? 0),
    Number(revalStats?.q ?? 0),
    Number(revalStats?.f ?? 0),
    Number(revalStats?.s ?? 0),
    tier15Clusters,
    vecBackfillEmbedded,
    contraDetected,
    Number(synthStats?.proposed ?? 0),
    Number(synthStats?.accepted ?? 0),
    Number(synthStats?.rejected ?? 0),
    Number(noiseStats?.stripped ?? 0),
    gateRejects,
    injTotal,
    injEmpty,
    injAvgFused,
    injNever30d,
    Number(memPool.active ?? 0),
    Number(memPool.probation ?? 0),
    Number(memPool.quarantine ?? 0),
    Number(memPool.archived ?? 0),
    Date.now()
  );

  const retentionDays = Number(loadConfig().metrics_rollup?.retention_days ?? 90);
  db.prepare(
    `DELETE FROM metrics_daily_rollup
     WHERE day_key < date('now', '-' || ? || ' days')`
  ).run(retentionDays);

  writeAudit(db, 'metrics_rollup_written', null, { day_key: dayKey });

  return { day_key: dayKey };
}
