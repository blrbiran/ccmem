import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// #453: file-based injection makes the model spend a tool round trip `cat`-ing .ccmem/context-*.md
// every session (tester: 5.93x tokens on an irrelevant prompt). injection.inline_bounded puts the
// file's own capped sections into additionalContext instead. It must never inline anything
// unbounded -- the reason injection went file-based was a 1.9 MB SessionStart output built from
// injection_cache.rendered_text (codex-omp spec §5.2) -- and with the switch off nothing may change.
// Design: docs/superpowers/specs/2026-11-25-bounded-inline-injection-design.md.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-inline-'));
const CONFIG_PATH = path.join(process.env.CCMEM_DATA_ROOT, 'inline-config.json');
process.env.CCMEM_CONFIG_PATH = CONFIG_PATH;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { resolveProjectKey } = await import('../../scripts/lib/project-key.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');
const {
  boundedInlineContext,
  getContextFilePath,
  INLINE_MAX_BYTES,
  MAX_CONTEXT_FILE_BYTES,
  STABLE_SECTION_MAX_BYTES
} = await import('../../scripts/lib/context-file.mjs');
const { buildReadInstruction, handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

const CWD = mkdtempSync(path.join(tmpdir(), 'ccmem-inline-cwd-'));
const PROJECT_KEY = resolveProjectKey(CWD);
const SESSION_ID = 'inline-session-0001';
const PROMPT = 'tell me about the zebrafish research notes';
const RETRIEVED_BOUND = 8192 - Buffer.byteLength('<!-- content-hash: 00000000 -->\n', 'utf8');
const bytes = (text) => Buffer.byteLength(text, 'utf8');

function writeConfig(injection) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ inject: { max_per_prompt: 60 }, ...(injection ? { injection } : {}) }));
}

// 3000 global rules (the stable section has to cut), a pinned marker, 40 near-cap zebrafish
// memories (the retrieved cap has to cut), and a 2 MB rendered_text in every cache row -- the
// unbounded text the legacy inline path would emit.
function seed() {
  const db = openDb();
  for (const table of ['memories', 'injection_cache', 'recent_injections', 'context_write_log']) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM config_kv WHERE key = 'mode'");
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (scope, project_key, type, content, source, trust_score, pinned,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES (?, ?, 'rule', ?, 'auto_inferred', 0.5, ?, 'active', 'active', ?, ?, ?)`
  );
  db.exec('BEGIN');
  for (let i = 0; i < 3000; i += 1) insert.run('global', null, `filler-rule-${i} keep lorem ipsum dolor sit amet`, 0, now, now, now - i);
  insert.run('global', null, 'PINNED-MARKER always run tests via run-tests.sh', 1, now, now, now - 864000000);
  for (let i = 0; i < 40; i += 1) {
    insert.run('project', PROJECT_KEY, `zebrafish research notes ${i} ${'x'.repeat(440)}`, 0, now, now, now);
  }
  db.exec('COMMIT');
  rebuildInjectionCache(db, PROJECT_KEY);
  db.prepare('UPDATE injection_cache SET rendered_text = ?').run(`HUGE-CACHE ${'y'.repeat(2 * 1024 * 1024)}`);
  db.close();
}

async function quiet(work) {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return await work();
  } finally {
    process.stderr.write = original;
  }
}

const sessionStart = () => quiet(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
const promptSubmit = (prompt = PROMPT) => quiet(() => handlePromptSubmit({ cwd: CWD, session_id: SESSION_ID, prompt }));

test('switch on: session start inlines the capped stable section, never the cache text', async () => {
  seed();
  writeConfig({ inline_bounded: true });
  const { additionalContext } = await sessionStart();

  // mutation: ignore the switch -> the read instruction comes back, red
  assert.match(additionalContext, /^## ccmem context\n=== ccmem: stable context ===/);
  assert.match(additionalContext, /PINNED-MARKER/);
  assert.doesNotMatch(additionalContext, /\.ccmem\/context-/);
  // mutation: inline the injection_cache rendered_text (the legacy path) -> 2 MB, red
  assert.doesNotMatch(additionalContext, /HUGE-CACHE/);
  assert.ok(bytes(additionalContext) <= bytes('## ccmem context\n') + STABLE_SECTION_MAX_BYTES, `${bytes(additionalContext)} B`);
  // The same text the file carries: one builder decides what is injected.
  const file = readFileSync(getContextFilePath(CWD, SESSION_ID), 'utf8');
  assert.ok(file.includes(additionalContext.slice('## ccmem context\n'.length)), 'inline text is the file\'s stable section');
});

test('switch on: prompt submit inlines only the retrieved rows, within the retrieved cap', async () => {
  seed();
  writeConfig({ inline_bounded: true });
  await sessionStart();
  const { additionalContext } = await promptSubmit();

  assert.match(additionalContext, /^## ccmem context\n=== ccmem: retrieved for current prompt ===/);
  assert.match(additionalContext, /zebrafish research notes/);
  // The stable section is inlined once at session start, not every turn.
  assert.doesNotMatch(additionalContext, /PINNED-MARKER|stable context|HUGE-CACHE/);
  // mutation: inline every retrieved row untrimmed (40 x ~470 B) -> over the cap, red
  assert.ok(bytes(additionalContext) <= bytes('## ccmem context\n') + RETRIEVED_BOUND, `${bytes(additionalContext)} B`);

  const none = await promptSubmit('qqqq wwww unrelated');
  assert.equal(none.additionalContext, '');
});

test('switch off (absent or false): both hooks emit exactly what they emit today', async () => {
  for (const injection of [null, { inline_bounded: false }]) {
    seed();
    writeConfig(injection);
    const start = await sessionStart();
    // mutation: treat the switch as on by default -> the stable section instead of the instruction, red
    assert.equal(start.additionalContext, buildReadInstruction(SESSION_ID, 'claude-code'), JSON.stringify(injection));
    const prompt = await promptSubmit();
    assert.equal(prompt.additionalContext, '', JSON.stringify(injection));
    assert.equal(prompt._metricFields.additional_context_empty, true);
  }
});

test('the inline guard refuses anything over the bound and keeps the fallback', () => {
  assert.equal(INLINE_MAX_BYTES, MAX_CONTEXT_FILE_BYTES);
  const original = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  try {
    // mutation: drop the byte check -> the 20 KB text comes back, red
    assert.equal(boundedInlineContext(['z'.repeat(20000)], 'FALLBACK'), 'FALLBACK');
  } finally {
    process.stderr.write = original;
  }
  assert.match(stderr, /not inlined/);
  assert.equal(boundedInlineContext(['', null], 'FALLBACK'), '');
});
