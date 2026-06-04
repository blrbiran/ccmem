import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDaemonAlive } from '../../daemon/lock.mjs';
import { getDataRoot } from '../db.mjs';

const DAEMON_MAIN = fileURLToPath(new URL('../../daemon/main.mjs', import.meta.url));
const LAUNCHD_LABEL = 'com.ccmem.daemon';
const WAIT_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 2000;
const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
const DAEMON_ENV_PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_FOUNDRY'
];

function resolveCommandFromPath(command, envPath) {
  const pathValue = String(envPath ?? '').trim();
  if (!pathValue) {
    return null;
  }

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }

    const candidate = path.join(dir, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildDaemonEnv(baseEnv = process.env) {
  const dataRoot = getDataRoot();
  const daemonEnv = {
    PATH: baseEnv.PATH ?? DEFAULT_PATH,
    CCMEM_DATA_ROOT: baseEnv.CCMEM_DATA_ROOT ?? dataRoot
  };

  const claudeCommand = baseEnv.CCMEM_CLAUDE_P_COMMAND
    ?? resolveCommandFromPath('claude', daemonEnv.PATH);
  if (claudeCommand) {
    daemonEnv.CCMEM_CLAUDE_P_COMMAND = claudeCommand;

    const claudeBinDir = path.dirname(claudeCommand);
    if (!daemonEnv.PATH.split(path.delimiter).includes(claudeBinDir)) {
      daemonEnv.PATH = `${claudeBinDir}${path.delimiter}${daemonEnv.PATH}`;
    }
  }

  const passthroughKeys = [
    'CCMEM_CLAUDE_P_ARGS_JSON',
    'CCMEM_CLAUDE_P_TIMEOUT_MS'
  ];

  for (const key of passthroughKeys) {
    const value = baseEnv[key];
    if (typeof value === 'string' && value) {
      daemonEnv[key] = value;
    }
  }

  for (const key of DAEMON_ENV_PASSTHROUGH) {
    const value = baseEnv[key];
    if (typeof value === 'string' && value) {
      daemonEnv[key] = value;
    }
  }

  return daemonEnv;
}

function buildLaunchdDaemonEnv(dataRoot) {
  return buildDaemonEnv({
    ...process.env,
    CCMEM_DATA_ROOT: dataRoot
  });
}

function probeClaudeJsonSchemaSupport(command, daemonEnv) {
  const result = spawnSync(command, ['-p', '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...daemonEnv
    }
  });

  if (result.error) {
    return {
      ok: false,
      reason: `resolved Claude Code binary at ${command} but could not inspect \`claude -p --help\` (${result.error.message})`
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: `resolved Claude Code binary at ${command} but capability check failed: \`claude -p --help\` exited ${result.status}`
    };
  }

  const helpText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!helpText.includes('--json-schema')) {
    return {
      ok: false,
      reason: `resolved Claude Code binary at ${command} does not support --json-schema; reinstall from a shell where \`claude\` points to a newer Claude Code build`
    };
  }

  return { ok: true };
}

function buildSpawnDaemonEnv() {
  return buildDaemonEnv(process.env);
}

