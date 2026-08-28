import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two channels decide what reaches the model on session start: retrieval
// (Tasks 2/3, scripts/lib/retrieval.mjs) and this injection_cache read in
// scripts/handlers/session-start.mjs. This file covers only the latter.
//
// handleSessionStart(hookData) opens its own db via openDb() and closes it
// itself (see the handler's try/finally) — it cannot be handed a db, so
// isolation has to come from the environment the process-level openDb()
// call resolves against, not from dependency injection.
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-w2-injection-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { resolveProjectKey } = await import('../../scripts/lib/project-key.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

// Project keys are computed, never literals: resolveProjectKey(cwd) shells
// out to `git config --get remote.origin.url` in that cwd and falls back to
// `path:` + sha256(cwd).slice(0,16). Two fresh temp dirs are not git repos,
// so both take the fallback branch and differ by path.
const PROJ_A_CWD = mkdtempSync(path.join(tmpdir(), 'ccmem-w2-proj-a-'));
const PROJ_B_CWD = mkdtempSync(path.join(tmpdir(), 'ccmem-w2-proj-b-'));
const KEY_A = resolveProjectKey(PROJ_A_CWD);
const KEY_B = resolveProjectKey(PROJ_B_CWD);
assert.notEqual(KEY_A, KEY_B, 'fixture requires two distinct project keys');

const SCOPE_A = `project:${KEY_A}`;
const SCOPE_B = `project:${KEY_B}`;
// Derived, not assumed: which of A/B sorts second (by the ORDER BY's
// secondary key, plain `scope` ascending) is whatever the computed hashes
// dictate, not something this file gets to pick.
const [FIRST_LABEL, FIRST_SCOPE, SECOND_LABEL, SECOND_SCOPE] =
  SCOPE_A < SCOPE_B ? ['A', SCOPE_A, 'B', SCOPE_B] : ['B', SCOPE_B, 'A', SCOPE_A];
const EXPECTED_ALL_ROWS = `G\n\n${FIRST_LABEL}\n\n${SECOND_LABEL}`;

const CONFIG_PATH = path.join(process.env.CCMEM_DATA_ROOT, 'session-start-config.json');
let previousConfigPath;

test.beforeEach(() => {
  previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  process.env.CCMEM_CONFIG_PATH = CONFIG_PATH;
});

test.afterEach(() => {
  if (previousConfigPath === undefined) {
    delete process.env.CCMEM_CONFIG_PATH;
  } else {
    process.env.CCMEM_CONFIG_PATH = previousConfigPath;
  }
});

// injection.file_based defaults to true, which would append
// buildReadInstruction() to additionalContext and break the exact-string
// assertions below. Turning it off here (alongside the eval switch under
// test) makes additionalContext === the raw joined injection_cache text.
// loadConfig() re-reads from disk every call — no cache — so this can
// change per test without restarting the process.
function writeConfig(disableScopeIsolation) {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    injection: { file_based: false },
    eval: { disable_scope_isolation: disableScopeIsolation }
  }));
}

