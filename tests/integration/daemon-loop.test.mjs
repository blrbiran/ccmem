import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-loop-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { dispatchTask } = await import('../../scripts/daemon/dispatch.mjs');
const { dayKey, mainLoop, runTask, scheduleCronTasks, weekKey, weeklyLeaseKey } = await import('../../scripts/daemon/loop.mjs');
const { RAN_BY, tryClaimLease } = await import('../../scripts/lib/task-runs.mjs');

function resetRuntimeTables(db) {
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM ccmem_blacklisted_sessions`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM memories`).run();
  db.prepare(`DELETE FROM config_kv WHERE key = 'mode'`).run();
}

function setClaudeBridgeEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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

test('mainLoop in off mode skips dispatching queued tasks and only sleeps', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  setMode(db, 'off');
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('demo-off', '{}', ?, ?, 'queued')`
  ).run(Date.now() - 1000, Date.now() - 1000);

  const seen = [];
  let stop = false;
  let sleptMs = null;
  const originalSetTimeout = global.setTimeout;

  global.setTimeout = ((fn, ms, ...args) => {
    sleptMs = ms;
    return originalSetTimeout(() => {
      stop = true;
      fn(...args);
    }, 0);
  });

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (_db, task) => {
        seen.push(task.type);
      }),
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const row = db.prepare(
    `SELECT status, started_at, finished_at, attempts
     FROM tasks
     WHERE type = 'demo-off'`
  ).get();

  assert.deepEqual(seen, []);
  assert.equal(sleptMs, 300000);
  assert.equal(row.status, 'queued');
  assert.equal(row.started_at, null);
  assert.equal(row.finished_at, null);
  assert.equal(row.attempts, 0);
  db.close();
});

test('mainLoop in off mode does not enqueue cron tasks or leases before sleeping', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  setMode(db, 'off');

  let stop = false;
  let sleptMs = null;
  const fixedNow = '2026-06-07T03:18:00.000Z';
  const fixedNowMs = new Date(fixedNow).getTime();
  const OriginalDate = global.Date;
  const originalSetTimeout = global.setTimeout;

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
  global.setTimeout = ((fn, ms, ...args) => {
    sleptMs = ms;
    return originalSetTimeout(() => {
      stop = true;
      fn(...args);
    }, 0);
  });

  try {
    await Promise.race([
      mainLoop(db, () => stop, async () => {
        throw new Error('off mode should not dispatch cron work');
      }),
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    global.Date = OriginalDate;
    global.setTimeout = originalSetTimeout;
  }

  const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get();
  const leaseCount = db.prepare(`SELECT COUNT(*) AS n FROM task_runs`).get();

  assert.equal(sleptMs, 300000);
  assert.equal(taskCount.n, 0);
  assert.equal(leaseCount.n, 0);
  db.close();
});

test('mainLoop shortens idle sleep to 30 seconds when wake file is recent', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const wakePath = path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake');
  const now = Date.now();

  writeFileSync(wakePath, String(now));
  utimesSync(wakePath, now / 1000, now / 1000);

  let stop = false;
  let sleptMs = null;
  const originalSetTimeout = global.setTimeout;

  global.setTimeout = ((fn, ms, ...args) => {
    sleptMs = ms;
    return originalSetTimeout(() => {
      stop = true;
      fn(...args);
    }, 0);
  });

  try {
    await Promise.race([
      mainLoop(db, () => stop, async () => {
        throw new Error('idle wake branch should not dispatch work');
      }),
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(sleptMs, 30000);
  db.close();
});

test('mainLoop in off mode also shortens sleep to 30 seconds when wake file is recent', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  setMode(db, 'off');
  const wakePath = path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake');
  const now = Date.now();

  writeFileSync(wakePath, String(now));
  utimesSync(wakePath, now / 1000, now / 1000);

  let stop = false;
  let sleptMs = null;
  const originalSetTimeout = global.setTimeout;

  global.setTimeout = ((fn, ms, ...args) => {
    sleptMs = ms;
    return originalSetTimeout(() => {
      stop = true;
      fn(...args);
    }, 0);
  });

  try {
    await Promise.race([
      mainLoop(db, () => stop, async () => {
        throw new Error('off mode wake branch should not dispatch work');
      }),
      new Promise((_, reject) => originalSetTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get();
  const leaseCount = db.prepare(`SELECT COUNT(*) AS n FROM task_runs`).get();

  assert.equal(sleptMs, 30000);
  assert.equal(taskCount.n, 0);
  assert.equal(leaseCount.n, 0);
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

test('mainLoop schedules exponential retry for retryable timeout failures', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts)
     VALUES ('retry-backoff', '{}', ?, ?, 'queued', 1)`
  ).run(now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async () => {
      stop = true;
      throw new Error('claude -p timeout after 50ms');
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'retry-backoff'
     ORDER BY id ASC`
  ).all();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].attempts, 2);
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 2);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 120_000);
  db.close();
});

test('mainLoop stops scheduling retries after retry budget is exhausted', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts)
     VALUES ('retry-exhausted', '{}', ?, ?, 'queued', 3)`
  ).run(now - 1000, now - 1000);

  let stop = false;

  await Promise.race([
    mainLoop(db, () => stop, async () => {
      stop = true;
      throw new Error('claude -p timeout after 50ms');
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'retry-exhausted'
     ORDER BY id ASC`
  ).all();

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].attempts, 4);
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  db.close();
});

test('mainLoop dispatches tasks scheduled for the current millisecond', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('edge-now', '{}', ?, ?, 'queued')`
  ).run(now, now);

  let stop = false;
  const seen = [];

  await Promise.race([
    mainLoop(db, () => stop, async (_db, task) => {
      seen.push(task.type);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);

  const row = db.prepare(`SELECT status, attempts FROM tasks WHERE type = 'edge-now'`).get();

  assert.deepEqual(seen, ['edge-now']);
  assert.equal(row.status, 'completed');
  assert.equal(row.attempts, 1);
  db.close();
});

test('callClaudeP spawns configured command and injects internal env', async () => {
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub.mjs');
  writeFileSync(
    script,
    "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',(chunk)=>{input+=chunk;});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({input,internal:process.env.CCMEM_INTERNAL||null,session:process.env.CCMEM_TEST_SESSION_ID||null}));});"
  );

  const raw = await callClaudeP('hello bridge', {
    command: process.execPath,
    args: [script],
    env: { CCMEM_TEST_SESSION_ID: 's-bridge-env' }
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.input, 'hello bridge');
  assert.equal(parsed.internal, '1');
  assert.equal(parsed.session, 's-bridge-env');
});


test('callClaudeP registers explicit child session ids in blacklist before spawn', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub-blacklist.mjs');
  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({session:process.env.CLAUDE_CODE_SESSION_ID||null}));"
  );

  const raw = await callClaudeP('hello bridge', {
    command: process.execPath,
    args: [script],
    env: { CLAUDE_CODE_SESSION_ID: 's-bridge-child' }
  });
  const parsed = JSON.parse(raw);
  const row = db.prepare(
    `SELECT reason, created_at, expires_at
     FROM ccmem_blacklisted_sessions
     WHERE session_id = ?`
  ).get('s-bridge-child');

  assert.equal(parsed.session, 's-bridge-child');
  assert.equal(row.reason, 'cron_llm_child');
  assert.equal(typeof row.created_at, 'number');
  assert.equal(typeof row.expires_at, 'number');
  assert.equal(row.expires_at - row.created_at, 30 * 60 * 1000);
  db.close();
});


test('callClaudeP surfaces non-zero exit with stderr excerpt', async () => {
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub-fail.mjs');
  writeFileSync(
    script,
    "process.stderr.write('bridge failed loudly');process.exit(7);"
  );

  await assert.rejects(
    () => callClaudeP('hello bridge', {
      command: process.execPath,
      args: [script]
    }),
    /claude -p exit 7: bridge failed loudly/
  );
});


test('callClaudeP converts minute-based retry-after into milliseconds', async () => {
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub-rate-limit-minutes.mjs');
  writeFileSync(
    script,
    "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);"
  );

  await assert.rejects(
    () => callClaudeP('hello bridge', {
      command: process.execPath,
      args: [script]
    }),
    (error) => {
      assert.match(error.message, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
      assert.equal(error.retryAfter, 120_000);
      return true;
    }
  );
});


test('callClaudeP defaults retry-after for too many requests errors', async () => {
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub-too-many-requests.mjs');
  writeFileSync(
    script,
    "process.stderr.write('too many requests');process.exit(29);"
  );

  await assert.rejects(
    () => callClaudeP('hello bridge', {
      command: process.execPath,
      args: [script]
    }),
    (error) => {
      assert.match(error.message, /claude -p exit 29: too many requests/);
      assert.equal(error.retryAfter, 60_000);
      return true;
    }
  );
});


test('callClaudeP times out and kills hung subprocesses', async () => {
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-stub-hang.mjs');
  writeFileSync(
    script,
    "process.stdin.resume();setTimeout(() => {}, 1000);"
  );

  await assert.rejects(
    () => callClaudeP('hello bridge', {
      command: process.execPath,
      args: [script],
      timeoutMs: 50
    }),
    /claude -p timeout after 50ms/
  );
});


test('dispatchTask can use configured claude bridge command', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-real-bridge.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-stub.mjs');

  writeFileSync(
    script,
    "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',(chunk)=>{input+=chunk;});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify([{content: input.includes('remember this preference') ? 'Preference captured from bridge' : 'Wrong prompt', type: 'rule', scope: 'project', tags: ['bridge']}]))});"
  );

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        stop = true;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred'
     ORDER BY id DESC
     LIMIT 1`
  ).get();

  assert.equal(memory.content, 'Preference captured from bridge');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['bridge']);
  db.close();
});


test('dispatchTask supersedes a stale summarize_pending bridge result when a newer seq appears during the bridge wait and later applies the newer seq', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-stale.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-stale-bridge.mjs');
  const release = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-stale-bridge.release');

  writeFileSync(
    script,
    [
      "import { existsSync } from 'node:fs';",
      "const release = process.argv[2];",
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "process.stdin.resume();",
      "while (!existsSync(release)) {",
      "  await sleep(10);",
      "}",
      "process.stdout.write(JSON.stringify([{content:'stale bridge result',type:'rule',scope:'project',tags:['stale-bridge']}]))"
    ].join('\n')
  );

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-stale', 'demo/repo', 1, 3, 0, 2, now);

  const inserted = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-stale',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script, release])
  });

  const queuedTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(inserted.lastInsertRowid));
  const runPromise = runTask(db, queuedTask, dispatchTask);

  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const running = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(queuedTask.id);
      if (running?.status === 'running') {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - started > 1000) {
        clearInterval(timer);
        reject(new Error('bridge task did not enter running state'));
      }
    }, 10);
  });

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-stale',
    transcript_path: transcript,
    last_message_seq: 3,
    llm_output: JSON.stringify([{ content: 'fresh bridge result', type: 'rule', scope: 'project', tags: ['fresh-bridge'] }])
  }), now + 1, now + 1);

  writeFileSync(release, 'ok');

  try {
    await runPromise;

    const freshTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND json_extract(payload, '$.session_id') = 's-bridge-stale'
         AND json_extract(payload, '$.last_message_seq') = 3`
    ).get();
    await runTask(db, freshTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const rows = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = 's-bridge-stale'
     ORDER BY id ASC`
  ).all();
  const stale = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'stale bridge result'`
  ).get();
  const fresh = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'fresh bridge result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const applied = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const appliedDetails = JSON.parse(applied.details);
  const audit = db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = 'summarize_pending_superseded'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(release), true);
  assert.deepEqual(rows.map((row) => [row.status, row.last_message_seq]), [
    ['superseded', 2],
    ['completed', 3]
  ]);
  assert.equal(stale.n, 0);
  assert.equal(fresh.content, 'fresh bridge result');
  assert.equal(fresh.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(fresh.tags), ['fresh-bridge']);
  assert.equal(audit.action, 'summarize_pending_superseded');
  assert.equal(details.last_message_seq, 2);
  assert.equal(applied.action, 'summarize_pending_applied');
  assert.equal(appliedDetails.session_id, 's-bridge-stale');
  assert.equal(appliedDetails.last_message_seq, 3);
  assert.equal(appliedDetails.inserted_count, 1);

  db.close();
});

test('dispatchTask re-applies the same summarize_pending seq after a prior bridge run completed', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-completed-retry.jsonl');

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-completed-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-completed-retry',
    transcript_path: transcript,
    last_message_seq: 2,
    llm_output: JSON.stringify([{ content: 'bridge replay result', type: 'rule', scope: 'project', tags: ['bridge-retry'] }])
  }), now - 2000, now - 2000);

  const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
  await runTask(db, firstTask, dispatchTask);

  const second = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-completed-retry',
    transcript_path: transcript,
    last_message_seq: 2,
    llm_output: JSON.stringify([{ content: 'bridge replay result', type: 'rule', scope: 'project', tags: ['bridge-retry'] }])
  }), now - 1000, now - 1000);

  const secondTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(second.lastInsertRowid));
  await runTask(db, secondTask, dispatchTask);

  const rows = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-completed-retry'
     ORDER BY id ASC`
  ).all();
  const memories = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'bridge replay result'
     ORDER BY id ASC`
  ).all();
  const audits = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-completed-retry'
     ORDER BY id ASC`
  ).all();

  assert.deepEqual(rows.map((row) => [row.status, row.last_message_seq]), [
    ['completed', 2],
    ['completed', 2]
  ]);
  assert.equal(memories.length, 2);
  for (const memory of memories) {
    assert.equal(memory.source, 'auto_inferred');
    assert.deepEqual(JSON.parse(memory.tags), ['bridge-retry']);
  }
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    const details = JSON.parse(audit.details);
    assert.equal(details.last_message_seq, 2);
    assert.equal(details.inserted_count, 1);
  }

  db.close();
});

test('dispatchTask registers generated child session ids in blacklist for summarize_pending bridge runs', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-child-session.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-child-session.mjs');

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:process.env.CLAUDE_CODE_SESSION_ID||'missing',type:'rule',scope:'project',tags:['bridge-child']}]))"
  );

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-child-blacklist', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-child-blacklist',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        stop = true;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const memory = db.prepare(
    `SELECT content
     FROM memories
     WHERE source = 'auto_inferred'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const blacklist = db.prepare(
    `SELECT reason, created_at, expires_at
     FROM ccmem_blacklisted_sessions
     WHERE session_id = ?`
  ).get(memory.content);

  assert.match(memory.content, /^[0-9a-f-]{36}$/i);
  assert.equal(blacklist.reason, 'cron_llm_child');
  assert.equal(typeof blacklist.created_at, 'number');
  assert.equal(typeof blacklist.expires_at, 'number');
  assert.equal(blacklist.expires_at - blacklist.created_at, 30 * 60 * 1000);
  db.close();
});


