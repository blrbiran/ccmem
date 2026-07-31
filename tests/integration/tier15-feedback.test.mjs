import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-tier15-'));
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { maybeRunTier15, runSessionStartMiniPrelude } = await import('../../scripts/lib/tier15.mjs');
const { inferPrevTurnOutcome } = await import('../../scripts/lib/feedback.mjs');

test('maybeRunTier15 archives low-trust memories and records lease', () => {
  const db = openDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
    ) VALUES ('project', 'demo/repo', 'fact', 'stale memory', 0, 'user_explicit', 0.05,
      'active', 0, 0, ?, ?, ?)`
  ).run(now, now, now);

  const result = maybeRunTier15(db);
  assert.equal(result.ran, true);
  assert.equal(result.skipped ?? null, null);

  const row = db.prepare(`SELECT decay_status FROM memories WHERE content = 'stale memory'`).get();
  assert.equal(row.decay_status, 'archived');

  const lease = db.prepare(`SELECT ran_by, status FROM task_runs WHERE type = 'tier1_5_maintenance'`).get();
  assert.equal(lease.ran_by, 'opportunistic');
  assert.equal(lease.status, 'completed');

  db.close();
});

test('maybeRunTier15 records the local calendar day lease at early-morning local times', () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs`).run();
  const fixedNow = new Date(2026, 5, 8, 2, 17, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;

  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNowMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = FixedDate;

  try {
    const result = maybeRunTier15(db);
    assert.equal(result.ran, true);

    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'`
    ).get();

    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.ran_by, 'opportunistic');
    assert.equal(lease.status, 'completed');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('runSessionStartMiniPrelude records the local calendar day lease at early-morning local times', () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs`).run();
  const fixedNow = new Date(2026, 5, 8, 2, 17, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;

  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNowMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = FixedDate;

  try {
    const ran = runSessionStartMiniPrelude(db);
    assert.equal(ran, true);

    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'tier1_5_mini_prelude'`
    ).get();

    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.ran_by, 'opportunistic');
    assert.equal(lease.status, 'completed');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('inferPrevTurnOutcome marks unknown feedback as unhelpful on negative prompt', () => {
  const db = openDb();
  const now = Date.now();

  const inserted = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
    ) VALUES ('project', 'demo/repo', 'fact', 'bad memory', 0, 'user_explicit', 0.9,
      'active', 0, 0, ?, ?, ?)`
  ).run(now, now, now);

  db.prepare(
    `INSERT INTO memory_feedback (
      session_id, injection_source, injected_ids, outcome, outcome_locked, evidence, recorded_at
    ) VALUES (?, ?, ?, 'unknown', 0, NULL, ?)`
  ).run('s-feedback', 'user_prompt_submit', JSON.stringify([Number(inserted.lastInsertRowid)]), now);

  inferPrevTurnOutcome(db, 's-feedback', '这不对，重做');

  const feedback = db.prepare(`SELECT outcome, evidence FROM memory_feedback WHERE session_id = 's-feedback'`).get();
  assert.equal(feedback.outcome, 'unhelpful');
  assert.equal(feedback.evidence, 'neg_keyword');

  const memory = db.prepare(`SELECT unhelpful_count FROM memories WHERE id = ?`).get(Number(inserted.lastInsertRowid));
  assert.equal(memory.unhelpful_count, 1);

  db.close();
});

test('runSessionStartMiniPrelude prunes stale recent injections and old task leases', () => {
  const db = openDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-old', 0, 'session_start', '[1]', ?)`
  ).run(now - (15 * 86400000));

  const insertRecent = db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-many', ?, 'user_prompt_submit', '[1]', ?)`
  );
  for (let i = 1; i <= 22; i += 1) {
    insertRecent.run(i, now - i);
  }

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
     VALUES ('summarize_pending', '2026-01-01', ?, 'completed', 'daemon')`
  ).run(now);

  const ran = runSessionStartMiniPrelude(db);
  assert.equal(ran, true);

  const stale = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-old'`).get();
  const kept = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-many'`).get();
  const oldestKept = db.prepare(
    `SELECT MIN(prompt_idx) AS min_prompt_idx FROM recent_injections WHERE session_id = 's-many'`
  ).get();
  const oldTasks = db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE type = 'summarize_pending'`).get();
  const lease = db.prepare(
    `SELECT ran_by, status FROM task_runs WHERE type = 'tier1_5_mini_prelude'`
  ).get();

  assert.equal(stale.n, 0);
  assert.equal(kept.n, 20);
  assert.equal(oldestKept.min_prompt_idx, 1);
  assert.equal(oldTasks.n, 0);
  assert.equal(lease.ran_by, 'opportunistic');
  assert.equal(lease.status, 'completed');

  db.close();
});

// Change 3: config_kv is the one table with no retention logic of its own,
// and the L2.5 probe's per-session l25_probe_last_idx:<sessionId> keys are
// the first per-session-cardinality rows ever written there.
test('runSessionStartMiniPrelude removes old l25_probe_last_idx config_kv keys and keeps recent ones', () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs WHERE type = 'tier1_5_mini_prelude'`).run();
  const now = Date.now();

  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('l25_probe_last_idx:s-old', '5', ?)`
  ).run(now - (15 * 86400000));
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('l25_probe_last_idx:s-new', '9', ?)`
  ).run(now - (1 * 86400000));
  // an unrelated config_kv key must never be touched by this cleanup
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('some_unrelated_kv_key', 'x', ?)`
  ).run(now - (30 * 86400000));

  const ran = runSessionStartMiniPrelude(db);
  assert.equal(ran, true);

  const oldKey = db.prepare(`SELECT 1 FROM config_kv WHERE key = 'l25_probe_last_idx:s-old'`).get();
  const newKey = db.prepare(`SELECT 1 FROM config_kv WHERE key = 'l25_probe_last_idx:s-new'`).get();
  const unrelatedKey = db.prepare(`SELECT 1 FROM config_kv WHERE key = 'some_unrelated_kv_key'`).get();

  assert.equal(Boolean(oldKey), false, 'keys older than the retention window must be removed');
  assert.equal(Boolean(newKey), true, 'recent keys must survive');
  assert.equal(Boolean(unrelatedKey), true, 'unrelated config_kv keys must never be touched');

  db.close();
});

// Change 2: retention_days: 0 (the default) means decision data is never
// auto-pruned — it should be removed by explicit human action only.
test('maybeRunTier15 does not prune decision data when retention_days is 0 (the default)', () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs WHERE type = 'tier1_5_maintenance'`).run();

  const oldTs = Date.now() - (400 * 86400000);
  writeFileSync(
    path.join(dataRoot, 'l25-probe.jsonl'),
    `${JSON.stringify({ ts: oldTs, tag: 'ancient' })}\n`,
    'utf8'
  );

  const result = maybeRunTier15(db);
  assert.equal(result.ran, true);

  const raw = readFileSync(path.join(dataRoot, 'l25-probe.jsonl'), 'utf8');
  assert.match(raw, /ancient/, 'retention_days: 0 must never prune decision data');

  db.close();
});

