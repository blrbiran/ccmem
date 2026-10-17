import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Spec §5.2 / A3 / A4: session start used to put every active memory of the
// scope into additionalContext (1.38 MB measured on a real global cache), and
// Claude Code keeps only a ~2 KB preview of it — the read instruction after
// it was never seen. These tests pin the new shape: the conversation gets the
// short read instruction only; the stable rules live in the context file,
// ranked and bounded.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-bounded-start-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { resolveProjectKey } = await import('../../scripts/lib/project-key.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');
const {
  CONTEXT_EMPTY_SENTINEL,
  getContextFilePath,
  MAX_CONTEXT_FILE_BYTES,
  STABLE_SECTION_MAX_BYTES
} = await import('../../scripts/lib/context-file.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

// A temp dir, not the repo: no .git and no .gitignore, so the context file
// write never touches a real exclude file.
const CWD = mkdtempSync(path.join(tmpdir(), 'ccmem-bounded-start-cwd-'));
const PROJECT_KEY = resolveProjectKey(CWD);
const SESSION_ID = 's1';
const FILLER_COUNT = 3000;
// filler globals + the pinned global + one project memory
const TOTAL_STABLE = FILLER_COUNT + 2;
const PROMPT = 'tell me about the zebrafish research notes';

function captureStderr(work) {
  const original = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => { buf += String(chunk); return true; };
  return Promise.resolve()
    .then(work)
    .then((result) => ({ result, stderr: buf }))
    .finally(() => { process.stderr.write = original; });
}

// The pinned row is inserted LAST and touched LONGEST ago, so it is first in
// the stable section only because rankRows put pinned first. If the stable
// section were built in id or recency order instead of the cache's ranked
// member_ids order, the 4 KB cut would drop it and PINNED-MARKER would vanish.
function seed() {
  const db = openDb();
  db.exec('DELETE FROM memories');
  db.exec('DELETE FROM injection_cache');
  db.exec('DELETE FROM recent_injections');
  db.exec('DELETE FROM context_write_log');
  db.exec("DELETE FROM config_kv WHERE key = 'mode'");

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (scope, project_key, type, content, source, trust_score, pinned,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES (?, ?, 'rule', ?, 'auto_inferred', 0.5, ?, 'active', 'active', ?, ?, ?)`
  );
  db.exec('BEGIN');
  for (let i = 0; i < FILLER_COUNT; i += 1) {
    insert.run('global', null, `filler-rule-${i} keep lorem ipsum dolor sit amet`, 0, now, now, now - i);
  }
  const pinned = insert.run('global', null, 'PINNED-MARKER always run tests via run-tests.sh', 1, now, now, now - (10 * 86400000));
  insert.run('project', PROJECT_KEY, 'zebrafish research notes for the bounded session fixture', 0, now, now, now);
  db.exec('COMMIT');

  rebuildInjectionCache(db, PROJECT_KEY);
  return { db, pinnedId: Number(pinned.lastInsertRowid) };
}

function readContextFile() {
  return readFileSync(getContextFilePath(CWD, SESSION_ID), 'utf8');
}

// The stable section is everything between the hash line and the retrieved
// block (or the end of the file when nothing was retrieved).
function stableSectionOf(text) {
  const body = text.slice(text.indexOf('\n') + 1);
  const retrievedAt = body.indexOf('\n\n=== ccmem: retrieved for current prompt ===');
  return retrievedAt === -1 ? body : body.slice(0, retrievedAt);
}

test('session start emits only the read instruction', async () => {
  const { db } = seed();
  db.close();

  const { result } = await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));

  assert.ok(Buffer.byteLength(result.additionalContext, 'utf8') <= 1024,
    `additionalContext is ${Buffer.byteLength(result.additionalContext, 'utf8')} bytes`);
  assert.match(result.additionalContext, /\.ccmem\//);
  assert.doesNotMatch(result.additionalContext, /PINNED-MARKER/);
  assert.doesNotMatch(result.additionalContext, /filler-rule-/);
});

test('context file holds a bounded ranked stable section', async () => {
  const { db, pinnedId } = seed();

  const { stderr } = await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
  const text = readContextFile();
  const stable = stableSectionOf(text);
  const landed = stable.split('\n').filter((line) => line.startsWith('- ')).length;

  assert.match(text, /PINNED-MARKER/);
  assert.match(stable, /^=== ccmem: stable context ===/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_FILE_BYTES);
  assert.equal(MAX_CONTEXT_FILE_BYTES, 12288);
  assert.ok(Buffer.byteLength(stable, 'utf8') <= STABLE_SECTION_MAX_BYTES,
    `stable section is ${Buffer.byteLength(stable, 'utf8')} bytes`);
  assert.equal(STABLE_SECTION_MAX_BYTES, 4096);
  assert.ok(landed > 1 && landed < TOTAL_STABLE, `landed ${landed} rows`);

  // The cut is reported, not hidden (A4).
  assert.match(stderr, new RegExp(`ccmem: stable section trimmed to ${landed} of ${TOTAL_STABLE} mems`));

  // Telemetry records the rows that actually landed, not the whole scope.
  const injection = db.prepare(
    `SELECT mem_ids FROM recent_injections WHERE session_id = ? AND inject_source = 'session_start'`
  ).get(SESSION_ID);
  const ids = JSON.parse(injection.mem_ids);
  assert.equal(ids.length, landed);
  assert.equal(ids[0], pinnedId);
  db.close();
});

// WHY: several KB of globals used to fill the section before any project
// rule was reached (real data: 0 of 1,960 project rows landed). The seed has
// >4 KB of unpinned globals and one unpinned project rule.
test('project rules are not starved by globals', async () => {
  const { db } = seed();
  db.close();

  await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
  const stable = stableSectionOf(readContextFile());

  assert.ok(stable.includes(`[PROJECT ${PROJECT_KEY}]\n- zebrafish research notes`), stable);
  assert.match(stable, /\[GLOBAL\]\n- \(pinned\) PINNED-MARKER/);
});

test('pinned rows of both scopes land', async () => {
  const { db } = seed();
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (scope, project_key, type, content, source, trust_score, pinned,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES ('project', ?, 'rule', 'PROJECT-PINNED-MARKER keep migrations reversible', 'auto_inferred', 0.5, 1,
             'active', 'active', ?, ?, ?)`
  ).run(PROJECT_KEY, now, now, now - (20 * 86400000));
  rebuildInjectionCache(db, PROJECT_KEY);
  db.close();

  await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
  const stable = stableSectionOf(readContextFile());

  assert.match(stable, /- \(pinned\) PINNED-MARKER/);
  assert.match(stable, /- \(pinned\) PROJECT-PINNED-MARKER/);
});