test('dispatchTask marks task failed when configured claude bridge exits non-zero', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-fail.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-fail.mjs');

  writeFileSync(script, "process.stderr.write('task bridge failed');process.exit(9);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-fail', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-fail',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const task = db.prepare(
    `SELECT status, error_excerpt
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-fail'`
  ).get();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(task.status, 'failed');
  assert.match(task.error_excerpt, /claude -p exit 9: task bridge failed/);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask re-applies the same summarize_pending seq after a prior bridge failure', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-fail-retry.jsonl');
  const failScript = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-fail-retry-fail.mjs');

  writeFileSync(failScript, "process.stderr.write('task bridge failed');process.exit(9);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-fail-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-fail-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([failScript])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const second = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-fail-retry',
    transcript_path: transcript,
    last_message_seq: 2,
    llm_output: JSON.stringify([{ content: 'bridge retry result', type: 'rule', scope: 'project', tags: ['bridge-retry'] }])
  }), now - 1000, now - 1000);

  const secondTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(second.lastInsertRowid));
  await runTask(db, secondTask, dispatchTask);

  const rows = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-fail-retry'
     ORDER BY id ASC`
  ).all();
  const memories = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'bridge retry result'
     ORDER BY id ASC`
  ).all();
  const audits = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-fail-retry'
     ORDER BY id ASC`
  ).all();

  assert.deepEqual(rows.map((row) => [row.status, row.last_message_seq]), [
    ['failed', 2],
    ['completed', 2]
  ]);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memories[0].tags), ['bridge-retry']);
  assert.equal(audits.length, 1);
  const details = JSON.parse(audits[0].details);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask schedules retry when configured claude bridge is rate limited', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 1234);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a rate-limit-scheduled retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-retry.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'rate limit retry result',type:'rule',scope:'project',tags:['rate-limit-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-rate-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'rate limit retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-rate-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'rate limit retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['rate-limit-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask defaults rate-limit retry delay to 60 seconds when retry-after is missing', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-default.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-default.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-default', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-default',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-default'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a default-rate-limit retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-default-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-default-retry.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-default-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-default-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'default rate limit retry result',type:'rule',scope:'project',tags:['rate-limit-default-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-rate-default-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-default-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'default rate limit retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-rate-default-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'default rate limit retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['rate-limit-default-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask defaults too-many-requests retry delay to 60 seconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-too-many-requests-default.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-too-many-requests-default.mjs');

  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-too-many-requests-default', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-too-many-requests-default',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-too-many-requests-default'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a too-many-requests retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-too-many-requests-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-too-many-requests-retry.mjs');

  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-too-many-requests-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-too-many-requests-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'too many requests retry result',type:'rule',scope:'project',tags:['too-many-requests-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-too-many-requests-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-too-many-requests-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'too many requests retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-too-many-requests-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'too many requests retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['too-many-requests-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask converts second-based retry-after into milliseconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-seconds.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-seconds.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-seconds', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-seconds',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-seconds'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 2_000);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a second-based retry-after retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-seconds-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-seconds-retry.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-seconds-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-seconds-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'second-based retry result',type:'rule',scope:'project',tags:['rate-limit-seconds-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-rate-seconds-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-seconds-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'second-based retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-rate-seconds-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'second-based retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['rate-limit-seconds-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask converts minute-based retry-after into milliseconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-minutes.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-minutes.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-minutes', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-minutes',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-minutes'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 120_000);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a minute-based retry-after retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-rate-limit-minutes-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-rate-limit-minutes-retry.mjs');

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-rate-minutes-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-rate-minutes-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'minute-based retry result',type:'rule',scope:'project',tags:['rate-limit-minutes-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-rate-minutes-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-rate-minutes-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'minute-based retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-rate-minutes-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'minute-based retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['rate-limit-minutes-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('dispatchTask marks task failed when configured claude bridge times out', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-timeout.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-timeout.mjs');

  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-timeout', 'demo/repo', 1, 3, 0, 2, now);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-timeout',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
    CCMEM_CLAUDE_P_TIMEOUT_MS: '50'
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null,
      CCMEM_CLAUDE_P_TIMEOUT_MS: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-timeout'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  db.close();
});

test('dispatchTask applies summarize_pending after a timeout-scheduled retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'summarize-bridge-timeout-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-task-timeout-retry.mjs');

  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember this preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  );

  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s-bridge-timeout-retry', 'demo/repo', 1, 3, 0, 2, now);

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-bridge-timeout-retry',
    transcript_path: transcript,
    last_message_seq: 2
  }), now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
    CCMEM_CLAUDE_P_TIMEOUT_MS: '50'
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null,
      CCMEM_CLAUDE_P_TIMEOUT_MS: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify([{content:'timeout retry result',type:'rule',scope:'project',tags:['timeout-retry']}]))"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = 's-bridge-timeout-retry'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-bridge-timeout-retry'
     ORDER BY id ASC`
  ).all();
  const memory = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'timeout retry result'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-bridge-timeout-retry'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'timeout retry result');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['timeout-retry']);
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

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
  const leaseKey = weeklyLeaseKey(new Date());
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