// Seeds injection_cache with the fixture rows against the real db.mjs
// openDb() — the same module the handler opens internally — so seeding and
// the handler's own read land in the same on-disk db under CCMEM_DATA_ROOT.
// Row insertion order is deliberately the REVERSE of the alphabetical
// scope order the correct query must produce: if Step 6's mutation (dropping
// the secondary `, scope` sort key) leaves SQLite's tie-break at scan/
// insertion order instead of scope order, this guarantees a mismatch
// regardless of which of KEY_A/KEY_B happens to hash lower — the test can't
// accidentally stay green by luck of the hash.
function seed() {
  const db = openDb();
  db.exec('DELETE FROM injection_cache');
  db.exec('DELETE FROM session_context');
  db.exec('DELETE FROM recent_injections');
  db.exec("DELETE FROM config_kv WHERE key = 'mode'");

  const now = Date.now();
  const insertRow = db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES (?, ?, ?, ?)`
  );
  insertRow.run('global', 'G', '["g1"]', now);
  const rowByLabel = { A: [SCOPE_A, 'A', '["a1"]'], B: [SCOPE_B, 'B', '["b1"]'] };
  // second-sorting row inserted first, first-sorting row inserted second:
  // reverse of the required output order.
  insertRow.run(...rowByLabel[SECOND_LABEL], now);
  insertRow.run(...rowByLabel[FIRST_LABEL], now);

  return db;
}

// runSessionStart takes NO db parameter — handleSessionStart(hookData)
// opens its own db via openDb() (see the real call sites at
// tests/integration/save-list-session-start.test.mjs:34 and :499). cwd is
// pinned to PROJ_A_CWD throughout so "own project" always resolves to
// SCOPE_A / KEY_A.
async function runSessionStart(disableScopeIsolation, sessionId = 's-w2-injection') {
  writeConfig(disableScopeIsolation);
  return handleSessionStart({ cwd: PROJ_A_CWD, session_id: sessionId });
}

// process.stderr.write is the existing repo warning channel (see
// SHADOW_NOTICE); testing it means capturing it.
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk, ...rest) => { buf += String(chunk); return orig(chunk, ...rest); };
  return { read: () => buf, restore: () => { process.stderr.write = orig; } };
}

// WHY: the switch off/on split is the entire effect W2 has on the injection
// channel. Off must read only global + the caller's own project; on must
// read every scope in injection_cache.
test('session_start reads only own project + global when the switch is off', async () => {
  seed();
  const out = await runSessionStart(false);
  // cwd is pinned to PROJ_A_CWD, so the WHERE clause matches SCOPE_A only —
  // its rendered_text is always 'A', independent of how A/B sort relative
  // to each other (there is no B row in the result set to tie-break against).
  assert.equal(out.additionalContext, 'G\n\nA');
});

// WHY: multiple project:* rows have no stable ordering on their own; if the
// injected text's join order is nondeterministic, the eval harness this
// switch exists for is not reproducible. The secondary sort key is a
// correctness requirement, not a style preference, so this asserts the
// full exact string (row set AND order), never a substring.
test('session_start reads every row, global first, then project keys sorted', async () => {
  seed();
  const out = await runSessionStart(true);
  assert.equal(out.additionalContext, EXPECTED_ALL_ROWS);
});

// WHY: diagnose's default output is only a count, no key names. This stderr
// line is the only signal that names, by key, that cross-project isolation
// is off; if it stays silent an operator has no way to know.
test('warns on stderr when the switch is on', async () => {
  seed();
  const cap = captureStderr();
  try {
    await runSessionStart(true);
  } finally {
    cap.restore();
  }
  assert.match(cap.read(), /disable_scope_isolation is ON/);
});

test('does not warn when the switch is off', async () => {
  seed();
  const cap = captureStderr();
  try {
    await runSessionStart(false);
  } finally {
    cap.restore();
  }
  assert.doesNotMatch(cap.read(), /disable_scope_isolation is ON/);
});

// WHY: shadow mode's early return sits AFTER the injection_cache SELECT, so
// the cross-project rows were genuinely read even though shadow mode
// discards the result. Silence there would be a lie. Shadow mode also
// writes SHADOW_NOTICE, so stderr holds two messages — match a substring,
// never assert the whole buffer.
test('warns in shadow mode too', async () => {
  const db = seed();
  setMode(db, 'shadow');
  const cap = captureStderr();
  try {
    await runSessionStart(true);
  } finally {
    cap.restore();
  }
  assert.match(cap.read(), /disable_scope_isolation is ON/);
});

// WHY: `mode === 'off'` returns before the injection_cache query ever runs,
// so nothing was read cross-project — warning here would be a false alarm.
test('does not warn in off mode', async () => {
  const db = seed();
  setMode(db, 'off');
  const cap = captureStderr();
  try {
    await runSessionStart(true);
  } finally {
    cap.restore();
  }
  assert.doesNotMatch(cap.read(), /disable_scope_isolation is ON/);
});

// FIX 2 (Important): same fail-safe read form as the retrieval channel (see
// v014-scope-isolation-retrieval.test.mjs) — session-start.mjs:77 reads
// config?.eval?.disable_scope_isolation === true. mergeConfig replaces the
// whole `eval` subtree on a scalar override, so a config file containing
// "eval": true (a plausible one-token typo for this key) makes config.eval a
// boolean and config.eval.disable_scope_isolation undefined. The required
// `=== true` form treats that as OFF (isolation HOLDS, no stderr warning);
// the forbidden `!== false` form would treat it as ON. Written straight to
// CCMEM_CONFIG_PATH (bypassing writeConfig()'s boolean-only shape) so the
// real loadConfig()/mergeConfig path is what's under test, not a simulation
// of it.
test('session_start keeps isolation and does not warn when config.eval is malformed', async () => {
  seed();
  writeFileSync(CONFIG_PATH, JSON.stringify({ injection: { file_based: false }, eval: true }));
  const cap = captureStderr();
  try {
    const out = await handleSessionStart({ cwd: PROJ_A_CWD, session_id: 's-w2-malformed-eval' });
    assert.equal(out.additionalContext, 'G\n\nA', 'own project + global only — the other project row must not leak');
    assert.doesNotMatch(cap.read(), /disable_scope_isolation is ON/);
  } finally {
    cap.restore();
  }
});

// ============================================================
// Task 5: neither handler may leave a write behind while the switch is on.
//
// WHY this matters more than the read-path tests above: this switch is
// documented as a READ-ONLY degradation for an eval harness. With it on,
// retrieval returns OTHER PROJECTS' memory ids. Those ids flow into
// recent_injections and memory_feedback, and settlement later hands them to
// adjustTrust() (scripts/lib/trust.mjs), which runs
// `UPDATE memories SET trust_score = ..., last_touched_at = ? WHERE id = ?`
// with NO scope check. One eval run would permanently rewrite another
// project's memories, and turning the switch back off does not undo it —
// last_touched_at feeds decay and injection ordering. These tests are the
// only thing standing between the switch and that irreversible damage.
// ============================================================

// session-start writes ONLY recent_injections (see writeRecentInjection at
// session-start.mjs:105); it never touches memory_feedback — that INSERT
// lives solely in prompt-submit.mjs:108-116. The memory_feedback assertion
// below is therefore a guard against a future change to this handler, not
// evidence that this task's fix does anything for that table — the real
// proof for memory_feedback is in the prompt-submit tests further down.
test('session-start writes recent_injections when the switch is off', async () => {
  const db = seed();
  await runSessionStart(false);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n > 0);
});

test('session-start writes no recent_injections rows while the switch is on', async () => {
  const db = seed();
  await runSessionStart(true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n, 0);
  // Guard against a future change, not proof about this one — see comment above.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_feedback').get().n, 0);
});

// prompt-submit is the handler the brief's own tests never exercised: it
// writes BOTH recent_injections AND memory_feedback (memory_feedback INSERT
// at prompt-submit.mjs:108-116), both inside the single
// `if (hookData.session_id && rows.length && !disableScopeIsolation)` guard.
// Task 4's seed() above only seeds injection_cache — a different table that
// session-start reads directly and prompt-submit never touches — so
// exercising this handler requires seeding `memories`, the table
// retrieveMemories() actually queries.
const PROMPT_SUBMIT_TEXT = 'tell me about the zebrafish research notes';

// Seeds one project-scoped memory for PROJ_A/KEY_A whose content shares
// tokens with PROMPT_SUBMIT_TEXT, so lexicalRetrieve's FTS/LIKE/legacy-
// substring lanes (whichever is active in this environment) all have
// something real to match — this is what lets the non-vacuity probe below
// assert `matched > 0` instead of hoping.
function seedMemories() {
  const db = openDb();
  db.exec('DELETE FROM memories');
  db.exec('DELETE FROM recent_injections');
  db.exec('DELETE FROM memory_feedback');
  db.exec('DELETE FROM session_context');
  db.exec("DELETE FROM config_kv WHERE key = 'mode'");

  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES ('project', ?, 'fact', ?, 'auto_inferred', 0.5, 'active', 'active', ?, ?, ?)`
  ).run(KEY_A, 'zebrafish research notes for the prompt submit fixture', now, now, now);

  return db;
}

