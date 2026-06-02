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
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const { fallbackProjectKey } = await import('../../scripts/lib/project-key.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

function resetDiagnoseTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedSessionDiagnostics(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
     ) VALUES
      ('s-1', 'demo/repo', 2, 5, 1200, 9, ?),
      ('s-2', 'demo/other', 1, 2, 300, 4, ?)`
  ).run(now, now - 1000);

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES
      ('s-1', 2, 'user_prompt_submit', '[1,2]', ?),
      ('s-1', 0, 'session_start', '[3]', ?),
      ('s-2', 1, 'user_prompt_submit', '[4]', ?)`
  ).run(now, now - 100, now - 1000);
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

test('cmdAdminDiagnose returns session diagnostics when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedSessionDiagnostics(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, sessions: true });

  assert.equal(Array.isArray(result.sessions), true);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].session_id, 's-1');
  assert.equal(result.sessions[0].message_count, 5);
  assert.deepEqual(result.sessions[0].recent_injections[0].mem_ids, [1, 2]);
  assert.equal(result.sessions[0].recent_injections[1].inject_source, 'session_start');
  assert.equal(result.sessions[1].session_id, 's-2');
  assert.deepEqual(result.sessions[1].recent_injections[0].mem_ids, [4]);
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

test('cli admin diagnose --sessions prints active sessions and recent injections', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedSessionDiagnostics(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--sessions'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: sessions 2/);
  assert.match(output, /session s-1 msgs=5 tools=2 duration_ms=1200 last_seq=9/);
  assert.match(output, /inject prompt=2 source=user_prompt_submit mems=1,2/);
  assert.match(output, /inject prompt=0 source=session_start mems=3/);
  assert.match(output, /session s-2 msgs=2 tools=1 duration_ms=300 last_seq=4/);
});

test('cli admin diagnose --sessions reflects hook-produced session diagnostics', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const globalMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Prefer concise answers',
    scope: 'global',
    type: 'rule'
  });
  const projectMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  db.close();

  await handleSessionStart({ cwd: diagnoseCwd, session_id: 's-hook' });
  await handlePromptSubmit({
    cwd: diagnoseCwd,
    session_id: 's-hook',
    prompt: 'add a route under app api'
  });

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--sessions'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: sessions 1/);
  assert.match(output, /session s-hook msgs=0 tools=0 duration_ms=0 last_seq=0/);
  assert.match(output, new RegExp(`inject prompt=1 source=user_prompt_submit mems=${projectMem.id}`));
  assert.match(output, new RegExp(`inject prompt=0 source=session_start mems=${globalMem.id},${projectMem.id}`));
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(diagnoseCwd, { recursive: true, force: true });
});
