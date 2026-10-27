import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { maybeRunTier15 } from '../tier15.mjs';

function parseMemoryId(id) {
  return Number.parseInt(String(id ?? '').replace(/^m/, ''), 10);
}

// Forget archives instead of deleting (human ruling 2026-10-27): the row keeps
// its content and state, retrieval and injection skip decay_status='archived',
// and the audit row records what to flip back to restore it. No trash file:
// the archived row is the backup (nothing hard-deletes archived rows, and
// `ccmem show <id>` still prints it), and a second plaintext copy would only
// duplicate content that may be secret.
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

  db.prepare(
    `UPDATE memories
     SET decay_status = 'archived', updated_at = ?
     WHERE id = ?`
  ).run(Date.now(), row.id);
  const auditId = writeAudit(db, 'forget', row.id, {
    user_action: 'forget',
    scope: row.scope,
    type: row.type,
    previous_decay_status: row.decay_status
  });
  rebuildInjectionCache(db, row.project_key ?? null);

  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    audit_id: auditId
  };
}
