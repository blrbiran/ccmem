import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-w2-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { ftsSearch, likeSearch, legacySubstringSearch, retrieveMemories } = await import('../../scripts/lib/retrieval.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');
const { getProvider } = await import('../../scripts/lib/embedding/provider.mjs');
const { currentEmbeddingSig } = await import('../../scripts/lib/embedding/signature.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');

// eval.disable_scope_isolation lets the eval harness build a true control
// group: with the switch on, retrieval must cross project boundaries; with
// it off (the default), it must not. seed() plants one memory per scope
// (own project, other project, global), all sharing the word "zebrafish" so
// every lane — FTS, LIKE, and the legacy substring fallback — can match all
// three rows if isolation is not applied.
//
// `memories.id` is an autoincrement INTEGER PK, not a label, so seed()
// returns a db plus a rowid -> label map; tests translate returned rows
// back to labels before asserting, keeping the assertions readable as
// 'own' / 'other' / 'glob' per the brief.
function seed() {
  const db = openDb();
  // openDb() opens the on-disk db file at CCMEM_DATA_ROOT; it is not a fresh
  // in-memory db per call. Without this, rows from an earlier test in this
  // file would still be present and inflate later assertions' result sets.
  db.exec('DELETE FROM memories');
  const now = Date.now();
  const rows = [
    ['own', 'project', 'proj-a'],
    ['other', 'project', 'proj-b'],
    ['glob', 'global', null]
  ];

  const labelById = new Map();
  for (const [label, scope, projectKey] of rows) {
    const result = db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES (?, ?, 'fact', ?, 'auto_inferred', 0.5, 'active', 'active', ?, ?, ?)`
    ).run(scope, projectKey, `a note about zebrafish for ${label}`, now, now, now);
    labelById.set(Number(result.lastInsertRowid), label);
  }

  return { db, labelById };
}

// WHY: 这三条 lane 各自独立地拼 SQL，历史上 review 已经在其中一条上抓到过
// "改完了但不起作用"。逐条直调 helper，是为了让某一条漏改时，红的是那一条，
// 而不是被另外两条的绿色盖过去。
for (const [name, call] of [
  ['ftsSearch', (db, off) => ftsSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['likeSearch', (db, off) => likeSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['legacySubstringSearch', (db, off) => legacySubstringSearch(db, 'zebrafish', 'proj-a', 50, off)]
]) {
  test(`${name} isolates by project when the switch is off`, () => {
    const { db, labelById } = seed();
    try {
      const labels = call(db, false).map((r) => labelById.get(Number(r.id))).sort();
      assert.deepEqual(labels, ['glob', 'own']);
    } finally {
      db.close();
    }
  });

  test(`${name} crosses projects when the switch is on`, () => {
    const { db, labelById } = seed();
    try {
      const labels = call(db, true).map((r) => labelById.get(Number(r.id))).sort();
      assert.deepEqual(labels, ['glob', 'other', 'own']);
    } finally {
      db.close();
    }
  });
}

// configWith per the plan: only the `eval` section is overridden here.
// Embedding is turned on for the retrievalPath === 'A' fixture below via a
// config_kv row instead (see seedEmbeddings) — resolveEnabled() in
// provider.mjs checks config_kv before the config object, so this reaches
// the embedding path without CCMEM_CONFIG_PATH or a second config shape.
function configWith(evalOverrides) {
  return structuredClone({ ...DEFAULT_CONFIG, eval: { ...DEFAULT_CONFIG.eval, ...evalOverrides } });
}

// WHY: retrieveMemories only takes the embedding path (retrievalPath 'A')
// when useEmbedding is true, and it only gets there without a real network
// call when a cached query vector already exists for the current sig. This
// mirrors the precedent at prompt-submit-retrieval.test.mjs:311-383: seed
// query_embedding_cache directly so provider.load() is never even attempted.
// embedding.enabled is forced on via config_kv (not the config object) per
// resolveEnabled()'s precedence — configWith() deliberately never touches
// `embedding`, so this is the only thing that turns the embedding path on.
//
// Deliberately does NOT give any memory row an embedding: with only 3 rows
// seeded, every embedded row lands inside the vector lane's top (limit * 2)
// cut regardless of similarity, so if 'other' had a vector too the cosine
// lane would silently rescue it whenever a lexical wire site was broken —
// masking exactly the bug this file exists to catch. Row-level embeddings
// are added per-test only where the vector lane itself is under test (see
// 'vector candidate query crosses projects when the switch is on' below).
function seedEmbeddings(db) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(now);

  const config = configWith({});
  const provider = getProvider(config);
  const sig = currentEmbeddingSig(provider, config);
  const vec = vecToBlob(new Float32Array([1, 0, 0]));

  const prompt = 'zebrafish';
  const promptHash = createHash('sha256').update(`${sig}\n${prompt}`).digest('hex');
  // ON CONFLICT, not plain INSERT: sig+prompt are identical across every test
  // in this file, and openDb() shares one on-disk db for the whole run — a
  // plain INSERT collides with the row a prior test already wrote.
  db.prepare(
    `INSERT INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(prompt_hash) DO UPDATE SET embedding = excluded.embedding, model = excluded.model`
  ).run(promptHash, vec, sig, prompt.length, now);

  return sig;
}

// WHY: retrieveMemories' like_fallback triggers whenever ftsRows is smaller
// than trigger_when_fts_below (3 by default). With only own+glob (2 rows)
// visible under isolation, stripping disableScopeIsolation from just the
// ftsSearch call (Step 7's mutation) drops ftsRows to 2, which is BELOW that
// trigger — the (still correctly wired) likeSearch fallback then fires and
// silently re-admits 'other' through a different lane, masking the exact bug
// this file exists to catch. Adding one more own-scope zebrafish row keeps
// the isolated FTS count at 3 (at, not below, the trigger) whether or not
// 'other' is present, so likeSearch never fires and only ftsSearch's own
// scope handling decides whether 'other' is visible.
function seedFtsDistractor(db, projectKey) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES ('project', ?, 'fact', 'a distractor note about zebrafish', 'auto_inferred', 0.5,
             'active', 'active', ?, ?, ?)`
  ).run(projectKey, now, now, now);
}

