import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-cli-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

test('cli mode updates stored mode', () => {
  const output = execFileSync(NODE, [CLI, 'mode', 'shadow'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: mode=shadow/);
});

test('cli audit show prints inserted audit row', async () => {
  const { openDb } = await import('../../scripts/lib/db.mjs');
  const db = openDb();
  const inserted = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, ?, ?)`
  ).run(Date.now(), 'save', '[1]', '{"ok":true}');
  db.close();

  const output = execFileSync(NODE, [CLI, 'audit', 'show', String(inserted.lastInsertRowid)], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /"action":"save"/);
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
