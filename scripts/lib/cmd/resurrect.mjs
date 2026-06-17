import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';
import { callClaudeP } from '../../daemon/claude-p.mjs';
import { insertMemory } from './save.mjs';
import { buildMergePrompt, MERGE_SCHEMA } from '../llm-prompts/contradiction-merge.mjs';
import { parseRawLlmOutput } from '../llm-parse.mjs';

function clampLimit(value, fallback = 10) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.max(1, Math.min(50, Math.trunc(n)));
}

function normalizeGreyDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'k') {
    return 'keep';
  }

  if (value === 'f') {
    return 'forget';
  }

  return 'skip';
}

function normalizeAlertDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'g') {
    return 'keep_global';
  }

  if (value === 'p') {
    return 'keep_project';
  }

  if (value === 'b') {
    return 'keep_both';
  }

  if (value === 'x') {
    return 'forget_both';
  }

  return 'skip';
}

function normalizeRevalidationDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'k') {
    return 'keep';
  }

  if (value === 'f') {
    return 'forget';
  }

  if (value === 'q') {
    return 'quarantine';
  }

  return 'skip';
}

function normalizeContradictionDecision(input) {
  const value = String(input ?? '').trim();
  if (value === 'a') {
    return 'keep_a';
  }

  if (value === 'b') {
    return 'keep_b';
  }

  if (value === 'B') {
    return 'keep_both';
  }

  if (value === 'm') {
    return 'merged';
  }

  return 'skip';
}

function normalizePromoteDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'p') {
    return 'promote';
  }
  if (value === 'd') {
    return 'dismiss';
  }
  return 'skip';
}

