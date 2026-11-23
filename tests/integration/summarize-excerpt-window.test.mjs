import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-excerpt-window-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');
const { runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
const { runTask } = await import('../../scripts/daemon/loop.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');

/**
 * These two tests exist because the window has to be honoured AT THE CALL SITE.
 * A unit test on the excerpt helper that passes the width in as an argument
 * would stay green even if the task kept slicing to a hard-coded constant --
 * which is exactly the bug being removed here. So both assertions read the
 * excerpt that was actually handed to the LLM, out of the audit row that
 * records it.
 */
const LONG_LINE = 'The team keeps every verification run unfiltered so exit codes survive. ';

function seedSession(db, { sessionId, transcriptPath, joinedChars }) {
  // one user entry long enough that the joined transcript exceeds any window
  // under test, plus a second entry so the session clears the min-length gate
  const filler = LONG_LINE.repeat(Math.ceil(joinedChars / LONG_LINE.length));
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: filler }] } })}\n` +
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'acknowledged' }] } })}\n`
  );
  db.prepare(
    `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at)
     VALUES (?, 'demo/repo', 0, 3, 0, 2, ?)`
  ).run(sessionId, Date.now());
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(
    JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      last_message_seq: 2,
      llm_output: JSON.stringify({
        synthesized: [{
          content: 'This project keeps verification runs unfiltered so exit codes survive.',
          type: 'rule',
          scope: 'project',
          tags: ['verification']
        }]
      })
    }),
    Date.now(),
    Date.now()
  );
  return db.prepare(`SELECT * FROM tasks WHERE type = 'summarize_pending' ORDER BY id DESC LIMIT 1`).get();
}

function excerptSentFor(db, sessionId) {
  const row = db.prepare(
    `SELECT details FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = ?
     ORDER BY id DESC LIMIT 1`
  ).get(sessionId);
  assert.ok(row, `no summarize_pending_applied audit row for ${sessionId}`);
  return JSON.parse(row.details).transcript_excerpt;
}

async function withConfig(overrides, fn) {
  const previous = process.env.CCMEM_CONFIG_PATH;
  const configPath = path.join(dataRoot, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify({
    summarize: { min_transcript_after_clean: 1, content_refiner: { enabled: false }, ...overrides },
    save: { max_chars_per_memory: 500 }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.CCMEM_CONFIG_PATH;
    else process.env.CCMEM_CONFIG_PATH = previous;
  }
}

test('a daemon that predates the window summarizes the same whole transcript', async () => {
  // The compatibility promise: last_message_seq means "the whole transcript", so an
  // OLD daemon (one that ignores transcript_window and parses the whole file) slices
  // the same prefix the new daemon would summarize. Hand it a Stop payload with the
  // window stripped -- exactly what an un-restarted daemon reads -- and the excerpt
  // must still end with the newest turn, not the file's opening.
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const sessionId = 's-legacy-daemon';
      const transcriptPath = path.join(dataRoot, 'legacy-daemon.jsonl');
      const prefix = transcriptLine('user', 'p'.repeat(2 * 1024 * 1024 + 256));
      const snapshot = prefix
        + transcriptLine('assistant', 'window retained line')
        + transcriptLine('user', 'NEWEST TURN');
      writeFileSync(transcriptPath, snapshot);
      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });

      const task = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?`
      ).get(sessionId);
      const payload = JSON.parse(task.payload);
      // What the old daemon does: it has no idea the window exists.
      delete payload.transcript_window;
      payload.llm_output = JSON.stringify({ synthesized: [] });
      const legacyPayload = JSON.stringify(payload);
      db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(legacyPayload, task.id);

      await runSummarizePending(db, { ...task, payload: legacyPayload });

      const excerpt = excerptSentFor(db, sessionId);
      assert.ok(excerpt.includes('NEWEST TURN'), 'the legacy path must reach the newest turn');
      // The prefix is one huge line; the excerpt cap keeps its tail, so the summary
      // sees the same end of the transcript either way.
      assert.ok(excerpt.endsWith('NEWEST TURN'), 'the legacy path must end at the newest turn');
    });
  } finally {
    db.close();
  }
});

test('the excerpt handed to the LLM is as wide as the shipped default', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const sessionId = 's-excerpt-default';
      const task = seedSession(db, {
        sessionId,
        transcriptPath: path.join(dataRoot, 'excerpt-default.jsonl'),
        joinedChars: 20_000
      });
      await runSummarizePending(db, task);

      assert.equal(excerptSentFor(db, sessionId).length, DEFAULT_CONFIG.summarize.transcript_excerpt_max);
    });
  } finally {
    db.close();
  }
});

test('the excerpt width follows config, so a rollback needs no code change', async () => {
  const db = openDb();
  try {
    await withConfig({ transcript_excerpt_max: 1500 }, async () => {
      const sessionId = 's-excerpt-override';
      const task = seedSession(db, {
        sessionId,
        transcriptPath: path.join(dataRoot, 'excerpt-override.jsonl'),
        joinedChars: 20_000
      });
      await runSummarizePending(db, task);

      assert.equal(excerptSentFor(db, sessionId).length, 1500);
    });
  } finally {
    db.close();
  }
});

function transcriptLine(type, text) {
  return `${JSON.stringify({ type, message: { content: [{ type: 'text', text }] } })}\n`;
}

function withLlmOutput(db, task, synthesized) {
  const payload = JSON.parse(task.payload);
  payload.llm_output = JSON.stringify({ synthesized });
  const serialized = JSON.stringify(payload);
  db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(serialized, task.id);
  return { ...task, payload: serialized };
}

test('summarize reads the recorded Stop byte range after the transcript grows', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const sessionId = 's-snapshot-range';
      const transcriptPath = path.join(dataRoot, 'snapshot-range.jsonl');
      const prefix = transcriptLine('user', 'p'.repeat(2 * 1024 * 1024 + 256));
      const snapshot = prefix
        + transcriptLine('assistant', 'retained-before-tail')
        + transcriptLine('user', 'CAPTURED_TAIL');
      writeFileSync(transcriptPath, snapshot);

      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });
      let task = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?`
      ).get(sessionId);
      const snapshotPayload = JSON.parse(task.payload);
      // Whole-transcript count (scanTranscript), not the 2-entry window (Ruling above).
      assert.equal(snapshotPayload.last_message_seq, 3);
      assert.equal(Number.isFinite(snapshotPayload.snapshot_observed_at), true);
      assert.deepEqual(snapshotPayload.transcript_window, {
        startByte: Buffer.byteLength(prefix),
        endByte: Buffer.byteLength(snapshot),
        completeLinesOnly: true,
        complete: true
      });

      task = withLlmOutput(db, task, []);
      writeFileSync(transcriptPath, transcriptLine('user', 'APPENDED_SENTINEL'), { flag: 'a' });
      await runSummarizePending(db, task);

      const excerpt = excerptSentFor(db, sessionId);
      assert.ok(excerpt.includes('CAPTURED_TAIL'));
      assert.ok(!excerpt.includes('APPENDED_SENTINEL'));
    });
  } finally {
    db.close();
  }
});

