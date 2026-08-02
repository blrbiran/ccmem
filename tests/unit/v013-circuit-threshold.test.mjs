import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-circuit-threshold-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { getProviderWithCircuit, recordEmbedFailure, _resetProviderCache } =
  await import('../../scripts/lib/embedding/provider.mjs');

/**
 * Finding 14: readConfigKvInt() turned "this key does not exist" into 0, because
 * Number(null) is 0 and 0 is finite. Both callers test existence with == null,
 * so a store that had never failed read as a store whose circuit was already
 * open. Three things followed from that one coercion:
 *
 *   1. recordEmbedFailure() always took the "already open, extend the window"
 *      branch and returned, so the circuit opened on the FIRST failure and
 *      embedding.circuit.failure_threshold never applied to anything.
 *   2. The embedding_circuit_open audit lives in the branch that became
 *      unreachable — the store carried 3,863 audit rows back to 2026-05-30 with
 *      2 circuit_close rows and 0 circuit_open rows, while the kv row proved the
 *      circuit had opened. Recovery was recorded; failure was not.
 *   3. getProviderWithCircuit()'s 'closed' fast path became unreachable too, so
 *      every healthy retrieval fell through to the probe branch and wrote
 *      embedding.last_probe_at. On a query-cache hit retrieval.mjs skips embed
 *      and therefore skips recordEmbedSuccess, so that row is never cleared and
 *      the next retrieval within probe_interval_ms reports the circuit open with
 *      no failure anywhere near it.
 *
 * These tests pin the existence check, not the coercion helper, because the
 * defect is only visible through what the two callers decide.
 */

const CIRCUIT_KEYS = ['embedding.circuit_open_until', 'embedding.consecutive_failures', 'embedding.last_probe_at'];

function freshCircuit(db) {
  db.prepare(`DELETE FROM config_kv WHERE key IN (${CIRCUIT_KEYS.map(() => '?').join(',')})`).run(...CIRCUIT_KEYS);
  db.prepare(`DELETE FROM audit_log WHERE action LIKE 'embedding_circuit%'`).run();
  _resetProviderCache();
}

function kv(db, key) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key)?.value ?? null;
}

// Enough config for getProvider() to hand back a provider without any network:
// providerByName('openai') + applyConfig() only reads declared values.
const CONFIG = { embedding: { enabled: true, provider: 'openai', openai_api_key: 'test-key' } };

test('a single embed failure does not open the circuit', () => {
  const db = openDb();
  try {
    freshCircuit(db);
    recordEmbedFailure(db, CONFIG);
    // The threshold defaults to 3. One failure must only be counted.
    assert.equal(kv(db, 'embedding.consecutive_failures'), '1');
    assert.equal(kv(db, 'embedding.circuit_open_until'), null);
  } finally {
    db.close();
  }
});

test('the circuit opens on the threshold-th failure and audits the open', () => {
  const db = openDb();
  try {
    freshCircuit(db);
    recordEmbedFailure(db, CONFIG);
    recordEmbedFailure(db, CONFIG);
    assert.equal(kv(db, 'embedding.circuit_open_until'), null, 'must still be closed at 2 of 3');
    recordEmbedFailure(db, CONFIG);

    assert.notEqual(kv(db, 'embedding.circuit_open_until'), null, 'must be open at 3 of 3');
    const audit = db.prepare(
      `SELECT details FROM audit_log WHERE action = 'embedding_circuit_open'`
    ).all();
    // Without this row the only trace of a degraded semantic lane is a config_kv
    // value that the next success deletes.
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].details).failures, 3);
  } finally {
    db.close();
  }
});

test('a store that has never failed reports a closed circuit and is not probed', () => {
  const db = openDb();
  try {
    freshCircuit(db);
    const { provider, circuit } = getProviderWithCircuit(db, CONFIG);

    assert.equal(circuit, 'closed');
    assert.notEqual(provider, null);
    // Writing a probe timestamp on the healthy path is what later reads back as
    // "probed too recently, treat as open" and drops retrieval to lexical.
    assert.equal(kv(db, 'embedding.last_probe_at'), null);
  } finally {
    db.close();
  }
});

test('an open circuit still gates the provider', () => {
  const db = openDb();
  try {
    freshCircuit(db);
    db.prepare(
      `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.circuit_open_until', ?, ?)`
    ).run(String(Date.now() + 300000), Date.now());

    const { provider, circuit } = getProviderWithCircuit(db, CONFIG);
    // Control against over-correcting: a fix that makes the existence check
    // stricter must not make a genuinely open circuit read as closed.
    assert.equal(circuit, 'open');
    assert.equal(provider, null);
  } finally {
    db.close();
  }
});
