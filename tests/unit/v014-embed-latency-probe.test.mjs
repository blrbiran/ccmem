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

test('the SDK import and client construction are outside the timed span', async () => {
  // hook 侧 retrieval.mjs 先 await provider.load(config) 再开始计时，
  // 所以 retrieval_embed_ms 是纯 HTTP 往返。探针若把 load() 圈进 t0，
  // 量的就是"import + 构造 + 往返"，比它要对比的那个量严格更大 ——
  // 而且 daemon 重启后的第一次探针会被动态 import 独占地拉高。
  const db = freshDb();
  const slowLoad = {
    loaded: false,
    async load() { await new Promise((r) => setTimeout(r, 60)); this.loaded = true; },
    async embed() {
      if (!this.loaded) throw new Error('embed() had to load the client itself — the import is inside the timed span');
      return [new Float32Array(1536)];
    }
  };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: slowLoad });

  const last = readFileSync(probeFile({}), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.ok, true, 'load() must be awaited before the round trip, exactly as the hook path does it');
  assert.ok(last.ms < 50, `ms must exclude the 60ms load(), got ${last.ms}`);
});

test('a load failure is not recorded as a near-zero-latency sample', async () => {
  // load() 失败（SDK 缺失、key 在构造期就被拒）不是一次延迟观测。
  // 让它落成 ok:false + ms≈0 的行，等于往延迟文件里塞一个非延迟事件，
  // 它会把分布左端往下拽，而事后无法区分。
  const db = freshDb();
  const before = (() => { try { return readFileSync(probeFile({}), 'utf8'); } catch { return ''; } })();
  const failingLoad = {
    async load() { throw new Error('Cannot find module \'openai\''); },
    async embed() { throw new Error('must not be called'); }
  };

  const result = await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: failingLoad });

  assert.equal(result.skipped, 'load_failed', 'a load failure must return a skipped shape, not a latency sample');
  const after = (() => { try { return readFileSync(probeFile({}), 'utf8'); } catch { return ''; } })();
  assert.equal(after, before, 'no row may be appended for a load failure');
});

test('a probe failure never touches the circuit breaker or the query cache', async () => {
  const db = freshDb();
  const throwing = { async load() {}, async embed() { throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: throwing });

  const kv = db.prepare('SELECT count(*) AS n FROM config_kv').get();
  assert.equal(kv.n, 0, 'the probe must not write any circuit-breaker key — it would open the gate on real retrieval');
  const cache = db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get();
  assert.equal(cache.n, 0, 'the probe must not pollute the query-vector cache');
});

test('a probe success also leaves the breaker and cache untouched', async () => {
  const db = freshDb();
  const ok = { async load() {}, async embed() { return [new Float32Array(1536)]; } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: ok });

  assert.equal(db.prepare('SELECT count(*) AS n FROM config_kv').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get().n, 0);
});

test('hitting the probe ceiling is recorded as its own field, not collapsed into a failure', async () => {
  const db = freshDb();
  const slow = { async load() {}, async embed() { await new Promise((r) => setTimeout(r, 60)); throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 50 }), provider: slow });

  const rows = readFileSync(probeFile({ }), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = rows.at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.timed_out_at_probe_limit, true, 'second censoring must stay visible — this probe exists because censoring was invisible');
  assert.equal(last.timeout_ms, 50, 'the ceiling that produced the row must travel with the row — timeout_ms is user-configurable and this file never rotates');
  assert.equal(last.signature, 'openai:text-embedding-3-small:1536');
  assert.equal(last.text_chars, 'hello probe'.length);
});

test('a fast failure is not mislabelled as hitting the ceiling', async () => {
  const db = freshDb();
  const fast = { async load() {}, async embed() { throw new Error('401 Unauthorized'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 10000 }), provider: fast });

  const rows = readFileSync(probeFile({}), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).timed_out_at_probe_limit, false);
});

test('a non-openai provider is skipped without writing a row', async () => {
  const db = freshDb();
  const cfg = { embedding: { provider: 'transformers-local', latency_probe: { enabled: true } } };
  const result = await runEmbedLatencyProbe(db, {}, { config: cfg, provider: { async load() {}, async embed() { throw new Error('must not be called'); } } });
  assert.equal(result.skipped, 'provider');
});

test('a disabled probe returns skipped and never invokes the provider — no real spend on someone else\'s behalf', async () => {
  const db = freshDb();
  let calls = 0;
  const counting = { async load() {}, async embed() { calls += 1; return [new Float32Array(1536)]; } };

  const result = await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ enabled: false }), provider: counting });

  assert.equal(calls, 0, 'the provider must never be invoked when latency_probe.enabled is false — that would fire a real, billable API request');
  assert.equal(result.skipped, 'disabled');
});

test('a truthy-but-not-true enabled value is treated as disabled — strict === true is the spec', async () => {
  const db = freshDb();
  let calls = 0;
  const counting = { async load() {}, async embed() { calls += 1; return [new Float32Array(1536)]; } };

  const result = await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ enabled: 'yes' }), provider: counting });

  assert.equal(calls, 0, 'a truthy string must not be enough to enable real spend');
  assert.equal(result.skipped, 'disabled');
});
