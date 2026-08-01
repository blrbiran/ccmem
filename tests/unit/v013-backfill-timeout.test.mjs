import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillEmbeddingConfig } from '../../scripts/daemon/tasks/vec-backfill.mjs';
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';

// Finding 4, measured. One timeout value served two opposite workloads:
//
//   prompt-submit retrieval — 1 query vector, on the hook latency budget,
//     failure is cheap (fall back to lexical)
//   vec_backfill           — backfill_batch_size rows in one request, in the
//     daemon, failure is expensive (the continuation chain stops dead)
//
// `openai_timeout_ms: 800` was chosen for the first. The second borrowed it, and
// on the dogfood store batch #2 died with "Request timed out" after batch #1
// squeaked through at 894ms — leaving 4259 rows pending forever.
//
// The backfill overrides the timeout for its own provider call only. The hook
// path keeps its 800ms budget, which is the whole reason that value is low.
test('the backfill overrides the hot-path timeout with its own', () => {
  const cfg = {
    embedding: { provider: 'openai', openai_timeout_ms: 800, api_timeout_ms: 30000, backfill_timeout_ms: 45000 }
  };

  const backfillCfg = backfillEmbeddingConfig(cfg);

  assert.equal(backfillCfg.embedding.openai_timeout_ms, 45000, 'openai reads openai_timeout_ms first');
  assert.equal(backfillCfg.embedding.api_timeout_ms, 45000, 'jina reads api_timeout_ms; both providers must be covered');
  assert.equal(cfg.embedding.openai_timeout_ms, 800, 'the caller config must not be mutated — the hook path shares it');
});

test('the shipped default leaves room for a full batch', () => {
  const backfillCfg = backfillEmbeddingConfig(DEFAULT_CONFIG);

  assert.equal(
    backfillCfg.embedding.openai_timeout_ms > DEFAULT_CONFIG.embedding.openai_timeout_ms,
    true,
    'a default that does not exceed the hot-path timeout would ship the bug that this fixes'
  );
});

// CONTROL against over-correction: a deployment that deliberately pins the backfill
// to the hot-path budget must be honoured, not silently widened.
test('an explicit backfill timeout is honoured even when it is small', () => {
  const cfg = { embedding: { openai_timeout_ms: 800, backfill_timeout_ms: 500 } };

  assert.equal(backfillEmbeddingConfig(cfg).embedding.openai_timeout_ms, 500);
});

// A timeout is transient, but the failure was terminal: the catch path wrote an
// audit row and rethrew, without queueing a continuation and without printing
// anything. On the dogfood store one timed-out batch stopped the chain dead at
// 4259 pending, and the only trace was a row in audit_log — `semantic status`
// showed a frozen number, daemon.err.log said nothing, and the circuit breaker
// never tripped because a single failure is below its threshold.
//
// Success already queues its own continuation and prints; failure must too, or
// "retry next batch" only ever means "retry after a manual restart".
test('a failed batch still queues a continuation and says so on stderr', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-backfill-err-'));
  const configPath = path.join(dataRoot, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    embedding: { enabled: true, provider: 'openai', openai_api_key: null, backfill_timeout_ms: 5000 }
  }));

  const previous = { root: process.env.CCMEM_DATA_ROOT, cfg: process.env.CCMEM_CONFIG_PATH, key: process.env.OPENAI_API_KEY };
  process.env.CCMEM_TEST_MODE = '1';
  process.env.CCMEM_DATA_ROOT = dataRoot;
  process.env.CCMEM_CONFIG_PATH = configPath;
  delete process.env.OPENAI_API_KEY;

  const { openDb } = await import('../../scripts/lib/db.mjs');
  const { runVecBackfill } = await import('../../scripts/daemon/tasks/vec-backfill.mjs');
  const { _resetProviderCache } = await import('../../scripts/lib/embedding/provider.mjs');

  const db = openDb();
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };

  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (
        scope, project_key, type, content, pinned, source, trust_score,
        decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
      ) VALUES ('project', 'demo/repo', 'fact', 'needs a vector', 0, 'user_explicit', 0.5,
        'active', 0, 0, ?, ?, ?)`
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.enabled', 'true', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(now);
    _resetProviderCache();

    await assert.rejects(runVecBackfill(db), 'the batch must fail — no API key is configured');

    const queued = db.prepare(
      `SELECT COUNT(*) n FROM tasks WHERE type = 'vec_backfill' AND status = 'queued'`
    ).get().n;
    assert.equal(queued, 1, 'a transient failure must not end the continuation chain');

    assert.equal(
      written.some((line) => line.includes('vec_backfill') && /fail|error/i.test(line)),
      true,
      'the failure must be visible where the successes are, not only in audit_log'
    );
  } finally {
    process.stderr.write = realWrite;
    db.close();
    _resetProviderCache();
    if (previous.root === undefined) delete process.env.CCMEM_DATA_ROOT; else process.env.CCMEM_DATA_ROOT = previous.root;
    if (previous.cfg === undefined) delete process.env.CCMEM_CONFIG_PATH; else process.env.CCMEM_CONFIG_PATH = previous.cfg;
    if (previous.key !== undefined) process.env.OPENAI_API_KEY = previous.key;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
