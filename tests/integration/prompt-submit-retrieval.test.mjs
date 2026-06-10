import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-retrieval-'));

const NODE = '/usr/local/bin/node';
const HOOK = '/Users/biran/code/skills/ccmem/scripts/hook.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

function withEnv(key, value, work) {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return work();
  } finally {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

async function saveProjectFact(content) {
  const db = openDb();
  try {
    return await cmdSave(db, {
      cwd: process.cwd(),
      content,
      scope: 'project',
      type: 'fact'
    });
  } finally {
    db.close();
  }
}

function readOne(sql, ...params) {
  const db = openDb();
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function readCount(sql, ...params) {
  return readOne(sql, ...params).n;
}

function setStoredMode(mode) {
  const db = openDb();
  try {
    setMode(db, mode);
  } finally {
    db.close();
  }
}

async function runPromptSubmit(input) {
  return await handlePromptSubmit(input);
}

function spawnPromptSubmitHook(input, extraEnv = {}) {
  return spawnSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT,
        ...extraEnv
      },
      encoding: 'utf8',
      input: JSON.stringify(input)
    }
  );
}

function execPromptSubmitHook(input, extraEnv = {}) {
  return execFileSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT,
        ...extraEnv
      },
      encoding: 'utf8',
      input: JSON.stringify(input)
    }
  );
}

test('prompt-submit retrieves relevant memories and records recent injections', async () => {
  const saved = await saveProjectFact('API routes live under /app/api');

  await handleSessionStart({ cwd: process.cwd(), session_id: 's-retrieval' });
  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 's-retrieval',
    prompt: 'add a route under app api'
  });
  const injection = readOne(
    `SELECT prompt_idx, inject_source, mem_ids
     FROM recent_injections
     WHERE session_id = 's-retrieval' AND inject_source = 'user_prompt_submit'`
  );
  const feedback = readOne(
    `SELECT injection_source, injected_ids, outcome
     FROM memory_feedback
     WHERE session_id = 's-retrieval'`
  );
  const session = readOne(
    `SELECT session_id, project_key
     FROM session_context
     WHERE session_id = 's-retrieval'`
  );

  assert.match(result.additionalContext, /app\/api/);
  assert.equal(injection.prompt_idx, 1);
  assert.equal(injection.inject_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(injection.mem_ids), [saved.id]);
  assert.equal(feedback.injection_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(feedback.injected_ids), [saved.id]);
  assert.equal(feedback.outcome, 'unknown');
  assert.equal(session.session_id, 's-retrieval');
  assert.equal(typeof session.project_key, 'string');
});

test('prompt-submit infers previous negative feedback from a correction prompt', async () => {
  const saved = await saveProjectFact('API routes live under /app/api');

  await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 's-feedback',
    prompt: 'add a route under app api'
  });
  const before = readOne(`SELECT trust_score FROM memories WHERE id = ?`, saved.id);

  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 's-feedback',
    prompt: '错了，重做'
  });
  const feedback = readOne(
    `SELECT outcome, evidence
     FROM memory_feedback
     WHERE session_id = 's-feedback'`
  );
  const after = readOne(`SELECT trust_score FROM memories WHERE id = ?`, saved.id);
  const injections = readOne(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-feedback'`
  );

  assert.equal(result.additionalContext, '');
  assert.equal(feedback.outcome, 'unhelpful');
  assert.equal(feedback.evidence, 'neg_keyword');
  assert.equal(after.trust_score < before.trust_score, true);
  assert.equal(injections.n, 1);
});


test('prompt-submit in off mode stays read-only and returns no injected context', async () => {
  await saveProjectFact('API routes live under /app/api');
  setStoredMode('off');

  const output = spawnPromptSubmitHook({
    cwd: process.cwd(),
    session_id: 's-off',
    prompt: 'add a route under app api'
  });

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-off'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = 's-off'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM session_context WHERE session_id = 's-off'`), 0);
});

test('prompt-submit hook exits early under CCMEM_INTERNAL and stays read-only', async () => {
  await saveProjectFact('API routes live under /app/api');
  setStoredMode('active');

  const output = spawnPromptSubmitHook(
    {
      cwd: process.cwd(),
      session_id: 's-internal',
      prompt: 'add a route under app api'
    },
    { CCMEM_INTERNAL: '1' }
  );

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-internal'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = 's-internal'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM session_context WHERE session_id = 's-internal'`), 0);
});

