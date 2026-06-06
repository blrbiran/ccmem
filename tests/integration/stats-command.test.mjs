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

function seedRollupRow(db, {
  dayKey,
  sessionStartP50 = 40,
  sessionStartP95 = 120,
  promptSubmitP50 = 30,
  promptSubmitP95 = 70,
  stopP50 = 35,
  stopP95 = 90,
  llmCalls = 4,
  llmTotalDurationMs = 8000,
  llmFailures = 0,
  llmDeadLetters = 0,
  secQuarantined = 0,
  secAlertsEmitted = 0,
  revalQuarantined = 0,
  revalFlagged = 0,
  revalScanned = 0,
  tier15Clusters = 0,
  memsActive = 5,
  memsProbation = 1,
  memsQuarantine = 0,
  memsArchived = 1,
  writtenAt = Date.now()
} = {}) {
  db.prepare(
    `INSERT INTO metrics_daily_rollup (
      day_key,
      hook_session_start_p50,
      hook_session_start_p95,
      hook_prompt_submit_p50,
      hook_prompt_submit_p95,
      hook_stop_p50,
      hook_stop_p95,
      llm_calls,
      llm_total_duration_ms,
      llm_failures,
      llm_dead_letters,
      sec_quarantined,
      sec_alerts_emitted,
      reval_quarantined,
      reval_flagged,
      reval_scanned,
      tier15_clusters,
      mems_active,
      mems_probation,
      mems_quarantine,
      mems_archived,
      written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dayKey,
    sessionStartP50,
    sessionStartP95,
    promptSubmitP50,
    promptSubmitP95,
    stopP50,
    stopP95,
    llmCalls,
    llmTotalDurationMs,
    llmFailures,
    llmDeadLetters,
    secQuarantined,
    secAlertsEmitted,
    revalQuarantined,
    revalFlagged,
    revalScanned,
    tier15Clusters,
    memsActive,
    memsProbation,
    memsQuarantine,
    memsArchived,
    writtenAt
  );
}

function resetStatsTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM cross_scope_alerts`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM metrics_daily_rollup`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function insertMemory(db, {
  status = 'active',
  decayStatus = 'active',
  trust = 0.5,
  content,
  quarantinedAt = null,
  now
}) {
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at,
      created_at, updated_at, tags, quarantined_at
    ) VALUES ('project', 'demo/repo', 'fact', ?, 0, 'user_explicit', ?, ?, ?, 0, 0, ?, ?, ?, '[]', ?)`
  ).run(content, trust, status, decayStatus, now, now, now, quarantinedAt);
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

function seedSecurityStatsFixture(db, now = Date.now()) {
  insertMemory(db, {
    content: 'quarantined item',
    trust: 0.1,
    decayStatus: 'quarantine',
    quarantinedAt: now - (26 * 86400000),
    now
  });
  insertMemory(db, { content: 'stable item', trust: 0.8, now });

  db.prepare(
    `INSERT INTO cross_scope_alerts (
      global_mem_id, project_mem_id, project_key, similarity, evidence, detected_at
     ) VALUES (1, 2, 'demo/repo', 0.84, 'pending duplicate', ?)`
  ).run(now - 2000);

  db.prepare(
    `INSERT INTO cross_scope_alerts (
      global_mem_id, project_mem_id, project_key, similarity, evidence, detected_at,
      acknowledged_at, acknowledged_action
     ) VALUES (1, 2, 'demo/repo', 0.79, 'ack duplicate', ?, ?, 'keep_global')`
  ).run(now - 4000, now - 1000);
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
     WHERE type = 'tier1_5_maintenance'
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
  assert.equal(result.memories.quarantined, 0);
  assert.equal(result.memories.archived, 2);
  assert.equal(result.memories.total, 4);
  assert.equal(result.trust.grey_zone, 1);
  assert.equal(result.feedback.helpful, 2);
  assert.equal(result.feedback.unhelpful, 1);
  assert.equal(result.feedback.unknown, 1);
  assert.equal(result.security.quarantined, 0);
  assert.equal(result.security.alerts_pending, 0);
  assert.equal(result.buckets.active, 2);
  assert.equal(result.buckets.archived, 2);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  db.close();
});

test('cmdStats reports security quarantine and cross-scope alert counts', async () => {
  const db = openDb();
  resetStatsTables(db);
  const now = Date.now();
  seedSecurityStatsFixture(db, now);

  const result = await cmdStats(db, { buckets: true });

  assert.equal(result.memories.quarantined, 1);
  assert.equal(result.memories.active, 1);
  assert.equal(result.security.quarantined, 1);
  assert.equal(result.security.pending_sunset, 1);
  assert.equal(result.security.alerts_pending, 1);
  assert.equal(result.security.alerts_acknowledged, 1);
  assert.equal(result.buckets.quarantine, 1);
  db.close();
});

test('cmdStats records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetStatsTables(db);
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
    seedStatsFixture(db, fixedNowMs);

    const result = await cmdStats(db, { buckets: true });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.tier15.ran, true);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
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
  assert.match(output, /Memories : 1 active \/ 1 probation \/ 0 quarantine \/ 2 archived/);
  assert.match(output, /Trust    : avg 0\.33 \| grey-zone 1/);
  assert.match(output, /Feedback : helpful 2 \/ unhelpful 1 \/ unknown 1/);
});

test('cli stats prints the security line when quarantine or alerts exist', () => {
  const db = openDb();
  resetStatsTables(db);
  seedSecurityStatsFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'stats'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Security : 1 quarantined \(1 pending sunset\) \| 1 cross-scope alerts pending/);
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
  assert.equal(parsed.memories.quarantined, 0);
  assert.equal(parsed.feedback.helpful, 2);
  assert.equal(parsed.security.alerts_pending, 0);
  assert.equal(parsed.buckets.archived, 2);
});

test('cli stats prints the tuning hint when suggestions are available', () => {
  const db = openDb();
  resetStatsTables(db);
  seedStatsFixture(db);
  for (let day = 1; day <= 7; day += 1) {
    seedRollupRow(db, { dayKey: `2026-06-0${day}` });
  }
  for (let i = 0; i < 10; i += 1) {
    db.prepare(
      `INSERT INTO audit_log (ts, action, affected_ids, details)
       VALUES (?, 'security_audit_run', NULL, ?)`
    ).run(
      Date.parse(`2026-06-${String((i % 7) + 1).padStart(2, '0')}T12:00:00Z`),
      JSON.stringify({ pool_b: 10, pool_a: 0, pool_c: 0 })
    );
  }
  db.close();

  const output = execFileSync(NODE, [CLI, 'stats'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Tuning  : \d+ suggestions available — run \/ccmem:admin diagnose --tuning/);
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
