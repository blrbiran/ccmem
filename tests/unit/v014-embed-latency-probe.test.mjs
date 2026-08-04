import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 模块级隔离：本文件永远不碰真实数据根。
const ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-probe-'));
process.env.CCMEM_DATA_ROOT = ROOT;
delete process.env.CCMEM_CONFIG_PATH;

const { runEmbedLatencyProbe, probeFile } = await import('../../scripts/daemon/tasks/embed-latency-probe.mjs');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
           CREATE TABLE config_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, set_at INTEGER NOT NULL);
           CREATE TABLE query_embedding_cache (prompt_hash TEXT PRIMARY KEY, vec BLOB);`);
  db.prepare('INSERT INTO memories (content) VALUES (?)').run('hello probe');
  return db;
}

const openaiCfg = (probe) => ({
  embedding: {
    provider: 'openai', openai_api_key: 'sk-test', openai_model: 'text-embedding-3-small',
    openai_dim: 1536, openai_timeout_ms: 800, latency_probe: { enabled: true, timeout_ms: 10000, ...probe }
  }
});

test('a probe failure never touches the circuit breaker or the query cache', async () => {
  const db = freshDb();
  const throwing = { async embed() { throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: throwing });

  const kv = db.prepare('SELECT count(*) AS n FROM config_kv').get();
  assert.equal(kv.n, 0, 'the probe must not write any circuit-breaker key — it would open the gate on real retrieval');
  const cache = db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get();
  assert.equal(cache.n, 0, 'the probe must not pollute the query-vector cache');
});

test('a probe success also leaves the breaker and cache untouched', async () => {
  const db = freshDb();
  const ok = { async embed() { return [new Float32Array(1536)]; } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: ok });

  assert.equal(db.prepare('SELECT count(*) AS n FROM config_kv').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get().n, 0);
});

test('hitting the probe ceiling is recorded as its own field, not collapsed into a failure', async () => {
  const db = freshDb();
  const slow = { async embed() { await new Promise((r) => setTimeout(r, 60)); throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 50 }), provider: slow });

  const rows = readFileSync(probeFile({ }), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = rows.at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.timed_out_at_probe_limit, true, 'second censoring must stay visible — this probe exists because censoring was invisible');
  assert.equal(last.signature, 'openai:text-embedding-3-small:1536');
  assert.equal(last.text_chars, 'hello probe'.length);
});

test('a fast failure is not mislabelled as hitting the ceiling', async () => {
  const db = freshDb();
  const fast = { async embed() { throw new Error('401 Unauthorized'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 10000 }), provider: fast });

  const rows = readFileSync(probeFile({}), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).timed_out_at_probe_limit, false);
});

test('a non-openai provider is skipped without writing a row', async () => {
  const db = freshDb();
  const cfg = { embedding: { provider: 'transformers-local', latency_probe: { enabled: true } } };
  const result = await runEmbedLatencyProbe(db, {}, { config: cfg, provider: { async embed() { throw new Error('must not be called'); } } });
  assert.equal(result.skipped, 'provider');
});

test('a disabled probe returns skipped and never invokes the provider — no real spend on someone else\'s behalf', async () => {
  const db = freshDb();
  let calls = 0;
  const counting = { async embed() { calls += 1; return [new Float32Array(1536)]; } };

  const result = await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ enabled: false }), provider: counting });

  assert.equal(calls, 0, 'the provider must never be invoked when latency_probe.enabled is false — that would fire a real, billable API request');
  assert.equal(result.skipped, 'disabled');
});

test('a truthy-but-not-true enabled value is treated as disabled — strict === true is the spec', async () => {
  const db = freshDb();
  let calls = 0;
  const counting = { async embed() { calls += 1; return [new Float32Array(1536)]; } };

  const result = await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ enabled: 'yes' }), provider: counting });

  assert.equal(calls, 0, 'a truthy string must not be enough to enable real spend');
  assert.equal(result.skipped, 'disabled');
});
