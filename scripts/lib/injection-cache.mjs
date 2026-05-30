import { renderStableContext } from './render.mjs';

export function rebuildInjectionCache(db, projectKey = null) {
  const globalRows = db.prepare(
    `SELECT id, scope, content, pinned
     FROM memories
     WHERE scope = 'global'
     ORDER BY pinned DESC, last_touched_at DESC`
  ).all();

  const globalRendered = renderStableContext(projectKey, globalRows);
  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       rendered_text = excluded.rendered_text,
       member_ids = excluded.member_ids,
       rendered_at = excluded.rendered_at`
  ).run('global', globalRendered, JSON.stringify(globalRows.map((row) => row.id)), Date.now());

  if (!projectKey) {
    return;
  }

  const projectRows = db.prepare(
    `SELECT id, scope, content, pinned
     FROM memories
     WHERE scope = 'project' AND project_key = ?
     ORDER BY pinned DESC, last_touched_at DESC`
  ).all(projectKey);

  const projectRendered = renderStableContext(projectKey, projectRows);
  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       rendered_text = excluded.rendered_text,
       member_ids = excluded.member_ids,
       rendered_at = excluded.rendered_at`
  ).run(`project:${projectKey}`, projectRendered, JSON.stringify(projectRows.map((row) => row.id)), Date.now());
}
