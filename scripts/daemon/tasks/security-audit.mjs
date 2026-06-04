import { callClaudeP } from '../claude-p.mjs';
import { buildSecurityAuditPrompt, parseSecurityAuditJson } from '../../lib/llm-prompts/security-audit.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';
import { securityAuditLeaseKey } from '../loop.mjs';

function dedupById(rows) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    output.push(row);
  }

  return output;
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function countByPool(candidates) {
  return {
    pool_a: candidates.filter((c) => c.pool === 'A').length,
    pool_b: candidates.filter((c) => c.pool === 'B').length,
    pool_c: candidates.filter((c) => c.pool === 'C').length
  };
}

function loadGlobalReferenceMems(db, maxRows) {
  return db.prepare(
    `SELECT id, trust_score, content
     FROM memories
     WHERE scope = 'global'
       AND decay_status = 'active'
       AND trust_score >= 0.7
     ORDER BY trust_score DESC, last_touched_at DESC
     LIMIT ?`
  ).all(maxRows);
}

export function selectAuditCandidates(db, cfg) {
  const now = Date.now();

  const poolA = db.prepare(
    `SELECT DISTINCT m.id, m.scope, m.project_key, m.type, m.source, m.content,
            m.trust_score, m.unhelpful_count, m.helpful_count, m.created_at,
            'A' AS pool
     FROM memories m
     JOIN memory_feedback f ON f.injected_ids LIKE '%' || m.id || '%'
     WHERE m.trust_score BETWEEN ? AND ?
       AND m.decay_status IN ('active', 'probation')
       AND f.outcome = 'unhelpful'
       AND f.recorded_at > ?
     LIMIT ?`
  ).all(
    cfg.pool_a.trustMin,
    cfg.pool_a.trustMax,
    now - (cfg.pool_a.windowDays * 86400000),
    cfg.pool_a.maxRows
  );

  const poolB = db.prepare(
    `SELECT m.id, m.scope, m.project_key, m.type, m.source, m.content,
            m.trust_score, m.unhelpful_count, m.helpful_count, m.created_at,
            'B' AS pool
     FROM memories m
     WHERE m.source IN ('auto_inferred', 'external', 'tool_output')
       AND m.decay_status IN ('active', 'probation')
       AND m.quarantined_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM memories m2
         WHERE m2.source = m.source
           AND date(m2.created_at / 1000, 'unixepoch') = date(m.created_at / 1000, 'unixepoch')
         GROUP BY m2.source, date(m2.created_at / 1000, 'unixepoch')
         HAVING COUNT(*) >= ?
       )
       AND m.created_at > ?
     LIMIT ?`
  ).all(
    cfg.pool_b.clusterMinSize,
    now - (cfg.pool_b.windowDays * 86400000),
    cfg.pool_b.maxRows
  );

  const poolC = db.prepare(
    `SELECT id, scope, project_key, type, source, content,
            trust_score, unhelpful_count, helpful_count, created_at,
            'C' AS pool
     FROM memories
     WHERE trust_score < 0.3 AND trust_score >= 0.1
       AND decay_status IN ('active', 'probation')
       AND quarantined_at IS NULL
       AND unhelpful_count >= ?
       AND updated_at > ?
     LIMIT ?`
  ).all(
    cfg.pool_c.unhelpfulMin,
    now - (cfg.pool_c.windowDays * 86400000),
    cfg.pool_c.maxRows
  );

  return dedupById([...poolA, ...poolB, ...poolC]);
}

