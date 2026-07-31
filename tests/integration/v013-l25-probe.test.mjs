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

function seedInjection(db, promptIdx, memIds, source = 'user_prompt_submit') {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(SESSION, promptIdx, source, JSON.stringify(memIds), Date.now());
}

function writeTranscript(assistantText) {
  const file = path.join(dataRoot, `transcript-${Math.floor(Math.random() * 1e9)}.jsonl`);
  writeFileSync(file, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
  })}\n`, 'utf8');
  return file;
}

function probeLines() {
  const raw = readFileSync(path.join(dataRoot, 'metrics.jsonl'), 'utf8');
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
  seedInjection(db, 0, [103], 'session_start');

  recordL25Probe(db, SESSION + '-ss', writeTranscript('unrelated reply'), {});

  assert.equal(probeLines().filter((r) => r.mem_id === 103).length, 0,
    'session_start injections are not turn-aligned and must be excluded');
});

test('probe does not modify trust, outcome, or decay_status', () => {
  const db = openDb();
  seedMemory(db, 104, 'some durable project convention worth keeping');
  seedInjection(db, 3, [104]);

  const before = db.prepare(
    `SELECT trust_score, decay_status, status FROM memories WHERE id = 104`).get();

  recordL25Probe(db, SESSION, writeTranscript('a reply mentioning conventions'), {});

  const after = db.prepare(
    `SELECT trust_score, decay_status, status FROM memories WHERE id = 104`).get();
  assert.deepEqual(after, before, 'the probe is observe-only');
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
