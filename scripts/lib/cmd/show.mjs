import { recentInjectionHistoryForMemory } from '../recent-injections.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

function parseMemoryId(id) {
  return Number.parseInt(String(id ?? '').replace(/^m/, ''), 10);
}

export async function cmdShow(db, { id }) {
  try {
    maybeRunTier15(db);
  } catch {}

  const memId = parseMemoryId(id);
  const row = Number.isFinite(memId)
    ? db.prepare(`SELECT * FROM memories WHERE id = ?`).get(memId)
    : null;

  if (!row) {
    return null;
  }

  return {
    ...row,
    injection_history: recentInjectionHistoryForMemory(db, memId, 10)
  };
}
