import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-retrieval-'));

const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'scripts/hook.mjs');

const { openDb } = await import('../../scripts/lib/db.mjs');
const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { getContextFilePath, CONTEXT_EMPTY_SENTINEL } = await import('../../scripts/lib/context-file.mjs');
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
      cwd: ROOT,
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
      cwd: ROOT,
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
    `SELECT prompt_idx, inject_source, mem_ids, scores
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

  const contextPath = getContextFilePath(process.cwd(), 's-retrieval');

  assert.equal(result.additionalContext, '');
  assert.equal(existsSync(contextPath), true);
  assert.match(readFileSync(contextPath, 'utf8'), /app\/api/);
  assert.equal(injection.prompt_idx, 1);
  assert.equal(injection.inject_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(injection.mem_ids), [saved.id]);
  assert.equal(injection.scores, null);
  assert.equal(feedback.injection_source, 'user_prompt_submit');
  assert.deepEqual(JSON.parse(feedback.injected_ids), [saved.id]);
  assert.equal(feedback.outcome, 'unknown');
  assert.equal(session.session_id, 's-retrieval');
  assert.equal(typeof session.project_key, 'string');
});

test('prompt-submit reports B-off metrics when embedding is disabled', async () => {
  await saveProjectFact('Workspace routes live under /app/api for lexical retrieval');

  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 's-b-off',
    prompt: 'workspace app api route'
  });

  assert.equal(result.additionalContext, '');
  assert.equal(result._metricFields.retrieval_path, 'B-off');
  assert.equal(result._metricFields.retrieval_embed_error, null);
  assert.equal(result._metricFields.retrieval_fallback, false);
});

test('prompt-submit reports B-circuit metrics when embedding circuit is open', async () => {
  await saveProjectFact('Circuit-open retrieval should still find lexical route memory');
  const db = openDb();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.circuit_open_until', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(String(Date.now() + 60000), Date.now());
  db.close();

  const configPath = path.join(process.env.CCMEM_DATA_ROOT, 'circuit-open-config.json');
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  const previousKey = process.env.OPENAI_API_KEY;
  writeFileSync(configPath, JSON.stringify({
    injection: { file_based: true },
    embedding: {
      enabled: true,
      provider: 'openai',
      openai_api_key: 'test-key',
      openai_base_url: 'http://127.0.0.1:1'
    }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const result = await runPromptSubmit({
      cwd: process.cwd(),
      session_id: 's-b-circuit',
      prompt: 'find lexical route memory under circuit open'
    });

    assert.equal(result.additionalContext, '');
    assert.equal(result._metricFields.retrieval_path, 'B-circuit');
    assert.equal(result._metricFields.retrieval_embed_error, null);
    assert.equal(result._metricFields.retrieval_fallback, false);
  } finally {
    if (previousConfigPath == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
    if (previousKey == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});

test('prompt-submit keeps session-scoped context files isolated across sessions', async () => {
  await saveProjectFact('Session A unique token qqqalphaonly remembers alpha route');
  await saveProjectFact('Session B unique token zzzbetaonly remembers beta route');

  await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 'aaaa1111-session',
    prompt: 'qqqalphaonly'
  });
  const fileABefore = readFileSync(getContextFilePath(process.cwd(), 'aaaa1111-session'), 'utf8');

  await runPromptSubmit({
    cwd: process.cwd(),
    session_id: 'bbbb2222-session',
    prompt: 'zzzbetaonly'
  });

  const fileAAfter = readFileSync(getContextFilePath(process.cwd(), 'aaaa1111-session'), 'utf8');
  const fileB = readFileSync(getContextFilePath(process.cwd(), 'bbbb2222-session'), 'utf8');

  assert.match(fileABefore, /qqqalphaonly/);
  assert.equal(fileAAfter, fileABefore);
  assert.match(fileB, /zzzbetaonly/);
  assert.equal(getContextFilePath(process.cwd(), 'aaaa1111-session') === getContextFilePath(process.cwd(), 'bbbb2222-session'), false);
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
  assert.equal(JSON.parse(output).hookSpecificOutput.additionalContext, '');
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

    assert.equal(result.additionalContext, '');
    assert.equal(readFileSync(getContextFilePath(process.cwd(), 's-no-fts'), 'utf8').includes('/app/api'), true);
    assert.equal(injection.prompt_idx, 1);
    assert.equal(injection.inject_source, 'user_prompt_submit');
    assert.equal(JSON.parse(injection.mem_ids).includes(saved.id), true);
  });
});

test('prompt-submit replaces an existing context file with the no relevant sentinel when retrieval is empty', async () => {
  const sessionId = 's-empty-1';
  await saveProjectFact('Existing context memory under /app/api');
  await runPromptSubmit({
    cwd: process.cwd(),
    session_id: sessionId,
    prompt: 'app api seed'
  });

  const result = await runPromptSubmit({
    cwd: process.cwd(),
    session_id: sessionId,
    prompt: 'completely unrelated phrase that matches nothing'
  });

  assert.equal(result.additionalContext, '');
  assert.equal(readFileSync(getContextFilePath(process.cwd(), sessionId), 'utf8'), CONTEXT_EMPTY_SENTINEL);
});

test('prompt-submit falls back to inline additionalContext when file-based injection is disabled', async () => {
  const configPath = path.join(process.env.CCMEM_DATA_ROOT, 'file-based-off.json');
  writeFileSync(configPath, JSON.stringify({ injection: { file_based: false } }));
  const previous = process.env.CCMEM_CONFIG_PATH;
  process.env.CCMEM_CONFIG_PATH = configPath;

  try {
    await saveProjectFact('Inline fallback memory under /app/api');
    const result = await runPromptSubmit({
      cwd: process.cwd(),
      session_id: 's-inline',
      prompt: 'app api inline fallback'
    });

    assert.match(result.additionalContext, /Inline fallback memory under \/app\/api/);
  } finally {
    if (previous == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previous;
    }
  }
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
