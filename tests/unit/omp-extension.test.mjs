import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

// The OMP extension runs inside every oh-my-pi session the human starts. What
// these pin is what that session relies on: ccmem speaks at most once per
// session (a short read instruction, never the system prompt), it stays out of
// subagents and print runs, and a broken or hanging hook can neither throw into
// OMP nor hold a turn longer than the timeout.
const scratch = mkdtempSync(path.join(tmpdir(), 'ccmem-omp-ext-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = path.join(scratch, 'data');
delete process.env.CCMEM_INTERNAL;

const { createCcmemExtension } = await import('../../integrations/omp/ccmem-extension.ts');
const { contextFileName, getContextFilePath } = await import('../../scripts/lib/context-file.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = '/opt/fake/bin/node';
const HOOK = '/opt/fake/ccmem/scripts/hook.mjs';

function fakePi() {
  const pi = {
    handlers: {},
    sent: [],
    on(event, handler) {
      pi.handlers[event] = handler;
    },
    sendMessage(message, options) {
      pi.sent.push({ message, options });
    }
  };
  return pi;
}

// A child process stand-in. `behaviour` decides what it does once spawned:
// { stdout, code } answers and exits, { error } fails to start, { hang: true }
// never exits.
function fakeChild(behaviour) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let stdin = '';
  child.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  child.stdinText = () => stdin;
  setImmediate(() => {
    if (behaviour.error) {
      child.emit('error', behaviour.error);
      return;
    }
    if (behaviour.hang) {
      return;
    }
    child.stdout.end(behaviour.stdout ?? '');
    setImmediate(() => child.emit('close', behaviour.code ?? 0));
  });
  return child;
}

function fakeSpawn(behaviour) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = fakeChild(typeof behaviour === 'function' ? behaviour(args) : behaviour);
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawnImpl, calls };
}

function hookOutput(eventName, additionalContext) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
}

function ctx({ sessionId = 's1', cwd = '/work/repo', file = '/omp/sessions/s1.jsonl', kind = 'main', mode = 'tui' } = {}) {
  return {
    cwd,
    mode,
    agent: { kind, id: 'Main', name: 'main', depth: 0 },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file
    }
  };
}

function load(spawnImpl, extra = {}) {
  const pi = fakePi();
  createCcmemExtension({ node: NODE, hookScript: HOOK, spawnImpl, ...extra })(pi);
  return pi;
}

const INSTRUCTION = 'Read .ccmem/s1.md now. After compaction, ALWAYS re-read it.';

test('session_start sends the read instruction once per session, hidden, for the next turn', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: hookOutput('SessionStart', INSTRUCTION) });
  const pi = load(spawnImpl);

  assert.equal(await pi.handlers.session_start({ type: 'session_start' }, ctx()), undefined);
  await pi.handlers.session_start({ type: 'session_start' }, ctx());

  assert.equal(calls.length, 1, 'the second session_start of the same session must not run the hook again');
  assert.equal(calls[0].command, NODE);
  assert.deepEqual(calls[0].args, ['--no-warnings', '--experimental-sqlite', HOOK, 'session-start', '--agent', 'omp']);
  assert.deepEqual(JSON.parse(calls[0].child.stdinText()), {
    session_id: 's1',
    cwd: '/work/repo',
    transcript_path: '/omp/sessions/s1.jsonl'
  });
  assert.deepEqual(pi.sent, [{
    message: { customType: 'ccmem', content: INSTRUCTION, display: false },
    options: { deliverAs: 'nextTurn' }
  }]);

  // A new session in the same process (OMP rebinds the factory) gets its own instruction.
  await pi.handlers.session_start({ type: 'session_start' }, ctx({ sessionId: 's2', file: '/omp/sessions/s2.jsonl' }));
  assert.equal(pi.sent.length, 2);
});

