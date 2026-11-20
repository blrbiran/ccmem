import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { collectInjectionRows, listNeverInjected } from '../recent-injections.mjs';
import { retrieveMemories } from '../retrieval.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

const READ_COLUMNS = `id, scope, project_key, type, content, pinned, source,
                      trust_score, tags, created_at, updated_at`;

/** Same visibility as `export`: archived, quarantined and deleted rows are not readable. */
const VISIBLE = `status = 'active' AND decay_status IN ('active', 'probation')`;

function readPayload({ query, scope, projectKey, total, rows }) {
  return {
    version: 1,
    query,
    scope,
    project_key: projectKey,
    total,
    memories: rows
  };
}

/** Retrieval rows carry only id/type/content/scope/score; a JSON consumer also wants the export columns. */
function hydrateScoreRows(db, rows) {
  if (!rows.length) {
    return [];
  }

  const byId = new Map(
    db.prepare(
      `SELECT ${READ_COLUMNS}
       FROM memories
       WHERE id IN (${rows.map(() => '?').join(',')})
         AND ${VISIBLE}`
    ).all(...rows.map((row) => row.id)).map((row) => [row.id, row])
  );

  return rows.flatMap((row) => {
    const full = byId.get(row.id);
    return full ? [{ ...full, score: row.score ?? null }] : [];
  });
}

/**
 * Issue #418: the read query the Orca panel uses instead of two full exports. One JSON object, one
 * process. `scope` selects visibility: `project` (default) is the retrieval scope — global rows plus
 * this repository's — while `global` and `all` exist for diagnosis. Scores are null on a plain list;
 * they are present whenever retrieval ran, and only the caller's requested page is returned.
 */
export async function cmdListJson(db, {
  limit = 20,
  offset = 0,
  query = null,
  cwd = process.cwd(),
  scope = 'project'
} = {}) {
  // Read-only: unlike `list`, this path must not run tier15's opportunistic maintenance
  // (it writes leases, audits and pruned rows) — the Orca panel is not a ccmem writer.
  const projectKey = resolveProjectKey(cwd);

  if (query) {
    const result = await retrieveMemories(db, query, projectKey, loadConfig(), {
      limit: offset + limit,
      order: 'fused'
    });
    const page = hydrateScoreRows(db, result.rows).slice(offset, offset + limit);
    return readPayload({ query, scope, projectKey, total: result.total ?? result.rows.length, rows: page });
  }

  const where = [
    VISIBLE,
    scope === 'global' ? `scope = 'global'` : null,
    scope === 'project' ? `(scope = 'global' OR project_key = ?)` : null
  ].filter(Boolean).join(' AND ');
  const params = scope === 'project' ? [projectKey] : [];

  const total = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT ${READ_COLUMNS}
     FROM memories
     WHERE ${where}
     ORDER BY pinned DESC, updated_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map((row) => ({ ...row, score: null }));

  return readPayload({ query: null, scope, projectKey, total, rows });
}

export async function cmdList(db, { limit = 20, quarantined = false, neverInjected = false, days = 30, query = null, cwd = process.cwd() } = {}) {
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

  if (neverInjected) {
    return listNeverInjected(db, { days, limit });
  }

  if (query) {
    const projectKey = resolveProjectKey(cwd);
    const result = await retrieveMemories(db, query, projectKey, loadConfig());
    return result.rows.slice(0, limit);
  }

  return db.prepare(
    `SELECT id, scope, project_key, type, content, pinned, decay_status, origin_agent
     FROM memories
     WHERE decay_status != 'quarantine'
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(limit);
}
