import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-forget-pin-'));

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const NODE = '/usr/local/bin/node';
const CLI = path.join(REPO_ROOT, 'scripts/cli.mjs');

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdForget } = await import('../../scripts/lib/cmd/forget.mjs');
const { cmdPin } = await import('../../scripts/lib/cmd/pin.mjs');
const { loadConfig } = await import('../../scripts/lib/config.mjs');
const { rebuildInjectionCache } = await import('../../scripts/lib/injection-cache.mjs');
const { retrieveMemories } = await import('../../scripts/lib/retrieval.mjs');

function resetTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function projectCacheMembers(db, projectKey = 'demo/repo') {
  const row = db.prepare(`SELECT member_ids FROM injection_cache WHERE scope = ?`).get(`project:${projectKey}`);
  return JSON.parse(row?.member_ids ?? '[]');
}

function forgetAuditRows(db, id) {
  return db.prepare(
    `SELECT a.id, a.details
     FROM audit_log a
     JOIN audit_log_targets t ON t.audit_id = a.id
     WHERE t.mem_id = ? AND a.action = 'forget'`
  ).all(id);
}

function insertMemory(db, { content, projectKey = 'demo/repo', now = Date.now() }) {
  const result = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
    ) VALUES ('project', ?, 'rule', ?, 0, 'user_explicit', 0.8, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  ).run(projectKey, content, now, now, now);

  return Number(result.lastInsertRowid);
}

// Rewritten from "deletes the memory and keeps a trash copy": forget must archive,
// not DELETE (ccmem CLAUDE.md iron rule 7; human ruling 2026-10-27 「forget 同意改成归档」).
// Ruling: human approved rewriting all necessary criteria, Orca session 7753e97d, 2026-10-27
test('cmdForget archives the memory: kept with its content, audited, never injected or retrieved again', async () => {
  const db = openDb();
  resetTables(db);
  const id = insertMemory(db, { content: 'zebracornflake deploy rule' });
  rebuildInjectionCache(db, 'demo/repo');
  const retrievedBefore = (await retrieveMemories(db, 'zebracornflake deploy', 'demo/repo', loadConfig())).rows.map((r) => r.id);
  // The memory is live before forget, so the "gone" assertions below can only pass because of forget.
  assert.ok(projectCacheMembers(db).includes(id));
  assert.ok(retrievedBefore.includes(id));

  const result = await cmdForget(db, { id: `m${id}` });

  const row = db.prepare(`SELECT content, decay_status FROM memories WHERE id = ?`).get(id);
  const audits = forgetAuditRows(db, id);
  const retrievedAfter = (await retrieveMemories(db, 'zebracornflake deploy', 'demo/repo', loadConfig())).rows.map((r) => r.id);

  assert.equal(result.id, id);
  assert.equal(result.scope, 'project');
  assert.equal(result.type, 'rule');
  // Archived, not deleted: the content survives, so the forget is reversible.
  assert.deepEqual({ ...row }, { content: 'zebracornflake deploy rule', decay_status: 'archived' });
  // One audit row naming the state to restore; the CLI points the user at it.
  assert.equal(audits.length, 1);
  assert.equal(result.audit_id, audits[0].id);
  assert.equal(JSON.parse(audits[0].details).previous_decay_status, 'active');
  assert.equal(projectCacheMembers(db).includes(id), false);
  assert.equal(retrievedAfter.includes(id), false);
  // No trash copy: the row itself is the backup (decision recorded in forget.mjs).
  assert.equal(existsSync(path.join(dataRoot, 'trash')), false);
  db.close();
});

test('cmdForget returns null for a missing memory', async () => {
  const db = openDb();
  resetTables(db);

  assert.equal(await cmdForget(db, { id: 'm999999' }), null);
  assert.equal(await cmdForget(db, { id: 'not-a-number' }), null);
  db.close();
});

test('cmdPin pins and unpins a memory, accepting m-prefixed ids', async () => {
  const db = openDb();
  resetTables(db);
  const id = insertMemory(db, { content: 'pin this rule' });

  const pinned = await cmdPin(db, { id: `m${id}` });
  const afterPin = db.prepare(`SELECT pinned FROM memories WHERE id = ?`).get(id);

  const unpinned = await cmdPin(db, { id, remove: true });
  const afterUnpin = db.prepare(`SELECT pinned FROM memories WHERE id = ?`).get(id);

  assert.deepEqual(pinned, { id, pinned: 1 });
  assert.equal(afterPin.pinned, 1);
  assert.deepEqual(unpinned, { id, pinned: 0 });
  assert.equal(afterUnpin.pinned, 0);
  db.close();
});

test('cmdPin returns null for a missing memory', async () => {
  const db = openDb();
  resetTables(db);

  assert.equal(await cmdPin(db, { id: 'm999999' }), null);
  assert.equal(await cmdPin(db, { id: undefined }), null);
  db.close();
});

// Rewritten from "cli forget deletes the memory" (asserted the row was gone and a trash file existed).
// Ruling: human approved rewriting all necessary criteria, Orca session 7753e97d, 2026-10-27
test('cli forget archives the memory and points at its audit row', () => {
  const db = openDb();
  resetTables(db);
  const id = insertMemory(db, { content: 'cli forget' });
  db.close();

  const output = execFileSync(NODE, [CLI, 'forget', `m${id}`], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(`SELECT decay_status FROM memories WHERE id = ?`).get(id);
  const audits = forgetAuditRows(verifyDb, id);
  verifyDb.close();

  assert.equal(row.decay_status, 'archived');
  assert.equal(audits.length, 1);
  assert.match(output, new RegExp(`ccmem: forgot memory #m${id} \\(project rule; archived, see ccmem audit show ${audits[0].id}\\)`));
});

test('cli pin and cli pin --remove flip the pinned flag', () => {
  const db = openDb();
  resetTables(db);
  const id = insertMemory(db, { content: 'cli pin' });
  db.close();

  const pinnedOutput = execFileSync(NODE, [CLI, 'pin', `m${id}`], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
  });

  const verifyPinned = openDb();
  const pinnedRow = verifyPinned.prepare(`SELECT pinned FROM memories WHERE id = ?`).get(id);
  verifyPinned.close();

  const unpinnedOutput = execFileSync(NODE, [CLI, 'pin', String(id), '--remove'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
  });

  const verifyUnpinned = openDb();
  const unpinnedRow = verifyUnpinned.prepare(`SELECT pinned FROM memories WHERE id = ?`).get(id);
  verifyUnpinned.close();

  assert.match(pinnedOutput, new RegExp(`ccmem: pinned memory #m${id}`));
  assert.equal(pinnedRow.pinned, 1);
  assert.match(unpinnedOutput, new RegExp(`ccmem: unpinned memory #m${id}`));
  assert.equal(unpinnedRow.pinned, 0);
});

test('cli forget exits 2 for a missing memory', () => {
  assert.throws(
    () =>
      execFileSync(NODE, [CLI, 'forget', 'm999999'], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8'
      }),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /ccmem: memory not found/);
      return true;
    }
  );
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