test('prompt-submit in shadow mode stays read-only and does not infer feedback', async () => {
  const saved = await saveProjectFact('API routes live under /app/api');
  setStoredMode('shadow');

  const before = readOne(`SELECT trust_score FROM memories WHERE id = ?`, saved.id);
  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 's-shadow',
    prompt: 'add a route under app api'
  });
  const after = readOne(`SELECT trust_score FROM memories WHERE id = ?`, saved.id);

  assert.equal(result.additionalContext, '');
  assert.equal(after.trust_score, before.trust_score);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-shadow'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = 's-shadow'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM session_context WHERE session_id = 's-shadow'`), 0);
});

test('prompt-submit hook in shadow mode stays read-only and emits diagnostic notice', async () => {
  await saveProjectFact('API routes live under /app/api');
  setStoredMode('shadow');

  const output = spawnPromptSubmitHook({
    cwd: process.cwd(),
    session_id: 's-shadow-hook',
    prompt: 'add a route under app api'
  });

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.match(output.stderr, /ccmem: mode=shadow \(read-only diagnostic — no writes, no inject\)/);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-shadow-hook'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = 's-shadow-hook'`), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM session_context WHERE session_id = 's-shadow-hook'`), 0);
});

test('prompt-submit hook exits early for sessions blacklisted by daemon bridge child ids', async () => {
  await saveProjectFact('API routes live under /app/api');

  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-prompt-submit-blacklist-child.mjs');
  writeFileSync(script, "process.stdout.write(process.env.CLAUDE_CODE_SESSION_ID || '')");

  const childSessionId = (await callClaudeP('hello bridge', {
    command: NODE,
    args: [script]
  })).trim();

  const output = execPromptSubmitHook({
    cwd: process.cwd(),
    session_id: childSessionId,
    prompt: 'add a route under app api'
  });

  assert.match(childSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(output, /"hookEventName":"UserPromptSubmit"/);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = ?`, childSessionId), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = ?`, childSessionId), 0);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM session_context WHERE session_id = ?`, childSessionId), 0);
});

test('prompt-submit hook ignores expired blacklisted sessions and proceeds normally', async () => {
  await saveProjectFact('API routes live under /app/api');
  setStoredMode('active');
  const now = Date.now();

  const db = openDb();
  db.prepare(
    `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
     VALUES (?, 'cron_llm_child', ?, ?)`
  ).run('s-expired', now, now - 1000);
  db.close();

  const output = execPromptSubmitHook({
    cwd: process.cwd(),
    session_id: 's-expired',
    prompt: 'add a route under app api'
  });

  assert.match(output, /"hookEventName":"UserPromptSubmit"/);
  assert.match(output, /app\/api/);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = ?`, 's-expired'), 1);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM memory_feedback WHERE session_id = ?`, 's-expired'), 1);
  assert.equal(readCount(`SELECT COUNT(*) AS n FROM ccmem_blacklisted_sessions WHERE session_id = ?`, 's-expired'), 1);
});

test('prompt-submit falls back to non-FTS retrieval when FTS5 is unavailable', async () => {
  await withEnv('CCMEM_DISABLE_FTS5', '1', async () => {
    const saved = await saveProjectFact('Semantic fallback remembers API route handlers under /app/api');
    await handleSessionStart({ cwd: process.cwd(), session_id: 's-no-fts' });

    const result = await runPromptSubmit({
      cwd: process.cwd(),
      session_id: 's-no-fts',
      prompt: 'where should I add api route handlers'
    });
    const injection = readOne(
      `SELECT prompt_idx, inject_source, mem_ids
       FROM recent_injections
       WHERE session_id = 's-no-fts' AND inject_source = 'user_prompt_submit'`
    );

    assert.match(result.additionalContext, /app\/api/);
    assert.equal(injection.prompt_idx, 1);
    assert.equal(injection.inject_source, 'user_prompt_submit');
    assert.equal(JSON.parse(injection.mem_ids).includes(saved.id), true);
  });
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
