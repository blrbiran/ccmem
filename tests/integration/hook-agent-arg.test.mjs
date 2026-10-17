import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Codex and oh-my-pi call the same hook entry as Claude Code, each passing
// `--agent <id>`. These tests spawn the real scripts/hook.mjs and pin that the
// agent id reaches the read instruction, session_context and the stop task.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-hook-agent-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');

const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'scripts/hook.mjs');
const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot };
delete env.CCMEM_INTERNAL;

function runHook(args, input) {
  return spawnSync(NODE, [HOOK, ...args], { cwd: ROOT, env, encoding: 'utf8', input: JSON.stringify(input) });
}

function withDb(fn) {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seedGlobalRule() {
  withDb((db) => {
    db.exec('DELETE FROM memories');
    db.exec('DELETE FROM injection_cache');
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score, pinned,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES ('global', NULL, 'rule', 'agent-arg seed rule', 'auto_inferred', 0.5, 1,
               'active', 'active', ?, ?, ?)`
    ).run(now, now, now);
    rebuildInjectionCache(db, null);
  });
}

function additionalContextOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function newCwd() {
  return mkdtempSync(path.join(tmpdir(), 'ccmem-hook-agent-cwd-'));
}

test('codex session-start returns hookSpecificOutput with the codex instruction', () => {
  seedGlobalRule();
  const result = runHook(['session-start', '--agent', 'codex'], { session_id: 'codex-sess-1', cwd: newCwd() });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = additionalContextOf(result);
  assert.ok(text.includes('.ccmem/'));
  assert.ok(text.includes('after context compaction'));
  assert.ok(!text.includes('/compact'), text);
  assert.ok(!/claude/i.test(text), text);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 1024);
  assert.equal(withDb((db) => db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('codex-sess-1').agent), 'codex');
});

test('omp session-start uses the omp wording', () => {
  seedGlobalRule();
  const text = additionalContextOf(runHook(['session-start', '--agent', 'omp'], { session_id: 'omp-sess-1', cwd: newCwd() }));
  assert.ok(text.includes('after compaction'));
  assert.ok(!text.includes('/compact'), text);
  assert.ok(!/claude/i.test(text), text);
  assert.equal(withDb((db) => db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('omp-sess-1').agent), 'omp');
});

test('no --agent keeps the claude-code instruction byte-identical', async () => {
  seedGlobalRule();
  const { buildReadInstruction } = await import('../../scripts/handlers/session-start.mjs');
  const text = additionalContextOf(runHook(['session-start'], { session_id: 'cc-sess-1', cwd: newCwd() }));
  assert.equal(text, [
    '## ccmem context',
    `Read \`.ccmem/${text.match(/context-[^`]+\.md/)[0]}\` at session start and after each /compact.`,
    'After /compact, ALWAYS re-read regardless of compressed summary content.',
    "Re-read if you haven't read it in the last 5 turns or when switching to a different task.",
    "Context is session-scoped; prioritize the user's current prompt over cached context.",
    'If file contains only "<!-- ccmem: no relevant memories -->" or is missing, proceed normally.'
  ].join('\n'));
  assert.equal(text, buildReadInstruction('cc-sess-1', 'claude-code'));
  assert.equal(text, buildReadInstruction('cc-sess-1'));
  assert.equal(withDb((db) => db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('cc-sess-1').agent), 'claude-code');
});

test('an unknown --agent value is treated as claude-code with a stderr warning', () => {
  seedGlobalRule();
  const result = runHook(['session-start', '--agent', 'bogus'], { session_id: 'bogus-sess-1', cwd: newCwd() });
  const text = additionalContextOf(result);
  assert.ok(text.includes('/compact'));
  assert.match(result.stderr, /unknown --agent 'bogus'/);
});

test('instruction is identical across calls within one session for every agent', async () => {
  const { buildReadInstruction } = await import('../../scripts/handlers/session-start.mjs');
  for (const agent of ['claude-code', 'codex', 'omp']) {
    assert.equal(buildReadInstruction('same-session', agent), buildReadInstruction('same-session', agent));
    assert.ok(Buffer.byteLength(buildReadInstruction('same-session', agent), 'utf8') <= 1024);
  }
});

test('stop with --agent omp enqueues agent omp', () => {
  const transcript = path.join(dataRoot, 'omp-session.jsonl');
  writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  withDb((db) => db.exec('DELETE FROM tasks'));
  const result = runHook(['stop', '--agent', 'omp'], { session_id: 'omp-stop-1', transcript_path: transcript, cwd: newCwd() });
  assert.equal(result.status, 0, result.stderr);
  withDb((db) => {
    const task = db.prepare("SELECT payload FROM tasks WHERE type = 'summarize_pending'").get();
    const payload = JSON.parse(task.payload);
    assert.equal(payload.agent, 'omp');
    assert.equal(payload.session_id, 'omp-stop-1');
    assert.equal(db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('omp-stop-1').agent, 'omp');
  });
});

test('stop without --agent records claude-code', () => {
  const transcript = path.join(dataRoot, 'cc-session.jsonl');
  writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  withDb((db) => db.exec('DELETE FROM tasks'));
  const result = runHook(['stop'], { session_id: 'cc-stop-1', transcript_path: transcript, cwd: newCwd() });
  assert.equal(result.status, 0, result.stderr);
  withDb((db) => {
    const payload = JSON.parse(db.prepare("SELECT payload FROM tasks WHERE type = 'summarize_pending'").get().payload);
    assert.equal(payload.agent, 'claude-code');
    assert.equal(db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('cc-stop-1').agent, 'claude-code');
  });
});

test('prompt-submit --agent codex records the agent on session_context', () => {
  const result = runHook(['prompt-submit', '--agent', 'codex'], { session_id: 'codex-prompt-1', cwd: newCwd(), prompt: 'hello there' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(withDb((db) => db.prepare('SELECT agent FROM session_context WHERE session_id = ?').get('codex-prompt-1').agent), 'codex');
});

test('codex session-start in a non-git dir writes the context file and a path: project key', () => {
  seedGlobalRule();
  const cwd = newCwd();
  const result = runHook(['session-start', '--agent', 'codex'], { session_id: 'codex-nogit-1', cwd });
  assert.equal(result.status, 0, result.stderr);
  const dir = path.join(cwd, '.ccmem');
  assert.ok(existsSync(dir));
  assert.ok(readdirSync(dir).some((name) => name.startsWith('context-')));
  const key = withDb((db) => db.prepare('SELECT project_key FROM session_context WHERE session_id = ?').get('codex-nogit-1').project_key);
  assert.ok(key.startsWith('path:'), key);
});