test('dispatchTask completes the anchored Sunday weekly lease across ISO week rollover catch-up', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const fixedNow = new Date(2021, 0, 5, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const llmOutput = JSON.stringify({
    synthesized: [
      {
        content: 'Preserve weekly lease alignment',
        type: 'fact',
        scope: 'project',
        output_type: 'rule'
      }
    ]
  });

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
    const leaseKey = weeklyLeaseKey(new Date());
    const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);

    assert.equal(claimed, true);
    assert.notEqual(weekKey(new Date()), leaseKey);

    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
    ).run(JSON.stringify({ llm_output: llmOutput }), fixedNowMs - 1000, fixedNowMs - 1000);

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

    assert.equal(task.status, 'completed');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('dispatchTask keeps weekly completion on the originally claimed lease even if finish time crosses into the next weekly window', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const claimTime = new Date(2021, 0, 5, 3, 18, 0, 0);
  const finishTime = new Date(2021, 0, 10, 3, 18, 0, 0);
  const claimMs = claimTime.getTime();
  const finishMs = finishTime.getTime();
  const OriginalDate = global.Date;
  const llmOutput = JSON.stringify({
    synthesized: [
      {
        content: 'Keep lease completion bound to the claimed window',
        type: 'fact',
        scope: 'project',
        output_type: 'rule'
      }
    ]
  });

  class ClaimDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [claimTime]));
    }

    static now() {
      return claimMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  class FinishDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [finishTime]));
    }

    static now() {
      return finishMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = ClaimDate;

  try {
    const leaseKey = weeklyLeaseKey(new Date());
    const finishLeaseKey = weeklyLeaseKey(finishTime);
    const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);

    assert.equal(claimed, true);
    assert.notEqual(leaseKey, finishLeaseKey);

    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
    ).run(JSON.stringify({ llm_output: llmOutput }), claimMs - 1000, claimMs - 1000);

    global.Date = FinishDate;

    const queuedTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'`
    ).get();

    await runTask(db, queuedTask, dispatchTask);

    const task = db.prepare(
      `SELECT status
       FROM tasks
       WHERE type = 'weekly_synthesis'`
    ).get();
    const claimedLease = db.prepare(
      `SELECT status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis' AND date_key = ?`
    ).get(leaseKey);
    const finishLease = db.prepare(
      `SELECT status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis' AND date_key = ?`
    ).get(finishLeaseKey);

    assert.equal(task.status, 'completed');
    assert.equal(claimedLease.status, 'completed');
    assert.equal(typeof claimedLease.completed_at, 'number');
    assert.equal(finishLease, undefined);
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});


