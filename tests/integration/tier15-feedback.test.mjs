import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-tier15-'));

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

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
