import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';

export async function cmdAdminAlias(db, {
  oldKey,
  newKey,
  confirm = () => ''
} = {}) {
  if (!oldKey || !newKey) {
    return {
      status: 'usage',
      reason: 'ccmem: usage: ccmem admin alias <old-project-key> <new-project-key>'
    };
  }

  const count = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE project_key = ?`
  ).get(oldKey)?.n ?? 0);

  if (count === 0) {
    return {
      status: 'not_found',
      reason: `ccmem: no memories found with project_key "${oldKey}"`
    };
  }

  const confirmation = await confirm({ oldKey, newKey, count });
  if (String(confirmation ?? '').trim() !== 'ALIAS') {
    return { status: 'cancelled', oldKey, newKey, count };
  }

  db.prepare(
    `UPDATE memories
     SET project_key = ?, updated_at = ?
     WHERE project_key = ?`
  ).run(newKey, Date.now(), oldKey);

  rebuildInjectionCache(db, newKey);
  db.prepare(`DELETE FROM injection_cache WHERE scope = ?`).run(`project:${oldKey}`);

  writeAudit(db, 'alias_applied', null, {
    old_key: oldKey,
    new_key: newKey,
    updated_count: count
  });

  return {
    status: 'applied',
    oldKey,
    newKey,
    updated_count: count
  };
}
