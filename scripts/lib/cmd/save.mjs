import { rebuildInjectionCache } from '../injection-cache.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { evaluateTier1 } from '../threat-scan.mjs';
import { inferType } from '../type-heuristic.mjs';

export async function cmdSave(db, { cwd, content, scope = 'project', type = null }) {
  const gate = evaluateTier1(content);
  if (!gate.ok) {
    throw Object.assign(new Error(`ccmem: rejected save (${gate.reason})`), { exitCode: 64 });
  }

  const resolvedType = type ?? inferType(content).type;
  const projectKey = scope === 'global' ? null : resolveProjectKey(cwd);
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO memories (
      scope,
      project_key,
      type,
      content,
      pinned,
      source,
      last_touched_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 0, 'user_explicit', ?, ?, ?)`
  ).run(scope, projectKey, resolvedType, content, now, now, now);

  rebuildInjectionCache(db, projectKey);

  return {
    id: Number(result.lastInsertRowid),
    scope,
    type: resolvedType
  };
}
