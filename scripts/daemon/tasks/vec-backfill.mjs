import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { vecToBlob } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { currentEmbeddingSig } from '../../lib/embedding/signature.mjs';

// `sig`, when passed, also counts rows whose embedding_sig no longer matches
// the current provider — the population this task's candidate query now
// selects from. Callers that don't have (or don't care about) a signature —
// e.g. the daemon-startup gate in daemon/main.mjs — keep the original
// embedding-IS-NULL-only count.
export function pendingEmbeddings(db, sig = null) {
  if (sig) {
    return Number(db.prepare(
      `SELECT COUNT(*) AS n
       FROM memories
       WHERE (embedding IS NULL OR embedding_sig IS NULL OR embedding_sig <> ?)
         AND status = 'active'
         AND decay_status IN ('active', 'probation')`
    ).get(sig)?.n ?? 0);
  }

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

  const sig = currentEmbeddingSig(provider, cfg);

  // Prefer rows whose signature doesn't match the current provider (NULL —
  // never embedded — or stale from a prior provider/model/dim) over rows
  // that are already current. This is what makes a provider switch heal
  // itself: every subsequent run re-embeds the stale rows until none remain.
  const rows = db.prepare(
    `SELECT id, content
     FROM memories
     WHERE (embedding IS NULL OR embedding_sig IS NULL OR embedding_sig <> ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY id ASC
     LIMIT ?`
  ).all(sig, Number(cfg.embedding?.backfill_batch_size ?? 50));

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
       SET embedding = ?, embedding_sig = ?, updated_at = ?
       WHERE id = ?`
    );

    db.exec('BEGIN');
    try {
      const now = Date.now();
      for (let i = 0; i < rows.length; i += 1) {
        update.run(vecToBlob(vectors[i]), sig, now, rows[i].id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    const remaining = pendingEmbeddings(db, sig);
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
