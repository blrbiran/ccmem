import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

export async function cmdPin(db, { id, remove = false }) {
  try {
    maybeRunTier15(db);
  } catch {}

  const row = db.prepare(`SELECT project_key FROM memories WHERE id = ?`).get(id);

  db.prepare(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`).run(
    remove ? 0 : 1,
    Date.now(),
    id
  );

  rebuildInjectionCache(db, row?.project_key ?? null);

  return {
    id,
    pinned: remove ? 0 : 1
  };
}