function applySecurityAuditVerdict(db, batch, verdict, totals, cfg, scanVersion) {
  const batchIds = new Set(batch.map((item) => item.id));
  const touchedProjects = new Set();
  let touchedGlobal = false;
  const now = Date.now();

  for (const item of verdict.quarantine ?? []) {
    if (!batchIds.has(item.id)) {
      continue;
    }

    const updated = db.prepare(
      `UPDATE memories
       SET decay_status = 'quarantine', quarantined_at = ?, updated_at = ?
       WHERE id = ? AND decay_status != 'quarantine'`
    ).run(now, now, item.id);

    if (updated.changes === 0) {
      continue;
    }

    const row = db.prepare(`SELECT scope, project_key FROM memories WHERE id = ?`).get(item.id);
    if (row?.scope === 'global') {
      touchedGlobal = true;
    } else if (row?.project_key) {
      touchedProjects.add(row.project_key);
    }

    writeAudit(db, 'security_quarantine_in', item.id, {
      reason: 'security_audit_llm',
      llm_reason: item.reason,
      source: 'llm',
      pattern_version: scanVersion
    });
    totals.quarantined += 1;
  }

  for (const alert of verdict.cross_scope_alerts ?? []) {
    if (!batchIds.has(alert.project_id)) {
      continue;
    }

    const projectMem = db.prepare(
      `SELECT project_key FROM memories WHERE id = ?`
    ).get(alert.project_id);
    if (!projectMem?.project_key) {
      continue;
    }

    const duplicate = db.prepare(
      `SELECT id
       FROM cross_scope_alerts
       WHERE global_mem_id = ?
         AND project_mem_id = ?
         AND detected_at > ?
       LIMIT 1`
    ).get(
      alert.global_id,
      alert.project_id,
      now - (cfg.cross_scope.dedup_window_days * 86400000)
    );
    if (duplicate) {
      continue;
    }

    const result = db.prepare(
      `INSERT INTO cross_scope_alerts (
        global_mem_id,
        project_mem_id,
        project_key,
        similarity,
        evidence,
        detected_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      alert.global_id,
      alert.project_id,
      projectMem.project_key,
      alert.similarity,
      JSON.stringify({ llm_evidence: alert.evidence }),
      now
    );

    writeAudit(db, 'security_alert_emitted', alert.project_id, {
      alert_id: Number(result.lastInsertRowid),
      global_id: alert.global_id,
      similarity: alert.similarity
    });
    totals.alerts_emitted += 1;
  }

  const stamp = db.prepare(
    `UPDATE memories
     SET last_scanned_patterns_version = ?
     WHERE id = ?`
  );
  for (const item of batch) {
    stamp.run(scanVersion, item.id);
  }

  if (touchedGlobal) {
    rebuildInjectionCache(db, null);
  }
  for (const projectKey of touchedProjects) {
    rebuildInjectionCache(db, projectKey);
  }
}

export async function runSecurityAudit(db, task) {
  const startedAt = Date.now();
  const payload = JSON.parse(task?.payload ?? '{}');
  const scheduledFor = Number(task?.scheduled_for);
  const cfg = loadConfig();
  const scanVersion = cfg.security.scan_patterns_version;
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : securityAuditLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : startedAt));
  const candidates = selectAuditCandidates(db, cfg.security.audit);
  const poolStats = countByPool(candidates);
  const totals = { quarantined: 0, alerts_emitted: 0, llm_calls: 0 };

  try {
    if (!candidates.length) {
      writeAudit(db, 'security_audit_run', null, {
        candidates_scanned: 0,
        quarantined: 0,
        alerts_emitted: 0,
        llm_calls: 0,
        duration_ms: Date.now() - startedAt,
        pattern_version: scanVersion,
        ...poolStats
      });
      return;
    }

    const reference = loadGlobalReferenceMems(db, cfg.security.audit.globalReferenceMaxRows);
    const batches = chunk(candidates, cfg.security.audit.maxPerBatch);

    for (const batch of batches) {
      const raw = await callClaudeP(buildSecurityAuditPrompt(batch, reference), {
        taskType: 'security_audit',
        mockOutput: payload.llm_output
      });
      totals.llm_calls += 1;
      const verdict = parseSecurityAuditJson(raw);
      applySecurityAuditVerdict(db, batch, verdict, totals, cfg.security, scanVersion);
    }

    writeAudit(db, 'security_audit_run', null, {
      candidates_scanned: candidates.length,
      quarantined: totals.quarantined,
      alerts_emitted: totals.alerts_emitted,
      llm_calls: totals.llm_calls,
      duration_ms: Date.now() - startedAt,
      pattern_version: scanVersion,
      ...poolStats
    });
  } finally {
    markLeaseComplete(db, 'security_audit', leaseKey);
  }
}
