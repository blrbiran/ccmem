import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../db.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

export async function cmdForget(db, { id }) {
  try {
    maybeRunTier15(db);
  } catch {}

  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);

  mkdirSync(path.join(getDataRoot(), 'trash'), { recursive: true });
  writeFileSync(path.join(getDataRoot(), 'trash', `${id}.md`), row.content);

  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  rebuildInjectionCache(db, row.project_key ?? null);

  return {
    id: row.id,
    scope: row.scope,
    type: row.type
  };
}
