import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-no-trunc-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
// Any LLM call these tests forget to mock must fail, never reach a real model.
process.env.CCMEM_CLAUDE_P_COMMAND = '/usr/bin/false';
delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
const { runTask } = await import('../../scripts/daemon/loop.mjs');

/**
 * Spec A2: what the summarizer produced must reach memory whole, or not at
 * all with the full text audited. A silent slice (the old 200-char cut on the
 * summary fields, or the word-boundary fallback after a failed refine) stores
 * a fragment nobody asked for and nobody can see was cut. These tests drive the
 * real task end to end and read back what was stored, so a slice re-added
 * anywhere on the path turns them red.
 */
const SENTENCE = 'Verification runs stay unfiltered so that exit codes survive the pipeline. ';

function longText(marker, chars) {
  const body = `${marker} ${SENTENCE.repeat(Math.ceil(chars / SENTENCE.length))}`;
  return body.slice(0, chars).trimEnd().padEnd(chars, 'x');
}

function seedTask(db, { sessionId, synthesized, refinerOutputs }) {
  // Each test starts from no memories, so dedup against a row an earlier test
  // left behind can never hide (or fake) what this test stores.
  db.prepare('DELETE FROM memories').run();
  const transcriptPath = path.join(dataRoot, `${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: SENTENCE.repeat(10) }] } })}\n` +
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
      llm_output: JSON.stringify({ synthesized }),
      ...(refinerOutputs ? { refiner_llm_outputs: refinerOutputs } : {})
    }),
    Date.now(),
    Date.now()
  );
  return db.prepare(`SELECT * FROM tasks WHERE type = 'summarize_pending' ORDER BY id DESC LIMIT 1`).get();
}

async function withConfig(summarizeOverrides, fn) {
  const previous = process.env.CCMEM_CONFIG_PATH;
  const configPath = path.join(dataRoot, `config-${Math.random().toString(36).slice(2)}.json`);
  // The quality gate is off so that a missing row can only mean the refine
  // path kept it out, never that the gate happened to reject the fragment.
  writeFileSync(configPath, JSON.stringify({
    summarize: {
      min_transcript_after_clean: 1,
      quality_gate: { enabled: false },
      content_refiner: { enabled: false },
      ...summarizeOverrides
    },
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

function rowsContaining(db, marker) {
  return db.prepare(`SELECT content, summary_meta FROM memories WHERE content LIKE ?`).all(`%${marker}%`);
}

function rejectAudits(db, sessionId) {
  return db.prepare(
    `SELECT details FROM audit_log
     WHERE action = 'summarize_refine_rejected'
       AND json_extract(details, '$.session_id') = ?`
  ).all(sessionId).map((row) => JSON.parse(row.details));
}

test('summary fields are not sliced', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const learned = longText('learned-field', 450);
      // Precondition on the fixture only (it cannot fail on product code): the
      // field must be longer than the old 200-char cut. What the product kept
      // is measured after the run, on the stored row.
      assert.equal(learned.length, 450);
      const task = seedTask(db, {
        sessionId: 's-fields',
        synthesized: [{
          content: 'marker-fields: this project keeps verification runs unfiltered.',
          type: 'rule',
          scope: 'project',
          tags: [],
          learned
        }]
      });
      await runSummarizePending(db, task);

      const rows = rowsContaining(db, 'marker-fields');
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0].summary_meta).learned.length, 450);
      assert.equal(JSON.parse(rows[0].summary_meta).learned, learned);
    });
  } finally {
    db.close();
  }
});

test('refine failure keeps the memory out and audits the full text', async () => {
  const db = openDb();
  try {
    await withConfig({ content_refiner: { enabled: true } }, async () => {
      const content = longText('marker-refine', 900);
      const tooLong = longText('marker-refine', 700);
      const task = seedTask(db, {
        sessionId: 's-refine',
        synthesized: [{ content, type: 'rule', scope: 'project', tags: [] }],
        refinerOutputs: [JSON.stringify({ content: tooLong }), JSON.stringify({ content: tooLong })]
      });
      await runSummarizePending(db, task);

      assert.deepEqual(rowsContaining(db, 'marker-refine'), [], 'no truncated fragment may be stored');
      const audits = rejectAudits(db, 's-refine');
      assert.equal(audits.length, 1);
      assert.equal(audits[0].reason, 'still_too_long');
      assert.equal(audits[0].content.length, 900);
      assert.equal(audits[0].content, content);
    });
  } finally {
    db.close();
  }
});

