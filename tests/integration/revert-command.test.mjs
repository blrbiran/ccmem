import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-revert-'));
const configPath = path.join(dataRoot, 'config.json');
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const CLI = path.join(REPO_ROOT, 'scripts/cli.mjs');
const PROJECT = 'demo/revert';
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_CONFIG_PATH = configPath;
writeFileSync(configPath, JSON.stringify({ embedding: { enabled: false } }));

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { writeAudit } = await import('../../scripts/lib/audit.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');

async function runRevert(db, options) {
  const cmdRevert = (await import('../../scripts/lib/cmd/revert.mjs')).cmdRevert;
  return cmdRevert(db, options);
}

function reset(db) {
  db.prepare('DELETE FROM audit_log_targets').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM injection_cache').run();
  db.prepare('DELETE FROM memories').run();
}

function seedMerge(db) {
  reset(db);
  const now = Date.now();
  const insertSource = db.prepare(`INSERT INTO memories (
    scope, project_key, type, content, source, trust_score, status, decay_status,
    last_touched_at, created_at, updated_at, tags, version
  ) VALUES ('project', ?, ?, ?, 'user_explicit', 0.7, 'active', ?, ?, ?, ?, '[]', 1)`);
  const sourceIds = [
    Number(insertSource.run(PROJECT, 'fact', 'original source alpha', 'active', now, now, now).lastInsertRowid),
    Number(insertSource.run(PROJECT, 'rule', 'original source beta', 'probation', now + 1, now + 1, now + 1).lastInsertRowid),
    Number(insertSource.run(PROJECT, 'episode', 'original source gamma', 'active', now + 2, now + 2, now + 2).lastInsertRowid)
  ];
  const mergeId = Number(db.prepare(`INSERT INTO memories (
    scope, project_key, type, content, source, trust_score, status, decay_status,
    last_touched_at, created_at, updated_at, tags, version, root_id, parent_id
  ) VALUES ('project', ?, 'fact', 'merged summary', 'user_explicit', 0.7, 'active', 'active', ?, ?, ?, '[]', 2, ?, ?)`)
    .run(PROJECT, now + 3, now + 3, now + 3, sourceIds[0], sourceIds[0]).lastInsertRowid);
  db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id IN (?, ?, ?)`)
    .run(mergeId, ...sourceIds);
  writeAudit(db, 'synthesis_dedup_merged', mergeId, {
    source_ids: sourceIds,
    superseded_ids: sourceIds,
    parent_id: sourceIds[0],
    root_id: sourceIds[0],
    version: 2,
    merged_content_excerpt: 'merged summary'
  });
  return { mergeId, sourceIds };
}

function memorySnapshot(db) {
  return db.prepare('SELECT * FROM memories ORDER BY id').all().map((row) => ({ ...row }));
}

function cacheSnapshot(db) {
  return db.prepare('SELECT scope, rendered_text, member_ids, rendered_at FROM injection_cache ORDER BY scope').all()
    .map((row) => ({ ...row }));
}

function runCli(env, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 20_000 });
}

const cliEnv = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot, CCMEM_CONFIG_PATH: configPath };

test('revert restores all merge sources and updates the project injection cache', async () => {
  const db = openDb();
  try {
    const { mergeId, sourceIds } = seedMerge(db);
    rebuildInjectionCache(db, PROJECT);
    assert.deepEqual(JSON.parse(db.prepare("SELECT member_ids FROM injection_cache WHERE scope = ?").get(`project:${PROJECT}`).member_ids), [mergeId]);

    assert.deepEqual(await runRevert(db, { id: String(mergeId) }), { status: 'reverted', id: mergeId, restoredIds: sourceIds });

    const restored = db.prepare('SELECT id, content, status, decay_status, superseded_by FROM memories WHERE id IN (?, ?, ?) ORDER BY id')
      .all(...sourceIds).map((row) => ({ ...row }));
    assert.deepEqual(restored, [
      { id: sourceIds[0], content: 'original source alpha', status: 'active', decay_status: 'active', superseded_by: null },
      { id: sourceIds[1], content: 'original source beta', status: 'active', decay_status: 'probation', superseded_by: null },
      { id: sourceIds[2], content: 'original source gamma', status: 'active', decay_status: 'active', superseded_by: null }
    ]);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(mergeId).status, 'superseded');
    assert.deepEqual(new Set(JSON.parse(db.prepare("SELECT member_ids FROM injection_cache WHERE scope = ?").get(`project:${PROJECT}`).member_ids)), new Set(sourceIds));
    const audit = db.prepare("SELECT action, affected_ids, details FROM audit_log WHERE action = 'memory_reverted'").get();
    assert.equal(audit.action, 'memory_reverted');
    assert.deepEqual(JSON.parse(audit.affected_ids), [mergeId]);
    assert.deepEqual(JSON.parse(audit.details).restored_ids, sourceIds);
  } finally {
    db.close();
  }
});

test('revert refuses a non-merge memory without changing rows, audit, or cache', async () => {
  const db = openDb();
  try {
    reset(db);
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO memories (
      scope, project_key, type, content, source, status, last_touched_at, created_at, updated_at
    ) VALUES ('project', ?, 'fact', 'ordinary memory', 'user_explicit', 'active', ?, ?, ?)`)
      .run(PROJECT, now, now, now).lastInsertRowid);
    rebuildInjectionCache(db, PROJECT);
    const memoriesBefore = memorySnapshot(db);
    const auditsBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const cacheBefore = cacheSnapshot(db);

    assert.equal((await runRevert(db, { id: String(id) })).status, 'unsupported');
    assert.deepEqual(memorySnapshot(db), memoriesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditsBefore);
    assert.deepEqual(cacheSnapshot(db), cacheBefore);
  } finally {
    db.close();
  }
});

