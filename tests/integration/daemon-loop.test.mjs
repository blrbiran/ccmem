import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-loop-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { dispatchTask } = await import('../../scripts/daemon/dispatch.mjs');
const { dayKey, mainLoop, scheduleCronTasks, weekKey } = await import('../../scripts/daemon/loop.mjs');
const { RAN_BY, tryClaimLease } = await import('../../scripts/lib/task-runs.mjs');

function resetRuntimeTables(db) {
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM memories`).run();
}

test('mainLoop dispatches queued tasks and marks them completed', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('demo', '{}', ?, ?, 'queued')`
  ).run(Date.now() - 1000, Date.now() - 1000);

  const seen = [];
  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (_db, task) => {
      seen.push(task.type);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const row = db.prepare(`SELECT status, started_at, finished_at, attempts FROM tasks WHERE type = 'demo'`).get();

  assert.deepEqual(seen, ['demo']);
  assert.equal(row.status, 'completed');
  assert.equal(typeof row.started_at, 'number');
  assert.equal(typeof row.finished_at, 'number');
  assert.equal(row.attempts, 1);
  db.close();
});

test('mainLoop marks failed tasks and stores error excerpt', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('broken', '{}', ?, ?, 'queued')`
  ).run(Date.now() - 1000, Date.now() - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async () => {
      stop = true;
      throw new Error('dispatch failed for test');
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const row = db.prepare(`SELECT status, finished_at, error_excerpt, attempts FROM tasks WHERE type = 'broken'`).get();

  assert.equal(row.status, 'failed');
  assert.equal(typeof row.finished_at, 'number');
  assert.equal(row.error_excerpt, 'dispatch failed for test');
  assert.equal(row.attempts, 1);
  db.close();
});

test('dispatchTask routes summarize_pending and keeps superseded status', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize.jsonl');

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember my preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I will remember that."}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s1', 'demo/repo', 1, 3, 0, 3, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ session_id: 's1', transcript_path: transcript, last_message_seq: 1 }), now - 2000, now - 2000);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ session_id: 's1', transcript_path: transcript, last_message_seq: 2 }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      if (JSON.parse(task.payload).last_message_seq === 2) {
        stop = true;
      }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const rows = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'summarize_pending'
     ORDER BY id ASC`
  ).all();
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_stub'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(rows.map((row) => row.status), ['superseded', 'completed']);
  assert.equal(audit.action, 'summarize_pending_stub');
  assert.equal(details.session_id, 's1');
  assert.equal(details.transcript_entry_count, 2);
  assert.match(details.transcript_excerpt, /user: remember my preference/);
  assert.match(details.transcript_excerpt, /assistant: I will remember that\./);
  db.close();
});

test('dispatchTask skips summarize_pending when transcript excerpt is empty', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'empty.jsonl');

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"image","source":"ignored"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-empty', 'demo/repo', 0, 3, 0, 1, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ session_id: 's-empty', transcript_path: transcript, last_message_seq: 1 }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const task = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = 's-empty'`
  ).get();
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_skipped'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(task.status, 'completed');
  assert.equal(audit.action, 'summarize_pending_skipped');
  assert.equal(details.reason, 'empty_transcript');
  assert.equal(details.session_id, 's-empty');
  db.close();
});

test('dispatchTask skips summarize_pending when session is too short', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'short.jsonl');

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-short', 'demo/repo', 0, 1, 0, 1, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ session_id: 's-short', transcript_path: transcript, last_message_seq: 1 }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const task = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = 's-short'`
  ).get();
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_skipped'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(task.status, 'completed');
  assert.equal(audit.action, 'summarize_pending_skipped');
  assert.equal(details.reason, 'short_session');
  assert.equal(details.session_id, 's-short');
  db.close();
});

test('dispatchTask marks bad summarize payload via audit', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ session_id: 's-bad' }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const task = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = 's-bad'`
  ).get();
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_bad_payload'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(task.status, 'completed');
  assert.equal(audit.action, 'summarize_pending_bad_payload');
  assert.equal(details.task_id > 0, true);
  db.close();
});

test('dispatchTask runs weekly_synthesis stub route', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weekKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const llmOutput = JSON.stringify({
    synthesized: [
      {
        content: 'Merge duplicate guidance',
        type: 'fact',
        scope: 'project',
        output_type: 'rule'
      }
    ]
  });

  assert.equal(claimed, true);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ llm_output: llmOutput }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      stop = true;
      await dispatchTask(loopDb, task);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const task = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'weekly_synthesis'`
  ).get();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(task.status, 'completed');
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  assert.equal(audit.action, 'weekly_synthesis_stub');
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');
  db.close();
});

