import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-l1sig-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');
const { inferPositiveFeedback } = await import('../../scripts/lib/feedback.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const CURRENT_SIG = 'transformers-local:Xenova/all-MiniLM-L6-v2:4';
const STALE_SIG = 'openai:text-embedding-3-small:4';

const QUERY = new Float32Array([1, 0, 0, 0]);
const MATCHES_QUERY = new Float32Array([1, 0, 0, 0]);   // cosine 1.0
const ORTHOGONAL = new Float32Array([0, 1, 0, 0]);      // cosine 0.0

function seedMemory(db, id, sig, vec) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, scope, project_key, type, content, source, trust_score,
                           status, decay_status, embedding, embedding_sig,
                           created_at, updated_at, last_touched_at)
     VALUES (?, 'global', NULL, 'rule', ?, 'auto_inferred', 0.5,
             'active', 'active', ?, ?, ?, ?, ?)`
  ).run(id, `memory ${id} under signature ${sig}`, vecToBlob(vec), sig, now, now, now);
}

function seedFeedback(db, sessionId, injectedIds) {
  db.prepare(
    `INSERT INTO memory_feedback (session_id, injection_source, injected_ids, outcome, outcome_locked, recorded_at)
     VALUES (?, 'user_prompt_submit', ?, 'unknown', 0, ?)`
  ).run(sessionId, JSON.stringify(injectedIds), Date.now());
}

function state(db, ids) {
  return {
    trust: ids.map((id) => db.prepare(`SELECT trust_score FROM memories WHERE id = ?`).get(id).trust_score),
    outcomes: db.prepare(`SELECT outcome FROM memory_feedback ORDER BY id`).all().map((r) => r.outcome)
  };
}

// I2 regression. This is the last signature-blind cosine consumer and the only
// one that MUTATES TRUST — it is on the UserPromptSubmit hook path and calls
// applyOutcomeToSubset('helpful_implicit'). After a provider or model switch,
// stored vectors from the old space are not comparable to a fresh query vector;
// cosining them anyway means trust is applied to an arbitrary memory. v0.13
// changes no trust RULES, but leaving a known-corrupt INPUT to those rules is a
// different thing.
test('a stale-signature vector can never win the L1-positive cosine, however well it scores', () => {
  const db = openDb();
  const SESSION = 'sess-l1-stale';
  // The stale memory is a PERFECT match; the current-signature one is
  // orthogonal. Signature-blind, the stale memory wins at cosine 1.0 and takes
  // the trust boost. Signature-aware, it is not even a candidate.
  seedMemory(db, 901, CURRENT_SIG, ORTHOGONAL);
  seedMemory(db, 902, STALE_SIG, MATCHES_QUERY);
  seedFeedback(db, SESSION, [901, 902]);

  const before = state(db, [901, 902]);
  inferPositiveFeedback(db, SESSION, 'yes exactly', QUERY, CURRENT_SIG);
  const after = state(db, [901, 902]);

  assert.deepEqual(after, before,
    'no trust may move: the only high-cosine candidate was measured in an incomparable embedding space');
});

// Guards the fix against the degenerate "filter everything out" implementation:
// a predicate that always excludes would also make the test above pass.
test('a current-signature vector above the threshold still earns helpful_implicit', () => {
  const db = openDb();
  const SESSION = 'sess-l1-current';
  seedMemory(db, 911, CURRENT_SIG, MATCHES_QUERY);
  seedFeedback(db, SESSION, [911]);

  const trustBefore = db.prepare(`SELECT trust_score FROM memories WHERE id = 911`).get().trust_score;
  inferPositiveFeedback(db, SESSION, 'yes exactly', QUERY, CURRENT_SIG);

  assert.ok(
    db.prepare(`SELECT trust_score FROM memories WHERE id = 911`).get().trust_score > trustBefore,
    'the signature filter must not disable the feature it protects'
  );
  assert.match(
    db.prepare(`SELECT outcome FROM memory_feedback WHERE session_id = ?`).get(SESSION).outcome,
    /helpful_implicit/
  );
});

test('L1-positive is skipped entirely when no embedding signature is available', () => {
  const db = openDb();
  const SESSION = 'sess-l1-nosig';
  seedMemory(db, 921, CURRENT_SIG, MATCHES_QUERY);
  seedFeedback(db, SESSION, [921]);

  const before = state(db, [921]);
  inferPositiveFeedback(db, SESSION, 'yes exactly', QUERY, null);

  assert.deepEqual(state(db, [921]), before,
    'without a signature there is no way to know which vectors are comparable — do not guess, and do not write trust');
});