test('dispatchTask can use configured claude bridge command for weekly_synthesis', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-stub.mjs');

  assert.equal(claimed, true);

  writeFileSync(
    script,
    "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',(chunk)=>{input+=chunk;});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({synthesized:[{content: input.includes('memory synthesis assistant') ? 'Weekly bridge rule' : 'Wrong prompt', type: 'fact', scope: 'project', output_type: 'rule'}]}));});"
  );

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

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
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');
  db.close();
});


test('dispatchTask registers generated child session ids in blacklist for weekly_synthesis bridge runs', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-child-session.mjs');
  const sessionFile = path.join(process.env.CCMEM_DATA_ROOT, 'weekly-child-session.txt');

  assert.equal(claimed, true);

  writeFileSync(
    script,
    "import { writeFileSync } from 'node:fs';import path from 'node:path';const sessionId=process.env.CLAUDE_CODE_SESSION_ID||'missing';writeFileSync(path.join(process.env.CCMEM_DATA_ROOT,'weekly-child-session.txt'),sessionId);process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly bridge child session captured',type:'fact',scope:'project',output_type:'rule'}]}));"
  );

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const childSessionId = readFileSync(sessionFile, 'utf8').trim();
  const blacklist = db.prepare(
    `SELECT reason, created_at, expires_at
     FROM ccmem_blacklisted_sessions
     WHERE session_id = ?`
  ).get(childSessionId);

  assert.match(childSessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(blacklist.reason, 'cron_llm_child');
  assert.equal(typeof blacklist.created_at, 'number');
  assert.equal(typeof blacklist.expires_at, 'number');
  assert.equal(blacklist.expires_at - blacklist.created_at, 30 * 60 * 1000);
  db.close();
});


