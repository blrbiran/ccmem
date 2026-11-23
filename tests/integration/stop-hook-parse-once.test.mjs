import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// #395: the Stop hook used to parse the transcript five times (stats, line
// count, two inferences, and the L2.5 probe). The handler now parses once and
// hands the entries to every consumer. This test injects the reader and counts
// its calls; a helper that still re-reads the file would push the count up.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-stop-once-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');

const entries = [
  { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'second answer' }] } }
];

test('the Stop hook reads the transcript once and passes the entries on', async (t) => {
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const db = openDb();
  let parses = 0;
  try {
    const result = await handleStop(
      db,
      { session_id: 's-parse-once', transcript_path: '/nonexistent/session.jsonl', cwd: dataRoot },
      { parseTranscript: () => { parses += 1; return entries; } }
    );
    assert.deepEqual(result, { additionalContext: '' });
    assert.equal(parses, 1);
    const row = db.prepare('SELECT message_count, tool_calls, last_seq, transcript_path FROM session_context WHERE session_id = ?').get('s-parse-once');
    assert.equal(row.message_count, 3);
    assert.equal(row.tool_calls, 0);
    assert.equal(row.last_seq, 3);
    // Tester #446/#447: the transcript this session was read from is on the row, so a
    // memory can later be checked against it and a manual summarize run can be built
    // from it. Losing this write silently disables both.
    assert.equal(row.transcript_path, '/nonexistent/session.jsonl');
  } finally {
    db.close();
  }
});