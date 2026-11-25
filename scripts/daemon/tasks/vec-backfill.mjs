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

// At startup no row is exempt. During continuation only the current running
// row is exempt, so queued rows and any other running row still block an insert.
export function enqueueVecBackfill(db, { delayMs = 0, now = Date.now(), excludeTaskId = null } = {}) {
  return db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     SELECT 'vec_backfill', '{}', ?, ?, 'queued'
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks
       WHERE type = 'vec_backfill'
         AND (status = 'queued' OR (status = 'running' AND id IS NOT ?))
     )`
  ).run(now + Math.max(0, delayMs), now, excludeTaskId).changes > 0;
}

// A 429 (or any other repeated provider failure) used to queue the next
// continuation for immediately, so an account out of credits retried every few
// seconds forever and wrote one daemon.err.log line per attempt. config_kv is
// where this task's other state already lives (the circuit breaker uses it),
// so the streak and the next attempt ride there rather than in a new table.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
// One line per window, not per failure: the first, then every tenth. A 429
// loop that has settled into the cap stays quiet between these.
const BACKOFF_LOG_EVERY = 10;
const BACKOFF_FAILURES_KEY = 'vec_backfill.consecutive_failures';
const BACKOFF_NEXT_ATTEMPT_KEY = 'vec_backfill.next_attempt_at';

function readBackoffInt(db, key) {
  const raw = db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key)?.value ?? null;
  if (raw == null) {
    return null;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resetBackoff(db) {
  db.prepare(`DELETE FROM config_kv WHERE key IN (?, ?)`).run(BACKOFF_FAILURES_KEY, BACKOFF_NEXT_ATTEMPT_KEY);
}

function recordFailureBackoff(db, now = Date.now()) {
  const failures = (readBackoffInt(db, BACKOFF_FAILURES_KEY) ?? 0) + 1;
  // 2 ** 20 is already far past the cap; clamping the exponent keeps a long
  // outage from turning into Infinity before the cap min() sees it.
  const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** Math.min(failures - 1, 20)));
  const nextAttemptAt = now + delayMs;
  const write = db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  );
  write.run(BACKOFF_FAILURES_KEY, String(failures), now);
  write.run(BACKOFF_NEXT_ATTEMPT_KEY, String(nextAttemptAt), now);

  return {
    failures,
    delayMs,
    nextAttemptAt,
    shouldLog: failures === 1 || failures % BACKOFF_LOG_EVERY === 0
  };
}

/**
 * The backfill's provider call is not the hook's. `openai_timeout_ms` is kept
 * small because embedding also sits on the prompt-submit retrieval path, where a
 * slow provider must fail fast and degrade to lexical. A backfill request carries
 * backfill_batch_size rows at once and cannot fit that budget: on the dogfood
 * store the first batch squeaked through at 894ms and the second died with
 * "Request timed out", which stopped the continuation chain with 4259 rows still
 * pending. Both provider keys are overridden so openai and jina behave alike.
 *
 * Returns a copy — the caller's config is shared with the hot path.
 */
export function backfillEmbeddingConfig(cfg) {
  const timeout = Number(cfg?.embedding?.backfill_timeout_ms ?? 30000);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return cfg;
  }

  return {
    ...cfg,
    embedding: { ...cfg?.embedding, openai_timeout_ms: timeout, api_timeout_ms: timeout }
  };
}

export async function runVecBackfill(db, task = null) {
  const cfg = loadConfig();
  const startedAt = Date.now();
  // The override must reach load() and embed() too, not just getProvider():
  // both recompute their config from loadConfig() when called bare, which puts
  // the hot-path timeout straight back and was why the first version of this fix
  // changed nothing observable.
  const backfillCfg = backfillEmbeddingConfig(cfg);
  const provider = getProvider(backfillCfg);
  const sig = currentEmbeddingSig(provider, cfg);
  // daily_maintenance calls this with ITS OWN task object; only a vec_backfill
  // row is the run's own and must be excluded from the continuation guard.
  const selfTaskId = task?.type === 'vec_backfill' ? task.id ?? null : null;

  function stopWithoutProvider(error = null) {
    const result = { embedded: 0, remaining: pendingEmbeddings(db, sig), duration_ms: 0, why: 'no-provider' };
    writeAudit(db, 'vec_backfill_run', null, error ? { ...result, error } : result);
    return result;
  }

  if (!provider) return stopWithoutProvider();

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
    await provider.load(backfillCfg);
    const vectors = await provider.embed(rows.map((row) => row.content), backfillCfg);
    const update = db.prepare(
      `UPDATE memories
       SET embedding = ?, embedding_sig = ?, updated_at = ?
       WHERE id = ?`
    );

    // IMMEDIATE 与这里的 deferred 等价（事务内第一条语句就是写），显式写出来是为了不必再推一遍。
    db.exec('BEGIN IMMEDIATE');
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

    // A completed batch proves the provider is working, so the next failure is
    // the first of a new streak and gets the short delay again.
    resetBackoff(db);

    const durationMs = Date.now() - startedAt;
    const remaining = pendingEmbeddings(db, sig);
    if (remaining > 0) {
      const chained = enqueueVecBackfill(db, { excludeTaskId: selfTaskId });
      process.stderr.write(`ccmem: vec_backfill embedded ${rows.length}, ${remaining} still pending under signature ${sig} — ${chained ? 'continuation queued' : 'another batch queued or running'}\n`);
    }
    writeAudit(db, 'vec_backfill_run', null, {
      embedded: rows.length,
      remaining,
      duration_ms: durationMs
    });
    return { embedded: rows.length, remaining, duration_ms: durationMs };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200);
    if (error?.code === 'EMBEDDING_CREDENTIALS_MISSING') return stopWithoutProvider(message);
    writeAudit(db, 'vec_backfill_error', null, {
      error: message,
      embedded_before_fail: 0
    });
    // The common failures here are transient — a timeout, a rate limit. Success
    // queues its own continuation; without the same on failure one bad batch ends
    // the chain, `pending` freezes at whatever it was, and the audit row is the
    // only trace: daemon.err.log stays silent, `semantic status` shows a number
    // that simply stops moving, and a single failure is below the circuit
    // breaker's threshold so nothing else notices either.
    //
    // Repeated failures are different: a 429 only repeats as fast as this path
    // reschedules it, so the delay doubles per consecutive failure (30s → 1h)
    // and the stderr line is written once per backoff window, not per attempt.
    const now = Date.now();
    const backoff = recordFailureBackoff(db, now);
    const chained = enqueueVecBackfill(db, { delayMs: backoff.delayMs, now, excludeTaskId: selfTaskId });
    if (backoff.shouldLog) {
      process.stderr.write(
        `ccmem: vec_backfill failed (attempt ${backoff.failures}): ${message} — next attempt in ${Math.round(backoff.delayMs / 1000)}s, ${chained ? 'continuation queued' : 'another batch queued or running'}\n`
      );
    }
    throw error;
  }
}