test('dispatchTask marks weekly_synthesis failed when configured claude bridge exits non-zero', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-fail.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('weekly bridge failed');process.exit(11);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const task = db.prepare(
    `SELECT status, error_excerpt
     FROM tasks
     WHERE type = 'weekly_synthesis'`
  ).get();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(task.status, 'failed');
  assert.match(task.error_excerpt, /claude -p exit 11: weekly bridge failed/);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask marks weekly_synthesis failed when configured claude bridge times out', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-timeout.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
    CCMEM_CLAUDE_P_TIMEOUT_MS: '50'
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null,
      CCMEM_CLAUDE_P_TIMEOUT_MS: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask schedules weekly_synthesis retry when configured claude bridge is rate limited', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 1234);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask applies weekly_synthesis after an explicit retry-after retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-retry.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly explicit retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
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

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  assert.equal(audit.action, 'weekly_synthesis_stub');
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');

  db.close();
});

test('dispatchTask defaults weekly_synthesis rate-limit retry delay to 60 seconds when retry-after is missing', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-default.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask applies weekly_synthesis after a default-rate-limit retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-default-retry.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly default retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
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

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  assert.equal(audit.action, 'weekly_synthesis_stub');
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');

  db.close();
});

test('dispatchTask defaults weekly_synthesis too-many-requests retry delay to 60 seconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-too-many-requests-default.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask applies weekly_synthesis after a too-many-requests retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-too-many-requests-retry.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly too many retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
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

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  assert.equal(audit.action, 'weekly_synthesis_stub');
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');

  db.close();
});

