import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-l25probe-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { recordL25Probe } = await import('../../scripts/lib/feedback.mjs');

const SESSION = 'sess-probe-1';

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function seedMemory(db, id, content) {
  db.prepare(
    `INSERT INTO memories (id, scope, project_key, type, content, source, trust_score,
                           status, decay_status, created_at, updated_at, last_touched_at)
     VALUES (?, 'global', NULL, 'rule', ?, 'auto_inferred', 0.5,
             'active', 'active', ?, ?, ?)`
  ).run(id, content, Date.now(), Date.now(), Date.now());
}

function seedInjection(db, promptIdx, memIds, source = 'user_prompt_submit', sessionId = SESSION) {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, promptIdx, source, JSON.stringify(memIds), Date.now());
}

function seedMemoryFeedback(db, sessionId, injectedIds) {
  db.prepare(
    `INSERT INTO memory_feedback (session_id, injection_source, injected_ids, recorded_at)
     VALUES (?, 'user_prompt_submit', ?, ?)`
  ).run(sessionId, JSON.stringify(injectedIds), Date.now());
}

function writeTranscript(assistantText) {
  const file = path.join(dataRoot, `transcript-${Math.floor(Math.random() * 1e9)}.jsonl`);
  writeFileSync(file, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
  })}\n`, 'utf8');
  return file;
}

// Decision-data rows default to enabled (config.metrics.decision_data.enabled
// defaults to true), so with the `{}` config most tests pass, the probe now
// writes to the durable decision stream (l25-probe.jsonl), not metrics.jsonl.
function probeLines() {
  let raw;
  try {
    raw = readFileSync(path.join(dataRoot, 'l25-probe.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.l25_probe === true);
}

test('probe records one metrics row per injected memory with all feature fields', () => {
  const db = openDb();
  seedMemory(db, 101, 'always use pnpm in this repository');
  seedInjection(db, 1, [101]);

  recordL25Probe(db, SESSION, writeTranscript('I will always use pnpm in this repository'), {});

  const rows = probeLines().filter((r) => r.mem_id === 101);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.hook, 'stop');
  assert.equal(r.prompt_idx, 1);
  assert.equal(r.mem_type, 'rule');
  assert.equal(r.mem_source, 'auto_inferred');
  assert.ok(r.l25_cov > 0.9, 'a near-verbatim reply should score high coverage');
  assert.ok(r.l25_lcp >= 6, 'verbatim run should be detected');
  assert.equal(typeof r.l25_id_literal, 'boolean');
  assert.equal(typeof r.l25_legacy_hit, 'boolean');
  assert.ok(Number.isFinite(r.mem_len) && Number.isFinite(r.reply_len));
});

// R1 regression: the case that the broken design would have silently dropped.
test('probe still records turns where the legacy matcher would have fired', () => {
  const db = openDb();
  const content = 'prefer esm imports over commonjs require';
  seedMemory(db, 102, content);
  seedInjection(db, 2, [102]);

  // Reply contains the memory verbatim -> legacy matcher hits.
  recordL25Probe(db, SESSION, writeTranscript(`Noted: ${content} going forward`), {});

  const rows = probeLines().filter((r) => r.mem_id === 102);
  assert.equal(rows.length, 1, 'legacy-hit turns must NOT be dropped by the probe');
  assert.equal(rows[0].l25_legacy_hit, true,
    'the control baseline must be able to be true, otherwise v0.14 has no comparison');
});

test('probe ignores session_start bulk injections', () => {
  const db = openDb();
  seedMemory(db, 103, 'this memory came from the session start bundle');
  // prompt_idx is deliberately far higher than any other row seeded in this
  // file (in either source) so that ORDER BY prompt_idx DESC would pick THIS
  // row over every user_prompt_submit row if the inject_source filter were
  // ever removed — the test must fail for that reason alone, not because a
  // session_start row happens to lose a prompt_idx tie-break.
  seedInjection(db, 1_000_000, [103], 'session_start', SESSION);

  recordL25Probe(db, SESSION, writeTranscript('unrelated reply'), {});

  assert.equal(probeLines().filter((r) => r.mem_id === 103).length, 0,
    'session_start injections are not turn-aligned and must be excluded');
});

test('probe does not modify trust, outcome, or decay_status', () => {
  const db = openDb();
  seedMemory(db, 104, 'some durable project convention worth keeping');
  seedInjection(db, 3, [104]);
  // outcome lives in memory_feedback, not memories — a regression that calls
  // noteFeedback() instead of adjustTrust() would rewrite outcome here while
  // leaving every memories column untouched, so it must be checked too.
  seedMemoryFeedback(db, SESSION, [104]);

  const beforeMemory = db.prepare(
    `SELECT trust_score, decay_status, status FROM memories WHERE id = 104`).get();
  const beforeFeedback = db.prepare(
    `SELECT id, outcome, outcome_locked FROM memory_feedback WHERE session_id = ?`).all(SESSION);

  recordL25Probe(db, SESSION, writeTranscript('a reply mentioning conventions'), {});

  const afterMemory = db.prepare(
    `SELECT trust_score, decay_status, status FROM memories WHERE id = 104`).get();
  const afterFeedback = db.prepare(
    `SELECT id, outcome, outcome_locked FROM memory_feedback WHERE session_id = ?`).all(SESSION);

  assert.deepEqual(afterMemory, beforeMemory, 'the probe is observe-only (memories)');
  assert.deepEqual(afterFeedback, beforeFeedback, 'the probe is observe-only (memory_feedback.outcome)');
});

test('probe honours enabled=false', () => {
  const db = openDb();
  seedMemory(db, 105, 'a memory that should not be probed at all');
  seedInjection(db, 4, [105]);

  recordL25Probe(db, SESSION, writeTranscript('some reply'),
    { feedback: { l25_probe: { enabled: false } } });

  assert.equal(probeLines().filter((r) => r.mem_id === 105).length, 0);
});

test('probe truncates to max_per_turn', () => {
  const db = openDb();
  const ids = [201, 202, 203];
  ids.forEach((id) => seedMemory(db, id, `memory number ${id} with enough words to count`));
  seedInjection(db, 5, ids);

  recordL25Probe(db, SESSION, writeTranscript('reply text'),
    { feedback: { l25_probe: { max_per_turn: 2 } } });

  const seen = probeLines().filter((r) => ids.includes(r.mem_id));
  assert.equal(seen.length, 2);
});

test('probe skips memories with fewer than 3 usable tokens', () => {
  const db = openDb();
  seedMemory(db, 106, 'ok go');
  seedInjection(db, 6, [106]);

  recordL25Probe(db, SESSION, writeTranscript('ok go'), {});

  assert.equal(probeLines().filter((r) => r.mem_id === 106).length, 0);
});

// F1 regression (amended per design discussion): a turn that retrieves
// nothing writes no recent_injections row, but Stop still fires (e.g. "yes" /
// "continue" / a retried Stop call). Re-picking the previous turn's injection
// is not noise to suppress — it is a NEGATIVE CONTROL (a memory definitely
// not in context, scored against a reply), which v0.14 needs to know the
// noise floor. So both calls must record, labelled by whether the injection
// was actually new for that turn.
test('probe labels turn_aligned instead of suppressing repeated Stop calls', () => {
  const db = openDb();
  const DEDUP_SESSION = 'sess-probe-dedup';
  seedMemory(db, 401, 'a memory used to test the turn_aligned label');
  seedInjection(db, 1, [401], 'user_prompt_submit', DEDUP_SESSION);
  const transcript = writeTranscript('a reply mentioning the turn_aligned label');

  recordL25Probe(db, DEDUP_SESSION, transcript, {});
  recordL25Probe(db, DEDUP_SESSION, transcript, {});

  const rows = probeLines().filter((r) => r.mem_id === 401);
  assert.equal(rows.length, 2, 'both calls must record — the second is a negative control, not noise');
  assert.equal(rows[0].turn_aligned, true, 'the first call has a genuinely new injection');
  assert.equal(rows[1].turn_aligned, false, 'the second call re-measures the same injection against a new reply');
});

// F4 regression: the real v0.12 matcher (matchesImplicitReference) lowercases
// the reply before checking `text.includes('m' + id)`, with no word boundary.
// A reply containing the id literal in a different case must still count.
test('l25_id_literal and l25_legacy_hit match the real matcher\'s case-insensitive id semantics', () => {
  const db = openDb();
  const ID_LITERAL_SESSION = 'sess-probe-idlit';
  seedMemory(db, 501, 'an unrelated memory used only to exercise the id literal check');
  seedInjection(db, 1, [501], 'user_prompt_submit', ID_LITERAL_SESSION);

  // The reply does not repeat the memory content, so the content-match branch
  // is false here; only the (differently-cased) id literal should hit.
  recordL25Probe(db, ID_LITERAL_SESSION,
    writeTranscript('See M501 for context, nothing else matches here'), {});

  const rows = probeLines().filter((r) => r.mem_id === 501);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].l25_id_literal, true,
    'uppercase "M501" must still match — the real matcher lowercases before comparing');
  assert.equal(rows[0].l25_legacy_hit, true,
    'the id-literal branch must be folded into the legacy baseline, matching the real matcher');
});

// F5 ruling: do not change the tokenizer, but flag CJK content so v0.14 can
// segment the distribution (an unbroken CJK run collapses to one token,
// which saturates l25_lcp and skews l25_cov for CJK memories).
test('has_cjk flags memory content containing CJK characters', () => {
  const db = openDb();
  const CJK_SESSION = 'sess-probe-cjk';
  seedMemory(db, 601, '总是 使用 拼音输入法');
  seedInjection(db, 1, [601], 'user_prompt_submit', CJK_SESSION);

  recordL25Probe(db, CJK_SESSION, writeTranscript('好的，已经确认'), {});

  const rows = probeLines().filter((r) => r.mem_id === 601);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].has_cjk, true, 'CJK memory content must be flagged for later segmentation');
});

test('has_cjk is false for latin-only memory content', () => {
  const db = openDb();
  const CJK_NEG_SESSION = 'sess-probe-cjk-neg';
  seedMemory(db, 602, 'always use pnpm in every latin only memory here');
  seedInjection(db, 1, [602], 'user_prompt_submit', CJK_NEG_SESSION);

  recordL25Probe(db, CJK_NEG_SESSION, writeTranscript('always use pnpm somewhere else'), {});

  const rows = probeLines().filter((r) => r.mem_id === 602);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].has_cjk, false);
});

test('probe is a no-op when the session has no prompt injections', () => {
  const db = openDb();
  assert.doesNotThrow(() => recordL25Probe(db, 'session-with-nothing', writeTranscript('hi'), {}));
});

test('probe is a no-op when the transcript is missing', () => {
  const db = openDb();
  seedMemory(db, 107, 'a memory with several meaningful tokens here');
  seedInjection(db, 7, [107]);

  assert.doesNotThrow(() =>
    recordL25Probe(db, SESSION, path.join(dataRoot, 'does-not-exist.jsonl'), {}));
  assert.equal(probeLines().filter((r) => r.mem_id === 107).length, 0);
});
