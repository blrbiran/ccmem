import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-weekly-no-trunc-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
// Any LLM call these tests forget to mock must fail, never reach a real model.
process.env.CCMEM_CLAUDE_P_COMMAND = '/usr/bin/false';
delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const configPath = path.join(dataRoot, 'config.json');
function writeConfig(extra = {}) {
  writeFileSync(configPath, JSON.stringify({
    save: { max_chars_per_memory: 500 },
    consolidation: { stale_check_enabled: false, ...extra }
  }));
}
writeConfig();
process.env.CCMEM_CONFIG_PATH = configPath;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runWeeklySynthesis } = await import('../../scripts/daemon/tasks/weekly-synthesis.mjs');
const { scoreSynthesisOutput } = await import('../../scripts/lib/synthesis-quality.mjs');

/**
 * Spec A2 covers every caller that writes LLM output into memory. Weekly
 * synthesis used to cut merged-duplicate and synthesized content to 500 chars,
 * when parsing the verdict and again in the merge UPDATE, and the quality
 * scorer cut it again to the per-type cap. Each cut stores a fragment nobody
 * can see was cut. Now over-long output is rewritten to the limit or rejected
 * with its full text audited, and a rejected merge supersedes nothing. These
 * tests read back what was stored, superseded and audited.
 */
const PROJECT = 'demo/weekly';
const WORDS = 'Keep verification output whole so exit codes survive every pipeline step. ';

function text(marker, chars) {
  return `${marker} ${WORDS.repeat(Math.ceil(chars / WORDS.length))}`.slice(0, chars).trimEnd().padEnd(chars, 'x');
}

function seedSources(db) {
  db.prepare('DELETE FROM memories').run();
  db.prepare(`DELETE FROM audit_log WHERE action = 'weekly_synthesis_refine_rejected'`).run();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
     ) VALUES ('project', ?, 'fact', ?, 0, 'auto_inferred', 0.6, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  );
  return ['source one keeps output whole', 'source two keeps exit codes']
    .map((content) => Number(insert.run(PROJECT, content, now, now, now).lastInsertRowid));
}

async function runWith(db, verdict, refinerOutputs) {
  await runWeeklySynthesis(db, {
    id: null,
    scheduled_for: Date.now(),
    payload: JSON.stringify({
      lease_key: 'test-week',
      llm_output: JSON.stringify({ merged_duplicates: [], synthesized: [], ...verdict }),
      ...(refinerOutputs ? { refiner_llm_outputs: refinerOutputs } : {})
    })
  });
}

const row = (db, id) => db.prepare('SELECT content, status FROM memories WHERE id = ?').get(id);
const rejectAudits = (db) => db.prepare(
  `SELECT details FROM audit_log WHERE action = 'weekly_synthesis_refine_rejected' ORDER BY id`
).all().map((r) => JSON.parse(r.details));
const tooLong = (marker) => [JSON.stringify({ content: text(marker, 600) }), JSON.stringify({ content: text(marker, 600) })];

test('merged duplicate: over-long and not rewritable is rejected whole, nothing superseded', async () => {
  const db = openDb();
  try {
    const [keep, other] = seedSources(db);
    const content = text('marker-merge-reject', 600);
    await runWith(db, { merged_duplicates: [{ content, source_ids: [keep, other] }] }, tooLong('marker-merge-reject'));

    assert.equal(row(db, keep).content, 'source one keeps output whole', 'the kept row must not take a sliced merge');
    assert.equal(row(db, other).status, 'active', 'a rejected merge supersedes nothing');
    const audits = rejectAudits(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, 'merged_duplicate');
    assert.equal(audits[0].reason, 'still_too_long');
    assert.equal(audits[0].content, content, 'the audit keeps the full 600-char output');
    assert.deepEqual(audits[0].source_ids, [keep, other]);
  } finally {
    db.close();
  }
});

test('merged duplicate: over-long is stored as its fitting rewrite', async () => {
  const db = openDb();
  try {
    const [keep, other] = seedSources(db);
    const rewrite = text('marker-merge-rewrite', 300);
    await runWith(
      db,
      { merged_duplicates: [{ content: text('marker-merge-rewrite', 600), source_ids: [keep, other] }] },
      [JSON.stringify({ content: rewrite })]
    );

    assert.equal(row(db, keep).content, rewrite);
    assert.equal(row(db, other).status, 'superseded');
    assert.deepEqual(rejectAudits(db), []);
  } finally {
    db.close();
  }
});

test('synthesized: over-long and not rewritable is rejected whole, not stored sliced', async () => {
  const db = openDb();
  try {
    const sources = seedSources(db);
    const content = text('marker-synth-reject', 600);
    await runWith(db, { synthesized: [{ content, output_type: 'consolidated', source_ids: sources }] }, tooLong('marker-synth-reject'));

    const stored = db.prepare(`SELECT content FROM memories WHERE content LIKE '%marker-synth-reject%'`).all();
    assert.deepEqual(stored, [], 'no sliced synthesis may be stored');
    const audits = rejectAudits(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, 'synthesized');
    assert.equal(audits[0].content, content);
    assert.deepEqual(audits[0].source_ids, sources);
  } finally {
    db.close();
  }
});

test('synthesized: rewritten to the per-type cap, not sliced to it', async () => {
  const db = openDb();
  writeConfig({ quality: { consolidated_max_chars: 100 } });
  try {
    const sources = seedSources(db);
    const rewrite = text('marker-synth-cap', 90);
    // 300 chars fits the 500 save limit but not the 100-char consolidated cap
    await runWith(
      db,
      { synthesized: [{ content: text('marker-synth-cap', 300), output_type: 'consolidated', source_ids: sources }] },
      [JSON.stringify({ content: rewrite })]
    );

    const stored = db.prepare(`SELECT content FROM memories WHERE content LIKE '%marker-synth-cap%'`).all();
    assert.deepEqual(stored.map((r) => r.content), [rewrite]);
  } finally {
    writeConfig();
    db.close();
  }
});

test('quality scorer rejects over-cap content instead of slicing it', () => {
  const item = { content: 'z'.repeat(600), output_type: 'consolidated', source_ids: [1] };
  const verdict = scoreSynthesisOutput(null, item, [{ id: 1 }]);
  assert.deepEqual(verdict, { pass: false, reason: 'too_long', score: 0 });
  assert.equal(item.content.length, 600, 'the scorer must not mutate content');
});
