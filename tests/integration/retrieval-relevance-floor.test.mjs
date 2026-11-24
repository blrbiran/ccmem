import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Tester #453: retrieval always filled every slot, so a prompt nothing in the store is about still got six
// memories (all cosine-only, best fused 0.188). A memory with no lexical hit is kept only when its cosine clears
// the floor calibrated for the embedding model in use; a model with no calibrated floor keeps today's behaviour.
const root = mkdtempSync(path.join(tmpdir(), 'ccmem-relevance-floor-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = root;
process.env.OPENAI_API_KEY = 'test-key';
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
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

const PROMPT = 'zzqpfxx wibblefrotz relevance probe';
const embedding = { enabled: true, provider: 'openai', openai_api_key: 'test-key', openai_base_url: 'http://127.0.0.1:1', openai_model: 'text-embedding-3-small' };
const writeConfig = (floors) => writeFileSync(configPath, JSON.stringify({ injection: { file_based: true }, embedding, retrieval: { min_cosine_by_signature: floors } }));

writeConfig({});
const SIG = currentEmbeddingSig(getProvider(loadConfig()), loadConfig());
const db = openDb();
// Content shares no word with the prompt, so only the cosine lane can surface either row.
const near = await insertMemory(db, { cwd: root, content: 'kappa quokka nine near fixture', scope: 'global', type: 'fact', embedSync: false, embeddingBlob: vecToBlob(new Float32Array([1, 0, 0])) });
const far = await insertMemory(db, { cwd: root, content: 'lambda yonder five far fixture', scope: 'global', type: 'fact', embedSync: false, embeddingBlob: vecToBlob(new Float32Array([0.5, Math.sqrt(0.75), 0])) });
db.prepare(`INSERT INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count) VALUES (?, ?, ?, ?, ?, 1)`)
  .run(createHash('sha256').update(`${SIG}\n${PROMPT}`).digest('hex'), vecToBlob(new Float32Array([1, 0, 0])), SIG, PROMPT.length, Date.now());
db.close();

async function ids(options) {
  const conn = openDb();
  try {
    const out = await retrieveMemories(conn, PROMPT, 'floor/repo', loadConfig(), options);
    assert.equal(out.retrievalPath, 'A');
    return out.rows.map((row) => row.id);
  } finally {
    conn.close();
  }
}

test('with a floor calibrated for this model, a cosine-only memory below it is not retrieved', async () => {
  writeConfig({ [SIG]: 0.6 });
  const got = await ids({ relevanceFloor: true });
  assert.ok(got.includes(near.id), 'cosine 1.0 clears 0.6');
  assert.ok(!got.includes(far.id), 'cosine 0.5 is below 0.6');
});

test('a model with no calibrated floor keeps every candidate', async () => {
  writeConfig({ 'some-other:model:1': 0.6 });
  const got = await ids({ relevanceFloor: true });
  assert.ok(got.includes(near.id) && got.includes(far.id));
});

test('callers that do not ask for the floor (search, list) are unchanged', async () => {
  writeConfig({ [SIG]: 0.6 });
  const got = await ids({});
  assert.ok(got.includes(near.id) && got.includes(far.id));
});

test('the prompt hook applies the floor and records how many it held back', async () => {
  writeConfig({ [SIG]: 0.6 });
  const result = await handlePromptSubmit({ cwd: root, session_id: 'floor-session', prompt: PROMPT, ccmem_agent: 'claude-code' });
  assert.equal(result._metricFields.matched, 1);
  assert.equal(result._metricFields.retrieval_gated, 1);
});