// WHY: retrieveMemories copies the lexical block for itself when embedding is
// available — it does NOT call lexicalRetrieve in that path. That is exactly
// the path the eval harness runs. Not pinning retrievalPath === 'A' would let
// a test that only wires lexicalRetrieve fall back into the (correctly wired,
// but irrelevant) lexical path and pass anyway. This assertion exists solely
// to make that failure mode loud.
test('end-to-end crosses projects on the embedding path', async () => {
  const { db, labelById } = seed();
  try {
    seedFtsDistractor(db, 'proj-a');
    seedEmbeddings(db);
    const config = configWith({ disable_scope_isolation: true });
    const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
    assert.equal(out.retrievalPath, 'A', 'must exercise the embedding path, not the lexical fallback');
    const labels = out.rows.map((r) => labelById.get(Number(r.id)));
    assert.ok(labels.includes('other'), 'proj-b memory must be visible');
  } finally {
    db.close();
  }
});

test('end-to-end isolates on the embedding path when the switch is off', async () => {
  const { db, labelById } = seed();
  try {
    seedFtsDistractor(db, 'proj-a');
    seedEmbeddings(db);
    const config = configWith({ disable_scope_isolation: false });
    const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
    assert.equal(out.retrievalPath, 'A');
    const labels = out.rows.map((r) => labelById.get(Number(r.id)));
    assert.ok(!labels.includes('other'), 'proj-b memory must NOT be visible');
  } finally {
    db.close();
  }
});

// WHY: the vector candidate query (allVecs) is not one of the three lexical
// helpers — Task 2's six assertions never touch it, and the end-to-end tests
// above deliberately keep 'other' out of the vector lane. This test gives
// 'other' content that shares no tokens with the query ("zebrafish"), so
// none of the three lexical lanes can find it — the only way it can appear
// in `rows` is via the cosine candidate query (allVecs) — isolating exactly
// the site the brief's anchor table calls out separately from the three
// helpers. Mirrors the disjoint-content pattern at
// prompt-submit-retrieval.test.mjs:311-383.
test('vector candidate query crosses projects when the switch is on', async () => {
  const { db, labelById } = seed();
  try {
    const otherId = [...labelById.entries()].find(([, label]) => label === 'other')[0];
    db.prepare(`UPDATE memories SET content = ? WHERE id = ?`)
      .run('completely unrelated elephant migration notes', otherId);

    const sig = seedEmbeddings(db);
    const vec = vecToBlob(new Float32Array([1, 0, 0]));
    db.prepare(`UPDATE memories SET embedding = ?, embedding_sig = ? WHERE id = ?`).run(vec, sig, otherId);

    const config = configWith({ disable_scope_isolation: true });
    const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
    assert.equal(out.retrievalPath, 'A');
    const labels = out.rows.map((r) => labelById.get(Number(r.id)));
    assert.ok(labels.includes('other'), 'proj-b memory must be visible via the vector lane alone');
  } finally {
    db.close();
  }
});

// WHY: retrieveMemories' own likeSearch call (wire site 3) is design §4.2
// table B row 5 — named alongside ftsSearch (row 4) as the two deadliest
// missed sites, and criterion 3 (retrievalPath === 'A') exists specifically
// so neither row's omission is structurally invisible. Task 2's unit test
// calls the exported likeSearch directly, which cannot detect a dropped 5th
// argument at retrieveMemories' own call site. Forcing useFts = false (via
// CCMEM_DISABLE_FTS5) means ftsSearch (site 2) never runs at all, so it
// cannot mask a broken site 3 the way the like_fallback trigger masked a
// broken site 2 in Step 7 — and with no embedding on 'other', the vector
// lane (site 4) cannot rescue it either. likeSearch is the only lane left
// standing.
test('likeSearch fallback crosses projects when the switch is on', async () => {
  const { db, labelById } = seed();
  const previousDisableFts = process.env.CCMEM_DISABLE_FTS5;
  try {
    seedEmbeddings(db);
    process.env.CCMEM_DISABLE_FTS5 = '1';
    const config = configWith({ disable_scope_isolation: true });
    const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
    assert.equal(out.retrievalPath, 'A');
    const labels = out.rows.map((r) => labelById.get(Number(r.id)));
    assert.ok(labels.includes('other'), 'proj-b memory must be visible via the likeSearch lane alone');
  } finally {
    if (previousDisableFts == null) {
      delete process.env.CCMEM_DISABLE_FTS5;
    } else {
      process.env.CCMEM_DISABLE_FTS5 = previousDisableFts;
    }
    db.close();
  }
});