test('prompt submit keeps the stable section', async () => {
  const { db } = seed();
  db.close();

  await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
  const { result } = await captureStderr(() => handlePromptSubmit({ cwd: CWD, session_id: SESSION_ID, prompt: PROMPT }));
  const text = readContextFile();

  assert.equal(result.additionalContext, '');
  assert.ok(result._metricFields.matched > 0, 'fixture must retrieve something');
  assert.match(text, /PINNED-MARKER/);
  assert.match(text, /=== ccmem: retrieved for current prompt ===/);
  assert.match(text, /\[m\d+\] rule \| project zebrafish research notes/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_FILE_BYTES);
  assert.ok(Buffer.byteLength(stableSectionOf(text), 'utf8') <= STABLE_SECTION_MAX_BYTES);

  // An unrelated prompt drops the retrieved block but keeps the stable rules.
  await captureStderr(() => handlePromptSubmit({ cwd: CWD, session_id: SESSION_ID, prompt: 'qqqq wwww unmatched' }));
  const cleared = readContextFile();
  assert.match(cleared, /PINNED-MARKER/);
  assert.doesNotMatch(cleared, /=== ccmem: retrieved for current prompt ===/);
});

test('instruction is identical across calls of one session', async () => {
  const { db } = seed();
  db.close();

  const first = await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));
  const second = await captureStderr(() => handleSessionStart({ cwd: CWD, session_id: SESSION_ID }));

  assert.equal(first.result.additionalContext, second.result.additionalContext);
});

// With neither stable nor retrieved rows there is nothing to keep: an
// existing file is replaced with the sentinel the read instruction names.
test('prompt submit writes the sentinel when there is neither stable nor retrieved content', async () => {
  const db = openDb();
  db.exec('DELETE FROM memories');
  db.exec('DELETE FROM injection_cache');
  db.close();
  mkdirSync(path.join(CWD, '.ccmem'), { recursive: true });
  writeFileSync(getContextFilePath(CWD, SESSION_ID), 'stale content from an earlier prompt\n');

  await captureStderr(() => handlePromptSubmit({ cwd: CWD, session_id: SESSION_ID, prompt: PROMPT }));

  assert.equal(readContextFile(), CONTEXT_EMPTY_SENTINEL);
});
