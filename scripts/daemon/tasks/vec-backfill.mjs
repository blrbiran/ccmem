import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { vecToBlob } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { currentEmbeddingSig } from '../../lib/embedding/signature.mjs';

// Counts rows a vec_backfill run under `sig` would still need to touch: never
// embedded, or embedded under a different signature. `sig` is required (not
// optional) on purpose — every caller, including the daemon-startup gate in
// daemon/main.mjs, must derive it the same way (currentEmbeddingSig), so a
// signature-unaware caller can no longer silently see "0 pending" on a store
// that is fully embedded but entirely stale.
export function pendingEmbeddings(db, sig) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE (embedding IS NULL OR embedding_sig IS NULL OR embedding_sig <> ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get(sig)?.n ?? 0);
}

/**
 * Queue the next batch when a run finishes with work still outstanding.
 *
 * One run only ever processes one backfill_batch_size batch, and vec_backfill
 * is on no recurring schedule — before this it was queued only at daemon
 * startup, so a store with 4,494 memories needed ~90 daemon restarts before the
 * semantic lane came back, degrading silently to lexical-only in the meantime.
 *
 * The guard counts only 'queued', deliberately NOT 'running': the run calling
 * this IS the running one, so including 'running' would make the condition
 * permanently true and the chain would never continue. daemon/main.mjs's
 * startup guard correctly counts both, because nothing is running there.
 */
function enqueueContinuation(db) {
  const alreadyQueued = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'vec_backfill'
       AND status = 'queued'`
  ).get()?.n ?? 0);
  if (alreadyQueued > 0) {
    return false;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('vec_backfill', '{}', ?, ?, 'queued')`
  ).run(now, now);
  return true;
}

export async function runVecBackfill(db, _task = null) {
  const cfg = loadConfig();
  const startedAt = Date.now();
  const provider = getProvider(cfg);
  const sig = currentEmbeddingSig(provider, cfg);

  if (!provider) {
    const remaining = pendingEmbeddings(db, sig);
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: 0,
      remaining,
      duration_ms: 0
    });
    return { embedded: 0, remaining, duration_ms: 0 };
  }

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
    if (remaining > 0) {
      const chained = enqueueContinuation(db);
      process.stderr.write(`ccmem: vec_backfill embedded ${rows.length}, ${remaining} still pending under signature ${sig} — ${chained ? 'continuation queued' : 'continuation already queued'}\n`);
    }
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
