import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-resurrect-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const CLI = '/Users/biran/code/skills/ccmem/scripts/cli.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdResurrect } = await import('../../scripts/lib/cmd/resurrect.mjs');

function resetResurrectTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedGreyZoneMemories(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
    ) VALUES
      ('project', 'demo/repo', 'fact', 'grey one', 0, 'user_explicit', 0.11, 'active', 'active', 0, 0, ?, ?, ?, '["ops"]'),
      ('project', 'demo/repo', 'rule', 'grey two', 0, 'user_explicit', 0.15, 'active', 'active', 0, 0, ?, ?, ?, '["ops","cli"]'),
      ('project', 'demo/repo', 'fact', 'stable three', 0, 'user_explicit', 0.45, 'active', 'active', 0, 0, ?, ?, ?, '["other"]')`
  ).run(now - 30, now - 30, now - 30, now - 20, now - 20, now - 20, now - 10, now - 10, now - 10);
}

test('cmdResurrect keeps and forgets grey-zone memories', async () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);

  const decisions = ['k', 'f'];
  const result = await cmdResurrect(db, {
    bottom: 2,
    decide: () => decisions.shift() ?? 's'
  });

  const rows = db.prepare(
    `SELECT content, trust_score, decay_status
     FROM memories
     WHERE content IN ('grey one', 'grey two')
     ORDER BY content ASC`
  ).all();

  assert.equal(result.tier15.ran, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.action), ['keep', 'forget']);
  assert.equal(rows[0].trust_score, 0.3);
  assert.equal(rows[0].decay_status, 'active');
  assert.equal(rows[1].decay_status, 'archived');
  db.close();
});

test('cmdResurrect filters grey-zone memories by tag', async () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);

  const result = await cmdResurrect(db, {
    tag: 'cli',
    decide: () => 's'
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content, 'grey two');
  assert.equal(result.items[0].action, 'skip');
  db.close();
});

test('cmdResurrect records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetResurrectTables(db);
  const fixedNow = new Date(2026, 5, 8, 2, 17, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;

  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNowMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = FixedDate;

  try {
    seedGreyZoneMemories(db, fixedNowMs);

    const result = await cmdResurrect(db, {
      bottom: 1,
      decide: () => 's'
    });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'daily_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.tier15.ran, true);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cli resurrect prints prompts and applies typed decisions', () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--bottom', '2'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'k\nf\n'
  });

  const verifyDb = openDb();
  const rows = verifyDb.prepare(
    `SELECT content, trust_score, decay_status
     FROM memories
     WHERE content IN ('grey one', 'grey two')
     ORDER BY content ASC`
  ).all();
  verifyDb.close();

  assert.match(output, /\[m\d+\] fact\|project trust=0\.11/);
  assert.match(output, /\[k\]eep \/ \[f\]orget \/ \[s\]kip:/);
  assert.match(output, /ccmem: resurrected 1, archived 1, skipped 0/);
  assert.equal(rows[0].trust_score, 0.3);
  assert.equal(rows[1].decay_status, 'archived');
});

test('cli resurrect prints no grey-zone memories when none match', () => {
  const db = openDb();
  resetResurrectTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: ''
  });

  assert.equal(output, 'ccmem: no grey-zone memories\n');
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
