import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-promote-'));
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
const { cmdPromote } = await import('../../scripts/lib/cmd/promote.mjs');

function resetPromoteTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedStaleMaintenanceState(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-old', 0, 'session_start', '[1]', ?)`
  ).run(now - (15 * 86400000));

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
     VALUES ('summarize_pending', '2026-01-01', ?, 'completed', 'daemon')`
  ).run(now);
}

function assertPreludeCleanup(db) {
  const stale = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections`).get();
  const oldTasks = db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE type = 'summarize_pending'`).get();
  const lease = db.prepare(`SELECT status FROM task_runs WHERE type = 'daily_maintenance'`).get();

  assert.equal(stale.n, 0);
  assert.equal(oldTasks.n, 0);
  assert.equal(lease.status, 'completed');
}

function insertPromoteMemory(
  db,
  { type = 'episode', scope = 'project', projectKey = 'demo/repo', trust = 0.55, content, tags = '[]', now = Date.now() }
) {
  const result = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
    ) VALUES (?, ?, ?, ?, 0, 'user_explicit', ?, 'active', 'active', 0, 0, ?, ?, ?, ?)`
  ).run(scope, projectKey, type, content, trust, now, now, now, tags);

  return Number(result.lastInsertRowid);
}

test('cmdPromote promotes a project episode to rule without changing trust', async () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'remember this workflow', type: 'episode', trust: 0.58 });

  const result = await cmdPromote(db, {
    id: `m${id}`,
    confirm: () => 'PROMOTE'
  });
  const row = db.prepare(`SELECT type, scope, trust_score FROM memories WHERE id = ?`).get(id);

  assert.equal(result.status, 'promoted');
  assert.equal(result.id, id);
  assert.equal(row.type, 'rule');
  assert.equal(row.scope, 'project');
  assert.equal(row.trust_score, 0.58);
  db.close();
});

test('cmdPromote refreshes both project and global cache on global promotion', async () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'share this everywhere', type: 'rule', trust: 0.66 });

  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES
     ('global', 'stale global', '[]', ?),
     ('project:demo/repo', 'stale project', '[999]', ?)`
  ).run(Date.now(), Date.now());

  const result = await cmdPromote(db, {
    id,
    global: true,
    confirm: () => 'PROMOTE GLOBAL'
  });
  const caches = db.prepare(
    `SELECT scope, rendered_text, member_ids
     FROM injection_cache
     ORDER BY scope ASC`
  ).all();

  assert.equal(result.status, 'promoted');
  assert.equal(caches.length, 2);
  assert.equal(caches[0].scope, 'global');
  assert.match(caches[0].rendered_text, /share this everywhere/);
  assert.equal(caches[0].member_ids, `[${id}]`);
  assert.equal(caches[1].scope, 'project:demo/repo');
  assert.equal(caches[1].member_ids, '[]');
  db.close();
});

test('cmdPromote blocks dangerous global promotion', async () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, {
    content: 'do not leak this',
    type: 'rule',
    tags: '["contains_secret"]'
  });

  const result = await cmdPromote(db, {
    id,
    global: true,
    confirm: () => 'PROMOTE GLOBAL'
  });
  const row = db.prepare(`SELECT scope, project_key, type FROM memories WHERE id = ?`).get(id);

  assert.equal(result.status, 'blocked');
  assert.equal(row.scope, 'project');
  assert.equal(row.project_key, 'demo/repo');
  assert.equal(row.type, 'rule');
  db.close();
});

test('cmdPromote runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'promote prelude cleanup', type: 'episode', trust: 0.58 });
  seedStaleMaintenanceState(db);

  const result = await cmdPromote(db, {
    id,
    confirm: () => 'PROMOTE'
  });

  assert.equal(result.status, 'promoted');
  assertPreludeCleanup(db);
  db.close();
});

test('cmdPromote records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'promote local-day lease', type: 'episode', trust: 0.58 });
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
    const result = await cmdPromote(db, {
      id,
      confirm: () => 'PROMOTE'
    });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'daily_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.status, 'promoted');
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cli promote --global applies verbatim confirmation and preserves trust', () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'share this rule', type: 'rule', trust: 0.62 });
  db.close();

  const output = execFileSync(NODE, [CLI, 'promote', `m${id}`, '--global'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'PROMOTE GLOBAL\n'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(`SELECT scope, project_key, type, trust_score FROM memories WHERE id = ?`).get(id);
  verifyDb.close();

  assert.match(output, /Promote to GLOBAL \(visible in every project\):/);
  assert.match(output, /Type PROMOTE GLOBAL to confirm:/);
  assert.match(output, new RegExp(`ccmem: promoted memory #m${id}`));
  assert.equal(row.scope, 'global');
  assert.equal(row.project_key, null);
  assert.equal(row.type, 'rule');
  assert.equal(row.trust_score, 0.62);
});

test('cli promote cancels when confirmation does not match', () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, { content: 'keep as episode', type: 'episode', trust: 0.41 });
  db.close();

  const output = execFileSync(NODE, [CLI, 'promote', String(id)], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'no\n'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(`SELECT type, scope, trust_score FROM memories WHERE id = ?`).get(id);
  verifyDb.close();

  assert.match(output, /Promote episode→rule \(project\):/);
  assert.match(output, /ccmem: cancelled/);
  assert.equal(row.type, 'episode');
  assert.equal(row.scope, 'project');
  assert.equal(row.trust_score, 0.41);
});

test('cli promote --global blocks dangerous memories with exit 78', () => {
  const db = openDb();
  resetPromoteTables(db);
  const id = insertPromoteMemory(db, {
    content: 'secret command',
    type: 'rule',
    tags: '["dangerous_command"]'
  });
  db.close();

  assert.throws(
    () =>
      execFileSync(NODE, [CLI, 'promote', `m${id}`, '--global'], {
        cwd: '/Users/biran/code/skills/ccmem',
        env,
        encoding: 'utf8',
        input: 'PROMOTE GLOBAL\n'
      }),
    (error) => {
      assert.equal(error.status, 78);
      assert.match(String(error.stderr), /ccmem: BLOCKED — cannot promote dangerous\/secret memory to global/);
      return true;
    }
  );
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
