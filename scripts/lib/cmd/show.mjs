import { maybeRunTier15 } from '../tier15.mjs';

export async function cmdShow(db, { id }) {
  try {
    maybeRunTier15(db);
  } catch {}

  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
}
