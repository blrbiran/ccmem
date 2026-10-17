import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-merge-no-trunc-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const configPath = path.join(dataRoot, 'config.json');
writeFileSync(configPath, JSON.stringify({ save: { max_chars_per_memory: 500 } }));
process.env.CCMEM_CONFIG_PATH = configPath;

// The merge path has no mock seam, so a stub LLM binary stands in for claude.
// It answers refine prompts with refine.json and everything else (the merge
// prompt) with merge.json; each test writes both files first.
const mergeFile = path.join(dataRoot, 'merge.json');
const refineFile = path.join(dataRoot, 'refine.json');
const stub = path.join(dataRoot, 'fake-claude.mjs');
writeFileSync(stub, `
import { readFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const isRefine = /^(Refine|Rewrite) the following memory/.test(input);
  process.stdout.write(readFileSync(isRefine ? ${JSON.stringify(refineFile)} : ${JSON.stringify(mergeFile)}, 'utf8'));
});
`);
process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub]);

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdResurrect } = await import('../../scripts/lib/cmd/resurrect.mjs');

/**
 * Spec A2: a contradiction merge proposed by the LLM used to be cut to 500 chars
 * and stored, so the human confirmed and kept a fragment without knowing it
 * was cut. Now the merge is rewritten to fit before the human sees it, or
 * rejected with its full text audited, leaving both memories untouched.
 */
const WORDS = 'Indent with the width the formatter enforces in each package. ';
function text(marker, chars) {
  return `${marker} ${WORDS.repeat(Math.ceil(chars / WORDS.length))}`.slice(0, chars).trimEnd().padEnd(chars, 'x');
}

function seed(db) {
  db.prepare('DELETE FROM contradiction_alerts').run();
  db.prepare('DELETE FROM memories').run();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
     ) VALUES ('global', NULL, 'rule', ?, 0, 'user_explicit', 0.8, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  );
  const a = Number(insert.run('Use 4 spaces for indentation', now, now, now).lastInsertRowid);
  const b = Number(insert.run('Use 2 spaces for indentation', now, now, now).lastInsertRowid);
  db.prepare(
    `INSERT INTO contradiction_alerts (mem_id_a, mem_id_b, scope, cosine_similarity, evidence, detected_at)
     VALUES (?, ?, 'global', 0.88, '{}', ?)`
  ).run(a, b, now - 1000);
  return { a, b };
}

async function mergeWith(db, { merged, refined }) {
  writeFileSync(mergeFile, JSON.stringify({ merge_possible: true, merged_content: merged }));
  writeFileSync(refineFile, JSON.stringify({ content: refined }));
  const shown = [];
  await cmdResurrect(db, {
    contradictions: true,
    decide: () => 'm',
    merge: async (_row, outcome) => {
      shown.push(outcome);
      return outcome.merge_possible ? { action: 'merged' } : { action: 'skip' };
    }
  });
  return shown;
}

test('a merge that cannot be rewritten to fit is rejected whole and nothing is superseded', async () => {
  const db = openDb();
  try {
    const { a, b } = seed(db);
    const merged = text('marker-merge-reject', 600);
    const shown = await mergeWith(db, { merged, refined: text('marker-merge-reject', 600) });

    assert.equal(shown.length, 1);
    assert.equal(shown[0].merge_possible, false, 'the human is told the merge failed');
    assert.deepEqual(db.prepare(`SELECT id FROM memories WHERE content LIKE '%marker-merge-reject%'`).all(), []);
    const statuses = [a, b].map((id) => db.prepare('SELECT status FROM memories WHERE id = ?').get(id).status);
    assert.deepEqual(statuses, ['active', 'active']);
    const audit = db.prepare(
      `SELECT details FROM audit_log WHERE action = 'contradiction_merge_refine_rejected' ORDER BY id DESC LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);
    assert.equal(details.reason, 'still_too_long');
    assert.equal(details.content, merged, 'the audit keeps the full 600-char merge');
    assert.deepEqual(details.source_ids, [a, b]);
  } finally {
    db.close();
  }
});

test('an over-long merge is rewritten before the human confirms it, and that text is stored', async () => {
  const db = openDb();
  try {
    const { a, b } = seed(db);
    const rewrite = text('marker-merge-fit', 300);
    const shown = await mergeWith(db, { merged: text('marker-merge-fit', 600), refined: rewrite });

    assert.equal(shown[0].merged_content, rewrite, 'the human confirms the text that is stored');
    const stored = db.prepare(`SELECT content FROM memories WHERE content LIKE '%marker-merge-fit%'`).all();
    assert.deepEqual(stored.map((r) => r.content), [rewrite]);
    const statuses = [a, b].map((id) => db.prepare('SELECT status FROM memories WHERE id = ?').get(id).status);
    assert.deepEqual(statuses, ['superseded', 'superseded']);
  } finally {
    db.close();
  }
});
