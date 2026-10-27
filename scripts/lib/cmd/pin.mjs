import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';
import { parseMemoryId } from '../memory-id.mjs';

export async function cmdPin(db, { id, remove = false }) {
  try {
    maybeRunTier15(db);
  } catch {}

  const memId = parseMemoryId(id);
  const row = memId != null
    ? db.prepare(`SELECT id, project_key FROM memories WHERE id = ?`).get(memId)
    : null;

  if (!row) {
    return null;
  }

  db.prepare(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`).run(
    remove ? 0 : 1,
    Date.now(),
    row.id
  );

  rebuildInjectionCache(db, row.project_key ?? null);

  return {
    id: row.id,
    pinned: remove ? 0 : 1
  };
}
