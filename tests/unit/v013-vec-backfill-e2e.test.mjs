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