test('dispatchTask fails unknown task types and preserves error excerpt', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('security_audit', '{}', ?, ?, 'queued')`
  ).run(now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      stop = true;
      await dispatchTask(loopDb, task);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const task = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'security_audit'`
  ).get();

  assert.equal(task.status, 'failed');
  assert.equal(task.error_excerpt, 'unknown task type: security_audit');
  assert.equal(task.attempts, 1);
  db.close();
});

test('dispatchTask runs daily_maintenance maintenance SQL', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = dayKey(new Date());
  const claimed = tryClaimLease(db, 'daily_maintenance', leaseKey, RAN_BY.DAEMON);

  assert.equal(claimed, true);

  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
    ) VALUES ('project', 'demo/repo', 'fact', 'stale daemon memory', 0, 'user_explicit', 0.05,
      'active', 0, 0, ?, ?, ?)`
  ).run(now, now, now);

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-old', 1, 'session_start', '[1]', ?)`
  ).run(now - (15 * 86400000));

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('daily_maintenance', '{}', ?, ?, 'queued')`
  ).run(now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      stop = true;
      await dispatchTask(loopDb, task);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const memory = db.prepare(
    `SELECT decay_status
     FROM memories
     WHERE content = 'stale daemon memory'`
  ).get();
  const injectionCount = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections`).get();
  const task = db.prepare(
    `SELECT status
     FROM tasks
     WHERE type = 'daily_maintenance'`
  ).get();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'daily_maintenance' AND date_key = ?`
  ).get(leaseKey);

  assert.equal(memory.decay_status, 'archived');
  assert.equal(injectionCount.n, 0);
  assert.equal(task.status, 'completed');
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  db.close();
});

test('scheduleCronTasks enqueues daily and weekly daemon work once per lease window', () => {
  const db = openDb();
  resetRuntimeTables(db);
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  const sundayMorning = new Date('2026-06-07T03:18:00.000Z');

  scheduleCronTasks(db, sundayMorning);
  scheduleCronTasks(db, sundayMorning);

  const taskCounts = db.prepare(
    `SELECT type, COUNT(*) AS n
     FROM tasks
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')
     GROUP BY type
     ORDER BY type ASC`
  ).all().map((row) => ({ type: row.type, n: row.n }));
  const leases = db.prepare(
    `SELECT type, date_key, ran_by, status
     FROM task_runs
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')
     ORDER BY type ASC`
  ).all().map((row) => ({
    type: row.type,
    date_key: row.date_key,
    ran_by: row.ran_by,
    status: row.status
  }));

  assert.deepEqual(taskCounts, [
    { type: 'daily_maintenance', n: 1 },
    { type: 'weekly_synthesis', n: 1 }
  ]);
  assert.deepEqual(leases, [
    { type: 'daily_maintenance', date_key: dayKey(sundayMorning), ran_by: 'daemon', status: 'running' },
    { type: 'weekly_synthesis', date_key: weekKey(sundayMorning), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('dispatchTask applies parsed llm output into memories', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'apply.jsonl');
  const llmOutput = [
    '```json',
    '[',
    '  {',
    '    "content": "Prefer concise answers",',
    '    "type": "rule",',
    '    "scope": "project",',
    '    "tags": ["style"]',
    '  }',
    ']',
    '```'
  ].join('\n');

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-apply', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-apply',
    transcript_path: transcript,
    last_message_seq: 2,
    llm_output: llmOutput
  }), now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const memory = db.prepare(
    `SELECT scope, project_key, type, content, source, trust_score, tags
     FROM memories
     WHERE source = 'auto_inferred'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(memory.scope, 'project');
  assert.equal(memory.project_key, 'demo/repo');
  assert.equal(memory.type, 'rule');
  assert.equal(memory.content, 'Prefer concise answers');
  assert.equal(memory.source, 'auto_inferred');
  assert.equal(memory.trust_score, 0.5);
  assert.deepEqual(JSON.parse(memory.tags), ['style']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.inserted_count, 1);
  assert.equal(details.skipped_count, 0);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
