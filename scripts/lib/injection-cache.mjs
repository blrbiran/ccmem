import { computePriority } from './priority.mjs';
import { renderStableContext } from './render.mjs';

function rankRows(rows) {
  return [...rows].sort((a, b) =>
    (Number(b.pinned ?? 0) - Number(a.pinned ?? 0))
    || (computePriority(b) - computePriority(a))
    || (Number(b.last_touched_at ?? 0) - Number(a.last_touched_at ?? 0))
  );
}

export function rebuildInjectionCache(db, projectKey = null) {
  const globalRows = db.prepare(
    `SELECT id, scope, content, pinned, type, trust_score, helpful_count, unhelpful_count,
            half_life_days, last_touched_at, consolidation_depth, temporal_type
     FROM memories
     WHERE scope = 'global'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all();

  const rankedGlobalRows = rankRows(globalRows);
  const globalRendered = renderStableContext(projectKey, rankedGlobalRows);
  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       rendered_text = excluded.rendered_text,
       member_ids = excluded.member_ids,
       rendered_at = excluded.rendered_at`
  ).run('global', globalRendered, JSON.stringify(rankedGlobalRows.map((row) => row.id)), Date.now());

  if (!projectKey) {
    return;
  }

  const projectRows = db.prepare(
    `SELECT id, scope, content, pinned, type, trust_score, helpful_count, unhelpful_count,
            half_life_days, last_touched_at, consolidation_depth, temporal_type
     FROM memories
     WHERE scope = 'project'
       AND project_key = ?
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all(projectKey);

  const rankedProjectRows = rankRows(projectRows);
  const projectRendered = renderStableContext(projectKey, rankedProjectRows);
  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       rendered_text = excluded.rendered_text,
       member_ids = excluded.member_ids,
       rendered_at = excluded.rendered_at`
  ).run(`project:${projectKey}`, projectRendered, JSON.stringify(rankedProjectRows.map((row) => row.id)), Date.now());
}