function renderEnvDict(env) {
  return Object.entries(env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join('\n');
}

function getDaemonPlistPaths(dataRoot) {
  return {
    stderrPath: path.join(dataRoot, 'daemon.err.log'),
    stdoutPath: path.join(dataRoot, 'daemon.out.log')
  };
}

function renderDaemonPlist(dataRoot, daemonEnv) {
  const paths = getDaemonPlistPaths(dataRoot);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>--no-warnings</string>
    <string>--experimental-sqlite</string>
    <string>${escapeXml(DAEMON_MAIN)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${escapeXml(paths.stderrPath)}</string>
  <key>StandardOutPath</key><string>${escapeXml(paths.stdoutPath)}</string>
  <key>EnvironmentVariables</key><dict>
${renderEnvDict(daemonEnv)}
  </dict>
</dict></plist>
`;
}

function getLaunchAgentDir() {
  return process.env.CCMEM_LAUNCHAGENT_DIR ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function getLaunchAgentPath() {
  return path.join(getLaunchAgentDir(), `${LAUNCHD_LABEL}.plist`);
}

function getLaunchCtlBin() {
  return process.env.CCMEM_LAUNCHCTL_BIN ?? 'launchctl';
}

function getLaunchDomain() {
  return `gui/${process.getuid()}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderPlist() {
  const dataRoot = getDataRoot();
  const daemonEnv = buildLaunchdDaemonEnv(dataRoot);

  return renderDaemonPlist(dataRoot, daemonEnv);
}

export { getLaunchAgentPath };

function runLaunchctl(args) {
  return spawnSync(getLaunchCtlBin(), args, { encoding: 'utf8' });
}

function launchctlError(result) {
  return (result.stderr || result.stdout || '').trim() || `launchctl ${result.status}`;
}

function isLaunchdInstalled() {
  return existsSync(getLaunchAgentPath());
}

function readPlist() {
  return readFileSync(getLaunchAgentPath(), 'utf8');
}

function loadRunningTask(db) {
  const runningTask = db.prepare(
    `SELECT id, type, started_at
     FROM tasks
     WHERE status = 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`
  ).get();

  return runningTask
    ? { id: runningTask.id, type: runningTask.type, started_at: runningTask.started_at }
    : null;
}

function loadDaemonStatus(db) {
  const lock = db.prepare(
    `SELECT holder_pid, hostname, acquired_at, heartbeat_at
     FROM daemon_lock
     WHERE id = 1`
  ).get();

  return {
    alive: isDaemonAlive(db),
    pid: lock?.holder_pid ?? null,
    hostname: lock?.hostname ?? null,
    acquired_at: lock?.acquired_at ?? null,
    heartbeat_at: lock?.heartbeat_at ?? null,
    heartbeat_age_ms: lock ? Math.max(0, Date.now() - lock.heartbeat_at) : null,
    running_task: loadRunningTask(db)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();
    if (value) {
      return value;
    }

    await sleep(WAIT_INTERVAL_MS);
  }

  return null;
}

function kickstartDaemon() {
  const result = runLaunchctl(['kickstart', `${getLaunchDomain()}/${LAUNCHD_LABEL}`]);
  if (result.status !== 0) {
    return {
      status: 'start_failed',
      reason: launchctlError(result)
    };
  }

  return null;
}

function bootstrapDaemon() {
  const result = runLaunchctl(['bootstrap', getLaunchDomain(), getLaunchAgentPath()]);
  if (result.status !== 0) {
    return {
      status: 'start_failed',
      reason: launchctlError(result)
    };
  }

  return null;
}

function bootoutDaemon() {
  const result = runLaunchctl(['bootout', getLaunchDomain(), getLaunchAgentPath()]);
  if (![0, 3].includes(result.status ?? 1)) {
    return {
      status: 'stop_failed',
      reason: launchctlError(result)
    };
  }

  return null;
}

function installDaemon() {
  const plistPath = getLaunchAgentPath();
  const dataRoot = getDataRoot();
  const daemonEnv = buildLaunchdDaemonEnv(dataRoot);
  const claudeCommand = daemonEnv.CCMEM_CLAUDE_P_COMMAND;

  if (!claudeCommand) {
    return {
      status: 'version_check_failed',
      plist_path: plistPath,
      reason: 'could not resolve `claude` from the install shell PATH; install from a shell where Claude Code is available'
    };
  }

  const capability = probeClaudeJsonSchemaSupport(claudeCommand, daemonEnv);
  if (!capability.ok) {
    return {
      status: 'version_check_failed',
      plist_path: plistPath,
      reason: capability.reason
    };
  }

  mkdirSync(getLaunchAgentDir(), { recursive: true });
  writeFileSync(plistPath, renderDaemonPlist(dataRoot, daemonEnv));

  const bootstrapError = bootstrapDaemon();
  if (bootstrapError) {
    return {
      status: 'install_failed',
      plist_path: plistPath,
      reason: bootstrapError.reason
    };
  }

  return {
    status: 'installed',
    plist_path: plistPath,
    plist: readPlist()
  };
}

function uninstallDaemon() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { status: 'not_installed', plist_path: plistPath };
  }

  const result = runLaunchctl(['bootout', getLaunchDomain(), plistPath]);
  if (![0, 3].includes(result.status ?? 1)) {
    return {
      status: 'uninstall_failed',
      plist_path: plistPath,
      reason: launchctlError(result)
    };
  }

  rmSync(plistPath, { force: true });
  return { status: 'uninstalled', plist_path: plistPath };
}

async function startDaemon(db) {
  const current = loadDaemonStatus(db);
  if (current.alive) {
    return { status: 'already_running', ...current };
  }

  if (isLaunchdInstalled()) {
    const kickstartError = kickstartDaemon();
    if (kickstartError) {
      const bootstrapError = bootstrapDaemon();
      if (bootstrapError) {
        return bootstrapError;
      }
    }

    const started = await waitFor(() => {
      const next = loadDaemonStatus(db);
      return next.alive ? next : null;
    });

    return started ? { status: 'started', via: 'launchctl', ...started } : { status: 'start_timeout', via: 'launchctl' };
  }

  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', DAEMON_MAIN], {
    detached: true,
    stdio: 'ignore',
    env: buildSpawnDaemonEnv()
  });
  child.unref();

  const started = await waitFor(() => {
    const next = loadDaemonStatus(db);
    return next.alive && next.pid === child.pid ? next : null;
  });

  return started
    ? { status: 'started', via: 'spawn', ...started }
    : { status: 'start_timeout', via: 'spawn', pid: child.pid, alive: false, running_task: null };
}