function parseTags(tags) {
  try {
    const parsed = JSON.parse(tags ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resurrectPromoteCandidates(db, { cwd, limit, decide, all = false }) {
  const currentProjectKey = resolveProjectKey(cwd);
  const rows = all
    ? db.prepare(
        `SELECT pc.id AS candidate_id,
                pc.mem_id,
                pc.project_key,
                pc.similar_in,
                pc.trigger,
                pc.detected_at,
                m.content,
                m.type,
                m.trust_score,
                m.tags
         FROM promote_candidates pc
         JOIN memories m ON m.id = pc.mem_id
         WHERE pc.acknowledged_at IS NULL
         ORDER BY pc.detected_at DESC, pc.id DESC
         LIMIT ?`
      ).all(clampLimit(limit, 10))
    : db.prepare(
        `SELECT pc.id AS candidate_id,
                pc.mem_id,
                pc.project_key,
                pc.similar_in,
                pc.trigger,
                pc.detected_at,
                m.content,
                m.type,
                m.trust_score,
                m.tags
         FROM promote_candidates pc
         JOIN memories m ON m.id = pc.mem_id
         WHERE pc.acknowledged_at IS NULL
           AND (pc.project_key = ? OR EXISTS (
             SELECT 1
             FROM json_each(pc.similar_in) je
             WHERE json_extract(je.value, '$.project_key') = ?
           ))
         ORDER BY pc.detected_at DESC, pc.id DESC
         LIMIT ?`
      ).all(currentProjectKey, currentProjectKey, clampLimit(limit, 10));

  const items = [];
  const touched = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizePromoteDecision(decide({
      ...row,
      similar: JSON.parse(row.similar_in ?? '[]')
    }));

    if (action === 'promote') {
      const tags = parseTags(row.tags);
      if (tags.includes('dangerous_command') || tags.includes('contains_secret')) {
        items.push({
          candidate_id: row.candidate_id,
          mem_id: row.mem_id,
          project_key: row.project_key,
          content: row.content,
          type: row.type,
          trust_score: row.trust_score,
          similar: JSON.parse(row.similar_in ?? '[]'),
          action: 'blocked'
        });
        continue;
      }

      db.prepare(
        `UPDATE memories
         SET scope = 'global', project_key = NULL, type = 'rule', updated_at = ?
         WHERE id = ?`
      ).run(now, row.mem_id);
      db.prepare(
        `UPDATE promote_candidates
         SET acknowledged_at = ?, acknowledged_action = 'promote'
         WHERE id = ?`
      ).run(now, row.candidate_id);
      writeAudit(db, 'cross_project_acknowledged', row.mem_id, {
        candidate_id: row.candidate_id,
        action: 'promote'
      });
      touched.push({ scope: 'global', project_key: null });
      touched.push({ scope: 'project', project_key: row.project_key ?? null });
    } else if (action === 'dismiss') {
      db.prepare(
        `UPDATE promote_candidates
         SET acknowledged_at = ?, acknowledged_action = 'dismiss'
         WHERE id = ?`
      ).run(now, row.candidate_id);
      writeAudit(db, 'cross_project_acknowledged', row.mem_id, {
        candidate_id: row.candidate_id,
        action: 'dismiss'
      });
    }

    items.push({
      candidate_id: row.candidate_id,
      mem_id: row.mem_id,
      project_key: row.project_key,
      content: row.content,
      type: row.type,
      trust_score: row.trust_score,
      similar: JSON.parse(row.similar_in ?? '[]'),
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'promote_candidates', items };
}

function acknowledgeContradiction(db, alertId, action, memIdA) {
  db.prepare(
    `UPDATE contradiction_alerts
     SET acknowledged_at = ?, acknowledged_action = ?
     WHERE id = ?`
  ).run(Date.now(), action, alertId);
  writeAudit(db, 'contradiction_acknowledged', memIdA, {
    alert_id: alertId,
    action
  });
}

async function mergeContradictionPair(db, row, merge) {
  if (typeof merge !== 'function') {
    return { action: 'skip', touched: [] };
  }

  const memA = {
    id: row.mem_id_a,
    scope: row.mem_a_scope,
    project_key: row.mem_a_project_key ?? null,
    type: row.type_a,
    content: row.content_a,
    trust_score: row.trust_a
  };
  const memB = {
    id: row.mem_id_b,
    scope: row.mem_b_scope,
    project_key: row.mem_b_project_key ?? null,
    type: row.type_b,
    content: row.content_b,
    trust_score: row.trust_b
  };

  let outcome;
  try {
    const raw = await callClaudeP(buildMergePrompt(memA, memB), {
      taskType: 'contradiction_merge',
      jsonSchema: MERGE_SCHEMA
    });
    const merged = parseRawLlmOutput(raw) ?? {};
    if (!merged.merge_possible) {
      outcome = await merge(row, { merge_possible: false, reason: String(merged.reason ?? '') });
      return { action: outcome?.action ?? 'skip', touched: [] };
    }

    const mergedContent = String(merged.merged_content ?? '').slice(0, 500);
    outcome = await merge(row, {
      merge_possible: true,
      merged_content: mergedContent
    });
    if (outcome?.action !== 'merged') {
      return { action: outcome?.action ?? 'skip', touched: [] };
    }

    const inserted = await insertMemory(db, {
      cwd: process.cwd(),
      content: mergedContent,
      type: 'consolidated',
      scope: memA.scope,
      projectKey: memA.project_key,
      source: 'cron_consolidated',
      trust: Math.max(Number(memA.trust_score ?? 0), Number(memB.trust_score ?? 0)),
      consolidationDepth: 0,
      parentIds: [memA.id, memB.id],
      lastTouchedAt: Date.now(),
      embedSync: false
    });

    const now = Date.now();
    db.prepare(
      `UPDATE memories
       SET status = 'superseded', updated_at = ?
       WHERE id IN (?, ?)`
    ).run(now, memA.id, memB.id);
    db.prepare(
      `UPDATE contradiction_alerts
       SET acknowledged_at = ?, acknowledged_action = 'merged'
       WHERE id = ?`
    ).run(now, row.id);
    writeAudit(db, 'contradiction_merged', inserted.id, {
      alert_id: row.id,
      source_ids: [memA.id, memB.id],
      merged_content_excerpt: mergedContent.slice(0, 80)
    });
    return {
      action: 'merged',
      touched: [
        { scope: memA.scope, project_key: memA.project_key ?? null },
        { scope: memB.scope, project_key: memB.project_key ?? null }
      ]
    };
  } catch (error) {
    outcome = await merge(row, {
      merge_possible: false,
      error: String(error?.message ?? error)
    });
    return { action: outcome?.action ?? 'skip', touched: [] };
  }
}

async function resurrectContradictions(db, { cwd, limit, decide, merge }) {
  const projectKey = resolveProjectKey(cwd);
  const rows = db.prepare(
    `SELECT a.id,
            a.mem_id_a,
            a.mem_id_b,
            a.scope,
            a.cosine_similarity,
            a.evidence,
            a.detected_at,
            ma.scope AS mem_a_scope,
            ma.project_key AS mem_a_project_key,
            ma.type AS type_a,
            ma.content AS content_a,
            ma.trust_score AS trust_a,
            mb.scope AS mem_b_scope,
            mb.project_key AS mem_b_project_key,
            mb.type AS type_b,
            mb.content AS content_b,
            mb.trust_score AS trust_b
     FROM contradiction_alerts a
     JOIN memories ma ON ma.id = a.mem_id_a
     JOIN memories mb ON mb.id = a.mem_id_b
     WHERE a.acknowledged_at IS NULL
       AND (a.scope = 'global' OR a.scope = ?)
     ORDER BY a.detected_at ASC, a.id ASC
     LIMIT ?`
  ).all(projectKey, clampLimit(limit, 10));
  const touched = [];
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    let action = normalizeContradictionDecision(decide(row));

    if (action === 'keep_a') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.mem_id_b);
      touched.push({ scope: row.mem_b_scope, project_key: row.mem_b_project_key ?? null });
      acknowledgeContradiction(db, row.id, action, row.mem_id_a);
    } else if (action === 'keep_b') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.mem_id_a);
      touched.push({ scope: row.mem_a_scope, project_key: row.mem_a_project_key ?? null });
      acknowledgeContradiction(db, row.id, action, row.mem_id_a);
    } else if (action === 'keep_both') {
      acknowledgeContradiction(db, row.id, action, row.mem_id_a);
    } else if (action === 'merged') {
      const outcome = await mergeContradictionPair(db, row, merge);
      action = outcome?.action ?? 'skip';
      if (Array.isArray(outcome?.touched)) {
        touched.push(...outcome.touched);
      }
    }

    items.push({
      id: row.id,
      mem_id_a: row.mem_id_a,
      mem_id_b: row.mem_id_b,
      cosine_similarity: row.cosine_similarity,
      detected_at: row.detected_at,
      evidence: row.evidence,
      type_a: row.type_a,
      content_a: row.content_a,
      trust_a: row.trust_a,
      type_b: row.type_b,
      content_b: row.content_b,
      trust_b: row.trust_b,
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'contradictions', items };
}

function rebuildTouchedCaches(db, touchedScopes) {
  let rebuildGlobal = false;
  const projectKeys = new Set();

  for (const row of touchedScopes) {
    if (row.scope === 'global') {
      rebuildGlobal = true;
    } else if (row.project_key) {
      projectKeys.add(row.project_key);
    }
  }

  if (rebuildGlobal) {
    rebuildInjectionCache(db, null);
  }

  for (const projectKey of projectKeys) {
    rebuildInjectionCache(db, projectKey);
  }
}

function resurrectGreyZone(db, { bottom, tag, decide }) {
  const params = [];
  let sql = `SELECT id, type, scope, project_key, content, trust_score, last_touched_at
    FROM memories
    WHERE trust_score >= 0.1 AND trust_score < 0.2 AND decay_status = 'active'`;

  if (tag) {
    sql += ` AND COALESCE(tags, '[]') LIKE ?`;
    params.push(`%"${tag}"%`);
  }

  sql += ` ORDER BY trust_score ASC, last_touched_at ASC, id ASC LIMIT ?`;
  params.push(clampLimit(bottom, 10));

  const rows = db.prepare(sql).all(...params);
  const touched = [];
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizeGreyDecision(decide(row));

    if (action === 'keep') {
      db.prepare(
        `UPDATE memories
         SET trust_score = 0.3, last_touched_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, now, row.id);
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    } else if (action === 'forget') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.id);
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    }

    items.push({
      id: row.id,
      type: row.type,
      scope: row.scope,
      content: row.content,
      trust_score: row.trust_score,
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'grey', items };
}

function resurrectQuarantined(db, { limit, decide }) {
  const cfg = loadConfig();
  const rows = db.prepare(
    `SELECT m.id, m.type, m.scope, m.project_key, m.content, m.trust_score, m.quarantined_at,
            (
              SELECT json_extract(a.details, '$.reason')
              FROM audit_log a
              JOIN audit_log_targets t ON t.audit_id = a.id
              WHERE t.mem_id = m.id AND a.action = 'security_quarantine_in'
              ORDER BY a.ts DESC, a.id DESC
              LIMIT 1
            ) AS reason
     FROM memories m
     WHERE m.decay_status = 'quarantine'
     ORDER BY m.quarantined_at ASC, m.id ASC
     LIMIT ?`
  ).all(clampLimit(limit, 10));
  const touched = [];
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizeGreyDecision(decide(row));

    if (action === 'keep') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'active',
             trust_score = ?,
             quarantined_at = NULL,
             last_touched_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(cfg.security.quarantine.resurrect_trust, now, now, row.id);
      writeAudit(db, 'security_quarantine_resurrect', row.id, { user_action: 'keep' });
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    } else if (action === 'forget') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', quarantined_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(now, row.id);
      writeAudit(db, 'security_quarantine_resurrect', row.id, { user_action: 'forget' });
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    }

    items.push({
      id: row.id,
      type: row.type,
      scope: row.scope,
      content: row.content,
      trust_score: row.trust_score,
      quarantined_at: row.quarantined_at,
      reason: row.reason,
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'quarantined', items };
}

function resurrectAlerts(db, { limit, decide }) {
  const rows = db.prepare(
    `SELECT a.id,
            a.global_mem_id,
            a.project_mem_id,
            a.project_key,
            a.similarity,
            a.detected_at,
            a.evidence,
            gm.scope AS global_scope,
            gm.project_key AS global_project_key,
            gm.type AS global_type,
            gm.content AS global_content,
            gm.trust_score AS global_trust_score,
            pm.scope AS project_scope,
            pm.project_key AS project_project_key,
            pm.type AS project_type,
            pm.content AS project_content,
            pm.trust_score AS project_trust_score
     FROM cross_scope_alerts a
     LEFT JOIN memories gm ON gm.id = a.global_mem_id
     LEFT JOIN memories pm ON pm.id = a.project_mem_id
     WHERE a.acknowledged_at IS NULL
     ORDER BY a.detected_at ASC, a.id ASC
     LIMIT ?`
  ).all(clampLimit(limit, 10));
  const touched = [];
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizeAlertDecision(decide(row));

    if (action === 'keep_global') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.project_mem_id);
      touched.push({ scope: row.project_scope, project_key: row.project_project_key ?? null });
    } else if (action === 'keep_project') {
      db.prepare(
        `UPDATE memories
         SET trust_score = 0.3, updated_at = ?
         WHERE id = ?`
      ).run(now, row.global_mem_id);
      touched.push({ scope: row.global_scope, project_key: row.global_project_key ?? null });
    } else if (action === 'forget_both') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id IN (?, ?)`
      ).run(now, row.global_mem_id, row.project_mem_id);
      touched.push({ scope: row.global_scope, project_key: row.global_project_key ?? null });
      touched.push({ scope: row.project_scope, project_key: row.project_project_key ?? null });
    }

    if (action !== 'skip') {
      db.prepare(
        `UPDATE cross_scope_alerts
         SET acknowledged_at = ?, acknowledged_action = ?
         WHERE id = ?`
      ).run(now, action, row.id);
      writeAudit(db, 'security_alert_acknowledged', row.project_mem_id, {
        alert_id: row.id,
        action
      });
    }

    items.push({
      id: row.id,
      global_mem_id: row.global_mem_id,
      project_mem_id: row.project_mem_id,
      project_key: row.project_key,
      similarity: row.similarity,
      detected_at: row.detected_at,
      evidence: row.evidence,
      global_content: row.global_content,
      global_type: row.global_type,
      global_trust_score: row.global_trust_score,
      project_content: row.project_content,
      project_type: row.project_type,
      project_trust_score: row.project_trust_score,
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'alerts', items };
}

function resurrectRevalidation(db, { cwd, limit, decide }) {
  const cutoffTs = Date.now() - (30 * 86400000);
  const projectKey = resolveProjectKey(cwd);
  const rows = db.prepare(
    `WITH latest_flag AS (
       SELECT t.mem_id, MAX(a.ts) AS flag_ts
       FROM audit_log a
       JOIN audit_log_targets t ON t.audit_id = a.id
       WHERE a.action = 'revalidation_flagged' AND a.ts > ?
       GROUP BY t.mem_id
     ),
     latest_resurrect AS (
       SELECT t.mem_id, MAX(a.ts) AS resurrect_ts
       FROM audit_log a
       JOIN audit_log_targets t ON t.audit_id = a.id
       WHERE a.action = 'revalidation_resurrect'
       GROUP BY t.mem_id
     )
     SELECT m.id, m.type, m.scope, m.project_key, m.content, m.trust_score, m.pinned,
            lf.flag_ts, lr.resurrect_ts,
            (
              SELECT json_extract(a.details, '$.trigger_pattern')
              FROM audit_log a
              JOIN audit_log_targets t ON t.audit_id = a.id
              WHERE t.mem_id = m.id AND a.action = 'revalidation_flagged'
              ORDER BY a.ts DESC, a.id DESC
              LIMIT 1
            ) AS trigger_pattern,
            (
              SELECT json_extract(a.details, '$.reason')
              FROM audit_log a
              JOIN audit_log_targets t ON t.audit_id = a.id
              WHERE t.mem_id = m.id AND a.action = 'revalidation_flagged'
              ORDER BY a.ts DESC, a.id DESC
              LIMIT 1
            ) AS flag_reason
     FROM memories m
     JOIN latest_flag lf ON lf.mem_id = m.id
     LEFT JOIN latest_resurrect lr ON lr.mem_id = m.id
     WHERE m.decay_status IN ('active', 'probation')
       AND (m.scope = 'global' OR m.project_key = ?)
       AND lf.flag_ts > COALESCE(lr.resurrect_ts, 0)
     ORDER BY m.trust_score ASC, lf.flag_ts DESC, m.id ASC
     LIMIT ?`
  ).all(cutoffTs, projectKey, clampLimit(limit, 10));

  const touched = [];
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizeRevalidationDecision(decide(row));

    if (action === 'keep') {
      db.prepare(
        `UPDATE memories
         SET last_touched_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, now, row.id);
      writeAudit(db, 'revalidation_resurrect', row.id, { user_action: 'keep' });
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    } else if (action === 'forget') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.id);
      writeAudit(db, 'revalidation_resurrect', row.id, { user_action: 'forget' });
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    } else if (action === 'quarantine') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'quarantine', quarantined_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, now, row.id);
      writeAudit(db, 'revalidation_resurrect', row.id, { user_action: 'quarantine' });
      touched.push({ scope: row.scope, project_key: row.project_key ?? null });
    }

    items.push({
      id: row.id,
      type: row.type,
      scope: row.scope,
      project_key: row.project_key,
      content: row.content,
      trust_score: row.trust_score,
      pinned: row.pinned,
      flag_ts: row.flag_ts,
      resurrect_ts: row.resurrect_ts,
      trigger_pattern: row.trigger_pattern,
      flag_reason: row.flag_reason,
      action
    });
  }

  rebuildTouchedCaches(db, touched);
  return { mode: 'revalidation', items };
}

export async function cmdResurrect(db, {
  cwd = process.cwd(),
  bottom = 10,
  tag = null,
  decide = () => 's',
  merge = null,
  quarantined = false,
  alerts = false,
  contradictions = false,
  revalidation = false,
  promoteCandidates = false,
  all = false,
  limit = null
} = {}) {
  const tier15 = alerts ? { ran: false, skipped: 'alerts_mode' } : maybeRunTier15(db);

  if (alerts) {
    return {
      tier15,
      ...resurrectAlerts(db, { limit: limit ?? bottom, decide })
    };
  }

  if (revalidation) {
    return {
      tier15,
      ...resurrectRevalidation(db, { cwd, limit: limit ?? bottom, decide })
    };
  }

  if (contradictions) {
    return {
      tier15,
      ...await resurrectContradictions(db, { cwd, limit: limit ?? bottom, decide, merge })
    };
  }

  if (quarantined) {
    return {
      tier15,
      ...resurrectQuarantined(db, { limit: limit ?? bottom, decide })
    };
  }

  if (promoteCandidates) {
    return {
      tier15,
      ...resurrectPromoteCandidates(db, { cwd, limit: limit ?? bottom, decide, all })
    };
  }

  return {
    tier15,
    ...resurrectGreyZone(db, { bottom, tag, decide })
  };
}
