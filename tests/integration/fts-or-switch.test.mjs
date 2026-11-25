import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Design: docs/superpowers/specs/2026-11-25-fts-or-relevance-gate-design.md. The FTS query was an implicit AND,
// so a natural-language prompt almost never matched and the lexical weight was dead; the relevance gate was cosine
// only. `retrieval.fts.mode: "or"` matches any discriminative prompt word and lets lexical evidence (distinct prompt
// words a row holds) keep a row the cosine floor would drop. Human ruling 2026-11-25: behind a switch, default
// stays "and" — so the first criterion pins the default path to the bytes it produced before the switch existed.
const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, '../fixtures/fts-default-and-golden.json');

const root = mkdtempSync(path.join(tmpdir(), 'ccmem-fts-or-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = root;
const configPath = path.join(root, 'config.json');
process.env.CCMEM_CONFIG_PATH = configPath;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { vecToBlob } = await import('../../scripts/lib/embedding/cosine.mjs');
const { getProvider } = await import('../../scripts/lib/embedding/provider.mjs');
const { currentEmbeddingSig } = await import('../../scripts/lib/embedding/signature.mjs');
const { loadConfig } = await import('../../scripts/lib/config.mjs');
const { retrieveMemories } = await import('../../scripts/lib/retrieval.mjs');

const PROJECT = 'fts-or/repo';
const embeddingA = { enabled: true, provider: 'openai', openai_api_key: 'test-key', openai_base_url: 'http://127.0.0.1:1', openai_model: 'text-embedding-3-small' };
const writeConfig = (cfg) => writeFileSync(configPath, JSON.stringify(cfg));

writeConfig({ embedding: embeddingA });
const SIG = currentEmbeddingSig(getProvider(loadConfig()), loadConfig());

// Unit vectors at a known cosine to the query vector [1, 0, 0].
const atCosine = (c) => new Float32Array([c, Math.sqrt(1 - (c * c)), 0]);
const FIXTURES = [
  ['The prompt cache TTL is five minutes for every hook invocation.', 0.9],
  ['Daemon restart requires reading the plist environment before admin daemon restart.', 0.55],
  ['Use sqlite backup to copy the database before any migration test.', 0.5],
  ['Always run the full test suite before tagging a release build.', 0.3],
  ['Retrieval gate drops rows below the cosine floor of the embedding model.', 0.65],
  ['记忆检索使用三元组分词，中文整句不命中。', 0.2],
  ['This is the thing that is in the place for the time and of the day.', 0.1],
  ['Quokka marmalade recipe needs zebra stripes and walrus butter.', 0.45]
];
const ids = [];
{
  const db = openDb();
  for (const [index, [content, cos]] of FIXTURES.entries()) {
    const row = await insertMemory(db, {
      cwd: root, projectKey: PROJECT, content, scope: 'global', type: 'fact', embedSync: false,
      embeddingBlob: vecToBlob(atCosine(cos)), lastTouchedAt: 1_700_000_000_000 + (index * 1000)
    });
    ids.push(row.id);
  }
  db.close();
}

const PROMPTS = [
  'how long is the prompt cache TTL for hooks',
  'what should I do before a daemon restart and reading the plist',
  'copy the database with sqlite backup before running migration tests and release tagging checks today',
  'unrelated question about cooking pasta tonight',
  'C++',
  '记忆检索',
  'the and of to in'
];

function seedQueryCache(prompt) {
  const db = openDb();
  db.prepare(`INSERT OR REPLACE INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(createHash('sha256').update(`${SIG}\n${prompt}`).digest('hex'), vecToBlob(new Float32Array([1, 0, 0])), SIG, prompt.length, Date.now());
  db.close();
}
for (const prompt of PROMPTS) seedQueryCache(prompt);

async function retrieve(prompt, cfg, options = {}) {
  writeConfig(cfg);
  const db = openDb();
  try {
    return await retrieveMemories(db, prompt, PROJECT, loadConfig(), options);
  } finally {
    db.close();
  }
}

// Everything a caller sees except wall-clock timing.
const observable = (out) => JSON.stringify({ rows: out.rows, total: out.total, gated: out.gated, retrievalPath: out.retrievalPath });

async function defaultSnapshot(extra) {
  const snap = [];
  for (const [label, cfg] of [['lexical', { embedding: { enabled: false } }], ['embedded', { embedding: embeddingA, retrieval: { min_cosine_by_signature: { [SIG]: 0.6 } } }]]) {
    for (const prompt of PROMPTS) {
      for (const relevanceFloor of [false, true]) {
        const merged = { ...cfg, retrieval: { ...(cfg.retrieval ?? {}), ...extra } };
        snap.push([label, prompt, relevanceFloor, observable(await retrieve(prompt, merged, { relevanceFloor }))]);
      }
    }
  }
  return snap;
}

test('default (no fts key) and explicit "and" return exactly what the code returned before the switch existed', async () => {
  const before = await defaultSnapshot({});
  if (process.env.CCMEM_WRITE_FTS_GOLDEN === '1') {
    // Generated once on the pre-switch commit (5ea8c80); never regenerate on the branch that changes retrieval.
    writeFileSync(GOLDEN, `${JSON.stringify(before, null, 1)}\n`);
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(before, golden, 'default path moved');
  assert.deepEqual(await defaultSnapshot({ fts: { mode: 'and' } }), golden, 'explicit and moved');
});

const LEX_OR = (extra = {}) => ({ embedding: { enabled: false }, retrieval: { like_fallback: { enabled: false }, fts: { mode: 'or' }, ...extra } });

test('criterion 1: a memory holding 3 words of a 12-word prompt is an FTS candidate in or mode', async () => {
  const prompt = 'please tell me whether quokka marmalade with zebra is something we discussed last week';
  const out = await retrieve(prompt, LEX_OR());
  const hit = out.rows.find((row) => row.id === ids[7]);
  assert.ok(hit, 'the 3-word row is returned');
  assert.ok(hit.score.fts > 0, 'and it came from FTS, not the substring rescue');
});

test('criterion 2: a stop-word-only or high-df-only overlap yields no FTS candidate', async () => {
  // Only stop words in common with row 6 (and with most rows).
  const stop = await retrieve('is the and of for that', LEX_OR());
  assert.ok(!stop.rows.some((row) => row.score.fts > 0), 'stop words are not searched');
  // "before" appears in 3 of 8 rows (df 0.375 > 0.2): it is not searched; "quokka" (1/8) is.
  const df = await retrieve('before quokka', LEX_OR());
  const ftsIds = df.rows.filter((row) => row.score.fts > 0).map((row) => row.id);
  assert.deepEqual(ftsIds, [ids[7]], 'only the discriminative word matched');
  // The same "before" is searched once the ratio admits it.
  const loose = await retrieve('before quokka', LEX_OR({ fts: { mode: 'or', max_df_ratio: 0.5 } }));
  assert.ok(loose.rows.filter((row) => row.score.fts > 0).length > 1, 'the df ratio is what dropped it');
});

const EMB_OR = (extra = {}) => ({ embedding: embeddingA, retrieval: { min_cosine_by_signature: { [SIG]: 0.6 }, fts: { mode: 'or' }, ...extra } });

test('criterion 3: below the cosine floor, a row holding 2 prompt words is kept and one holding 1 is dropped', async () => {
  // Row 1 (cosine 0.55) holds "daemon", "restart", "plist"; row 2 (0.5) holds only "sqlite".
  const prompt = 'daemon restart plist sqlite';
  seedQueryCache(prompt);
  const out = await retrieve(prompt, EMB_OR(), { relevanceFloor: true });
  assert.equal(out.retrievalPath, 'A');
  const got = out.rows.map((row) => row.id);
  assert.ok(got.includes(ids[1]), 'three prompt words keep a row the floor drops');
  assert.ok(!got.includes(ids[2]), 'one prompt word does not');
  assert.ok(got.includes(ids[0]), 'cosine 0.9 still clears the floor with no lexical hit');
  // The cosine-only gate (and mode) drops row 1.
  const andOut = await retrieve(prompt, { ...EMB_OR(), retrieval: { min_cosine_by_signature: { [SIG]: 0.6 } } }, { relevanceFloor: true });
  assert.ok(!andOut.rows.some((row) => row.id === ids[1]), 'and mode keeps the cosine-only gate');
});

test('criterion 3b: with more than 6 discriminative words the bar is 30% of them, not 2', async () => {
  // 10 discriminative words; row 1 holds 2 of them (daemon, plist) -> below ceil(0.3 * 10) = 3.
  const prompt = 'daemon plist aardvark bobsleigh cantaloupe dirigible escarpment flamingo gazebo hullabaloo';
  seedQueryCache(prompt);
  const out = await retrieve(prompt, EMB_OR(), { relevanceFloor: true });
  assert.ok(!out.rows.some((row) => row.id === ids[1]));
  const few = 'daemon plist aardvark';
  seedQueryCache(few);
  const fewOut = await retrieve(few, EMB_OR(), { relevanceFloor: true });
  assert.ok(fewOut.rows.some((row) => row.id === ids[1]), 'with 3 words, 2 hits clear the bar');
});

test('criterion 4: the embedding-free path applies the lexical half of the gate', async () => {
  const cfg = { embedding: { enabled: false }, retrieval: { fts: { mode: 'or' } } };
  // "walrus" alone overlaps row 7 by one word; LIKE (and FTS) would return it.
  const one = await retrieve('walrus opera tickets', cfg, { relevanceFloor: true });
  assert.equal(one.retrievalPath, 'B-off');
  assert.ok(!one.rows.some((row) => row.id === ids[7]), 'a single-word overlap is dropped');
  assert.ok(one.gated >= 1, 'and counted as gated');
  const two = await retrieve('walrus butter opera', cfg, { relevanceFloor: true });
  assert.ok(two.rows.some((row) => row.id === ids[7]), 'a two-word overlap is kept');
  // Callers that do not ask for the gate (search, list) are not gated.
  const ungated = await retrieve('walrus opera tickets', cfg, {});
  assert.ok(ungated.rows.some((row) => row.id === ids[7]));
});
