import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function resetTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
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

test('cmdForget deletes the memory and keeps a trash copy', async () => {
  const db = openDb();
  resetTables(db);
  const id = insertMemory(db, { content: 'delete this rule' });

  const result = await cmdForget(db, { id: `m${id}` });
  const row = db.prepare(`SELECT id FROM memories WHERE id = ?`).get(id);

  assert.equal(result.id, id);
  assert.equal(result.scope, 'project');
  assert.equal(result.type, 'rule');
  assert.equal(row, undefined);
  assert.equal(readFileSync(path.join(dataRoot, 'trash', `${id}.md`), 'utf8'), 'delete this rule');
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

test('cli forget deletes the memory', () => {
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
  const row = verifyDb.prepare(`SELECT id FROM memories WHERE id = ?`).get(id);
  verifyDb.close();

  assert.match(output, new RegExp(`ccmem: forgot memory #m${id}`));
  assert.equal(row, undefined);
  assert.ok(existsSync(path.join(dataRoot, 'trash', `${id}.md`)));
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