test('revert refuses an incomplete source set without partial recovery', async () => {
  const db = openDb();
  try {
    const { mergeId, sourceIds } = seedMerge(db);
    db.prepare('UPDATE memories SET superseded_by = NULL WHERE id = ?').run(sourceIds[2]);
    const memoriesBefore = memorySnapshot(db);
    const auditsBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const cacheBefore = cacheSnapshot(db);

    assert.equal((await runRevert(db, { id: String(mergeId) })).status, 'unsupported');
    assert.deepEqual(memorySnapshot(db), memoriesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditsBefore);
    assert.deepEqual(cacheSnapshot(db), cacheBefore);
  } finally {
    db.close();
  }
});

test('revert refuses a version that already has a successor', async () => {
  const db = openDb();
  try {
    const { mergeId, sourceIds } = seedMerge(db);
    const now = Date.now();
    const successorId = Number(db.prepare(`INSERT INTO memories (
      scope, project_key, type, content, source, status, last_touched_at, created_at, updated_at,
      version, root_id, parent_id
    ) VALUES ('project', ?, 'fact', 'later merge', 'cron_consolidated', 'active', ?, ?, ?, 3, ?, ?)`)
      .run(PROJECT, now, now, now, sourceIds[0], mergeId).lastInsertRowid);
    db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(successorId, mergeId);
    const memoriesBefore = memorySnapshot(db);
    const auditsBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    const cacheBefore = cacheSnapshot(db);

    assert.equal((await runRevert(db, { id: String(mergeId) })).status, 'unsupported');
    assert.deepEqual(memorySnapshot(db), memoriesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditsBefore);
    assert.deepEqual(cacheSnapshot(db), cacheBefore);
  } finally {
    db.close();
  }
});

test('revert refuses archived or candidate-expired merge targets without changing state', async () => {
  for (const decayStatus of ['archived', 'candidate_expire']) {
    const db = openDb();
    try {
      const { mergeId } = seedMerge(db);
      db.prepare('UPDATE memories SET decay_status = ? WHERE id = ?').run(decayStatus, mergeId);
      rebuildInjectionCache(db, PROJECT);
      const memoriesBefore = memorySnapshot(db);
      const auditsBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
      const cacheBefore = cacheSnapshot(db);

      assert.equal((await runRevert(db, { id: String(mergeId) })).status, 'unsupported', decayStatus);
      assert.deepEqual(memorySnapshot(db), memoriesBefore);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, auditsBefore);
      assert.deepEqual(cacheSnapshot(db), cacheBefore);
    } finally {
      db.close();
    }
  }
});

test('CLI rejects malformed and unknown revert ids and reverses a valid merge', () => {
  const db = openDb();
  let mergeId;
  try {
    const seeded = seedMerge(db);
    mergeId = seeded.mergeId;
  } finally {
    db.close();
  }

  const malformed = runCli(cliEnv, 'revert', 'nope');
  assert.equal(malformed.status, 64);
  assert.match(malformed.stderr, /invalid memory id/);

  const missing = runCli(cliEnv, 'revert', '999999');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /memory not found/);

  const result = runCli(cliEnv, 'revert', String(mergeId));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reverted merge/);
  const after = openDb();
  try {
    assert.deepEqual(after.prepare('SELECT status FROM memories WHERE id = ?').get(mergeId).status, 'superseded');
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'memory_reverted'").get().n, 1);
  } finally {
    after.close();
  }
});
