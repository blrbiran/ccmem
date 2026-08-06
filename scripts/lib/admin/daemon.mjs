import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDaemonAlive } from '../../daemon/lock.mjs';
import { loadConfig } from '../config.mjs';
import { getDataRoot } from '../db.mjs';
import { comparePlist, EMPTY_LISTS, evaluateGates, parseEnvDict, splitPlist } from './plist-drift.mjs';

const DAEMON_MAIN = fileURLToPath(new URL('../../daemon/main.mjs', import.meta.url));
const LAUNCHD_LABEL = 'com.ccmem.daemon';
const WAIT_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 2000;
// 启动等待与停止等待不同源。restart 是人为动作，没有任何外部截止时间约束它,
// 所以抬高的唯一代价是"真失败时多等 3 秒"；而 2000ms 不够一次冷启动，代价是把
// 一次成功的重启报成失败，并诱使操作者再重启一次。取值与本文件 PLIST_PROBE_TIMEOUT_MS
// 一致，理由也一致（见该常量附近那条注释）。bug-063 缺陷 1。
// 冷启动无法按需复现（当前 uptime 是热的），所以这个数是判断，不是测量出来的 ——
// 真正的安全网是 restart_failed 的可读消息，不是这个数字。
const START_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
export const DAEMON_ENV_PASSTHROUGH = [
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

export function buildDaemonEnv(baseEnv = process.env) {
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
    'CCMEM_CLAUDE_P_TIMEOUT_MS',
    // Without this the daemon's loadConfig() silently falls back to DEFAULT_CONFIG
    // while the CLI and hooks read the operator's file, so the two processes derive
    // different embedding signatures and semantic retrieval degrades to lexical with
    // nothing reported. The file is the only channel for the key too, which is why
    // provider API keys deliberately stay off this list (see the daemon env test).
    'CCMEM_CONFIG_PATH'
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

function uniq(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function resolveInstallNodePath(baseEnv = process.env, cfg = loadConfig()) {
  const configured = cfg.daemon?.platform_install_fallback_node_paths ?? [];
  const candidates = uniq([
    baseEnv.CCMEM_INSTALL_NODE_PATH,
    ...configured,
    process.execPath
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.execPath;
}

export { resolveInstallNodePath };

function buildLaunchdProgramArguments(nodePath) {
  return [nodePath, '--no-warnings', '--experimental-sqlite', DAEMON_MAIN];
}

function renderProgramArguments(args) {
  return args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
}

function getInstallStatePath() {
  return path.join(getDataRoot(), 'daemon-install-state.json');
}

function getWrapperScriptPath() {
  return path.join(getDataRoot(), 'daemon-wrapper.sh');
}

function getWrapperPidPath() {
  return path.join(getDataRoot(), 'daemon-wrapper.pid');
}

function readInstallState() {
  if (!existsSync(getInstallStatePath())) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(getInstallStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeInstallState(state) {
  mkdirSync(getDataRoot(), { recursive: true });
  writeFileSync(getInstallStatePath(), JSON.stringify(state));
}

function clearInstallState() {
  rmSync(getInstallStatePath(), { force: true });
}

function readWrapperPid() {
  if (!existsSync(getWrapperPidPath())) {
    return null;
  }

  const value = Number.parseInt(readFileSync(getWrapperPidPath(), 'utf8').trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderFallbackWrapper(nodePath, outPath, errPath) {
  return `#!/bin/sh
# ccmem daemon wrapper (container fallback) — auto-generated, do not edit
while true; do
  "${nodePath}" --no-warnings --experimental-sqlite "${DAEMON_MAIN}" >> "${outPath}" 2>> "${errPath}"
  sleep 10
done
`;
}

function writeFallbackWrapper(nodePath) {
  const dataRoot = getDataRoot();
  const { stdoutPath, stderrPath } = getDaemonPlistPaths(dataRoot);
  const wrapperPath = getWrapperScriptPath();

  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(wrapperPath, renderFallbackWrapper(nodePath, stdoutPath, stderrPath), { mode: 0o755 });
  return wrapperPath;
}

function clearFallbackWrapperFiles() {
  rmSync(getWrapperPidPath(), { force: true });
  rmSync(getWrapperScriptPath(), { force: true });
}

function isFallbackInstalled() {
  return readInstallState()?.variant === 'container-fallback';
}

function shouldUseContainerFallback(reason) {
  return /Failed to connect to bus|No such file or directory|ENOENT|not found/i.test(reason);
}

function spawnDetachedDaemon(nodePath = process.execPath) {
  const child = spawn(nodePath, ['--no-warnings', '--experimental-sqlite', DAEMON_MAIN], {
    detached: true,
    stdio: 'ignore',
    env: buildSpawnDaemonEnv()
  });
  child.unref();
  return child;
}

function spawnFallbackWrapper(nodePath = process.execPath) {
  const wrapperPath = writeFallbackWrapper(nodePath);
  const child = spawn('sh', [wrapperPath], {
    detached: true,
    stdio: 'ignore',
    env: buildSpawnDaemonEnv()
  });
  child.unref();
  writeFileSync(getWrapperPidPath(), `${child.pid}`);
  return child;
}

function stopFallbackWrapper() {
  const wrapperPid = readWrapperPid();
  if (!wrapperPid) {
    clearFallbackWrapperFiles();
    return false;
  }

  try {
    process.kill(-wrapperPid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }

  return true;
}

function fallbackNodePath() {
  return readInstallState()?.node_path ?? resolveInstallNodePath(process.env);
}

function probeClaudeJsonSchemaSupport(command, daemonEnv, timeoutMs) {
  const result = spawnSync(command, ['-p', '--help'], {
    encoding: 'utf8',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
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

function renderDaemonPlist(dataRoot, daemonEnv, nodePath = process.execPath) {
  const paths = getDaemonPlistPaths(dataRoot);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${renderProgramArguments(buildLaunchdProgramArguments(nodePath))}
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

export function renderPlist() {
  const dataRoot = getDataRoot();
  const daemonEnv = buildLaunchdDaemonEnv(dataRoot);
  const nodePath = resolveInstallNodePath(process.env);

  return renderDaemonPlist(dataRoot, daemonEnv, nodePath);
}

export { getLaunchAgentPath };

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
  const startupSchemaRow = db.prepare(
    `SELECT value
     FROM config_kv
     WHERE key = 'daemon_startup_schema_version'`
  ).get();
  const startupSchemaVersion = startupSchemaRow?.value == null ? null : Number(startupSchemaRow.value);
  const installState = readInstallState();
  const wrapperPid = readWrapperPid();
  const wrapperAlive = isProcessAlive(wrapperPid);

  return {
    alive: isDaemonAlive(db),
    pid: lock?.holder_pid ?? null,
    hostname: lock?.hostname ?? null,
    acquired_at: lock?.acquired_at ?? null,
    heartbeat_at: lock?.heartbeat_at ?? null,
    heartbeat_age_ms: lock ? Math.max(0, Date.now() - lock.heartbeat_at) : null,
    startup_schema_version: Number.isFinite(startupSchemaVersion) ? startupSchemaVersion : null,
    uptime_sec: lock?.acquired_at ? Math.max(0, Math.floor((Date.now() - lock.acquired_at) / 1000)) : null,
    running_task: loadRunningTask(db),
    install_variant: installState?.variant ?? null,
    install_source: installState?.source ?? null,
    wrapper_pid: wrapperPid,
    wrapper_alive: wrapperAlive,
    stale_pid: wrapperPid && !wrapperAlive ? wrapperPid : null
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

export function maybeRespawnContainerFallback(db) {
  const status = loadDaemonStatus(db);
  if (status.install_variant !== 'container-fallback' || status.alive || !status.stale_pid) {
    return false;
  }

  spawnFallbackWrapper(fallbackNodePath());
  return true;
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

  const nodePath = resolveInstallNodePath(process.env);

  mkdirSync(getLaunchAgentDir(), { recursive: true });
  writeFileSync(plistPath, renderPlist());

  const bootstrapError = bootstrapDaemon();
  if (bootstrapError) {
    if (!shouldUseContainerFallback(bootstrapError.reason)) {
      return {
        status: 'install_failed',
        plist_path: plistPath,
        reason: bootstrapError.reason
      };
    }

    const child = spawnFallbackWrapper(nodePath);
    writeInstallState({ variant: 'container-fallback', source: 'wrapper', node_path: nodePath });
    return {
      status: 'installed',
      plist_path: plistPath,
      plist: readPlist(),
      variant: 'linux/container-fallback',
      pid: child.pid
    };
  }

  clearFallbackWrapperFiles();
  clearInstallState();
  return {
    status: 'installed',
    plist_path: plistPath,
    plist: readPlist()
  };
}

async function uninstallDaemon(db) {
  const plistPath = getLaunchAgentPath();
  const fallbackInstalled = isFallbackInstalled();

  if (!existsSync(plistPath) && !fallbackInstalled) {
    return { status: 'not_installed', plist_path: plistPath };
  }

  if (fallbackInstalled) {
    const stopped = await stopDaemon(db);
    if (!['stopped', 'not_running'].includes(stopped.status)) {
      return {
        status: 'uninstall_failed',
        plist_path: plistPath,
        reason: `fallback daemon ${stopped.status}`
      };
    }
    clearFallbackWrapperFiles();
    clearInstallState();
  }

  if (existsSync(plistPath)) {
    const result = runLaunchctl(['bootout', getLaunchDomain(), plistPath]);
    if (![0, 3].includes(result.status ?? 1) && !fallbackInstalled) {
      return {
        status: 'uninstall_failed',
        plist_path: plistPath,
        reason: launchctlError(result)
      };
    }
  }

  clearFallbackWrapperFiles();
  clearInstallState();
  rmSync(plistPath, { force: true });
  return { status: 'uninstalled', plist_path: plistPath };
}

async function startDaemon(db) {
  const current = loadDaemonStatus(db);
  if (current.alive) {
    return { status: 'already_running', ...current };
  }

  if (isFallbackInstalled()) {
    const child = spawnFallbackWrapper(fallbackNodePath());
    const started = await waitFor(() => {
      const next = loadDaemonStatus(db);
      return next.alive && next.wrapper_pid === child.pid ? next : null;
    }, START_WAIT_TIMEOUT_MS);

    return started
      ? { status: 'started', via: 'wrapper', ...started }
      : { status: 'start_timeout', via: 'wrapper', pid: child.pid, alive: false, running_task: null, install_variant: 'container-fallback' };
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
    }, START_WAIT_TIMEOUT_MS);

    return started ? { status: 'started', via: 'launchctl', ...started } : { status: 'start_timeout', via: 'launchctl' };
  }

  const child = spawnDetachedDaemon(process.execPath);

  const started = await waitFor(() => {
    const next = loadDaemonStatus(db);
    return next.alive && next.pid === child.pid ? next : null;
  }, START_WAIT_TIMEOUT_MS);

  return started
    ? { status: 'started', via: 'spawn', ...started }
    : { status: 'start_timeout', via: 'spawn', pid: child.pid, alive: false, running_task: null };
}

async function stopDaemon(db) {
  const current = loadDaemonStatus(db);

  if (isFallbackInstalled()) {
    const hadWrapper = stopFallbackWrapper();
    const stopped = await waitFor(() => {
      const lock = db.prepare(`SELECT 1 FROM daemon_lock WHERE id = 1`).get();
      return lock ? null : true;
    });

    clearFallbackWrapperFiles();
    if (stopped) {
      return { status: hadWrapper ? 'stopped' : 'not_running', via: 'wrapper', ...current };
    }

    return { status: 'stop_timeout', via: 'wrapper', ...current };
  }

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

// 本地进程启动，量级远低于此；restart 是人为动作，宁可等也不要误判。
// 这个值是设计决定，不是实测导出的。不进配置 —— 新增配置项就是新增一个
// 可与代码分歧的面（Finding 12 的形状）。
const PLIST_PROBE_TIMEOUT_MS = 5000;

function rewritePlistIfAllowed() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { written: false, blocked_by: null, reason: 'daemon is not installed under launchd' };
  }

  const onDisk = readFileSync(plistPath, 'utf8');
  const expected = renderPlist();
  if (onDisk === expected) {
    return { written: false, blocked_by: null, reason: 'plist already matches the current environment' };
  }

  const oldEnv = parseEnvDict(splitPlist(onDisk).envText);
  const newEnv = parseEnvDict(splitPlist(expected).envText);
  if (!oldEnv.ok || !newEnv.ok) {
    return { written: false, blocked_by: 'unparsable', reason: 'the installed plist is not in a shape this build can read; leaving it alone' };
  }

  const verdict = evaluateGates(oldEnv.env, newEnv.env, {
    defaultDataRoot: getDataRoot(),
    probe: (command, env) => probeClaudeJsonSchemaSupport(command, env, PLIST_PROBE_TIMEOUT_MS)
  });
  if (!verdict.ok) {
    return { written: false, blocked_by: verdict.blocked_by, reason: verdict.reason };
  }

  writeFileSync(plistPath, expected);
  return { written: true, blocked_by: null, reason: 'plist regenerated from the current environment' };
}

async function restartDaemon(db) {
  const current = loadDaemonStatus(db);
  const stopped = await stopDaemon(db);

  if (!['stopped', 'not_running'].includes(stopped.status)) {
    return { ...stopped, status: 'restart_failed', phase: 'stop', previous_pid: current.pid ?? null };
  }

  const rewrite = rewritePlistIfAllowed();

  const started = await startDaemon(db);
  if (!['started', 'already_running'].includes(started.status)) {
    return { ...started, status: 'restart_failed', phase: 'start', previous_pid: current.pid ?? null, plist_rewrite: rewrite };
  }

  return { ...started, status: 'restarted', previous_pid: current.pid ?? null, plist_rewrite: rewrite };
}

// 检测不启子进程 —— 探针只属于门禁。这就是 status 能顺带报 drift 的原因。
function describePlistDrift() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { status: 'not_installed', ...EMPTY_LISTS };
  }

  const onDisk = readFileSync(plistPath, 'utf8');
  const expected = renderPlist();
  if (onDisk === expected) {
    return { status: 'in_sync', ...EMPTY_LISTS };
  }

  return comparePlist(onDisk, expected);
}

export async function cmdAdminDaemon(db, { verb } = {}) {
  if (verb === 'status') {
    const status = loadDaemonStatus(db);
    return { ...status, plist_drift: describePlistDrift() };
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
    return uninstallDaemon(db);
  }

  throw new Error(`unsupported admin daemon verb: ${verb}`);
}
