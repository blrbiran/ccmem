import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CCMEM_TEST_MODE = '1';
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-rotate-log-'));
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { cmdAdminDaemon, rotateDaemonLog } = await import('../../scripts/lib/admin/daemon.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Issue 420: the binary that runs this suite is the binary the child CLI must run, whatever path the
// checkout lives at or which node is first on PATH.
const NODE = process.execPath;
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const LOG_PATH = path.join(dataRoot, 'daemon.err.log');
const MiB = 1024 * 1024;

function writeLog(size, seed = 0) {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buffer[i] = (i + seed) % 251;
  }
  writeFileSync(LOG_PATH, buffer);
  return buffer;
}

test('rotating keeps the last N bytes aside and truncates the live file in place', () => {
  const original = writeLog(2048, 7);

  const result = rotateDaemonLog({ keepBytes: 512 });

  assert.equal(result.status, 'rotated');
  assert.equal(result.path, LOG_PATH);
  assert.equal(result.before_bytes, 2048);
  assert.equal(result.kept_bytes, 512);
  assert.equal(statSync(LOG_PATH).size, 0, 'the live file must be truncated, not removed');

  const tail = readFileSync(result.tail_path);
  assert.equal(tail.length, 512);
  assert.equal(
    Buffer.compare(tail, original.subarray(original.length - 512)),
    0,
    'the tail file must contain the last N bytes, in order'
  );
  // 0600 is set at creation, not inherited from umask.
  assert.equal(statSync(result.tail_path).mode & 0o777, 0o600);
});

test('the default keeps 5 MiB and a colliding epoch-ms never overwrites the first tail', () => {
  const first = writeLog(5 * MiB + 100, 3);
  const realNow = Date.now;
  const frozen = realNow();

  // Same millisecond for both rotations forces the EEXIST branch: without the
  // `wx` retry the second tail would silently replace the first.
  Date.now = () => frozen;
  try {
    const firstRun = rotateDaemonLog();
    assert.equal(firstRun.kept_bytes, 5 * MiB, 'the default keep size is 5 MiB');
    const second = writeLog(64, 11);
    const secondRun = rotateDaemonLog();
    assert.notEqual(secondRun.tail_path, firstRun.tail_path, 'a colliding epoch-ms must not reuse the tail path');
    assert.equal(Buffer.compare(readFileSync(firstRun.tail_path), first.subarray(first.length - 5 * MiB)), 0);
    assert.equal(Buffer.compare(readFileSync(secondRun.tail_path), second), 0);
  } finally {
    Date.now = realNow;
  }
});

test('a missing log is reported, not created', () => {
  rmSync(LOG_PATH, { force: true });

  const result = rotateDaemonLog();

  assert.equal(result.status, 'log_missing');
  assert.equal(result.path, LOG_PATH);
  assert.equal(existsSync(LOG_PATH), false, 'rotation must not fabricate a log');
});

function cliEnv(extra = {}) {
  return {
    ...process.env,
    CCMEM_TEST_MODE: '1',
    CCMEM_DATA_ROOT: dataRoot,
    CCMEM_LAUNCHAGENT_DIR: path.join(dataRoot, 'LaunchAgents'),
    ...extra
  };
}

test('cli admin daemon rotate-log prints the sizes and the tail path', () => {
  writeLog(2048, 9);

  const result = spawnSync(NODE, [CLI, 'admin', '--', 'daemon', 'rotate-log', '--keep-bytes', '300'], {
    cwd: ROOT,
    env: cliEnv(),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ccmem: daemon log rotated/);
  assert.match(result.stdout, /before_bytes=2048/);
  assert.match(result.stdout, /kept_bytes=300/);
  const tail = /tail=(\S+)/.exec(result.stdout)?.[1];
  assert.ok(tail && existsSync(tail), 'the printed tail path must exist');
  assert.equal(statSync(LOG_PATH).size, 0);
});

test('cli admin daemon rotate-log exits non-zero and says so when the log is missing', () => {
  rmSync(LOG_PATH, { force: true });

  const result = spawnSync(NODE, [CLI, 'admin', '--', 'daemon', 'rotate-log'], {
    cwd: ROOT,
    env: cliEnv(),
    encoding: 'utf8'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /daemon log not found/);
  assert.match(result.stderr, new RegExp(LOG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('cli admin daemon install names an oversized stderr log without rotating it', () => {
  const launchAgentDir = path.join(dataRoot, 'LaunchAgents');
  mkdirSync(launchAgentDir, { recursive: true });
  const fakeLaunchctl = path.join(dataRoot, 'fake-launchctl.sh');
  writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeLaunchctl, 0o755);

  const fakeClaudeDir = path.join(dataRoot, 'fake-claude-bin');
  const fakeClaude = path.join(fakeClaudeDir, 'claude');
  mkdirSync(fakeClaudeDir, { recursive: true });
  writeFileSync(fakeClaude, '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "--help" ]; then\n  printf %s\\n "--json-schema"\n  exit 0\nfi\nexit 0\n');
  chmodSync(fakeClaude, 0o755);

  writeFileSync(
    path.join(dataRoot, 'config.json'),
    JSON.stringify({ llm: { commands: { codex: path.join(dataRoot, 'absent', 'codex'), omp: path.join(dataRoot, 'absent', 'omp') } } })
  );

  const oversized = 10 * MiB + 1;
  writeLog(oversized, 5);

  const env = cliEnv({
    CCMEM_LAUNCHCTL_BIN: fakeLaunchctl,
    CCMEM_CLAUDE_P_COMMAND: fakeClaude,
    PATH: `${fakeClaudeDir}${path.delimiter}${process.env.PATH ?? ''}`
  });

  const installed = spawnSync(NODE, [CLI, 'admin', '--', 'daemon', 'install'], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });

  try {
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /ccmem: daemon installed/);
    assert.match(installed.stdout, new RegExp(`daemon\\.err\\.log is ${oversized} bytes`));
    assert.match(installed.stdout, /ccmem admin daemon rotate-log/);
    assert.equal(statSync(LOG_PATH).size, oversized, 'install must not rotate the operator\'s log');
  } finally {
    const uninstalled = spawnSync(NODE, [CLI, 'admin', '--', 'daemon', 'uninstall'], {
      cwd: ROOT,
      env,
      encoding: 'utf8'
    });
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
  }
});

test('cmdAdminDaemon routes rotate-log through the daemon verb table', async () => {
  writeLog(128, 1);
  const db = openDb();
  try {
    const result = await cmdAdminDaemon(db, { verb: 'rotate-log', keepBytes: '64' });
    assert.equal(result.status, 'rotated');
    assert.equal(result.kept_bytes, 64);
  } finally {
    db.close();
  }

  writeLog(128, 2);
  const missingDb = openDb();
  try {
    const missing = await cmdAdminDaemon(missingDb, { verb: 'rotate-log', keepBytes: 'nope' });
    assert.equal(missing.status, 'invalid_keep_bytes');
  } finally {
    missingDb.close();
  }
});
