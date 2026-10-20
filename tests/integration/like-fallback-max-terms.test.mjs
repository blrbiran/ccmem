import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-like-max-terms-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { retrieveMemories } = await import('../../scripts/lib/retrieval.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');
const { getProvider } = await import('../../scripts/lib/embedding/provider.mjs');
const { currentEmbeddingSig } = await import('../../scripts/lib/embedding/signature.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');

// retrieval.like_fallback.max_terms was a dead key: config said 5, while the
// only call site hard-coded extractShortTokens(prompt, 10). The human ruling
// (2026-10-18, handoff §2.3 item 1) was "wire it, default 10" — i.e. the key
// starts governing the LIKE fallback, and its default is the value the code
// already used, so nobody's retrieval changes.
//
// The prompt below has eleven distinct tokens. Each memory matches exactly one
// of them by substring: 'anchor' the 1st, 'tenth' the 10th, 'eleventh' the
// 11th. Which rows the LIKE lane returns therefore reads off how many prompt
// tokens it used. 'anchor' keeps the candidate set non-empty in every case so
// lexicalRetrieve's legacySubstringSearch rescue (which only fires on an empty
// candidate set and ignores max_terms) can never stand in for the LIKE lane.
const PROMPT = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo';

function seed() {
  const db = openDb();
  db.exec('DELETE FROM memories');
  const now = Date.now();
  const labelById = new Map();
  for (const [label, content] of [
    ['anchor', 'anchor row mentions alpha'],
    ['tenth', 'row mentions juliet'],
    ['eleventh', 'row mentions kilo']
  ]) {
    const result = db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES ('project', 'proj-a', 'fact', ?, 'auto_inferred', 0.5, 'active', 'active', ?, ?, ?)`
    ).run(content, now, now, now);
    labelById.set(Number(result.lastInsertRowid), label);
  }
  return { db, labelById };
}

function configWithLikeFallback(likeFallback) {
  return structuredClone({
    ...DEFAULT_CONFIG,
    retrieval: { ...DEFAULT_CONFIG.retrieval, like_fallback: likeFallback }
  });
}

// Same technique as v014-scope-isolation-retrieval.test.mjs: a cached query
// vector for the exact prompt plus config_kv embedding.enabled puts
// retrieveMemories on path 'A' without any network call. No memory row gets a
// vector, so the cosine lane cannot add rows and only the LIKE lane decides.
function enableEmbeddingPath(db) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(now);
  const config = structuredClone(DEFAULT_CONFIG);
  const sig = currentEmbeddingSig(getProvider(config), config);
  const promptHash = createHash('sha256').update(`${sig}\n${PROMPT}`).digest('hex');
  db.prepare(
    `INSERT INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(prompt_hash) DO UPDATE SET embedding = excluded.embedding, model = excluded.model`
  ).run(promptHash, vecToBlob(new Float32Array([1, 0, 0])), sig, PROMPT.length, now);
}

function disableEmbeddingPath(db) {
  db.exec("DELETE FROM config_kv WHERE key = 'embedding.enabled'");
}

// FTS off forces the LIKE lane to run (useFts false) on both paths; otherwise
// FTS would find all three rows and the LIKE lane would never fire.
async function retrieveLabels(config, path) {
  const { db, labelById } = seed();
  const previous = process.env.CCMEM_DISABLE_FTS5;
  try {
    process.env.CCMEM_DISABLE_FTS5 = '1';
    if (path === 'A') enableEmbeddingPath(db); else disableEmbeddingPath(db);
    const out = await retrieveMemories(db, PROMPT, 'proj-a', config);
    // Pinning the path is what makes each case reach its own call site:
    // lexicalRetrieve (B-off) and retrieveMemories' private copy of the
    // lexical block (A) each call likeSearch separately.
    assert.equal(out.retrievalPath, path);
    return out.rows.map((r) => labelById.get(Number(r.id))).sort();
  } finally {
    if (previous == null) delete process.env.CCMEM_DISABLE_FTS5;
    else process.env.CCMEM_DISABLE_FTS5 = previous;
    db.close();
  }
}

test('the shipped default for like_fallback.max_terms is 10, the value the code always used', () => {
  assert.equal(DEFAULT_CONFIG.retrieval.like_fallback.max_terms, 10);
});

for (const retrievalPath of ['B-off', 'A']) {
  // Zero behaviour change: before the wiring the LIKE lane always took the
  // first 10 prompt tokens. With the shipped defaults it must still reach the
  // 10th token and still stop before the 11th.
  test(`[${retrievalPath}] default config: LIKE fallback uses exactly the first 10 prompt tokens`, async () => {
    const labels = await retrieveLabels(structuredClone(DEFAULT_CONFIG), retrievalPath);
    assert.deepEqual(labels, ['anchor', 'tenth']);
  });

  // A config object whose like_fallback block lacks max_terms (a partial
  // config handed straight to retrieval) must fall back to the same 10.
  test(`[${retrievalPath}] like_fallback without max_terms falls back to 10`, async () => {
    const labels = await retrieveLabels(
      configWithLikeFallback({ enabled: true, trigger_when_fts_below: 3 }),
      retrievalPath
    );
    assert.deepEqual(labels, ['anchor', 'tenth']);
  });

  // The wiring itself: a configured value must actually narrow the lane. If
  // the call site ignores the key (the dead-key state), 'tenth' comes back.
  test(`[${retrievalPath}] like_fallback.max_terms = 2 narrows the LIKE fallback to the first 2 tokens`, async () => {
    const labels = await retrieveLabels(
      configWithLikeFallback({ enabled: true, trigger_when_fts_below: 3, max_terms: 2 }),
      retrievalPath
    );
    assert.deepEqual(labels, ['anchor']);
  });
}
