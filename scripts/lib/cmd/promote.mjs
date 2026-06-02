import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

const BLOCKED_GLOBAL_TAGS = new Set(['dangerous_command', 'contains_secret']);

function parseMemoryId(id) {
  return Number.parseInt(String(id ?? '').replace(/^m/, ''), 10);
}

function parseTags(tags) {
  try {
    const parsed = JSON.parse(tags ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function cmdPromote(db, { id, global = false, confirm = () => '' } = {}) {
  try {
    maybeRunTier15(db);
  } catch {}

  const memId = parseMemoryId(id);
  const mem = Number.isFinite(memId)
    ? db.prepare(`SELECT * FROM memories WHERE id = ?`).get(memId)
    : null;

  if (!mem) {
    return { status: 'not_found' };
  }

  if (global) {
    if (mem.scope !== 'project' || mem.type !== 'rule') {
      return {
        status: 'unsupported',
        reason: 'only project rules can be promoted to global',
        id: mem.id
      };
    }

    if (parseTags(mem.tags).some((tag) => BLOCKED_GLOBAL_TAGS.has(tag))) {
      return {
        status: 'blocked',
        reason: 'dangerous/secret memory cannot be promoted to global',
        id: mem.id
      };
    }

    if (confirm(mem) !== 'PROMOTE GLOBAL') {
      return { status: 'cancelled', id: mem.id };
    }

    db.prepare(
      `UPDATE memories
       SET scope = 'global', project_key = NULL, type = 'rule', updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), mem.id);
  } else {
    if (mem.scope !== 'project') {
      return {
        status: 'unsupported',
        reason: 'only project memories can be promoted to rules',
        id: mem.id
      };
    }

    if (confirm(mem) !== 'PROMOTE') {
      return { status: 'cancelled', id: mem.id };
    }

    db.prepare(
      `UPDATE memories
       SET type = 'rule', updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), mem.id);
  }

  rebuildInjectionCache(db, mem.project_key ?? null);

  return {
    status: 'promoted',
    id: mem.id,
    scope: global ? 'global' : mem.scope,
    type: 'rule'
  };
}
