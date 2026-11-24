import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const NODE = process.execPath;
const CLI = path.join(REPO_ROOT, 'scripts/cli.mjs');
const MAIN = path.join(REPO_ROOT, 'scripts/daemon/main.mjs');

// Issue #396: a plist that exec'd a main.mjs left behind by a moved repo made
// launchd restart the daemon every ~30s, appending MODULE_NOT_FOUND to
// daemon.err.log forever (83 MB / 1.98 M lines at the tester). Everything below
// exercises one of the three cheap guards: refuse a dead program path at
// install/restart, report it from diagnose, and cap unattended starts per hour.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-daemon-hardening-'));
const launchAgentDir = path.join(dataRoot, 'LaunchAgents');
const plistPath = path.join(launchAgentDir, 'com.ccmem.daemon.plist');
const fakeLaunchctlPath = path.join(dataRoot, 'fake-launchctl.sh');
const fakeLaunchctlLog = path.join(dataRoot, 'fake-launchctl.log');

mkdirSync(launchAgentDir, { recursive: true });
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_LAUNCHAGENT_DIR = launchAgentDir;
process.env.CCMEM_LAUNCHCTL_BIN = fakeLaunchctlPath;
process.env.CCMEM_LAUNCHCTL_LOG = fakeLaunchctlLog;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');
const { renderPlist } = await import('../../scripts/lib/admin/daemon.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const {
  clearStartHistory,
  DEFAULT_MAX_STARTS_PER_HOUR,
  getStartHistoryPath,
  recordDaemonStart,
  START_WINDOW_MS
} = await import('../../scripts/daemon/crash-guard.mjs');

function writeFakeLaunchctl(script = "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$CCMEM_LAUNCHCTL_LOG\"\nexit 0\n") {
  writeFileSync(fakeLaunchctlPath, script);
  chmodSync(fakeLaunchctlPath, 0o755);
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    CCMEM_TEST_MODE: '1',
    CCMEM_DATA_ROOT: dataRoot,
    CCMEM_LAUNCHAGENT_DIR: launchAgentDir,
    CCMEM_LAUNCHCTL_BIN: fakeLaunchctlPath,
    CCMEM_LAUNCHCTL_LOG: fakeLaunchctlLog,
    ...extra
  };
}

function runCli(args, extraEnv = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    cwd: REPO_ROOT,
    env: cliEnv(extraEnv),
    encoding: 'utf8'
  });
}

function writePlist({ programArgs, extra = '' }) {
  const strings = programArgs.map((arg) => `    <string>${arg}</string>`).join('\n');
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ccmem.daemon</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>${extra}
  <key>StandardErrorPath</key><string>${path.join(dataRoot, 'daemon.err.log')}</string>
</dict></plist>
`
  );
}

function resetDb() {
  const db = openDb();
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM tasks`).run();
  return db;
}

test.afterEach(() => {
  rmSync(plistPath, { force: true });
  rmSync(fakeLaunchctlLog, { force: true });
  clearStartHistory();
});

