import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-stop-hook-'));
const transcript = path.join(dataRoot, 'session.jsonl');
const wakePath = path.join(dataRoot, 'daemon.wake');
writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const HOOK = '/Users/biran/code/skills/ccmem/scripts/hook.mjs';

async function openStopDb() {
  process.env.CCMEM_TEST_MODE = '1';
  process.env.CCMEM_DATA_ROOT = dataRoot;
  const { openDb } = await import('../../scripts/lib/db.mjs');
  return openDb();
}

async function resetStopState() {
  const db = await openStopDb();
  try {
    db.prepare(`DELETE FROM tasks`).run();
    db.prepare(`DELETE FROM session_context`).run();
    db.prepare(`DELETE FROM memory_feedback`).run();
    db.prepare(`DELETE FROM recent_injections`).run();
    db.prepare(`DELETE FROM memories`).run();
    db.prepare(`DELETE FROM ccmem_blacklisted_sessions`).run();
    db.prepare(`DELETE FROM config_kv WHERE key = 'mode'`).run();
  } finally {
    db.close();
  }

  rmSync(wakePath, { force: true });
}

async function setStoredMode(mode) {
  const { setMode } = await import('../../scripts/lib/mode.mjs');
  const db = await openStopDb();
  try {
    setMode(db, mode);
  } finally {
    db.close();
  }
}

