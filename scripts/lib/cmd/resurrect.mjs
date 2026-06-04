import { loadConfig } from '../config.mjs';
import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

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

export async function cmdResurrect(db, {
  bottom = 10,
  tag = null,
  decide = () => 's',
  quarantined = false,
  alerts = false,
  limit = null
} = {}) {
  const tier15Ran = alerts ? false : maybeRunTier15(db);

  if (alerts) {
    return {
      tier15: { ran: tier15Ran },
      ...resurrectAlerts(db, { limit: limit ?? bottom, decide })
    };
  }

  if (quarantined) {
    return {
      tier15: { ran: tier15Ran },
      ...resurrectQuarantined(db, { limit: limit ?? bottom, decide })
    };
  }

  return {
    tier15: { ran: tier15Ran },
    ...resurrectGreyZone(db, { bottom, tag, decide })
  };
}
