import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-monthly-no-trunc-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
// Any LLM call these tests forget to mock must fail, never reach a real model.
process.env.CCMEM_CLAUDE_P_COMMAND = '/usr/bin/false';
delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const configPath = path.join(dataRoot, 'config.json');
writeFileSync(configPath, JSON.stringify({ consolidation: { monthly: { min_consolidated: 2 } } }));
process.env.CCMEM_CONFIG_PATH = configPath;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { runMonthlyMetaSynthesis } = await import('../../scripts/daemon/tasks/monthly-meta-synthesis.mjs');

/**
 * Spec A2 covers every caller that writes LLM output into memory. Monthly
 * meta-synthesis used to cut each meta-rule to 80 chars (W-3) by slicing, which
 * stores a mid-word fragment nobody can see was cut. The 80-char limit stays;
 * it is now met by a rewrite or the item is rejected with its full text
 * audited. These tests read back what was stored and what was audited.
 */
const PROJECT = 'demo/monthly';
const WORDS = 'Keep verification output whole so exit codes survive every pipeline step. ';

function text(marker, chars) {
  return `${marker} ${WORDS.repeat(Math.ceil(chars / WORDS.length))}`.slice(0, chars).trimEnd().padEnd(chars, 'x');
}

function seedParents(db) {
  db.prepare('DELETE FROM memories').run();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
     ) VALUES ('project', ?, 'consolidated', ?, 0, 'cron_consolidated', 0.7, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  );
  return ['parent one about verification', 'parent two about exit codes']
    .map((content) => Number(insert.run(PROJECT, content, now, now, now).lastInsertRowid));
}

async function runWith(db, { content, refinerOutputs }) {
  const parents = seedParents(db);
  await runMonthlyMetaSynthesis(db, {
    payload: JSON.stringify({
      scope: PROJECT,
      llm_output: JSON.stringify({ synthesized: [{ content, source_ids: parents }] }),
      ...(refinerOutputs ? { refiner_llm_outputs: refinerOutputs } : {})
    })
  });
  return parents;
}

function metaRows(db, marker) {
  return db.prepare(`SELECT content FROM memories WHERE content LIKE ? AND parent_ids IS NOT NULL`).all(`%${marker}%`);
}

function rejectAudits(db) {
  return db.prepare(`SELECT details FROM audit_log WHERE action = 'monthly_meta_refine_rejected' ORDER BY id`)
    .all().map((row) => JSON.parse(row.details));
}

test('an over-long meta-rule that cannot be rewritten is rejected whole, not sliced', async () => {
  const db = openDb();
  try {
    db.prepare(`DELETE FROM audit_log WHERE action = 'monthly_meta_refine_rejected'`).run();
    const content = text('marker-reject', 600);
    const parents = await runWith(db, {
      content,
      refinerOutputs: [JSON.stringify({ content: text('marker-reject', 100) }), JSON.stringify({ content: text('marker-reject', 100) })]
    });

    assert.deepEqual(metaRows(db, 'marker-reject'), [], 'no sliced meta-rule may be stored');
    const audits = rejectAudits(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].reason, 'still_too_long');
    assert.equal(audits[0].content, content, 'the audit keeps the full 600-char output');
    const statuses = parents.map((id) => db.prepare('SELECT status FROM memories WHERE id = ?').get(id).status);
    assert.deepEqual(statuses, ['active', 'active'], 'parents stay active when the meta-rule is rejected');
  } finally {
    db.close();
  }
});

test('an over-long meta-rule is stored as its fitting rewrite', async () => {
  const db = openDb();
  try {
    const rewrite = text('marker-rewrite', 60);
    await runWith(db, {
      content: text('marker-rewrite', 120),
      refinerOutputs: [JSON.stringify({ content: rewrite })]
    });

    assert.deepEqual(metaRows(db, 'marker-rewrite').map((row) => row.content), [rewrite]);
  } finally {
    db.close();
  }
});

test('a meta-rule of exactly 80 chars is stored whole without a rewrite', async () => {
  const db = openDb();
  try {
    const content = text('marker-fits', 80);
    // no refiner mocks: a refine call here would fail and reject the item
    await runWith(db, { content });

    assert.deepEqual(metaRows(db, 'marker-fits').map((row) => row.content), [content]);
  } finally {
    db.close();
  }
});
