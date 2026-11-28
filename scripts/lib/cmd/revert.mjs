import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { parseMemoryId } from '../memory-id.mjs';

function refuse(reason) {
  return { status: 'unsupported', reason };
}

export function cmdRevert(db, { id }) {
  const memoryId = parseMemoryId(id);
  if (memoryId == null) {
    return refuse('invalid memory id');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const target = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
    if (!target) {
      db.exec('ROLLBACK');
      return { status: 'not_found' };
    }
    if (target.status !== 'active' || !['active', 'probation'].includes(target.decay_status)
      || target.superseded_by != null || target.parent_id == null || Number(target.version) < 2) {
      db.exec('ROLLBACK');
      return refuse('not a current merged version');
    }

    const audits = db.prepare(
      `SELECT details FROM audit_log
       WHERE action = 'synthesis_dedup_merged' AND affected_ids = ?
       ORDER BY id`
    ).all(JSON.stringify([memoryId]));
    if (audits.length !== 1) {
      db.exec('ROLLBACK');
      return refuse('merge audit is missing or ambiguous');
    }

    let details;
    try {
      details = JSON.parse(audits[0].details ?? 'null');
    } catch {
      details = null;
    }
    const sourceIds = details?.source_ids;
    if (!Array.isArray(sourceIds) || sourceIds.length < 2
      || sourceIds.some((sourceId) => !Number.isSafeInteger(sourceId) || sourceId <= 0)
      || new Set(sourceIds).size !== sourceIds.length
      || !sourceIds.includes(Number(target.parent_id))
      || Number(details.parent_id) !== Number(target.parent_id)) {
      db.exec('ROLLBACK');
      return refuse('merge source list is invalid');
    }

    const placeholders = sourceIds.map(() => '?').join(', ');
    const linked = db.prepare(
      `SELECT id, scope, project_key, status, superseded_by
       FROM memories WHERE superseded_by = ? ORDER BY id`
    ).all(memoryId);
    const expectedIds = [...sourceIds].sort((a, b) => a - b);
    const linkedIds = linked.map((row) => Number(row.id));
    const sourceRows = db.prepare(
      `SELECT id, scope, project_key, status, superseded_by
       FROM memories WHERE id IN (${placeholders}) ORDER BY id`
    ).all(...sourceIds);
    const sourcesAreValid = sourceRows.length === sourceIds.length
      && sourceRows.every((row) => row.status === 'superseded'
        && Number(row.superseded_by) === memoryId
        && row.scope === target.scope
        && (row.project_key ?? null) === (target.project_key ?? null));
    if (JSON.stringify(linkedIds) !== JSON.stringify(expectedIds) || !sourcesAreValid) {
      db.exec('ROLLBACK');
      return refuse('merge sources no longer match this version');
    }

    const now = Date.now();
    if (Number(db.prepare(
      `UPDATE memories SET status = 'superseded', updated_at = ?
       WHERE id = ? AND status = 'active' AND superseded_by IS NULL`
    ).run(now, memoryId).changes) !== 1) {
      throw new Error(`memory changed during revert: ${memoryId}`);
    }
    const restore = db.prepare(
      `UPDATE memories SET status = 'active', superseded_by = NULL, updated_at = ?
       WHERE id = ? AND status = 'superseded' AND superseded_by = ?`
    );
    for (const sourceId of sourceIds) {
      if (Number(restore.run(now, sourceId, memoryId).changes) !== 1) {
        throw new Error(`merge source changed during revert: ${sourceId}`);
      }
    }

    writeAudit(db, 'memory_reverted', memoryId, {
      restored_ids: sourceIds,
      merge_version: Number(target.version)
    });
    db.exec('COMMIT');
    rebuildInjectionCache(db, target.project_key ?? null);
    return { status: 'reverted', id: memoryId, restoredIds: sourceIds };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
