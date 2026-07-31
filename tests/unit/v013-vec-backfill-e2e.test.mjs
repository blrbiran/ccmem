import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-vec-backfill-e2e-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { runVecBackfill } = await import('../../scripts/daemon/tasks/vec-backfill.mjs');
const { getProvider } = await import('../../scripts/lib/embedding/provider.mjs');
const { currentEmbeddingSig } = await import('../../scripts/lib/embedding/signature.mjs');
const { loadConfig } = await import('../../scripts/lib/config.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');

// This file gets its own isolated CCMEM_DATA_ROOT (not shared with
// v013-vec-backfill-sig.test.mjs) so runVecBackfill's real candidate query —
// which has no project/scope filter — can't pick up fixture rows planted by
// unrelated tests and throw off exact counts here.

function bufEqual(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// transformers-local.mjs ships a deterministic stub extractor under
// CCMEM_TEST_MODE=1 (no network, no real model load), so runVecBackfill can
// be driven end to end instead of only exercising its shared SQL predicate.
test('runVecBackfill re-embeds never-embedded and stale-signature rows, and leaves current-signature rows untouched', async () => {
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)`
    ).run(Date.now());

    const cfg = loadConfig();
    const currentSig = currentEmbeddingSig(getProvider(cfg), cfg);
    assert.equal(currentSig, 'transformers-local:Xenova/all-MiniLM-L6-v2:384');

    const neverEmbedded = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'e2e vec backfill never embedded fixture',
      scope: 'project',
      projectKey: 'vec-backfill-e2e/repo',
      type: 'fact',
      embedSync: false
    });

    const staleVector = vecToBlob(new Float32Array(384).fill(0.01));
    const stale = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'e2e vec backfill stale signature fixture',
      scope: 'project',
      projectKey: 'vec-backfill-e2e/repo',
      type: 'fact',
      embedSync: false,
      embeddingBlob: staleVector
    });
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('openai:text-embedding-3-small:1536', stale.id);

    const currentVector = vecToBlob(new Float32Array(384).fill(0.02));
    const current = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'e2e vec backfill already-current signature fixture',
      scope: 'project',
      projectKey: 'vec-backfill-e2e/repo',
      type: 'fact',
      embedSync: false,
      embeddingBlob: currentVector
    });
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run(currentSig, current.id);

    const result = await runVecBackfill(db);

    assert.equal(result.embedded, 2, 'only the never-embedded and stale-signature rows should be re-embedded');
    assert.equal(result.remaining, 0);

    const rows = db.prepare(
      `SELECT id, embedding, embedding_sig FROM memories WHERE id IN (?, ?, ?)`
    ).all(neverEmbedded.id, stale.id, current.id);
    const byId = new Map(rows.map((row) => [row.id, row]));

    assert.equal(byId.get(neverEmbedded.id).embedding_sig, currentSig);
    assert.ok(byId.get(neverEmbedded.id).embedding, 'never-embedded row must now have a vector');

    assert.equal(byId.get(stale.id).embedding_sig, currentSig, 'stale row must be re-tagged with the current signature');
    assert.equal(
      bufEqual(byId.get(stale.id).embedding, staleVector),
      false,
      'stale row must be re-embedded (new vector), not merely re-tagged with the old vector'
    );

    // The already-current row is the discriminator: if the candidate query's
    // signature predicate were dropped, this row would be re-embedded too and
    // this assertion would fail even though the other two still pass.
    assert.equal(byId.get(current.id).embedding_sig, currentSig);
    assert.equal(
      bufEqual(byId.get(current.id).embedding, currentVector),
      true,
      'already-current row must be left byte-identical — the candidate query must exclude it'
    );
  } finally {
    db.close();
  }
});

// I3 regression. Migration 016 leaves every pre-existing row with
// embedding_sig IS NULL, and retrieval.mjs now excludes those from the cosine
// lane. runVecBackfill processes ONE backfill_batch_size batch per invocation
// and was enqueued only at daemon startup — a 4,494-memory store needed ~90
// daemon restarts before semantic retrieval came back. A stderr line from a
// background daemon is not a channel users read, and "semantic retrieval is off
// for weeks after upgrading" is exactly the silent degradation this release
// exists to prevent. So a partial run must queue its own continuation.
test('a partial vec_backfill run queues its own continuation, and does not pile up duplicates', async () => {
  const db = openDb();
  try {
    db.prepare(
      `INSERT OR REPLACE INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)`
    ).run(Date.now());
    db.prepare(`DELETE FROM tasks WHERE type = 'vec_backfill'`).run();

    // batch_size defaults to 50; seed more than one batch so remaining > 0.
    for (let i = 0; i < 55; i += 1) {
      await insertMemory(db, {
        cwd: process.cwd(),
        content: `i3 continuation fixture number ${i} with enough words to store`,
        scope: 'project',
        projectKey: 'vec-backfill-i3/repo',
        type: 'fact',
        embedSync: false
      });
    }

    const first = await runVecBackfill(db);
    assert.ok(first.remaining > 0, 'fixture sanity: one batch must not finish the store');

    const queued = () => Number(db.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE type = 'vec_backfill' AND status = 'queued'`
    ).get().n);
    assert.equal(queued(), 1,
      'a partial run must enqueue its own continuation — otherwise the store stays half-stale until the next daemon start');

    // Running again while that continuation is still queued must not add a
    // second one: the queue would grow by one task per batch.
    const second = await runVecBackfill(db);
    assert.equal(queued(), 1, 'the queued/running guard must keep this idempotent');

    // Drain to completion, then confirm the chain stops instead of self-feeding
    // forever once there is nothing left to embed.
    let guard = 0;
    let last = second;
    while (last.remaining > 0 && guard < 10) {
      last = await runVecBackfill(db);
      guard += 1;
    }
    assert.equal(last.remaining, 0, 'fixture sanity: the store must finish draining');

    db.prepare(`DELETE FROM tasks WHERE type = 'vec_backfill'`).run();
    await runVecBackfill(db);
    assert.equal(queued(), 0, 'a run with nothing left to do must NOT enqueue another — that would spin forever');
  } finally {
    db.close();
  }
});