test('dispatchTask converts weekly_synthesis second-based retry-after into milliseconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-seconds.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 2_000);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask applies weekly_synthesis after a second-based retry-after retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-seconds-retry.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly second retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
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

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  assert.equal(audit.action, 'weekly_synthesis_stub');
  assert.equal(details.item_count, 1);
  assert.equal(details.first_output_type, 'rule');

  db.close();
});

test('dispatchTask converts weekly_synthesis minute-based retry-after into milliseconds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-minutes.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 1000, now - 1000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  let stop = false;

  try {
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        stop = true;
        await dispatchTask(loopDb, task);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'weekly_synthesis' AND date_key = ?`
  ).get(leaseKey);
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM audit_log
     WHERE action = 'weekly_synthesis_stub'`
  ).get();

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 120_000);
  assert.equal(lease.status, 'running');
  assert.equal(lease.completed_at, null);
  assert.equal(auditCount.n, 0);
  db.close();
});

test('dispatchTask applies weekly_synthesis after a minute-based retry-after retry later succeeds', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const now = Date.now();
  const leaseKey = weeklyLeaseKey(new Date());
  const claimed = tryClaimLease(db, 'weekly_synthesis', leaseKey, RAN_BY.DAEMON);
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-weekly-rate-limit-minutes-retry.mjs');

  assert.equal(claimed, true);

  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");

  const first = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('weekly_synthesis', ?, ?, ?, 'queued')`
  ).run('{}', now - 2000, now - 2000);

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(first.lastInsertRowid));
    await runTask(db, firstTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({synthesized:[{content:'Weekly minute retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
  );
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script])
  });

  try {
    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);
  } finally {
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: null,
      CCMEM_CLAUDE_P_COMMAND: null,
      CCMEM_CLAUDE_P_ARGS_JSON: null
    });
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id ASC`
  ).all();
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

  assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
    ['failed', 1],
    ['completed', 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[1].error_excerpt, null);
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
    `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
     VALUES ('s-expired', 'cron_llm_child', ?, ?),
            ('s-active', 'cron_llm_child', ?, ?)`
  ).run(now - (31 * 60 * 1000), now - 1000, now, now + (30 * 60 * 1000));

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
  const blacklistSessions = db.prepare(
    `SELECT session_id
     FROM ccmem_blacklisted_sessions
     ORDER BY session_id ASC`
  ).all().map((row) => row.session_id);
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
  assert.deepEqual(blacklistSessions, ['s-active']);
  assert.equal(task.status, 'completed');
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  db.close();
});

