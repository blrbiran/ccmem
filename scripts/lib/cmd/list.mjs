import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { retrieveMemories } from '../retrieval.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

export async function cmdList(db, { limit = 20, quarantined = false, query = null, cwd = process.cwd() } = {}) {
  try {
    maybeRunTier15(db);
  } catch {}

  if (quarantined) {
    return db.prepare(
      `SELECT m.id, m.scope, m.project_key, m.type, m.content, m.pinned, m.source,
              m.trust_score, m.quarantined_at,
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
       ORDER BY m.quarantined_at DESC, m.id DESC
       LIMIT ?`
    ).all(limit);
  }

  if (query) {
    const projectKey = resolveProjectKey(cwd);
    const result = await retrieveMemories(db, query, projectKey, loadConfig());
    return result.rows.slice(0, limit);
  }

  return db.prepare(
    `SELECT id, scope, project_key, type, content, pinned, decay_status
     FROM memories
     WHERE decay_status != 'quarantine'
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(limit);
}
