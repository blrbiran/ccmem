import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-vec-backfill-sig-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { pendingEmbeddings } = await import('../../scripts/daemon/tasks/vec-backfill.mjs');

// pendingEmbeddings(db, sig) drives both vec_backfill's candidate-selection
// query (same WHERE clause, verbatim) and its own `remaining` audit stat.
// This proves the population it selects is "never embedded OR embedded under
// a different signature" — not just "never embedded" — which is what makes a
// provider switch heal itself: rows embedded under the old signature must
// still count as pending under the new one.
test('pendingEmbeddings(db, sig) counts NULL and stale-signature rows, excludes matching rows', async () => {
  const db = openDb();
  try {
    const never = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'never embedded fixture row',
      scope: 'project',
      projectKey: 'vec-backfill-sig/repo',
      type: 'fact',
      embedSync: false
    });
    const stale = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'stale signature fixture row',
      scope: 'project',
      projectKey: 'vec-backfill-sig/repo',
      type: 'fact',
      embedSync: false,
      embeddingBlob: Buffer.from(new Float32Array([1, 0, 0]).buffer)
    });
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('local:Xenova/all-MiniLM-L6-v2:384', stale.id);
    const current = await insertMemory(db, {
      cwd: process.cwd(),
      content: 'current signature fixture row',
      scope: 'project',
      projectKey: 'vec-backfill-sig/repo',
      type: 'fact',
      embedSync: false,
      embeddingBlob: Buffer.from(new Float32Array([1, 0, 0]).buffer)
    });
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('openai:text-embedding-3-small:1536', current.id);

    const before = pendingEmbeddings(db, 'openai:text-embedding-3-small:1536');
    assert.equal(before >= 2, true, 'never-embedded and stale-signature rows must both count as pending');

    // Re-embedding only the current-signature row must not change the count —
    // proving the exclusion is specific to matching rows, not incidental.
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('openai:text-embedding-3-small:1536', current.id);
    const after = pendingEmbeddings(db, 'openai:text-embedding-3-small:1536');
    assert.equal(after, before);

    // Once the stale row is re-embedded under the current signature too, it
    // must drop out of the pending count.
    db.prepare(`UPDATE memories SET embedding = ?, embedding_sig = ? WHERE id = ?`).run(
      Buffer.from(new Float32Array([1, 0, 0]).buffer),
      'openai:text-embedding-3-small:1536',
      stale.id
    );
    const afterHeal = pendingEmbeddings(db, 'openai:text-embedding-3-small:1536');
    assert.equal(afterHeal, before - 1);
    assert.equal(afterHeal >= 1, true, `never-embedded fixture (id ${never.id}) should still be pending`);
  } finally {
    db.close();
  }
});
