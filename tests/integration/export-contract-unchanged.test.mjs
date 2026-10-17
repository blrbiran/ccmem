import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Orca's ccmemExport schema is .strict(): any extra key (e.g. origin_agent) breaks it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-export-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

test('export rows keep exactly the 11 contract keys even when origin_agent is set', async () => {
  const db = openDb();
  await insertMemory(db, { cwd: ROOT, content: 'exported fact written by codex', scope: 'global', originAgent: 'codex', embedSync: false });
  db.close();

  const out = spawnSync('/usr/local/bin/node', [path.join(ROOT, 'scripts/cli.mjs'), 'export', '--json', '--scope', 'global'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot }
  });
  assert.equal(out.status, 0, out.stderr);
  const { memories } = JSON.parse(out.stdout);
  assert.ok(memories.length >= 1);
  for (const row of memories) {
    assert.deepEqual(Object.keys(row).sort(),
      ['content', 'created_at', 'id', 'pinned', 'project_key', 'scope', 'source', 'tags', 'trust_score', 'type', 'updated_at']);
  }
});
