import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../db.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

function parseMemoryId(id) {
  return Number.parseInt(String(id ?? '').replace(/^m/, ''), 10);
}

export async function cmdForget(db, { id }) {
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

  mkdirSync(path.join(getDataRoot(), 'trash'), { recursive: true });
  writeFileSync(path.join(getDataRoot(), 'trash', `${row.id}.md`), row.content);

  db.prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
  rebuildInjectionCache(db, row.project_key ?? null);

  return {
    id: row.id,
    scope: row.scope,
    type: row.type
  };
}