test('session_start sends nothing when the hook returns no instruction', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: hookOutput('SessionStart', '') });
  const pi = load(spawnImpl);
  await pi.handlers.session_start({ type: 'session_start' }, ctx());
  assert.equal(calls.length, 1);
  assert.deepEqual(pi.sent, []);
});

test('before_agent_start runs prompt-submit and returns undefined, never touching the system prompt', async () => {
  // Even a hook that (wrongly) returned context must not reach the conversation:
  // per turn, ccmem only rewrites the context file.
  const { spawnImpl, calls } = fakeSpawn({ stdout: hookOutput('UserPromptSubmit', 'should not be injected') });
  const pi = load(spawnImpl);
  const event = { type: 'before_agent_start', prompt: 'fix the flaky test', images: [], systemPrompt: ['SYSTEM'] };

  const result = await pi.handlers.before_agent_start(event, ctx());

  assert.equal(result, undefined);
  assert.deepEqual(event.systemPrompt, ['SYSTEM']);
  assert.deepEqual(pi.sent, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--no-warnings', '--experimental-sqlite', HOOK, 'prompt-submit', '--agent', 'omp']);
  assert.deepEqual(JSON.parse(calls[0].child.stdinText()), {
    session_id: 's1',
    cwd: '/work/repo',
    transcript_path: '/omp/sessions/s1.jsonl',
    prompt: 'fix the flaky test'
  });
});

test('session_stop runs stop with the session file from the event and returns undefined', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: '{}' });
  const pi = load(spawnImpl);
  const event = {
    type: 'session_stop',
    messages: [],
    turn_id: 3,
    session_id: 'from-event',
    session_file: '/omp/sessions/from-event.jsonl',
    stop_hook_active: false,
    signal: new AbortController().signal
  };

  const result = await pi.handlers.session_stop(event, ctx({ sessionId: 'from-ctx', file: '/omp/other.jsonl' }));

  assert.equal(result, undefined, 'a result would ask OMP to continue the turn');
  assert.deepEqual(calls[0].args, ['--no-warnings', '--experimental-sqlite', HOOK, 'stop', '--agent', 'omp']);
  assert.deepEqual(JSON.parse(calls[0].child.stdinText()), {
    session_id: 'from-event',
    cwd: '/work/repo',
    transcript_path: '/omp/sessions/from-event.jsonl'
  });
});

test('subagents, print runs and ccmem\'s own summarizer children run no hook at all', async (t) => {
  const stopEvent = { type: 'session_stop', messages: [], session_id: 's1', session_file: '/f.jsonl' };
  const promptEvent = { type: 'before_agent_start', prompt: 'p', systemPrompt: [] };
  const cases = [
    ['subagent', ctx({ kind: 'sub' }), () => {}],
    ['print mode', ctx({ mode: 'print' }), () => {}],
    ['CCMEM_INTERNAL=1', ctx(), () => {
      process.env.CCMEM_INTERNAL = '1';
      t.after(() => delete process.env.CCMEM_INTERNAL);
    }]
  ];

  for (const [label, context, arrange] of cases) {
    arrange();
    const { spawnImpl, calls } = fakeSpawn({ stdout: hookOutput('SessionStart', INSTRUCTION) });
    const pi = load(spawnImpl);
    await pi.handlers.session_start({ type: 'session_start' }, context);
    assert.equal(await pi.handlers.before_agent_start(promptEvent, context), undefined);
    assert.equal(await pi.handlers.session_stop(stopEvent, context), undefined);
    assert.equal(calls.length, 0, `${label}: no hook may run`);
    assert.deepEqual(pi.sent, [], `${label}: nothing may be sent`);
  }
});

