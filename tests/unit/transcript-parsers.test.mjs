import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Codex and oh-my-pi sessions must feed the same summarizer and feedback
// learning that Claude Code transcripts feed. Each agent writes a different
// file format; one parser per agent turns it into the entry shape everything
// downstream already reads. These tests pin what each parser keeps and drops,
// because a parser that lets injected context through turns AGENTS.md, the
// environment block or ccmem's own output into "memories".
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-transcript-parsers-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { parseTranscript, countTranscriptLines, computeSessionStats } = await import('../../scripts/lib/transcript.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');
const { runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/transcripts');
const CODEX_FIXTURE = path.join(FIXTURES, 'codex-rollout.jsonl');
const OMP_FIXTURE = path.join(FIXTURES, 'omp-session.jsonl');

const user = (content) => ({ type: 'user', message: { content } });
const assistant = (content) => ({ type: 'assistant', message: { content } });
const tool = () => ({ type: 'tool', message: { content: '' } });

const CODEX_EXPECTED = [
  user('Please switch the build to pnpm.'),
  tool(),
  tool(),
  assistant('Switched the build to pnpm and regenerated the lockfile.'),
  user('Thanks. Always use pnpm in this repository.'),
  assistant('Noted: \npnpm from now on.')
];

const OMP_EXPECTED = [
  user('How should the config file be formatted?'),
  assistant('Let me check what the loader reads.'),
  tool(),
  user('Use JSON; it is what the loader reads.'),
  assistant('Switched the config to JSON.')
];

// A Claude Code transcript in the shapes it really writes, including a
// tool_result and a non-conversation line.
const CLAUDE_LINES = [
  { type: 'summary', summary: 'fixture summary', leafUuid: 'u0' },
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Please switch the build to pnpm.' } },
  { type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'Switched.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }
];

function writeTemp(name, text) {
  const file = path.join(dataRoot, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

function withDb(fn) {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function withDbAsync(fn) {
  const db = openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

test('codex: keeps the conversation and tool calls, drops injected context', () => {
  const entries = parseTranscript(CODEX_FIXTURE, 'codex');
  // The fixture also holds a developer message, an AGENTS.md item, an
  // environment_context item, a user_instructions item, ccmem's read
  // instruction, tool outputs, reasoning and event lines: none may survive.
  assert.deepEqual(entries, CODEX_EXPECTED);
});

test('codex: no injected or tool-output text reaches the extracted text', () => {
  const joined = parseTranscript(CODEX_FIXTURE, 'codex').map((entry) => entry.message.content).join('\n');
  for (const leak of ['AGENTS.md', 'environment_context', 'user_instructions', 'permissions instructions', '## ccmem context', '=== ccmem:', 'Fixture rule']) {
    assert.equal(joined.includes(leak), false, `codex parser leaked "${leak}"`);
  }
});

test('omp: follows the active branch only, in order', () => {
  const entries = parseTranscript(OMP_FIXTURE, 'omp');
  // e3/e4 are an abandoned branch off e2; the last physical entry (a
  // title_change) is the leaf, and walking parentId from it skips them.
  assert.deepEqual(entries, OMP_EXPECTED);
  assert.equal(entries.some((entry) => entry.message.content.includes('ABANDONED')), false);
});

test('omp: a user message carrying ccmem\'s read instruction is dropped', () => {
  const joined = parseTranscript(OMP_FIXTURE, 'omp').map((entry) => entry.message.content).join('\n');
  assert.equal(joined.includes('## ccmem context'), false);
  assert.equal(joined.includes('=== ccmem:'), false);
});

test('claude-code: output is the raw entries, unchanged, with or without the agent argument', () => {
  const file = writeTemp('claude.jsonl', `${CLAUDE_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`);
  assert.deepEqual(parseTranscript(file), CLAUDE_LINES);
  assert.deepEqual(parseTranscript(file, 'claude-code'), CLAUDE_LINES);
});

test('parsers skip malformed lines', () => {
  // A transcript is read while the agent may still be appending to it, so the
  // last line can be half-written. That must cost one line, not the whole
  // Stop hook (it used to throw out of JSON.parse).
  const cases = [
    ['claude-code', `${CLAUDE_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`, CLAUDE_LINES],
    ['codex', readFileSync(CODEX_FIXTURE, 'utf8'), CODEX_EXPECTED],
    ['omp', readFileSync(OMP_FIXTURE, 'utf8'), OMP_EXPECTED]
  ];
  for (const [agent, text, expected] of cases) {
    const file = writeTemp(`half-${agent}.jsonl`, `${text}{"type":"message","id":"zz","parentId":"e1`);
    assert.deepEqual(parseTranscript(file, agent), expected, `${agent} did not skip the half line`);
  }
  // A malformed line in the middle is skipped too; for omp the leaf is still
  // the last line that parsed.
  const mid = writeTemp('mid-codex.jsonl', `not json\n${readFileSync(CODEX_FIXTURE, 'utf8')}`);
  assert.deepEqual(parseTranscript(mid, 'codex'), CODEX_EXPECTED);
});

test('codex: a zstd-compressed rollout yields no entries and says so on stderr', (t) => {
  const file = writeTemp('rollout-old.jsonl.zst', '\x28\xb5\x2f\xfd binary');
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  const entries = parseTranscript(file, 'codex');
  process.stderr.write = original;
  assert.deepEqual(entries, []);
  assert.equal(writes.some((line) => line.includes('.zst')), true, `no stderr notice: ${JSON.stringify(writes)}`);
});

test('count and stats are taken from the agent\'s normalized entries', () => {
  // last_message_seq slices this same parser output, so it must count
  // normalized entries, not raw lines (the codex fixture has 19 raw lines).
  assert.equal(countTranscriptLines(CODEX_FIXTURE, 'codex'), 6);
  assert.equal(countTranscriptLines(OMP_FIXTURE, 'omp'), 5);
  assert.deepEqual(computeSessionStats(CODEX_FIXTURE, 'codex'), { toolCalls: 2, messageCount: 6, durationMs: 0 });
  assert.deepEqual(computeSessionStats(OMP_FIXTURE, 'omp'), { toolCalls: 1, messageCount: 5, durationMs: 0 });
});

test('stop: a codex session is counted and learned from through the codex parser', async () => {
  const sessionId = 'sess-codex-stop';
  const memId = withDb((db) => {
    const now = Date.now();
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO memories (scope, project_key, type, content, source, trust_score,
                             status, decay_status, created_at, updated_at, last_touched_at)
       VALUES ('global', NULL, 'rule', 'pnpm from now on.', 'auto_inferred', 0.5,
               'active', 'active', ?, ?, ?)`
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
       VALUES (?, 1, 'user_prompt_submit', ?, ?)`
    ).run(sessionId, JSON.stringify([Number(lastInsertRowid)]), now);
    db.prepare(
      `INSERT INTO memory_feedback (session_id, injection_source, injected_ids, recorded_at)
       VALUES (?, 'user_prompt_submit', ?, ?)`
    ).run(sessionId, JSON.stringify([Number(lastInsertRowid)]), now);
    return Number(lastInsertRowid);
  });

  await withDbAsync((db) => handleStop(db, {
    session_id: sessionId,
    transcript_path: CODEX_FIXTURE,
    cwd: dataRoot,
    ccmem_agent: 'codex'
  }));

  withDb((db) => {
    const ctx = db.prepare('SELECT message_count, tool_calls, last_seq, agent FROM session_context WHERE session_id = ?').get(sessionId);
    assert.deepEqual({ ...ctx }, { message_count: 6, tool_calls: 2, last_seq: 6, agent: 'codex' });
    const task = db.prepare(
      `SELECT payload FROM tasks WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = ?`
    ).get(sessionId);
    assert.equal(JSON.parse(task.payload).last_message_seq, 6);
    // The last codex assistant reply quotes the injected memory, so implicit
    // feedback must see it. Read as a Claude transcript it has no assistant
    // entry at all, and this row would stay 'unknown'.
    const feedback = db.prepare('SELECT outcome FROM memory_feedback WHERE session_id = ?').get(sessionId);
    assert.equal(feedback.outcome, 'helpful_implicit', `memory ${memId} not credited`);
  });

  // The L2.5 probe reads the same last reply; without the codex parser it
  // finds no reply and writes no row.
  const probeRows = readFileSync(path.join(dataRoot, 'l25-probe.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.session_id === sessionId && row.mem_id === memId);
  assert.equal(probeRows.length, 1);
  assert.equal(probeRows[0].reply_head, 'Noted: \npnpm from now on.');
});

test('stop: an omp self-correction marks the turn unhelpful', async () => {
  const sessionId = 'sess-omp-selfcorrect';
  const file = writeTemp('omp-selfcorrect.jsonl', [
    { type: 'title', title: 't' },
    { type: 'session', version: 3, id: 's', timestamp: '2026-10-17T00:00:00.000Z', cwd: '/w' },
    { type: 'message', id: 'a1', parentId: null, timestamp: 't', message: { role: 'user', content: 'go' } },
    { type: 'message', id: 'a2', parentId: 'a1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'Actually, I was wrong about the flag.' }] } }
  ].map((line) => JSON.stringify(line)).join('\n'));
  withDb((db) => db.prepare(
    `INSERT INTO memory_feedback (session_id, injection_source, injected_ids, recorded_at)
     VALUES (?, 'user_prompt_submit', '[]', ?)`
  ).run(sessionId, Date.now()));

  // Through the Stop hook, so the agent must reach inferFromTranscript. Read
  // as a Claude transcript, the omp lines hold no assistant entry and the row
  // would stay 'unknown'.
  await withDbAsync((db) => handleStop(db, {
    session_id: sessionId,
    transcript_path: file,
    cwd: dataRoot,
    ccmem_agent: 'omp'
  }));

  withDb((db) => {
    const row = db.prepare('SELECT outcome FROM memory_feedback WHERE session_id = ?').get(sessionId);
    assert.equal(row.outcome, 'unhelpful');
  });
});

test('summarize: a codex session is summarized from the codex parser and stored as origin_agent=codex', async () => {
  const sessionId = 'sess-codex-summary';
  const configPath = path.join(dataRoot, 'summarize-config.json');
  writeFileSync(configPath, JSON.stringify({
    summarize: { min_transcript_after_clean: 1, content_refiner: { enabled: false } },
    save: { max_chars_per_memory: 500 }
  }));
  const previous = process.env.CCMEM_CONFIG_PATH;
  process.env.CCMEM_CONFIG_PATH = configPath;
  try {
    const task = withDb((db) => {
      db.prepare(
        `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent)
         VALUES (?, 'demo/repo', 2, 6, 0, 6, ?, 'codex')`
      ).run(sessionId, Date.now());
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('summarize_pending', ?, ?, ?, 'queued')`
      ).run(JSON.stringify({
        session_id: sessionId,
        transcript_path: CODEX_FIXTURE,
        last_message_seq: 6,
        agent: 'codex',
        llm_output: JSON.stringify({
          synthesized: [{ content: 'This repository builds with pnpm, never npm or yarn.', type: 'rule', scope: 'project', tags: ['build'] }]
        })
      }), Date.now(), Date.now());
      return db.prepare(`SELECT * FROM tasks WHERE type = 'summarize_pending' ORDER BY id DESC LIMIT 1`).get();
    });

    await withDbAsync((db) => runSummarizePending(db, task));

    withDb((db) => {
      const audit = db.prepare(
        `SELECT details FROM audit_log WHERE action = 'summarize_pending_applied'
         AND json_extract(details, '$.session_id') = ?`
      ).get(sessionId);
      assert.ok(audit, 'summary was not applied');
      const excerpt = JSON.parse(audit.details).transcript_excerpt;
      assert.match(excerpt, /switch the build to pnpm/);
      assert.equal(excerpt.includes('AGENTS.md'), false);
      const row = db.prepare('SELECT origin_agent FROM memories WHERE content = ?').get('This repository builds with pnpm, never npm or yarn.');
      assert.equal(row?.origin_agent, 'codex');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previous;
    }
  }
});
