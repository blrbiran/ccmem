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

test('prompt-submit retrieves relevant memories and records recent injections', async () => {
  const db = openDb();
  const saved = await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });

  await handleSessionStart({ cwd: process.cwd(), session_id: 's-retrieval' });
  const result = await handlePromptSubmit({
    cwd: process.cwd(),
    session_id: 's-retrieval',
    prompt: 'add a route under app api'
  });
  const injection = db.prepare(
    `SELECT prompt_idx, inject_source, mem_ids
     FROM recent_injections
     WHERE session_id = 's-retrieval' AND inject_source = 'user_prompt_submit'`
  ).get();
  const feedback = db.prepare(
    `SELECT injection_source, injected_ids, outcome
     FROM memory_feedback
     WHERE session_id = 's-retrieval'`
  ).get();
  const session = db.prepare(
    `SELECT session_id, project_key
     FROM session_context
     WHERE session_id = 's-retrieval'`
  ).get();

  assert.match(result.additionalContext, /app\/api/);
  assert.equal(injection.prompt_idx, 1);
  assert.equal(injection.inject_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(injection.mem_ids), [saved.id]);
  assert.equal(feedback.injection_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(feedback.injected_ids), [saved.id]);
  assert.equal(feedback.outcome, 'unknown');
  assert.equal(session.session_id, 's-retrieval');
  assert.equal(typeof session.project_key, 'string');
  db.close();
});

test('prompt-submit infers previous negative feedback from a correction prompt', async () => {
  const db = openDb();
  const saved = await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });

  await handlePromptSubmit({
    cwd: process.cwd(),
    session_id: 's-feedback',
    prompt: 'add a route under app api'
  });
  const before = db.prepare(`SELECT trust_score FROM memories WHERE id = ?`).get(saved.id);

  const result = await handlePromptSubmit({
    cwd: process.cwd(),
    session_id: 's-feedback',
    prompt: '错了，重做'
  });
  const feedback = db.prepare(
    `SELECT outcome, evidence
     FROM memory_feedback
     WHERE session_id = 's-feedback'`
  ).get();
  const after = db.prepare(`SELECT trust_score FROM memories WHERE id = ?`).get(saved.id);
  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-feedback'`
  ).get();

  assert.equal(result.additionalContext, '');
  assert.equal(feedback.outcome, 'unhelpful');
  assert.equal(feedback.evidence, 'neg_keyword');
  assert.equal(after.trust_score < before.trust_score, true);
  assert.equal(injections.n, 1);
  db.close();
});


test('prompt-submit in off mode stays read-only and returns no injected context', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  setMode(db, 'off');

  const output = spawnSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-off',
        prompt: 'add a route under app api'
      })
    }
  );

  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-off'`
  ).get();
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = 's-off'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-off'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(injections.n, 0);
  assert.equal(feedback.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('prompt-submit hook exits early under CCMEM_INTERNAL and stays read-only', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  setMode(db, 'active');

  const output = spawnSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT,
        CCMEM_INTERNAL: '1'
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-internal',
        prompt: 'add a route under app api'
      })
    }
  );

  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-internal'`
  ).get();
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = 's-internal'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-internal'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(injections.n, 0);
  assert.equal(feedback.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('prompt-submit in shadow mode stays read-only and does not infer feedback', async () => {
  const db = openDb();
  const saved = await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  setMode(db, 'shadow');

  const before = db.prepare(`SELECT trust_score FROM memories WHERE id = ?`).get(saved.id);
  const result = await handlePromptSubmit({
    cwd: process.cwd(),
    session_id: 's-shadow',
    prompt: 'add a route under app api'
  });
  const after = db.prepare(`SELECT trust_score FROM memories WHERE id = ?`).get(saved.id);
  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-shadow'`
  ).get();
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = 's-shadow'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-shadow'`
  ).get();

  assert.equal(result.additionalContext, '');
  assert.equal(after.trust_score, before.trust_score);
  assert.equal(injections.n, 0);
  assert.equal(feedback.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('prompt-submit hook in shadow mode stays read-only and emits diagnostic notice', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  setMode(db, 'shadow');

  const output = spawnSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-shadow-hook',
        prompt: 'add a route under app api'
      })
    }
  );

  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-shadow-hook'`
  ).get();
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = 's-shadow-hook'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-shadow-hook'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"UserPromptSubmit"/);
  assert.match(output.stderr, /ccmem: mode=shadow \(read-only diagnostic — no writes, no inject\)/);
  assert.equal(injections.n, 0);
  assert.equal(feedback.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('prompt-submit hook exits early for sessions blacklisted by daemon bridge child ids', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });

  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-prompt-submit-blacklist-child.mjs');
  writeFileSync(script, "process.stdout.write(process.env.CLAUDE_CODE_SESSION_ID || '')");

  const childSessionId = (await callClaudeP('hello bridge', {
    command: NODE,
    args: [script]
  })).trim();

  const output = execFileSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: childSessionId,
        prompt: 'add a route under app api'
      })
    }
  );

  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = ?`
  ).get(childSessionId);
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = ?`
  ).get(childSessionId);
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = ?`
  ).get(childSessionId);

  assert.match(childSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(output, /"hookEventName":"UserPromptSubmit"/);
  assert.equal(injections.n, 0);
  assert.equal(feedback.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('prompt-submit hook ignores expired blacklisted sessions and proceeds normally', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  setMode(db, 'active');
  const now = Date.now();

  db.prepare(
    `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
     VALUES (?, 'cron_llm_child', ?, ?)`
  ).run('s-expired', now, now - 1000);

  const output = execFileSync(
    NODE,
    [HOOK, 'prompt-submit'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-expired',
        prompt: 'add a route under app api'
      })
    }
  );

  const injections = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = ?`
  ).get('s-expired');
  const feedback = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memory_feedback
     WHERE session_id = ?`
  ).get('s-expired');
  const blacklist = db.prepare(
    `SELECT COUNT(*) AS n
     FROM ccmem_blacklisted_sessions
     WHERE session_id = ?`
  ).get('s-expired');

  assert.match(output, /"hookEventName":"UserPromptSubmit"/);
  assert.match(output, /app\/api/);
  assert.equal(injections.n, 1);
  assert.equal(feedback.n, 1);
  assert.equal(blacklist.n, 1);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
