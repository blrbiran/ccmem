import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-stats-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const CLI = '/Users/biran/code/skills/ccmem/scripts/cli.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdStats } = await import('../../scripts/lib/cmd/stats.mjs');

function resetStatsTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function insertMemory(db, {
  status = 'active',
  decayStatus = 'active',
  trust = 0.5,
  content,
  now
}) {
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
    ) VALUES ('project', 'demo/repo', 'fact', ?, 0, 'user_explicit', ?, ?, ?, 0, 0, ?, ?, ?, '[]')`
  ).run(content, trust, status, decayStatus, now, now, now);
}

function seedStatsFixture(db, now = Date.now()) {
  insertMemory(db, { content: 'stable', trust: 0.9, now });
  insertMemory(db, { content: 'grey', trust: 0.15, status: 'probation', now });
  insertMemory(db, { content: 'stale', trust: 0.05, now });
  insertMemory(db, { content: 'old', trust: 0.2, decayStatus: 'archived', now });

  db.prepare(
    `INSERT INTO memory_feedback (session_id, injection_source, injected_ids, outcome, recorded_at)
     VALUES
     ('s1', 'session_start', '[1]', 'helpful', ?),
     ('s2', 'session_start', '[2]', 'helpful', ?),
     ('s3', 'prompt_submit', '[3]', 'unhelpful', ?),
     ('s4', 'prompt_submit', '[4]', 'unknown', ?)`
  ).run(now, now, now, now);

  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(4321, 'stats-host', now - 5000, now - 900);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, started_at, status)
     VALUES ('summarize_pending', '{}', ?, ?, ?, 'running')`
  ).run(now - 2000, now - 2000, now - 1000);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('weekly_synthesis', '{}', ?, ?, 'queued')`
  ).run(now - 500, now - 500, now - 400, now - 400, now - 300, now - 300);
}

test('cmdStats aggregates runtime state and opportunistic maintenance', async () => {
  const db = openDb();
  resetStatsTables(db);
  const now = Date.now();
  seedStatsFixture(db, now);

  const result = await cmdStats(db, { buckets: true });
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'daily_maintenance'
     ORDER BY id DESC
     LIMIT 1`
  ).get();

  assert.equal(result.tier1.available, true);
  assert.equal(result.tier15.ran, true);
  assert.equal(result.tier2.alive, true);
  assert.equal(result.tier2.pid, 4321);
  assert.equal(result.tier2.pending.summarize_pending, 2);
  assert.equal(result.tier2.pending.weekly_synthesis, 1);
  assert.equal(result.memories.active, 1);
  assert.equal(result.memories.probation, 1);
  assert.equal(result.memories.archived, 2);
  assert.equal(result.memories.total, 4);
  assert.equal(result.trust.grey_zone, 1);
  assert.equal(result.feedback.helpful, 2);
  assert.equal(result.feedback.unhelpful, 1);
  assert.equal(result.feedback.unknown, 1);
  assert.equal(result.buckets.active, 2);
  assert.equal(result.buckets.archived, 2);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  db.close();
});

test('cli stats prints human summary', () => {
  const db = openDb();
  resetStatsTables(db);
  seedStatsFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'stats'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Tier 1   : ok injecting \/ retrieving/);
  assert.match(output, /Tier 1\.5 : ok opportunistic maintenance/);
  assert.match(output, /Tier 2   : ok daemon alive pid=4321 host=stats-host/);
  assert.match(output, /Memories : 1 active \/ 1 probation \/ 2 archived/);
  assert.match(output, /Trust    : avg 0\.33 \| grey-zone 1/);
  assert.match(output, /Feedback : helpful 2 \/ unhelpful 1 \/ unknown 1/);
});

test('cli stats --json returns structured stats', () => {
  const db = openDb();
  resetStatsTables(db);
  seedStatsFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'stats', '--json', '--buckets'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.tier2.alive, true);
  assert.equal(parsed.memories.archived, 2);
  assert.equal(parsed.feedback.helpful, 2);
  assert.equal(parsed.buckets.archived, 2);
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
