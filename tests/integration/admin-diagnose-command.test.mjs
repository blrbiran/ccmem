import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-diagnose-'));
const diagnoseCwd = mkdtempSync(path.join(tmpdir(), 'ccmem-diagnose-cwd-'));
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
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const { fallbackProjectKey } = await import('../../scripts/lib/project-key.mjs');

function resetDiagnoseTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
}

function seedAliveDaemon(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(2468, 'diagnose-host', now - 4000, now - 600);
}

test('cmdAdminDiagnose returns db health, daemon status, and fallback project key', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedAliveDaemon(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd });

  assert.equal(result.db.health, 'ok');
  assert.equal(result.db.schema_version, 2);
  assert.equal(result.daemon.alive, true);
  assert.equal(result.daemon.pid, 2468);
  assert.equal(result.project_key.value, fallbackProjectKey(diagnoseCwd));
  assert.equal(result.project_key.source, 'fallback');
  assert.equal(result.project_key.cwd, null);
  assert.equal(result.project_key.fallback_value, null);
  assert.equal(result.tier2.available, true);
  assert.equal(result.migrations, null);
  db.close();
});

test('cmdAdminDiagnose returns migration history when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, migrations: true });

  assert.equal(Array.isArray(result.migrations), true);
  assert.equal(result.migrations.length >= 2, true);
  assert.deepEqual(result.migrations[0], {
    from_version: 0,
    to_version: 1,
    description: 'v0.1 initial schema',
    applied_at: result.migrations[0].applied_at,
    applied_by: 'ccmem-cli'
  });
  assert.equal(result.migrations.at(-1).to_version, 2);
  db.close();
});

test('cli admin diagnose prints default diagnostics', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedAliveDaemon(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: db ok schema=2/);
  assert.match(output, /ccmem: daemon alive pid=2468 host=diagnose-host/);
  assert.match(output, /ccmem: project_key path:/);
  assert.match(output, /ccmem: tier2 available/);
});

test('cli admin diagnose prints daemon unavailable when lock is absent', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon unavailable/);
  assert.match(output, /ccmem: tier2 unavailable/);
});

test('cli admin diagnose --migrations prints schema migration history', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--migrations'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /migration 0->1 by=ccmem-cli desc=v0\.1 initial schema/);
  assert.match(output, /migration 1->2 by=ccmem-cli desc=v0\.2 schema/);
});

test('cli admin diagnose --key prints focused project key diagnostics', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--key'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: project_key path:/);
  assert.match(output, /ccmem: cwd \/(private\/)?tmp\//);

  const projectKey = output.match(/ccmem: project_key (path:[0-9a-f]{16}) source=fallback/)?.[1];
  assert.equal(typeof projectKey, 'string');
  assert.match(output, new RegExp(`ccmem: fallback ${projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(diagnoseCwd, { recursive: true, force: true });
});
