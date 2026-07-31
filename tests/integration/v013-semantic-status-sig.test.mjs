import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-semstatus-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');
const { cmdAdminSemantic } = await import('../../scripts/lib/admin/semantic.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

// I4 regression. `admin semantic status` maintained a FOURTH, signature-blind
// definition of "pending" (`WHERE embedding IS NULL`). After migration 016 an
// operator saw `diagnose --retrieval` report thousands of stale vectors while
// `semantic status` reported pending: 0 on the same store — two ccmem commands
// contradicting each other during exactly the incident the embedding signature
// exists to make legible.
test('admin semantic status counts stale-signature rows as pending, agreeing with diagnose --retrieval', async () => {
  const db = openDb();
  const now = Date.now();

  db.prepare(
    `INSERT OR REPLACE INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)`
  ).run(now);

  // A fully embedded store — every row HAS a vector, so the old NULL-only count
  // reports 0 — but every vector was produced by a superseded provider.
  const stale = vecToBlob(new Float32Array(384).fill(0.01));
  for (let i = 1; i <= 3; i += 1) {
    db.prepare(
      `INSERT INTO memories (id, scope, project_key, type, content, source, trust_score,
                             status, decay_status, embedding, embedding_sig,
                             created_at, updated_at, last_touched_at)
       VALUES (?, 'global', NULL, 'fact', ?, 'auto_inferred', 0.5, 'active', 'active', ?, ?, ?, ?, ?)`
    ).run(i, `stale-signature memory number ${i}`, stale, 'openai:text-embedding-3-small:1536', now, now, now);
  }

  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL`).get().n, 0,
    'fixture sanity: nothing is NULL, so a signature-blind count would say "pending: 0"'
  );

  const status = await cmdAdminSemantic(db, { verb: 'status' });
  const diagnose = await cmdAdminDiagnose(db, { cwd: process.cwd(), retrieval: true });

  assert.equal(status.pending, 3,
    'a fully embedded but entirely stale store has 3 rows vec_backfill will still touch');
  assert.equal(status.pending, diagnose.retrieval.stale_vectors,
    'the two commands must not contradict each other about the same store');
});
