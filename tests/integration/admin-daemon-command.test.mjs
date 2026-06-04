import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-daemon-'));
const launchAgentDir = path.join(dataRoot, 'LaunchAgents');
const fakeLaunchctlPath = path.join(dataRoot, 'fake-launchctl.sh');
const fakeLaunchctlLog = path.join(dataRoot, 'fake-launchctl.log');
mkdirSync(launchAgentDir, { recursive: true });
writeFileSync(
  fakeLaunchctlPath,
  "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$CCMEM_LAUNCHCTL_LOG\"\nexit 0\n"
);
chmodSync(fakeLaunchctlPath, 0o755);

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_LAUNCHAGENT_DIR = launchAgentDir;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot,
  CCMEM_LAUNCHAGENT_DIR: launchAgentDir
};

const ROOT = '/Users/biran/code/skills/ccmem';
const NODE = '/usr/local/bin/node';
const CLI = `${ROOT}/scripts/cli.mjs`;
const BIN = `${ROOT}/bin/ccmem`;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDaemon, getLaunchAgentPath } = await import('../../scripts/lib/admin/daemon.mjs');

function resetAdminTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function seedAliveDaemon(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(4321, 'test-host', now - 5000, now - 800);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, started_at, status)
     VALUES ('summarize_pending', '{}', ?, ?, ?, 'running')`
  ).run(now - 2000, now - 2000, now - 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDaemonLock() {
  const db = openDb();
  const row = db.prepare(`SELECT holder_pid, hostname, heartbeat_at FROM daemon_lock WHERE id = 1`).get() ?? null;
  db.close();
  return row;
}

async function waitForDaemonLock(present, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = readDaemonLock();
    if (present && row) {
      return row;
    }

    if (!present && !row) {
      return true;
    }

    await sleep(50);
  }

  return null;
}

async function stopRunningDaemon() {
  const row = readDaemonLock();
  if (!row) {
    return;
  }

  try {
    process.kill(row.holder_pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }

  const stopped = await waitForDaemonLock(false);
  if (!stopped) {
    const db = openDb();
    db.prepare(`DELETE FROM daemon_lock WHERE id = 1`).run();
    db.close();
  }
}

function readLaunchctlLog() {
  return existsSync(fakeLaunchctlLog) ? readFileSync(fakeLaunchctlLog, 'utf8') : '';
}

async function withFakeLaunchctl(run) {
  const previousBin = process.env.CCMEM_LAUNCHCTL_BIN;
  const previousLog = process.env.CCMEM_LAUNCHCTL_LOG;
  process.env.CCMEM_LAUNCHCTL_BIN = fakeLaunchctlPath;
  process.env.CCMEM_LAUNCHCTL_LOG = fakeLaunchctlLog;
  rmSync(fakeLaunchctlLog, { force: true });

  try {
    return await run();
  } finally {
    if (previousBin === undefined) {
      delete process.env.CCMEM_LAUNCHCTL_BIN;
    } else {
      process.env.CCMEM_LAUNCHCTL_BIN = previousBin;
    }

    if (previousLog === undefined) {
      delete process.env.CCMEM_LAUNCHCTL_LOG;
    } else {
      process.env.CCMEM_LAUNCHCTL_LOG = previousLog;
    }
  }
}

test.afterEach(async () => {
  await stopRunningDaemon();
  rmSync(getLaunchAgentPath(), { force: true });
  rmSync(fakeLaunchctlLog, { force: true });
  const db = openDb();
  resetAdminTables(db);
  db.close();
});

test('cmdAdminDaemon returns live daemon status and running task', async () => {
  const db = openDb();
  resetAdminTables(db);
  seedAliveDaemon(db);

  const result = await cmdAdminDaemon(db, { verb: 'status' });

  assert.equal(result.alive, true);
  assert.equal(result.pid, 4321);
  assert.equal(result.hostname, 'test-host');
  assert.equal(result.running_task.type, 'summarize_pending');
  assert.equal(typeof result.heartbeat_age_ms, 'number');
  db.close();
});

test('cmdAdminDaemon start, restart, and stop manage the daemon lifecycle', async () => {
  const db = openDb();
  resetAdminTables(db);

  const started = await cmdAdminDaemon(db, { verb: 'start' });
  assert.equal(started.status, 'started');
  assert.equal(typeof started.pid, 'number');

  const liveRow = await waitForDaemonLock(true);
  assert.equal(liveRow?.holder_pid, started.pid);

  const restarted = await cmdAdminDaemon(db, { verb: 'restart' });
  assert.equal(restarted.status, 'restarted');
  assert.equal(restarted.previous_pid, started.pid);
  assert.equal(typeof restarted.pid, 'number');

  const restartedRow = await waitForDaemonLock(true);
  assert.equal(restartedRow?.holder_pid, restarted.pid);

  const stopped = await cmdAdminDaemon(db, { verb: 'stop' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pid, restarted.pid);
  db.close();

  assert.equal(await waitForDaemonLock(false), true);
});

test('cmdAdminDaemon install and uninstall manage a launchd plist', async () => {
  await withFakeLaunchctl(async () => {
    const fakeClaudeDir = path.join(dataRoot, 'fake-claude-bin');
    const fakeClaudePath = path.join(fakeClaudeDir, 'claude');
    mkdirSync(fakeClaudeDir, { recursive: true });
    writeFileSync(fakeClaudePath, '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "--help" ]; then\n  printf %s\\n "--json-schema"\n  exit 0\nfi\nexit 0\n');
    chmodSync(fakeClaudePath, 0o755);

    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const previousFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY;
    const previousPath = process.env.PATH;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-test';
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1';
    process.env.PATH = `${fakeClaudeDir}:${process.env.PATH ?? ''}`;

    const db = openDb();
    resetAdminTables(db);

    try {
      const installed = await cmdAdminDaemon(db, { verb: 'install' });
      assert.equal(installed.status, 'installed');
      assert.equal(existsSync(installed.plist_path), true);
      assert.match(installed.plist, /com\.ccmem\.daemon/);
      assert.match(installed.plist, /--no-warnings/);
      assert.match(installed.plist, /--experimental-sqlite/);
      assert.match(installed.plist, /CCMEM_DATA_ROOT/);
      assert.match(installed.plist, /CCMEM_ENABLE_REAL_CLAUDE_P/);
      assert.match(installed.plist, /CCMEM_CLAUDE_P_COMMAND/);
      assert.match(installed.plist, new RegExp(fakeClaudePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(installed.plist, />1</);
      assert.match(installed.plist, /ANTHROPIC_API_KEY/);
      assert.match(installed.plist, /test-api-key/);
      assert.match(installed.plist, /ANTHROPIC_DEFAULT_SONNET_MODEL/);
      assert.match(installed.plist, /claude-sonnet-test/);
      assert.match(installed.plist, /CLAUDE_CODE_USE_FOUNDRY/);
      assert.match(installed.plist, new RegExp(dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const uninstalled = await cmdAdminDaemon(db, { verb: 'uninstall' });
      assert.equal(uninstalled.status, 'uninstalled');
      assert.equal(existsSync(installed.plist_path), false);

      const log = readLaunchctlLog();
      assert.match(log, /bootstrap/);
      assert.match(log, /bootout/);
    } finally {
      db.close();
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey;
      }
      if (previousSonnet === undefined) {
        delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      } else {
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = previousSonnet;
      }
      if (previousFoundry === undefined) {
        delete process.env.CLAUDE_CODE_USE_FOUNDRY;
      } else {
        process.env.CLAUDE_CODE_USE_FOUNDRY = previousFoundry;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});

test('cli admin daemon status prints live daemon summary', () => {
  const db = openDb();
  resetAdminTables(db);
  seedAliveDaemon(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'status'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon alive pid=4321/);
  assert.match(output, /host=test-host/);
  assert.match(output, /running=summarize_pending#\d+/);
});

test('bin ccmem suppresses sqlite experimental warning for daemon status', () => {
  const db = openDb();
  resetAdminTables(db);
  seedAliveDaemon(db);
  db.close();

  const output = execFileSync(BIN, ['admin', 'daemon', 'status'], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });

  assert.doesNotMatch(output, /ExperimentalWarning/);
  assert.match(output, /ccmem: daemon alive pid=4321/);
  assert.match(output, /running=summarize_pending#\d+/);
});

test('cli admin daemon start, restart, and stop manage a detached daemon', async () => {
  const db = openDb();
  resetAdminTables(db);
  db.close();

  const startOutput = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'start'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });
  assert.match(startOutput, /ccmem: daemon started pid=\d+/);

  const startedRow = await waitForDaemonLock(true);
  assert.equal(typeof startedRow?.holder_pid, 'number');

  const restartOutput = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'restart'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });
  assert.match(restartOutput, /ccmem: daemon restarted pid=\d+/);

  const restartedRow = await waitForDaemonLock(true);
  assert.equal(typeof restartedRow?.holder_pid, 'number');

  const stopOutput = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'stop'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });
  assert.match(stopOutput, /ccmem: daemon stopped pid=\d+/);
  assert.equal(await waitForDaemonLock(false), true);
});

test('cli admin daemon install and uninstall manage a launchd plist', () => {
  rmSync(fakeLaunchctlLog, { force: true });
  const fakeClaudeDir = path.join(dataRoot, 'fake-cli-claude-bin');
  const fakeClaudePath = path.join(fakeClaudeDir, 'claude');
  mkdirSync(fakeClaudeDir, { recursive: true });
  writeFileSync(fakeClaudePath, '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "--help" ]; then\n  printf %s\\n "--json-schema"\n  exit 0\nfi\nexit 0\n');
  chmodSync(fakeClaudePath, 0o755);

  const cliEnv = {
    ...env,
    PATH: `${fakeClaudeDir}:${env.PATH ?? process.env.PATH ?? ''}`,
    ANTHROPIC_API_KEY: 'test-api-key',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-test',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CCMEM_LAUNCHCTL_BIN: fakeLaunchctlPath,
    CCMEM_LAUNCHCTL_LOG: fakeLaunchctlLog
  };

  const installOutput = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'install'], {
    cwd: ROOT,
    env: cliEnv,
    encoding: 'utf8'
  });
  assert.match(installOutput, /ccmem: daemon installed /);
  assert.equal(existsSync(getLaunchAgentPath()), true);
  const plist = readFileSync(getLaunchAgentPath(), 'utf8');
  assert.match(plist, /CCMEM_ENABLE_REAL_CLAUDE_P/);
  assert.match(plist, /CCMEM_CLAUDE_P_COMMAND/);
  assert.match(plist, new RegExp(fakeClaudePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const uninstallOutput = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'uninstall'], {
    cwd: ROOT,
    env: cliEnv,
    encoding: 'utf8'
  });
  assert.match(uninstallOutput, /ccmem: daemon uninstalled /);
  assert.equal(existsSync(getLaunchAgentPath()), false);

  const log = readLaunchctlLog();
  assert.match(log, /bootstrap/);
  assert.match(log, /bootout/);
});

test('cli admin daemon install blocks claude binaries without json-schema support', () => {
  rmSync(fakeLaunchctlLog, { force: true });
  const fakeClaudeDir = path.join(dataRoot, 'fake-old-claude-bin');
  const fakeClaudePath = path.join(fakeClaudeDir, 'claude');
  mkdirSync(fakeClaudeDir, { recursive: true });
  writeFileSync(fakeClaudePath, '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "--help" ]; then\n  printf %s\\n "Usage: claude -p [options]"\n  exit 0\nfi\nexit 0\n');
  chmodSync(fakeClaudePath, 0o755);

  const cliEnv = {
    ...env,
    PATH: `${fakeClaudeDir}:${env.PATH ?? process.env.PATH ?? ''}`,
    CCMEM_LAUNCHCTL_BIN: fakeLaunchctlPath,
    CCMEM_LAUNCHCTL_LOG: fakeLaunchctlLog
  };

  const result = spawnSync(NODE, [CLI, 'admin', '--', 'daemon', 'install'], {
    cwd: ROOT,
    env: cliEnv,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /json-schema/i);
  assert.equal(existsSync(getLaunchAgentPath()), false);
  assert.equal(readLaunchctlLog(), '');
});

test('bin ccmem resolves the real script path when invoked through a symlink', () => {
  rmSync(fakeLaunchctlLog, { force: true });
  const symlinkPath = path.join(dataRoot, 'ccmem');
  rmSync(symlinkPath, { force: true });
  symlinkSync(BIN, symlinkPath);

  const cliEnv = {
    ...env,
    PATH: `/usr/local/bin:${process.env.PATH ?? ''}`,
    ANTHROPIC_API_KEY: 'test-api-key',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-test',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CCMEM_LAUNCHCTL_BIN: fakeLaunchctlPath,
    CCMEM_LAUNCHCTL_LOG: fakeLaunchctlLog
  };

  const installOutput = execFileSync(symlinkPath, ['admin', 'daemon', 'install'], {
    cwd: ROOT,
    env: cliEnv,
    encoding: 'utf8'
  });
  assert.doesNotMatch(installOutput, /ExperimentalWarning/);
  assert.match(installOutput, /ccmem: daemon installed /);
  assert.equal(existsSync(getLaunchAgentPath()), true);
  assert.match(readFileSync(getLaunchAgentPath(), 'utf8'), /CCMEM_ENABLE_REAL_CLAUDE_P/);
  assert.match(readFileSync(getLaunchAgentPath(), 'utf8'), /ANTHROPIC_API_KEY/);
  assert.match(readFileSync(getLaunchAgentPath(), 'utf8'), /ANTHROPIC_DEFAULT_SONNET_MODEL/);

  const uninstallOutput = execFileSync(symlinkPath, ['admin', 'daemon', 'uninstall'], {
    cwd: ROOT,
    env: cliEnv,
    encoding: 'utf8'
  });
  assert.match(uninstallOutput, /ccmem: daemon uninstalled /);
  assert.equal(existsSync(getLaunchAgentPath()), false);

  const log = readLaunchctlLog();
  assert.match(log, /bootstrap/);
  assert.match(log, /bootout/);
});

test('cli admin daemon status prints not running when daemon lock is absent', () => {
  const db = openDb();
  resetAdminTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'daemon', 'status'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon not running/);
});

test.after(async () => {
  await stopRunningDaemon();
  rmSync(dataRoot, { recursive: true, force: true });
});