test('install refuses a ProgramArguments path that is not a file and records nothing', () => {
  writeFakeLaunchctl();
  rmSync(plistPath, { force: true });
  // A directory passes resolveInstallNodePath's existsSync but cannot be exec'd.
  const directoryAsNode = path.join(dataRoot, 'not-a-node-binary');
  mkdirSync(directoryAsNode, { recursive: true });

  const fakeClaudeDir = path.join(dataRoot, 'fake-claude-bin');
  mkdirSync(fakeClaudeDir, { recursive: true });
  writeFileSync(
    path.join(fakeClaudeDir, 'claude'),
    '#!/bin/sh\nif [ "$1" = "-p" ] && [ "$2" = "--help" ]; then printf %s\\n "--json-schema"; exit 0; fi\nexit 0\n'
  );
  chmodSync(path.join(fakeClaudeDir, 'claude'), 0o755);

  const result = runCli(['admin', '--', 'daemon', 'install'], {
    PATH: `${fakeClaudeDir}${path.delimiter}${process.env.PATH ?? ''}`,
    CCMEM_INSTALL_NODE_PATH: directoryAsNode
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon install refused/);
  assert.ok(result.stderr.includes(directoryAsNode), `the missing path must be named, got: ${result.stderr}`);
  assert.ok(result.stderr.includes(REPO_ROOT), `the migration hint must name the current repo, got: ${result.stderr}`);
  assert.equal(existsSync(plistPath), false, 'a refused install must not write a plist');
  assert.equal(existsSync(fakeLaunchctlLog), false, 'a refused install must not call launchctl');
});

test('restart refuses an installed plist whose program path no longer exists', async () => {
  writeFakeLaunchctl();
  const deadMain = path.join(dataRoot, 'moved-away', 'scripts', 'daemon', 'main.mjs');
  writePlist({ programArgs: ['/also/gone/node', '--no-warnings', '--experimental-sqlite', deadMain] });
  const before = readFileSync(plistPath, 'utf8');
  const db = resetDb();

  try {
    const result = await cmdAdminDaemon(db, { verb: 'restart' });

    assert.equal(result.status, 'program_missing');
    assert.deepEqual(result.missing_paths, ['/also/gone/node', deadMain]);
    assert.match(result.reason, /moved/);
    assert.ok(result.reason.includes(deadMain));
    assert.ok(result.reason.includes(REPO_ROOT));
    assert.equal(readFileSync(plistPath, 'utf8'), before, 'the installed plist must be left byte-for-byte alone');
    assert.equal(existsSync(fakeLaunchctlLog), false, 'restart must not bootout/kickstart a job it refuses');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daemon_lock').get().n, 0);
  } finally {
    db.close();
  }
});

test('cli restart exits 1 and names the dead path without touching launchd', () => {
  writeFakeLaunchctl();
  const deadMain = path.join(dataRoot, 'moved-away', 'scripts', 'daemon', 'main.mjs');
  writePlist({ programArgs: [process.execPath, '--no-warnings', '--experimental-sqlite', deadMain] });

  const result = runCli(['admin', '--', 'daemon', 'restart']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon restart refused/);
  assert.ok(result.stderr.includes(deadMain));
  assert.equal(existsSync(fakeLaunchctlLog), false);
});

test('diagnose reports a plist whose program path is missing and whose last exit code is nonzero', async () => {
  writeFakeLaunchctl(
    '#!/bin/sh\nif [ "$1" = "print" ]; then\n  printf \'%s\\n\' "state = not running"\n  printf \'%s\\n\' "last exit code = 1"\n  exit 0\nfi\nexit 0\n'
  );
  const deadMain = path.join(dataRoot, 'moved-away', 'scripts', 'daemon', 'main.mjs');
  writePlist({ programArgs: [process.execPath, '--no-warnings', '--experimental-sqlite', deadMain] });

  const db = resetDb();
  try {
    const result = await cmdAdminDiagnose(db, { cwd: dataRoot });
    assert.equal(result.daemon.plist.installed, true);
    assert.equal(result.daemon.plist.ok, false);
    assert.deepEqual(result.daemon.plist.missing_paths, [deadMain]);
    assert.equal(result.daemon.plist.launchd.last_exit_code, 1);
    assert.ok(result.daemon.plist.problems.some((problem) => problem.includes(deadMain)));
    assert.ok(result.daemon.plist.problems.some((problem) => problem.includes('last exit code 1')));
  } finally {
    db.close();
  }

  const cli = runCli(['admin', '--', 'diagnose']);
  assert.equal(cli.status, 1, 'a dead daemon plist makes diagnose a failure');
  assert.match(cli.stdout, /ccmem: FAIL daemon plist/);
  assert.ok(cli.stdout.includes(deadMain));
  assert.match(cli.stdout, /last exit code 1/);
});

test('diagnose stays green for a plist whose program exists and whose last exit code is zero', async () => {
  writeFakeLaunchctl(
    '#!/bin/sh\nif [ "$1" = "print" ]; then\n  printf \'%s\\n\' "pid = 4242"\n  printf \'%s\\n\' "last exit code = 0"\n  exit 0\nfi\nexit 0\n'
  );
  writePlist({ programArgs: [process.execPath, '--no-warnings', '--experimental-sqlite', MAIN] });

  const db = resetDb();
  try {
    const result = await cmdAdminDiagnose(db, { cwd: dataRoot });
    assert.equal(result.daemon.plist.ok, true);
    assert.deepEqual(result.daemon.plist.problems, []);
  } finally {
    db.close();
  }

  const cli = runCli(['admin', '--', 'diagnose']);
  assert.equal(cli.status, 0);
  assert.equal(/FAIL daemon plist/.test(cli.stdout), false);
});

test('the installed plist throttles launchd restarts', () => {
  assert.match(renderPlist(), /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
});

test('the crash-loop guard allows the limit, refuses after it, and records only real starts', () => {
  const statePath = path.join(dataRoot, 'guard-test', 'daemon-start-history.json');
  const t0 = 1_700_000_000_000;
  const maxStarts = 3;

  for (let i = 0; i < maxStarts; i += 1) {
    const recorded = recordDaemonStart({ now: t0 + i * 1000, statePath, maxStarts });
    assert.equal(recorded.allowed, true, `start ${i + 1} of ${maxStarts} must be allowed`);
    assert.equal(recorded.starts, i + 1);
  }

  const bytesAfterLimit = readFileSync(statePath, 'utf8');
  const blocked = recordDaemonStart({ now: t0 + 30_000, statePath, maxStarts });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.starts, maxStarts);
  assert.equal(blocked.limit, maxStarts);
  assert.equal(blocked.retry_after_ms, START_WINDOW_MS - 30_000);
  assert.equal(readFileSync(statePath, 'utf8'), bytesAfterLimit, 'a refused start must not extend the window');

  const stillBlocked = recordDaemonStart({ now: t0 + START_WINDOW_MS - 1, statePath, maxStarts });
  assert.equal(stillBlocked.allowed, false);
  assert.equal(stillBlocked.retry_after_ms, 1);

  const afterWindow = recordDaemonStart({ now: t0 + START_WINDOW_MS + 2001, statePath, maxStarts });
  assert.equal(afterWindow.allowed, true, 'the window must free up once the oldest start falls out');
  assert.equal(afterWindow.starts, 1, 'starts outside the window must be pruned');
});

test('an explicit clear lets a fresh operator start through a full history', () => {
  const statePath = path.join(dataRoot, 'guard-test', 'daemon-start-history.json');
  const now = Date.now();
  for (let i = 0; i < DEFAULT_MAX_STARTS_PER_HOUR; i += 1) {
    recordDaemonStart({ now: now + i, statePath });
  }
  assert.equal(recordDaemonStart({ now: now + 100, statePath }).allowed, false);

  clearStartHistory({ statePath });

  assert.equal(recordDaemonStart({ now: now + 200, statePath }).allowed, true);
});

test('the guard state lives in the app data root', () => {
  assert.equal(getStartHistoryPath(), path.join(dataRoot, 'daemon-start-history.json'));
});

test('a daemon over the hourly limit exits with one line instead of looping', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-crash-guard-'));
  const now = Date.now();
  writeFileSync(
    path.join(root, 'daemon-start-history.json'),
    JSON.stringify({ starts: Array.from({ length: DEFAULT_MAX_STARTS_PER_HOUR }, (_, i) => now + i) })
  );

  const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: root };
  delete env.CCMEM_CONFIG_PATH;

  try {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-sqlite', MAIN],
      { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30000 }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to crash-loop/);
    assert.equal(result.stderr.trim().split('\n').length, 1, `expected exactly one line, got: ${result.stderr}`);
    assert.equal(existsSync(path.join(root, 'global.db')), false, 'the guard must stop the daemon before it opens the store');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the guard state file is created owner-only', () => {
  const statePath = path.join(dataRoot, 'guard-mode', 'daemon-start-history.json');
  recordDaemonStart({ now: Date.now(), statePath });
  const mode = statSync(statePath).mode & 0o777;
  assert.equal(mode, 0o600);
});
