import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

function clampBottom(bottom) {
  const n = Number(bottom ?? 10);
  if (!Number.isFinite(n)) {
    return 10;
  }

  return Math.max(1, Math.min(50, Math.trunc(n)));
}

function normalizeDecision(input) {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'k') {
    return 'keep';
  }

  if (value === 'f') {
    return 'forget';
  }

  return 'skip';
}

export async function cmdResurrect(db, { bottom = 10, tag = null, decide = () => 's' } = {}) {
  const tier15Ran = maybeRunTier15(db);
  const params = [];
  let sql = `SELECT id, type, scope, project_key, content, trust_score, last_touched_at
    FROM memories
    WHERE trust_score >= 0.1 AND trust_score < 0.2 AND decay_status = 'active'`;

  if (tag) {
    sql += ` AND COALESCE(tags, '[]') LIKE ?`;
    params.push(`%"${tag}"%`);
  }

  sql += ` ORDER BY trust_score ASC, last_touched_at ASC, id ASC LIMIT ?`;
  params.push(clampBottom(bottom));

  const rows = db.prepare(sql).all(...params);
  const changedScopes = new Map();
  const items = [];

  for (const row of rows) {
    const now = Date.now();
    const action = normalizeDecision(decide(row));

    if (action === 'keep') {
      db.prepare(
        `UPDATE memories
         SET trust_score = 0.3, last_touched_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, now, row.id);
      changedScopes.set(`${row.scope}:${row.project_key ?? ''}`, row.project_key ?? null);
    } else if (action === 'forget') {
      db.prepare(
        `UPDATE memories
         SET decay_status = 'archived', updated_at = ?
         WHERE id = ?`
      ).run(now, row.id);
      changedScopes.set(`${row.scope}:${row.project_key ?? ''}`, row.project_key ?? null);
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

  for (const projectKey of changedScopes.values()) {
    rebuildInjectionCache(db, projectKey);
  }

  return {
    tier15: { ran: tier15Ran },
    items
  };
}