// Positive control for the same wiring: once a user explicitly opts into a
// bounded retention_days, tier15 must actually prune using it.
test('maybeRunTier15 prunes decision data once a user opts into bounded retention_days', () => {
  const db = openDb();
  db.prepare(`DELETE FROM task_runs WHERE type = 'tier1_5_maintenance'`).run();

  const configPath = path.join(dataRoot, 'decision-retention-config.json');
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  writeFileSync(configPath, JSON.stringify({
    metrics: { decision_data: { enabled: true, file: 'l25-probe-retained.jsonl', retention_days: 5 } }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;

  try {
    const now = Date.now();
    writeFileSync(
      path.join(dataRoot, 'l25-probe-retained.jsonl'),
      [
        JSON.stringify({ ts: now - (10 * 86400000), tag: 'old' }),
        JSON.stringify({ ts: now - (1 * 86400000), tag: 'recent' })
      ].join('\n') + '\n',
      'utf8'
    );

    const result = maybeRunTier15(db);
    assert.equal(result.ran, true);

    const raw = readFileSync(path.join(dataRoot, 'l25-probe-retained.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /"tag":"old"/, 'rows older than retention_days must be pruned once opted in');
    assert.match(raw, /"tag":"recent"/, 'rows within retention_days must survive');
  } finally {
    db.close();
    if (previousConfigPath == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
