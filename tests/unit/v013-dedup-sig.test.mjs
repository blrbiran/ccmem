import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-dedup-sig-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { dedupCheck } = await import('../../scripts/lib/dedup.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');

const CFG = {
  dedup: {
    enabled: true,
    window_days: 30,
    fts_candidate_limit: 20,
    jaccard_threshold: 0.3,
    trigram_size: 3,
    cosine_threshold: 0.85
  },
  embedding: {
    enabled: true,
    provider: 'openai',
    openai_model: 'text-embedding-3-small',
    openai_dim: 1536
  }
};

// Candidate content is deliberately lexically disjoint from the new content
// (near-zero trigram overlap) so a `duplicate: true` result can only come
// from the cosine lane — isolating exactly the behavior this fix changes.
const NEW_CONTENT = 'zzqx flarnorb query fixture distinctive alpha';
const CANDIDATE_CONTENT = 'wibblejolt henooo blipzork totally separate beta';

test('dedupCheck flags a cosine duplicate when the candidate embedding_sig matches the current provider', async () => {
  const db = openDb();
  try {
    const vec = new Float32Array(1536).fill(0.02);
    const existing = await insertMemory(db, {
      cwd: process.cwd(),
      content: CANDIDATE_CONTENT,
      scope: 'project',
      projectKey: 'dedup-sig/repo',
      type: 'fact',
      embedSync: false,
      embeddingBlob: vecToBlob(vec)
    });
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('openai:text-embedding-3-small:1536', existing.id);

    const result = dedupCheck(db, {
      content: NEW_CONTENT,
      scope: 'project',
      projectKey: 'dedup-sig/repo',
      contentVec: vec
    }, CFG);

    assert.equal(result.duplicate, true);
    assert.equal(result.lane, 'cosine');
    assert.equal(result.existingId, existing.id);
  } finally {
    db.close();
  }
});

test('dedupCheck does not flag a cosine duplicate when the candidate embedding_sig is stale', async () => {
  const db = openDb();
  try {
    // Distinct project key from the test above — dedupCheck's candidate query
    // is scoped by project_key, and reusing the same key would let the other
    // test's matching-signature fixture leak in as a second candidate here.
    const projectKey = 'dedup-sig-stale/repo';
    const vec = new Float32Array(1536).fill(0.02);
    const existing = await insertMemory(db, {
      cwd: process.cwd(),
      content: CANDIDATE_CONTENT,
      scope: 'project',
      projectKey,
      type: 'fact',
      embedSync: false,
      embeddingBlob: vecToBlob(vec)
    });
    // Same vector as the positive-control test above, but tagged with a
    // signature from a different provider/model/dim — same-dimension model
    // switches are exactly the case the brief calls "worse" than a length
    // mismatch, because the cosine score still comes out plausible.
    db.prepare(`UPDATE memories SET embedding_sig = ? WHERE id = ?`).run('local:Xenova/all-MiniLM-L6-v2:384', existing.id);

    const result = dedupCheck(db, {
      content: NEW_CONTENT,
      scope: 'project',
      projectKey,
      contentVec: vec
    }, CFG);

    assert.equal(result.duplicate, false, 'a stale-signature candidate must not suppress a genuinely new memory via cosine');
  } finally {
    db.close();
  }
});
