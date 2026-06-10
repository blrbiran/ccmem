import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { vecToBlob } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';

export function pendingEmbeddings(db) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
}

export async function runVecBackfill(db, _task = null) {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const provider = getProvider(cfg);

  if (!provider) {
    const remaining = pendingEmbeddings(db);
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: 0,
      remaining,
      duration_ms: 0
    });
    return { embedded: 0, remaining, duration_ms: 0 };
  }

  const rows = db.prepare(
    `SELECT id, content
     FROM memories
     WHERE embedding IS NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY id ASC
     LIMIT ?`
  ).all(Number(cfg.embedding?.backfill_batch_size ?? 50));

  if (!rows.length) {
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: 0,
      remaining: 0,
      duration_ms: 0
    });
    return { embedded: 0, remaining: 0, duration_ms: 0 };
  }

  try {
    await provider.load();
    const vectors = await provider.embed(rows.map((row) => row.content));
    const update = db.prepare(
      `UPDATE memories
       SET embedding = ?, updated_at = ?
       WHERE id = ?`
    );

    db.exec('BEGIN');
    try {
      const now = Date.now();
      for (let i = 0; i < rows.length; i += 1) {
        update.run(vecToBlob(vectors[i]), now, rows[i].id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    const remaining = pendingEmbeddings(db);
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: rows.length,
      remaining,
      duration_ms: durationMs
    });
    return { embedded: rows.length, remaining, duration_ms: durationMs };
  } catch (error) {
    writeAudit(db, 'vec_backfill_error', null, {
      error: String(error?.message ?? error).slice(0, 200),
      embedded_before_fail: 0
    });
    throw error;
  }
}