test('dispatchTask keeps daily completion on the originally claimed lease even if finish time crosses into the next day', async () => {
  const db = openDb();
  resetRuntimeTables(db);
  const claimTime = new Date(2026, 5, 8, 2, 18, 0, 0);
  const finishTime = new Date(2026, 5, 9, 2, 18, 0, 0);
  const claimMs = claimTime.getTime();
  const finishMs = finishTime.getTime();
  const OriginalDate = global.Date;

  class ClaimDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [claimTime]));
    }

    static now() {
      return claimMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  class FinishDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [finishTime]));
    }

    static now() {
      return finishMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = ClaimDate;

  try {
    const leaseKey = dayKey(new Date());
    const finishLeaseKey = dayKey(finishTime);
    const claimed = tryClaimLease(db, 'daily_maintenance', leaseKey, RAN_BY.DAEMON);

    assert.equal(claimed, true);
    assert.notEqual(leaseKey, finishLeaseKey);

    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('daily_maintenance', '{}', ?, ?, 'queued')`
    ).run(claimMs - 1000, claimMs - 1000);

    global.Date = FinishDate;

    const queuedTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'daily_maintenance'`
    ).get();

    await runTask(db, queuedTask, dispatchTask);

    const task = db.prepare(
      `SELECT status
       FROM tasks
       WHERE type = 'daily_maintenance'`
    ).get();
    const claimedLease = db.prepare(
      `SELECT status, completed_at
       FROM task_runs
       WHERE type = 'daily_maintenance' AND date_key = ?`
    ).get(leaseKey);
    const finishLease = db.prepare(
      `SELECT status, completed_at
       FROM task_runs
       WHERE type = 'daily_maintenance' AND date_key = ?`
    ).get(finishLeaseKey);

    assert.equal(task.status, 'completed');
    assert.equal(claimedLease.status, 'completed');
    assert.equal(typeof claimedLease.completed_at, 'number');
    assert.equal(finishLease, undefined);
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('scheduleCronTasks at local 03:17 on Sunday enqueues daily and weekly work once per lease window', () => {
  const db = openDb();
  resetRuntimeTables(db);
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  const sundayMorning = new Date(2026, 5, 7, 3, 17, 0, 0);

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
    { type: 'weekly_synthesis', date_key: weeklyLeaseKey(sundayMorning), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks on Sunday before local 03:17 only enqueues daily maintenance', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const sundayBeforeWeekly = new Date(2026, 5, 7, 3, 16, 0, 0);

  scheduleCronTasks(db, sundayBeforeWeekly);
  scheduleCronTasks(db, sundayBeforeWeekly);

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
    { type: 'daily_maintenance', n: 1 }
  ]);
  assert.deepEqual(leases, [
    { type: 'daily_maintenance', date_key: dayKey(sundayBeforeWeekly), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks before local 02:17 does not enqueue any cron work', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const beforeDaily = new Date(2026, 5, 6, 2, 16, 0, 0);

  scheduleCronTasks(db, beforeDaily);
  scheduleCronTasks(db, beforeDaily);

  const taskCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')`
  ).get();
  const leaseCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM task_runs
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')`
  ).get();

  assert.equal(taskCount.n, 0);
  assert.equal(leaseCount.n, 0);

  db.close();
});

test('scheduleCronTasks at local 02:17 on non-Sunday enqueues daily maintenance under the local calendar day lease', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const dailyBoundary = new Date(2026, 5, 8, 2, 17, 0, 0);
  const localDailyLeaseKey = '2026-06-08';

  scheduleCronTasks(db, dailyBoundary);
  scheduleCronTasks(db, dailyBoundary);

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
  const tasks = db.prepare(
    `SELECT type, payload
     FROM tasks
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')
     ORDER BY type ASC`
  ).all().map((row) => ({
    type: row.type,
    payload: JSON.parse(row.payload)
  }));

  assert.deepEqual(taskCounts, [
    { type: 'daily_maintenance', n: 1 }
  ]);
  assert.deepEqual(leases, [
    { type: 'daily_maintenance', date_key: localDailyLeaseKey, ran_by: 'daemon', status: 'running' }
  ]);
  assert.deepEqual(tasks, [
    { type: 'daily_maintenance', payload: { lease_key: localDailyLeaseKey } }
  ]);

  db.close();
});