test('extension swallows hook failure and timeout', { timeout: 10_000 }, async () => {
  const timeoutMs = 300;
  const startEvent = { type: 'session_start' };
  const promptEvent = { type: 'before_agent_start', prompt: 'p', systemPrompt: [] };
  const stopEvent = { type: 'session_stop', messages: [], session_id: 's1', session_file: '/f.jsonl' };

  const failures = {
    'spawn emits error': () => fakeSpawn({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }).spawnImpl,
    'spawn throws': () => () => {
      throw new Error('EAGAIN');
    },
    'hook exits non-zero': () => fakeSpawn({ stdout: hookOutput('SessionStart', INSTRUCTION), code: 1 }).spawnImpl,
    'hook prints garbage': () => fakeSpawn({ stdout: 'not json' }).spawnImpl
  };

  for (const [label, makeSpawn] of Object.entries(failures)) {
    const pi = load(makeSpawn(), { timeoutMs });
    for (const [name, event] of [['session_start', startEvent], ['before_agent_start', promptEvent], ['session_stop', stopEvent]]) {
      const started = Date.now();
      assert.equal(await pi.handlers[name](event, ctx()), undefined, `${label}: ${name}`);
      assert.ok(Date.now() - started < timeoutMs, `${label}: ${name} must not wait for the timeout`);
    }
    assert.deepEqual(pi.sent, [], `${label}: nothing may be sent`);
  }

  // A hook that never exits: each handler gives up at the timeout and kills it.
  const { spawnImpl, calls } = fakeSpawn({ hang: true });
  const pi = load(spawnImpl, { timeoutMs });
  for (const [name, event] of [['session_start', startEvent], ['before_agent_start', promptEvent], ['session_stop', stopEvent]]) {
    const started = Date.now();
    assert.equal(await pi.handlers[name](event, ctx()), undefined, `hang: ${name}`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= timeoutMs - 20 && elapsed < timeoutMs + 200, `hang: ${name} took ${elapsed} ms`);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.child.killed), 'a timed-out hook is killed, not left running');
  assert.deepEqual(pi.sent, []);
});

test('a sendMessage that throws does not escape session_start', async () => {
  const { spawnImpl } = fakeSpawn({ stdout: hookOutput('SessionStart', INSTRUCTION) });
  const pi = load(spawnImpl);
  pi.sendMessage = () => {
    throw new Error('Extension runtime not initialized');
  };
  assert.equal(await pi.handlers.session_start({ type: 'session_start' }, ctx()), undefined);
});

test('against the real hook: session_start sends the short omp instruction and prompt-submit writes the context file', { timeout: 30_000 }, async () => {
  // One pinned global rule, so prompt-submit has a stable section to write.
  const db = openDb();
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score, pinned,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES ('global', NULL, 'rule', 'omp extension seed rule', 'auto_inferred', 0.5, 1,
               'active', 'active', ?, ?, ?)`
    ).run(now, now, now);
    rebuildInjectionCache(db, null);
  } finally {
    db.close();
  }
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-omp-ext-cwd-'));
  const pi = fakePi();
  createCcmemExtension({ node: process.execPath, hookScript: path.join(ROOT, 'scripts/hook.mjs') })(pi);
  const context = ctx({ sessionId: 'omp-real-1', cwd, file: path.join(cwd, 'omp-real-1.jsonl') });

  await pi.handlers.session_start({ type: 'session_start' }, context);
  assert.equal(pi.sent.length, 1);
  const { content } = pi.sent[0].message;
  assert.ok(content.includes(`.ccmem/${contextFileName('omp-real-1')}`), content);
  assert.match(content, /After compaction/, 'the omp wording, not Claude\'s /compact');
  assert.ok(Buffer.byteLength(content) <= 1024, `instruction is ${Buffer.byteLength(content)} bytes`);

  const result = await pi.handlers.before_agent_start({ type: 'before_agent_start', prompt: 'hello', systemPrompt: [] }, context);
  assert.equal(result, undefined);
  assert.match(readFileSync(getContextFilePath(cwd, 'omp-real-1'), 'utf8'), /omp extension seed rule/, 'prompt-submit writes the context file');
  assert.equal(pi.sent.length, 1, 'per turn nothing is sent into the conversation');
});