test('Stop timestamp and transcript window survive a retry row', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const sessionId = 's-snapshot-retry';
      const transcriptPath = path.join(dataRoot, 'snapshot-retry.jsonl');
      writeFileSync(transcriptPath, transcriptLine('user', 'remember this rule') + transcriptLine('assistant', 'noted'));
      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });

      const originalTask = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?`
      ).get(sessionId);
      const originalPayload = JSON.parse(originalTask.payload);
      await runTask(db, originalTask, async () => {
        const error = new Error('simulated timeout');
        error.timedOut = true;
        throw error;
      });

      const retryTask = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id DESC LIMIT 1`
      ).get(sessionId);
      const retryPayload = JSON.parse(retryTask.payload);

      assert.ok(retryTask.id > originalTask.id);
      assert.equal(retryPayload.snapshot_observed_at, originalPayload.snapshot_observed_at);
      assert.deepEqual(retryPayload.transcript_window, originalPayload.transcript_window);
    });
  } finally {
    db.close();
  }
});

test('a newer Stop supersedes the older active snapshot range', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const sessionId = 's-equal-count-snapshot';
      const transcriptPath = path.join(dataRoot, 'equal-count-snapshot.jsonl');
      const prefix = transcriptLine('user', 'p'.repeat(2 * 1024 * 1024 + 256));
      const firstSnapshot = prefix
        + transcriptLine('assistant', 'first snapshot entry one')
        + transcriptLine('user', 'first snapshot entry two');
      writeFileSync(transcriptPath, firstSnapshot);
      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });
      await new Promise((resolve) => setTimeout(resolve, 2));

      const extension = transcriptLine('assistant', 'f'.repeat(2 * 1024 * 1024 + 256))
        + transcriptLine('assistant', 'second snapshot entry one')
        + transcriptLine('user', 'second snapshot entry two');
      writeFileSync(transcriptPath, extension, { flag: 'a' });
      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });

      const tasks = db.prepare(
        `SELECT id, status, payload FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id ASC`
      ).all(sessionId);
      // Both Stops queued their snapshot: the whole-transcript sequence differs, so
      // the unique index does not merge them. Stop itself supersedes nothing.
      assert.equal(tasks.length, 2);
      assert.deepEqual(tasks.map((row) => row.status), ['queued', 'queued']);
      const older = JSON.parse(tasks[0].payload);
      const newer = JSON.parse(tasks[1].payload);
      // Whole-transcript counts (scanTranscript), not the retained window's entry count.
      assert.ok(newer.last_message_seq > older.last_message_seq);
      assert.ok(newer.transcript_window.endByte > older.transcript_window.endByte);
      assert.ok(newer.snapshot_observed_at > older.snapshot_observed_at);

      // The ordering lives in the run, not in the Stop: running the newer snapshot
      // retires the older pending row, and only the newer one is summarized.
      const newerTask = withLlmOutput(db, tasks[1], [{
        content: 'This project should retain the newer snapshot memory.',
        type: 'rule',
        scope: 'project',
        tags: ['snapshot-ordering']
      }]);
      await runSummarizePending(db, newerTask);
      const after = db.prepare(
        `SELECT id, status FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id ASC`
      ).all(sessionId);
      // runSummarizePending does not touch the row's status (runTask owns that): the
      // older pending row is retired, the row being summarized stays queued.
      assert.deepEqual(after.map((row) => [row.id, row.status]), [[tasks[0].id, 'superseded'], [tasks[1].id, 'queued']]);
    });
  } finally {
    db.close();
  }
});