test('scheduleCronTasks on Monday before local 03:17 does not catch up weekly synthesis yet', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const mondayBeforeWeeklyHour = new Date(2026, 5, 8, 3, 16, 0, 0);

  scheduleCronTasks(db, mondayBeforeWeeklyHour);
  scheduleCronTasks(db, mondayBeforeWeeklyHour);

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
    { type: 'daily_maintenance', n: 1 }
  ]);
  assert.deepEqual(leases, [
    { type: 'daily_maintenance', date_key: dayKey(mondayBeforeWeeklyHour), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks at local 03:17 on Monday catches up weekly synthesis once per week lease window', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const mondayBoundary = new Date(2026, 5, 8, 3, 17, 0, 0);

  scheduleCronTasks(db, mondayBoundary);
  scheduleCronTasks(db, mondayBoundary);

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
    { type: 'daily_maintenance', date_key: dayKey(mondayBoundary), ran_by: 'daemon', status: 'running' },
    { type: 'weekly_synthesis', date_key: weeklyLeaseKey(mondayBoundary), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks on Monday after local 03:17 catches up weekly synthesis once per week lease window', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const mondayAfterWeeklyHour = new Date(2026, 5, 8, 3, 18, 0, 0);

  scheduleCronTasks(db, mondayAfterWeeklyHour);
  scheduleCronTasks(db, mondayAfterWeeklyHour);

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
    { type: 'daily_maintenance', date_key: dayKey(mondayAfterWeeklyHour), ran_by: 'daemon', status: 'running' },
    { type: 'weekly_synthesis', date_key: weeklyLeaseKey(mondayAfterWeeklyHour), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks keeps weekly catch-up under the same Sunday lease across later weekdays', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const sundayBoundary = new Date(2026, 5, 7, 3, 17, 0, 0);
  const mondayAfterWeeklyHour = new Date(2026, 5, 8, 3, 18, 0, 0);
  const tuesdayAfterWeeklyHour = new Date(2026, 5, 9, 3, 18, 0, 0);

  scheduleCronTasks(db, mondayAfterWeeklyHour);
  scheduleCronTasks(db, tuesdayAfterWeeklyHour);

  const weeklyTaskCount = db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'weekly_synthesis'`
  ).get();
  const weeklyLeases = db.prepare(
    `SELECT date_key, ran_by, status
     FROM task_runs
     WHERE type = 'weekly_synthesis'
     ORDER BY date_key ASC`
  ).all().map((row) => ({
    date_key: row.date_key,
    ran_by: row.ran_by,
    status: row.status
  }));

  assert.equal(weeklyTaskCount.n, 1);
  assert.deepEqual(weeklyLeases, [
    { date_key: weeklyLeaseKey(sundayBoundary), ran_by: 'daemon', status: 'running' }
  ]);

  db.close();
});

test('scheduleCronTasks persists the anchored Sunday lease key in cron task payload across ISO week rollover catch-up', () => {
  const db = openDb();
  resetRuntimeTables(db);
  const tuesdayAfterIsoRollover = new Date(2021, 0, 5, 3, 18, 0, 0);

  scheduleCronTasks(db, tuesdayAfterIsoRollover);
  scheduleCronTasks(db, tuesdayAfterIsoRollover);

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
  const tasks = db.prepare(
    `SELECT type, payload
     FROM tasks
     WHERE type IN ('daily_maintenance', 'weekly_synthesis')
     ORDER BY type ASC`
  ).all().map((row) => ({
    type: row.type,
    payload: JSON.parse(row.payload)
  }));

  assert.notEqual(weekKey(tuesdayAfterIsoRollover), weeklyLeaseKey(tuesdayAfterIsoRollover));
  assert.deepEqual(taskCounts, [
    { type: 'daily_maintenance', n: 1 },
    { type: 'weekly_synthesis', n: 1 }
  ]);
  assert.deepEqual(leases, [
    { type: 'daily_maintenance', date_key: dayKey(tuesdayAfterIsoRollover), ran_by: 'daemon', status: 'running' },
    { type: 'weekly_synthesis', date_key: weeklyLeaseKey(tuesdayAfterIsoRollover), ran_by: 'daemon', status: 'running' }
  ]);
  assert.deepEqual(tasks, [
    { type: 'daily_maintenance', payload: { lease_key: dayKey(tuesdayAfterIsoRollover) } },
    { type: 'weekly_synthesis', payload: { lease_key: weeklyLeaseKey(tuesdayAfterIsoRollover) } }
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