// handlePromptSubmit(hookData) is single-argument like handleSessionStart —
// it opens its own db via openDb() and closes it itself, so it reads
// whatever seedMemories() just wrote to the same on-disk db under
// CCMEM_DATA_ROOT. cwd is pinned to PROJ_A_CWD so the seeded row is always
// "own project" — cross-project matching is Tasks 2/3's concern, not this
// task's; this task only needs retrieval to match *something*.
async function runPromptSubmit(disableScopeIsolation, sessionId = 's-w2-prompt-submit') {
  writeConfig(disableScopeIsolation);
  return handlePromptSubmit({ cwd: PROJ_A_CWD, session_id: sessionId, prompt: PROMPT_SUBMIT_TEXT });
}

// WHY (non-vacuity probe, mandatory): both writes below are guarded by
// `rows.length`, so "zero rows written" is trivially true whenever retrieval
// simply matched nothing — a test that only checked the two COUNT(*)s would
// pass identically whether the guard exists or retrieval is just broken,
// proving nothing. handlePromptSubmit returns _metricFields.matched =
// rows.length (prompt-submit.mjs:128-130); asserting it is > 0 here is what
// turns "zero rows written" into "retrieval DID return rows and the writes
// were suppressed" instead of "nothing was retrieved".
test('prompt-submit writes neither recent_injections nor memory_feedback while the switch is on, even though retrieval matched', async () => {
  const db = seedMemories();
  const out = await runPromptSubmit(true);
  assert.ok(out._metricFields.matched > 0, 'fixture must actually match — otherwise this test is vacuous');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_feedback').get().n, 0);
});

test('prompt-submit writes both recent_injections and memory_feedback as usual while the switch is off', async () => {
  const db = seedMemories();
  const out = await runPromptSubmit(false);
  assert.ok(out._metricFields.matched > 0, 'fixture must actually match — otherwise this test is vacuous');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n > 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM memory_feedback').get().n > 0);
});

test.after(() => {
  rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true });
  rmSync(PROJ_A_CWD, { recursive: true, force: true });
  rmSync(PROJ_B_CWD, { recursive: true, force: true });
});