test('a too-long first rewrite is re-asked once and the fitting rewrite is stored', async () => {
  const db = openDb();
  try {
    await withConfig({ content_refiner: { enabled: true } }, async () => {
      const content = longText('marker-retry', 900);
      const tooLong = longText('marker-retry', 700);
      const fits = longText('marker-retry', 300);
      const task = seedTask(db, {
        sessionId: 's-retry',
        synthesized: [{ content, type: 'rule', scope: 'project', tags: [] }],
        refinerOutputs: [JSON.stringify({ content: tooLong }), JSON.stringify({ content: fits })]
      });
      await runSummarizePending(db, task);

      const rows = rowsContaining(db, 'marker-retry');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, fits);
      assert.deepEqual(rejectAudits(db, 's-retry'), []);
    });
  } finally {
    db.close();
  }
});

test('refiner disabled stores nothing truncated', async () => {
  const db = openDb();
  try {
    await withConfig({ content_refiner: { enabled: false } }, async () => {
      const content = longText('marker-disabled', 900);
      const task = seedTask(db, {
        sessionId: 's-disabled',
        synthesized: [{ content, type: 'rule', scope: 'project', tags: [] }]
      });
      await runSummarizePending(db, task);

      assert.deepEqual(rowsContaining(db, 'marker-disabled'), [], 'no truncated fragment may be stored');
      const audits = rejectAudits(db, 's-disabled');
      assert.equal(audits.length, 1);
      assert.equal(audits[0].reason, 'refiner_disabled');
      assert.equal(audits[0].content, content);
    });
  } finally {
    db.close();
  }
});

test('json-string content is unwrapped', async () => {
  const db = openDb();
  try {
    await withConfig({}, async () => {
      const task = seedTask(db, {
        sessionId: 's-unwrap',
        synthesized: [{ content: '{"content":"Only clean up X"}', type: 'rule', scope: 'project', tags: [] }]
      });
      await runSummarizePending(db, task);

      const rows = rowsContaining(db, 'Only clean up X');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, 'Only clean up X');
    });
  } finally {
    db.close();
  }
});

// A backend that answers every real call with a usage-limit error, the way
// Claude reports an exhausted subscription. Only the refiner makes a real call
// here (the task's own LLM output is mocked).
async function withExhaustedLlm(fn) {
  const stub = path.join(dataRoot, `exhausted-llm-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(stub, "process.stderr.write('Claude usage limit reached. Your limit resets 5pm\\n');\nprocess.exit(1);\n");
  const previous = { command: process.env.CCMEM_CLAUDE_P_COMMAND, args: process.env.CCMEM_CLAUDE_P_ARGS_JSON };
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub]);
  try {
    return await fn();
  } finally {
    process.env.CCMEM_CLAUDE_P_COMMAND = previous.command;
    if (previous.args == null) delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    else process.env.CCMEM_CLAUDE_P_ARGS_JSON = previous.args;
    const db = openDb();
    try {
      db.prepare('DELETE FROM llm_backend_state').run();
      db.prepare('DELETE FROM llm_switch_proposals').run();
    } finally {
      db.close();
    }
  }
}

test('an exhausted backend during the refine leaves the task to be retried, not the memory rejected', async () => {
  const db = openDb();
  try {
    await withConfig({ content_refiner: { enabled: true } }, async () => {
      await withExhaustedLlm(async () => {
        const content = longText('marker-exhausted', 900);
        const task = seedTask(db, {
          sessionId: 's-exhausted',
          synthesized: [{ content, type: 'rule', scope: 'project', tags: [] }]
        });
        await runTask(db, task, runSummarizePending);

        assert.deepEqual(rejectAudits(db, 's-exhausted'), [], 'an unanswered refine is not a rejection');
        assert.deepEqual(rowsContaining(db, 'marker-exhausted'), []);
        assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'failed');
        const retries = db.prepare(
          `SELECT payload FROM tasks WHERE type = 'summarize_pending' AND status = 'queued' AND id > ?`
        ).all(task.id);
        assert.equal(retries.length, 1, 'the loop queues the same task again (spec G5)');
        assert.equal(retries[0].payload, task.payload);
      });
    });
  } finally {
    db.prepare(`DELETE FROM tasks WHERE type = 'summarize_pending'`).run();
    db.close();
  }
});