test('older Stop task is superseded when a newer snapshot retains fewer entries', async () => {
  const db = openDb();
  try {
    await withConfig({ quality_gate: { enabled: false } }, async () => {
      const sessionId = 's-shrinking-snapshot';
      const transcriptPath = path.join(dataRoot, 'shrinking-snapshot.jsonl');
      const prefix = transcriptLine('user', 'p'.repeat(2 * 1024 * 1024 + 256));
      const firstSnapshot = prefix
        + transcriptLine('user', 'older snapshot marker one')
        + transcriptLine('assistant', 'older snapshot marker two')
        + transcriptLine('user', 'older snapshot marker three');
      writeFileSync(transcriptPath, firstSnapshot);

      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });
      let olderTask = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id ASC LIMIT 1`
      ).get(sessionId);
      olderTask = withLlmOutput(db, olderTask, [{
        content: 'This project should retain the older snapshot memory.',
        type: 'rule',
        scope: 'project',
        tags: ['snapshot-ordering']
      }]);
      await new Promise((resolve) => setTimeout(resolve, 2));

      const extension = transcriptLine('assistant', 'f'.repeat(2 * 1024 * 1024 + 256))
        + transcriptLine('user', 'newer snapshot marker one')
        + transcriptLine('assistant', 'newer snapshot marker two');
      writeFileSync(transcriptPath, extension, { flag: 'a' });
      await handleStop(db, { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd() });
      let newerTask = db.prepare(
        `SELECT * FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id DESC LIMIT 1`
      ).get(sessionId);
      const olderPayload = JSON.parse(olderTask.payload);
      const newerPayload = JSON.parse(newerTask.payload);
      assert.ok(newerPayload.transcript_window.endByte > olderPayload.transcript_window.endByte);
      // Ruling (2026-11-23, #395 follow-up): last_message_seq keeps its WHOLE-transcript
      // meaning (scanTranscript), not the retained window's entry count. A daemon that
      // predates the window parses the full file and slices it with this number; a
      // window-relative count would make it summarize the transcript's opening turns.
      // The file only grows between two Stops, so the newer Stop's sequence is larger
      // even though its 2 MiB tail now holds fewer entries.
      assert.ok(newerPayload.last_message_seq > olderPayload.last_message_seq);
      assert.ok(newerPayload.snapshot_observed_at > olderPayload.snapshot_observed_at);
      assert.ok(newerTask.id > olderTask.id);
      newerTask = withLlmOutput(db, newerTask, [{
        content: 'This project should retain the newer snapshot memory.',
        type: 'rule',
        scope: 'project',
        tags: ['snapshot-ordering']
      }]);

      db.prepare('UPDATE tasks SET status = \'failed\' WHERE id = ?').run(olderTask.id);
      const retryInsert = db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts)
         VALUES ('summarize_pending', ?, ?, ?, 'queued', 1)`
      ).run(olderTask.payload, Date.now(), Date.now());
      const retryTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(retryInsert.lastInsertRowid));
      assert.ok(retryTask.id > newerTask.id);

      await runSummarizePending(db, retryTask);
      const statusesAfterRetryRun = db.prepare(
        `SELECT id, status FROM tasks
         WHERE type = 'summarize_pending'
           AND json_extract(payload, '$.session_id') = ?
         ORDER BY id ASC`
      ).all(sessionId);
      assert.deepEqual(statusesAfterRetryRun.map((row) => [row.id, row.status]), [
        [olderTask.id, 'failed'],
        [newerTask.id, 'queued'],
        [retryTask.id, 'superseded']
      ]);

      await runSummarizePending(db, newerTask);
      const memories = db.prepare(
        `SELECT content FROM memories
         WHERE source = 'auto_inferred'
           AND content IN (?, ?)
         ORDER BY content ASC`
      ).all(
        'This project should retain the older snapshot memory.',
        'This project should retain the newer snapshot memory.'
      );
      assert.deepEqual(memories.map((row) => row.content), [
        'This project should retain the newer snapshot memory.'
      ]);
    });
  } finally {
    db.close();
  }
});
