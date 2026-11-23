import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-provenance-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { SUMMARIZE_PENDING_JSON_SCHEMA, buildSummarizePrompt } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

/**
 * Tester #446: a memory had no verifiability dimension. Provenance lived only in `audit_log.details`
 * (session_id + transcript_path), and the transcripts themselves are being cleaned by the OS — so
 * nothing could later check a memory against what was actually said, and `summary_meta`'s
 * investigated/learned columns, present in the schema since v0.1, were filled in 1 row of 1162.
 *
 * The two P0 pieces: a memory records the session and transcript it came from when they are known,
 * and the extraction prompt asks for and requires `learned` so a future calibration task has
 * something to compare against.
 */
test('a memory records the session and transcript it was extracted from (#446)', async () => {
  const db = openDb();
  const m = await insertMemory(db, {
    cwd: process.cwd(), content: 'provenance probe: record where this came from', scope: 'global', embedSync: false,
    provenance: { sessionId: 'sess-1', transcriptPath: '/tmp/sess-1.jsonl' },
  });
  const row = db.prepare('SELECT session_id, transcript_path FROM memories WHERE id = ?').get(m.id);
  // mutation: drop the columns from the insert -> both NULL, red
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.transcript_path, '/tmp/sess-1.jsonl');
  db.close();
});

test('a memory without provenance stays NULL rather than guessed (#446)', async () => {
  const db = openDb();
  const m = await insertMemory(db, { cwd: process.cwd(), content: 'no provenance probe at all', scope: 'global', embedSync: false });
  const row = db.prepare('SELECT session_id, transcript_path FROM memories WHERE id = ?').get(m.id);
  assert.equal(row.session_id, null);
  assert.equal(row.transcript_path, null);
  db.close();
});

test('the extraction schema requires learned, so a memory says what it established (#446)', () => {
  // mutation: remove 'learned' from required -> a model may omit it and the column stays empty, red
  assert.ok(SUMMARIZE_PENDING_JSON_SCHEMA.properties.synthesized.items.required.includes('learned'));
});

test('the extraction prompt asks for the fields it requires (#446)', () => {
  const prompt = buildSummarizePrompt('user: hello\nassistant: hi');
  for (const field of ['learned', 'investigated']) {
    // mutation: drop the field's instruction -> the model never fills it, red
    assert.match(prompt, new RegExp(`\\b${field}\\b`), `prompt names ${field}`);
  }
});

// The write path the extraction run actually takes: without this, the columns exist and stay NULL.
test('a summarized memory carries the session and transcript of the run (#446)', async () => {
  const db = openDb();
  const probe = mkdtempSync(path.join(tmpdir(), 'ccmem-prov-transcript-'));
  const transcriptPath = path.join(probe, 'session.jsonl');
  const { writeFileSync } = await import('node:fs');
  // Long enough to clear summarize.min_transcript_after_clean (200 chars) and the 2-message minimum.
  const line = (who, text) => JSON.stringify({ type: who, message: { content: [{ type: 'text', text }] } });
  writeFileSync(transcriptPath, [
    line('user', `remember the deploy order: ${'blue then green. '.repeat(12)}`),
    line('assistant', `deploy order noted: ${'blue then green. '.repeat(12)}`),
  ].join('\n'));
  const { buildSummarizePrompt: _b, runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
  const sessionId = 'sess-prov-1';
  db.prepare(`INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent, transcript_path)
    VALUES (?, 'p', 0, 2, 0, 2, ?, 'claude-code', ?)`).run(sessionId, Date.now(), transcriptPath);
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, last_message_seq: 2,
    llm_output: JSON.stringify([{ content: 'deploy order is blue then green', type: 'fact', scope: 'global', tags: ['deploy'], learned: 'deploy order is blue then green' }]) });
  const id = Number(db.prepare(`INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, started_at) VALUES ('summarize_pending', ?, ?, ?, 'running', ?) RETURNING id`).get(payload, Date.now(), Date.now(), Date.now()).id);
  await runSummarizePending(db, db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  const row = db.prepare("SELECT session_id, transcript_path, summary_meta FROM memories WHERE content LIKE 'deploy order is blue%' ORDER BY id DESC LIMIT 1").get();
  // mutation: drop `provenance` from the insert call -> both NULL while the columns exist, red
  assert.equal(row.session_id, sessionId);
  assert.equal(row.transcript_path, transcriptPath);
  assert.match(String(row.summary_meta), /learned/);
  db.close();
  rmSync(probe, { recursive: true, force: true });
});