async function stopDaemon(db) {
  const current = loadDaemonStatus(db);

  if (isLaunchdInstalled()) {
    const error = bootoutDaemon();
    if (error) {
      return { ...current, ...error };
    }

    return { status: current.pid ? 'stopped' : 'not_running', via: 'launchctl', ...current };
  }

  if (!current.pid) {
    return { status: 'not_running', ...current };
  }

  try {
    process.kill(current.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      db.prepare(`DELETE FROM daemon_lock WHERE id = 1`).run();
      return { status: 'stopped', ...current };
    }

    throw error;
  }

  const stopped = await waitFor(() => {
    const lock = db.prepare(`SELECT 1 FROM daemon_lock WHERE id = 1`).get();
    return lock ? null : true;
  });

  return stopped ? { status: 'stopped', ...current } : { status: 'stop_timeout', ...current };
}

async function restartDaemon(db) {
  const current = loadDaemonStatus(db);
  const stopped = await stopDaemon(db);

  if (!['stopped', 'not_running'].includes(stopped.status)) {
    return { status: 'restart_failed', phase: 'stop', previous_pid: current.pid ?? null, ...stopped };
  }

  const started = await startDaemon(db);
  if (!['started', 'already_running'].includes(started.status)) {
    return { status: 'restart_failed', phase: 'start', previous_pid: current.pid ?? null, ...started };
  }

  return { ...started, status: 'restarted', previous_pid: current.pid ?? null };
}

export async function cmdAdminDaemon(db, { verb } = {}) {
  if (verb === 'status') {
    return loadDaemonStatus(db);
  }

  if (verb === 'start') {
    return startDaemon(db);
  }

  if (verb === 'stop') {
    return stopDaemon(db);
  }

  if (verb === 'restart') {
    return restartDaemon(db);
  }

  if (verb === 'install') {
    return installDaemon();
  }

  if (verb === 'uninstall') {
    return uninstallDaemon();
  }

  throw new Error(`unsupported admin daemon verb: ${verb}`);
}