async function seedBlacklistedSession(sessionId, expiresAtOffsetMs = 30 * 60 * 1000) {
  const db = await openStopDb();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
       VALUES (?, 'cron_llm_child', ?, ?)`
    ).run(sessionId, now, now + expiresAtOffsetMs);
  } finally {
    db.close();
  }
}

async function loadStopCounts(sessionId) {
  const db = await openStopDb();
  try {
    return {
      task: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE type='summarize_pending'").get(),
      ctx: db.prepare("SELECT COUNT(*) AS n FROM session_context WHERE session_id = ?").get(sessionId),
      feedback: db.prepare("SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = ?").get(sessionId),
      blacklist: db.prepare("SELECT COUNT(*) AS n FROM ccmem_blacklisted_sessions WHERE session_id = ?").get(sessionId)
    };
  } finally {
    db.close();
  }
}

function runStopHook({ sessionId, transcriptPath = transcript, extraEnv = env }) {
  return spawnSync(
    NODE,
    [HOOK, 'stop'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: extraEnv,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: '/Users/biran/code/skills/ccmem'
      })
    }
  );
}

async function seedStopMemoryFeedback({ sessionId, content, inject = false }) {
  const db = await openStopDb();
  const now = Date.now();
  try {
    const inserted = db.prepare(
      `INSERT INTO memories (
        scope, project_key, type, content, pinned, source, trust_score,
        decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at
      ) VALUES ('project', 'demo/repo', 'fact', ?, 0, 'user_explicit', 0.9,
        'active', 0, 0, ?, ?, ?)`
    ).run(content, now, now, now);
    const id = Number(inserted.lastInsertRowid);

    db.prepare(
      `INSERT INTO memory_feedback (
        session_id, injection_source, injected_ids, outcome, recorded_at
      ) VALUES (?, 'user_prompt_submit', ?, 'unknown', ?)`
    ).run(sessionId, JSON.stringify([id]), now);

    if (inject) {
      db.prepare(
        `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
         VALUES (?, 1, 'user_prompt_submit', ?, ?)`
      ).run(sessionId, JSON.stringify([id]), now);
    }

    return id;
  } finally {
    db.close();
  }
}

test('hook.mjs stop writes hook output and DB side effects', async () => {
  await resetStopState();

  const result = runStopHook({ sessionId: 's-hook' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);

  const counts = await loadStopCounts('s-hook');
  assert.equal(counts.task.n, 1);
  assert.equal(counts.ctx.n, 1);
  assert.equal(existsSync(wakePath), true);
});

test('hook.mjs stop in off mode stays read-only and emits no notice', async () => {
  await resetStopState();
  await setStoredMode('off');

  const result = runStopHook({ sessionId: 's-off' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.doesNotMatch(result.stderr, /ccmem:/);

  const counts = await loadStopCounts('s-off');
  assert.equal(counts.task.n, 0);
  assert.equal(counts.ctx.n, 0);
  assert.equal(counts.feedback.n, 0);
  assert.equal(existsSync(wakePath), false);
});

test('hook.mjs stop in shadow mode stays read-only and emits diagnostic notice', async () => {
  await resetStopState();
  await setStoredMode('shadow');

  const result = runStopHook({ sessionId: 's-shadow' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.match(result.stderr, /ccmem: mode=shadow \(read-only diagnostic — no writes, no inject\)/);

  const counts = await loadStopCounts('s-shadow');
  assert.equal(counts.task.n, 0);
  assert.equal(counts.ctx.n, 0);
  assert.equal(counts.feedback.n, 0);
  assert.equal(existsSync(wakePath), false);
});

test('hook.mjs stop exits early under CCMEM_INTERNAL and stays read-only', async () => {
  await resetStopState();

  const result = runStopHook({
    sessionId: 's-internal',
    extraEnv: { ...env, CCMEM_INTERNAL: '1' }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.equal(result.stderr, '');

  const counts = await loadStopCounts('s-internal');
  assert.equal(counts.task.n, 0);
  assert.equal(counts.ctx.n, 0);
  assert.equal(counts.feedback.n, 0);
  assert.equal(existsSync(wakePath), false);
});

test('hook.mjs stop exits early for blacklisted sessions and stays read-only', async () => {
  await resetStopState();
  await seedBlacklistedSession('s-blacklisted');

  const result = runStopHook({ sessionId: 's-blacklisted' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.doesNotMatch(result.stderr, /ccmem:/);

  const counts = await loadStopCounts('s-blacklisted');
  assert.equal(counts.task.n, 0);
  assert.equal(counts.ctx.n, 0);
  assert.equal(counts.feedback.n, 0);
  assert.equal(counts.blacklist.n, 1);
  assert.equal(existsSync(wakePath), false);
});

test('hook.mjs stop ignores expired blacklisted sessions and proceeds normally', async () => {
  await resetStopState();
  await seedBlacklistedSession('s-expired', -1000);

  const result = runStopHook({ sessionId: 's-expired' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.doesNotMatch(result.stderr, /ccmem:/);

  const counts = await loadStopCounts('s-expired');
  assert.equal(counts.task.n, 1);
  assert.equal(counts.ctx.n, 1);
  assert.equal(counts.feedback.n, 0);
  assert.equal(counts.blacklist.n, 1);
  assert.equal(existsSync(wakePath), true);
});

test('hook.mjs stop exits early for sessions blacklisted by daemon bridge child ids', async () => {
  await resetStopState();

  process.env.CCMEM_TEST_MODE = '1';
  process.env.CCMEM_DATA_ROOT = dataRoot;
  const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
  const script = path.join(dataRoot, 'claude-stop-blacklist-child.mjs');
  writeFileSync(script, "process.stdout.write(process.env.CLAUDE_CODE_SESSION_ID || '')");

  const childSessionId = (await callClaudeP('hello bridge', {
    command: NODE,
    args: [script]
  })).trim();

  const result = runStopHook({ sessionId: childSessionId });

  assert.match(childSessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"hookEventName":"Stop"/);
  assert.doesNotMatch(result.stderr, /ccmem:/);

  const counts = await loadStopCounts(childSessionId);
  assert.equal(counts.task.n, 0);
  assert.equal(counts.ctx.n, 0);
  assert.equal(counts.feedback.n, 0);
  assert.equal(counts.blacklist.n, 1);
  assert.equal(existsSync(wakePath), false);
});

test('hook.mjs stop marks self-corrected feedback as unhelpful', async () => {
  await resetStopState();
  const sessionId = 's-l2';
  const transcriptL2 = path.join(dataRoot, 'session-l2.jsonl');
  writeFileSync(
    transcriptL2,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Actually, I was wrong."}]}}\n'
  );
  const memoryId = await seedStopMemoryFeedback({
    sessionId,
    content: 'API routes live under /app/api'
  });

  const result = runStopHook({ sessionId, transcriptPath: transcriptL2 });

  assert.equal(result.status, 0);

  const db = await openStopDb();
  try {
    const feedback = db.prepare(
      `SELECT outcome, evidence FROM memory_feedback WHERE session_id = ?`
    ).get(sessionId);
    const memory = db.prepare(
      `SELECT unhelpful_count, trust_score FROM memories WHERE id = ?`
    ).get(memoryId);
    assert.equal(feedback.outcome, 'unhelpful');
    assert.equal(feedback.evidence, 'assistant_self_correction');
    assert.equal(memory.unhelpful_count, 1);
    assert.equal(memory.trust_score, 0.8);
  } finally {
    db.close();
  }
});

test('hook.mjs stop marks referenced memory as helpful implicit and wakes daemon', async () => {
  await resetStopState();
  const sessionId = 's-l25';
  const transcriptL25 = path.join(dataRoot, 'session-l25.jsonl');
  writeFileSync(
    transcriptL25,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"As a reminder, API routes live under /app/api for this repo."}]}}\n'
  );
  const memoryId = await seedStopMemoryFeedback({
    sessionId,
    content: 'API routes live under /app/api',
    inject: true
  });

  const result = runStopHook({ sessionId, transcriptPath: transcriptL25 });

  assert.equal(result.status, 0);

  const db = await openStopDb();
  try {
    const feedback = db.prepare(
      `SELECT outcome, evidence FROM memory_feedback WHERE session_id = ?`
    ).get(sessionId);
    const memory = db.prepare(
      `SELECT helpful_count, trust_score FROM memories WHERE id = ?`
    ).get(memoryId);
    const task = db.prepare(
      `SELECT type FROM tasks WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?`
    ).get(sessionId);
    assert.equal(feedback.outcome, 'helpful_implicit');
    assert.equal(feedback.evidence, 'assistant_reference');
    assert.equal(memory.helpful_count, 1);
    assert.equal(memory.trust_score, 0.925);
    assert.equal(task.type, 'summarize_pending');
    assert.equal(existsSync(wakePath), true);
  } finally {
    db.close();
  }
});

test('hook.mjs stop dedupes summarize_pending for the same session and transcript seq', async () => {
  await resetStopState();

  const sessionId = 's-dedupe';
  const first = runStopHook({ sessionId });
  const second = runStopHook({ sessionId });

  assert.equal(first.status, 0);
  assert.equal(second.status, 0);

  const db = await openStopDb();
  try {
    const tasks = db.prepare(
      `SELECT COUNT(*) AS n
       FROM tasks
       WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?`
    ).get(sessionId);
    const task = db.prepare(
      `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
       FROM tasks
       WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?`
    ).get(sessionId);
    const ctx = db.prepare(
      `SELECT COUNT(*) AS n
       FROM session_context
       WHERE session_id = ?`
    ).get(sessionId);

    assert.equal(tasks.n, 1);
    assert.equal(task.status, 'queued');
    assert.equal(task.last_message_seq, 1);
    assert.equal(ctx.n, 1);
    assert.equal(existsSync(wakePath), true);
  } finally {
    db.close();
  }
});

test('hook.mjs stop enqueues a fresh summarize_pending task after transcript seq advances', async () => {
  await resetStopState();

  const sessionId = 's-dedupe-advance';
  const first = runStopHook({ sessionId });
  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}\n'
  );
  const second = runStopHook({ sessionId });

  assert.equal(first.status, 0);
  assert.equal(second.status, 0);

  const db = await openStopDb();
  try {
    const tasks = db.prepare(
      `SELECT json_extract(payload, '$.last_message_seq') AS last_message_seq
       FROM tasks
       WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?
       ORDER BY id ASC`
    ).all(sessionId);

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].last_message_seq, 1);
    assert.equal(tasks[1].last_message_seq, 2);
  } finally {
    db.close();
    writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  }
});

test('hook.mjs stop re-enqueues the same summarize_pending seq after the prior task completed', async () => {
  await resetStopState();

  const sessionId = 's-dedupe-completed';
  const first = runStopHook({ sessionId });

  assert.equal(first.status, 0);

  const db = await openStopDb();
  try {
    db.prepare(
      `UPDATE tasks
       SET status = 'completed', finished_at = ?
       WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now(), sessionId);
  } finally {
    db.close();
  }

  const second = runStopHook({ sessionId });
  assert.equal(second.status, 0);

  const verifyDb = await openStopDb();
  try {
    const tasks = verifyDb.prepare(
      `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
       FROM tasks
       WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?
       ORDER BY id ASC`
    ).all(sessionId);

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].status, 'completed');
    assert.equal(tasks[0].last_message_seq, 1);
    assert.equal(tasks[1].status, 'queued');
    assert.equal(tasks[1].last_message_seq, 1);
  } finally {
    verifyDb.close();
  }
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
