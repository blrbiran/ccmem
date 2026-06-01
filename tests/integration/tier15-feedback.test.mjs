import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-tier15-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { maybeRunTier15 } = await import('../../scripts/lib/tier15.mjs');
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

  const ran = maybeRunTier15(db);
  assert.equal(ran, true);

  const row = db.prepare(`SELECT decay_status FROM memories WHERE content = 'stale memory'`).get();
  assert.equal(row.decay_status, 'archived');

  const lease = db.prepare(`SELECT ran_by, status FROM task_runs WHERE type = 'daily_maintenance'`).get();
  assert.equal(lease.ran_by, 'opportunistic');
  assert.equal(lease.status, 'completed');

  db.close();
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

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
