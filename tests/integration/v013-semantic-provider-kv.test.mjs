import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-semprov-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminSemantic } = await import('../../scripts/lib/admin/semantic.mjs');
const { getProvider, _resetProviderCache } = await import('../../scripts/lib/embedding/provider.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function readProviderKv(db) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.active_provider'`).get()?.value ?? null;
}

function setProviderKv(db, value) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.active_provider', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(value, Date.now());
}

// Finding 6 (dogfood). `admin semantic on` used to write `embedding.active_provider`
// into config_kv UNCONDITIONALLY. Because resolveProviderName (provider.mjs:69-79)
// reads config_kv BEFORE the config file, one `semantic on` permanently shadowed
// the file's `embedding.provider`, with no command able to clear it: an operator
// who declared `"provider": "openai"` in config.json and restarted the daemon kept
// getting transformers-local forever, with no signal explaining why.
//
// `semantic on` WITHOUT --provider means "enable whatever the config file declares",
// so it must clear the override rather than re-pin it.
test('semantic on without --provider clears the config_kv provider override', async () => {
  const db = openDb();
  setProviderKv(db, 'jina');
  assert.equal(readProviderKv(db), 'jina', 'precondition: kv override is set');

  await cmdAdminSemantic(db, { verb: 'on' });

  assert.equal(
    readProviderKv(db),
    null,
    'embedding.active_provider must be DELETED so the config file regains authority'
  );

  // The user-facing outcome: the file-declared provider now actually resolves.
  _resetProviderCache();
  const provider = getProvider({ embedding: { enabled: true, provider: 'transformers-local' } });
  assert.equal(provider.modelId, 'Xenova/all-MiniLM-L6-v2', 'file-declared provider must win once the kv row is gone');
});

// CONTROL against over-correction: the fix must not turn into "always delete".
// An explicit --provider is a deliberate runtime override and must still persist.
// This test passes both before and after the fix by design — it exists to catch a
// wrong fix, not to prove the right one.
test('semantic on --provider still writes the explicit override to config_kv', async () => {
  const db = openDb();
  db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.active_provider'`).run();

  await cmdAdminSemantic(db, { verb: 'on', provider: 'transformers-local' });

  assert.equal(
    readProviderKv(db),
    'transformers-local',
    'an explicitly requested provider must be persisted as a runtime override'
  );
});

// The command computed `providerName` from the config file but let getProvider
// resolve the provider independently — and getProvider reads config_kv first.
// With a stale kv row the two disagreed: the command loaded (and reported) one
// provider while recording another.
test('the loaded provider matches the provider the command reports', async () => {
  const db = openDb();
  setProviderKv(db, 'jina');

  const result = await cmdAdminSemantic(db, { verb: 'on' });

  assert.equal(result.provider, 'transformers-local', 'reported provider comes from the config file');
  assert.equal(result.model, 'Xenova/all-MiniLM-L6-v2', 'and the model reported is the one actually loaded');
});

// Finding 9 follow-up. `semantic on` carried a second, overlapping model-change
// detector: it compared the freshly loaded model against an `embedding.active_model`
// row and, on any difference, ran `UPDATE memories SET embedding = NULL` across the
// whole store. The signature mechanism (v0.13 B1) already handles a model change
// correctly and non-destructively — vec_backfill re-embeds rows whose signature no
// longer matches — so the detector only added a way to lose data.
//
// The Finding 6 fix made it reachable by accident: it deletes `active_provider` but
// left `active_model` behind, so the two keys came from different layers. A store
// carrying `active_model = text-embedding-3-small` from an OpenAI run would have
// every vector wiped by one bare `semantic on` in a shell that resolves to the
// local provider.
test('semantic on preserves existing vectors when the recorded model differs', async () => {
  const db = openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at,
      embedding, embedding_sig
    ) VALUES ('project', 'demo/repo', 'fact', 'vector must survive semantic on', 0, 'user_explicit', 0.5,
      'active', 0, 0, ?, ?, ?, ?, 'transformers-local:Xenova/all-MiniLM-L6-v2:384')`
  ).run(now, now, now, Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer));

  // Residue from a previous OpenAI run: a model name the local provider will never match.
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.active_model', 'text-embedding-3-small', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(Date.now());

  await cmdAdminSemantic(db, { verb: 'on' });

  const row = db.prepare(
    `SELECT embedding, embedding_sig FROM memories WHERE content = 'vector must survive semantic on'`
  ).get();
  assert.notEqual(row.embedding, null, 'enabling semantic search must never destroy stored vectors');
  assert.equal(
    row.embedding_sig,
    'transformers-local:Xenova/all-MiniLM-L6-v2:384',
    'the signature stays intact; vec_backfill re-embeds by signature mismatch, not by mass deletion'
  );
});
