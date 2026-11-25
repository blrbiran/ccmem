import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBackendState } from '../../daemon/backend-state.mjs';
import { clearStartHistory } from '../../daemon/crash-guard.mjs';
import { isLockRowAlive } from '../../daemon/lock.mjs';
import { loadConfig } from '../config.mjs';
import { QUEUE_OVERDUE_MS } from './cron.mjs';
import { lastWakeAt } from '../../daemon/wake.mjs';
import { DB_BUSY_TIMEOUT_MS, getDataRoot } from '../db.mjs';
import {
  comparePlist,
  EMPTY_LISTS,
  evaluateGates,
  parseEnvDict,
  parseProgramArguments,
  splitPlist
} from './plist-drift.mjs';

const DAEMON_MAIN = fileURLToPath(new URL('../../daemon/main.mjs', import.meta.url));
// launchd 对 KeepAlive job 的默认节流是 10s；把一个每 30s 就崩一次、每次都往
// daemon.err.log 追加一段 MODULE_NOT_FOUND 的进程改成每分钟一次，是这一侧
// 唯一不需要代码判断的减速手段。crash-guard 在 daemon 进程里另有硬上限。
const THROTTLE_INTERVAL_SECONDS = 60;

const LAUNCHD_LABEL = 'com.ccmem.daemon';
// daemon.err.log is launchd's StandardErrorPath, so the daemon cannot be asked
// to rotate it and a rename would leave the open fd writing to the moved file.
// The operator-invoked verb copies the tail aside and truncates in place: the
// fd stays the same file, and the next write lands at the new end.
const DEFAULT_LOG_KEEP_BYTES = 5 * 1024 * 1024;
const LOG_NOTICE_BYTES = 10 * 1024 * 1024;
const WAIT_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 2000;
// 启动等待与停止等待不同源。restart 是人为动作，没有任何外部截止时间约束它,
// 所以抬高的唯一代价是"真失败时多等 3 秒"；而 2000ms 不够一次冷启动，代价是把
// 一次成功的重启报成失败，并诱使操作者再重启一次。取值与本文件 PLIST_PROBE_TIMEOUT_MS
// 一致，理由也一致（见该常量附近那条注释）。bug-063 缺陷 1。
// 冷启动无法按需复现（当前 uptime 是热的），所以这个数是判断，不是测量出来的 ——
// 真正的安全网是 restart_failed 的可读消息，不是这个数字。
const START_WAIT_TIMEOUT_MS = 5000;
// 停止等待的被等方是 daemon 的 releaseDaemonLock —— 一条 DELETE，撞写锁时按开库时设的
// busy_timeout 等。等待方的预算必须**大于**它，否则 daemon 只是被别的写入方挡了一下，
// stop 就会在它删掉锁行之前放弃，把一次成功的 stop 报成 stop_timeout（形状同 bug-063
// 缺陷 1，当时只修了 start 一侧）。所以这个数从 DB_BUSY_TIMEOUT_MS 导出，而不是自己写一个
// —— 两个数各写各的正是上一次出问题的方式。
// ⚠️ 已知残余：SIGTERM 到达时 daemon 若正好卡在另一条同样被挡住的语句上（比如心跳 UPDATE），
// 两段 busy 等待会串起来，超过这个预算 —— 那种情况仍会报 stop_timeout，两条 stop 测试都不覆盖。
const STOP_WAIT_TIMEOUT_MS = DB_BUSY_TIMEOUT_MS + 1000;
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
  if (path.isAbsolute(command)) {
    return existsSync(command) ? command : null;
  }

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

// Backends the daemon may run: the active one plus every failover candidate.
// Only llm.backend is required at install; the rest are best effort.
function configuredBackends(cfg) {
  return uniq([cfg.llm?.backend ?? 'claude', ...(cfg.llm?.backend_order ?? [])]);
}

function backendCommandName(cfg, backend) {
  return cfg.llm?.commands?.[backend] ?? backend;
}

export function buildDaemonEnv(baseEnv = process.env, cfg = loadConfig()) {
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

  // codex / omp are found by PATH, not by an env pointer: put the directory of
  // each one that resolves on the daemon PATH. A missing one is left out here;
  // the install check decides whether that is fatal.
  for (const backend of configuredBackends(cfg)) {
    if (backend === 'claude') continue;
    const resolved = resolveCommandFromPath(backendCommandName(cfg, backend), daemonEnv.PATH);
    if (!resolved) continue;
    const binDir = path.dirname(resolved);
    if (!daemonEnv.PATH.split(path.delimiter).includes(binDir)) {
      daemonEnv.PATH = `${binDir}${path.delimiter}${daemonEnv.PATH}`;
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

// The caller's `claude` can be a session-scoped shim (cmux puts one first on
// PATH) that disappears with the terminal; writing it into the plist broke the
// daemon's claude -p on 2026-10-13. So an installed plist's command is kept
// unless the caller sets CCMEM_CLAUDE_P_COMMAND on purpose. Human ruling, Orca
// session 308b874c, 2026-10-20.
function installedClaudeCommand() {
  if (process.env.CCMEM_CLAUDE_P_COMMAND !== undefined || !isLaunchdInstalled()) {
    return {};
  }

  const parsed = parseEnvDict(splitPlist(readPlist()).envText);
  const command = parsed.ok ? parsed.env.CCMEM_CLAUDE_P_COMMAND : undefined;
  return command ? { CCMEM_CLAUDE_P_COMMAND: command } : {};
}

function buildLaunchdDaemonEnv(dataRoot) {
  return buildDaemonEnv({
    ...process.env,
    CCMEM_DATA_ROOT: dataRoot,
    ...installedClaudeCommand()
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

  // 探针没能跑起来（spawn 失败、超时）跟探针跑完了、答案是"不支持"是两件事：
  // 前者对能力一无所知。合成同一个否定，一次瞬时失败就伪装成永久的能力缺失，
  // 而重写被静默拦下 —— CLI 只打印 blocked_by/reason（cli.mjs:578）。
  if (result.error) {
    return {
      ok: false,
      indeterminate: true,
      reason: `resolved Claude Code binary at ${command} but could not inspect \`claude -p --help\` (${result.error.message}); this says nothing about whether it supports --json-schema`
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

const BACKEND_PROBES = {
  codex: { args: ['exec', '--help'], flag: '--ephemeral' },
  omp: { args: ['--help'], flag: '--no-extensions' }
};

// `--help` only, never a prompt. Returns { ok } or { ok: false, reason }.
function probeBackendCapability(backend, command, daemonEnv, timeoutMs) {
  const { args, flag } = BACKEND_PROBES[backend];
  const shown = `\`${backend} ${args.join(' ')}\``;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    env: { ...process.env, ...daemonEnv }
  });

  if (result.error) {
    return { ok: false, reason: `${backend} capability check failed: could not run ${shown} at ${command} (${result.error.message})` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `${backend} capability check failed: ${shown} at ${command} exited ${result.status}` };
  }
  if (!`${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes(flag)) {
    return { ok: false, reason: `${backend} capability check failed: ${command} does not support ${flag}` };
  }
  return { ok: true };
}

// Checks codex / omp. Returns { error, warnings }: a problem with llm.backend is
// the error, a problem with a failover-only backend is a warning.
function checkOtherBackends(cfg, daemonEnv) {
  const active = cfg.llm?.backend ?? 'claude';
  const warnings = [];
  for (const backend of configuredBackends(cfg)) {
    if (backend === 'claude') continue;
    const name = backendCommandName(cfg, backend);
    const command = resolveCommandFromPath(name, daemonEnv.PATH);
    let problem = null;
    if (!command) {
      problem = backend === active
        ? `could not resolve \`${name}\` for llm.backend=${backend} from the install shell PATH; install from a shell where ${backend} is available`
        : `${backend} not found; failover to ${backend} will not work`;
    } else if (BACKEND_PROBES[backend]) {
      const probed = probeBackendCapability(backend, command, daemonEnv);
      if (!probed.ok) problem = probed.reason;
    }
    if (!problem) continue;
    if (backend === active) return { error: problem, warnings };
    warnings.push(problem);
  }
  return { error: null, warnings };
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

function stderrLogPath() {
  return getDaemonPlistPaths(getDataRoot()).stderrPath;
}

// epoch-ms names the tail, and `wx` refuses to overwrite: two rotations in the
// same millisecond must produce two files, not one silently replaced tail.
function createUniqueTailFile(logPath) {
  let timestamp = Date.now();
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const tailPath = `${logPath}.${timestamp}.tail`;
    try {
      return { fd: openSync(tailPath, 'wx', 0o600), tailPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
    timestamp += 1;
  }

  throw new Error(`could not find an unused tail path next to ${logPath}`);
}

/**
 * Copy the last `keepBytes` of daemon.err.log to `<path>.<epoch-ms>.tail` and
 * truncate the live file in place. Never renames the live file: launchd and the
 * daemon hold an fd open, and a rename would keep every subsequent write going
 * into the renamed file while a fresh daemon.err.log sat empty.
 */
export function rotateDaemonLog({ keepBytes } = {}) {
  const logPath = stderrLogPath();
  const keep = keepBytes == null || keepBytes === ''
    ? DEFAULT_LOG_KEEP_BYTES
    : Number(keepBytes);

  if (!Number.isFinite(keep) || keep <= 0) {
    return {
      status: 'invalid_keep_bytes',
      path: logPath,
      keep_bytes: keepBytes ?? null,
      default_keep_bytes: DEFAULT_LOG_KEEP_BYTES
    };
  }

  let sourceFd;
  try {
    sourceFd = openSync(logPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'log_missing', path: logPath };
    }
    throw error;
  }

  let beforeBytes;
  let tail;
  try {
    beforeBytes = fstatSync(sourceFd).size;
    const start = Math.max(0, beforeBytes - keep);
    tail = Buffer.alloc(beforeBytes - start);
    if (tail.length > 0) {
      readSync(sourceFd, tail, 0, tail.length, start);
    }
  } finally {
    closeSync(sourceFd);
  }

  const { fd, tailPath } = createUniqueTailFile(logPath);
  try {
    if (tail.length > 0) {
      writeSync(fd, tail);
    }
  } finally {
    closeSync(fd);
  }

  truncateSync(logPath, 0);

  return {
    status: 'rotated',
    path: logPath,
    before_bytes: beforeBytes,
    kept_bytes: tail.length,
    tail_path: tailPath
  };
}

// Reported by `install` only. Rotation is the operator's call: the log is their
// data, so an oversized one is named, never shrunk behind their back.
function oversizedStderrLog() {
  const logPath = stderrLogPath();
  try {
    const { size } = statSync(logPath);
    return size > LOG_NOTICE_BYTES
      ? { path: logPath, size_bytes: size, default_keep_bytes: DEFAULT_LOG_KEEP_BYTES }
      : null;
  } catch {
    return null;
  }
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
  <key>ThrottleInterval</key><integer>${THROTTLE_INTERVAL_SECONDS}</integer>
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

// What launchd itself says about the job. An installed plist and a live lock
// do not prove launchd manages the process: from a sandbox (2026-10-20) a
// restart started a daemon launchd had no job for, reported "restarted", and
// nothing brought it back when it exited.
function readLaunchdJob() {
  const result = runLaunchctl(['print', `${getLaunchDomain()}/${LAUNCHD_LABEL}`]);
  if (result.status !== 0) {
    return { loaded: false, pid: null, last_exit_code: null, reason: launchctlError(result) };
  }
  const text = result.stdout ?? '';
  const pid = /^\s*pid = (\d+)\s*$/m.exec(text);
  const exitCode = /^\s*last exit code = (-?\d+)\s*$/m.exec(text);
  return {
    loaded: true,
    pid: pid ? Number(pid[1]) : null,
    last_exit_code: exitCode ? Number(exitCode[1]) : null,
    reason: null
  };
}

const LAUNCHD_JOB_ABSENT_HINT = `no ${LAUNCHD_LABEL} job in launchd; run \`ccmem admin daemon install\` from a normal terminal (not a sandbox)`;

function isLaunchdInstalled() {
  return existsSync(getLaunchAgentPath());
}

function readPlist() {
  return readFileSync(getLaunchAgentPath(), 'utf8');
}

function isRegularFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// ProgramArguments 里除了选项（以 - 开头）以外都是 launchd 将来要 exec 的路径。
// 这里不做 PATH 解析：模板写进去的永远是绝对路径，相对路径在 launchd 的 cwd（/）
// 下本来就找不到，按"缺"处理才是实话。
export function findMissingProgramFiles(programArgs) {
  if (!Array.isArray(programArgs)) return [];
  const missing = [];
  for (const arg of programArgs) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue;
    if (!isRegularFile(arg)) missing.push(arg);
  }
  return missing;
}

function programMissingReason(missing) {
  const currentRepo = path.dirname(path.dirname(DAEMON_MAIN));
  const names = missing.map((candidate) => `\`${candidate}\``).join(', ');
  return `ProgramArguments names ${names}, which ${missing.length === 1 ? 'does not' : 'do not'} exist; if the ccmem repository moved, run \`ccmem admin daemon uninstall && ccmem admin daemon install\` from the current checkout (${currentRepo})`;
}

function installedProgramArguments() {
  const parsed = splitPlist(readPlist()).programArgs;
  return parseProgramArguments(parsed);
}

// install 写盘前 / restart 动 launchd 前调用。返回 null 表示没有可校验的
// ProgramArguments（未安装、或不是本构建能读的形状），否则 { ok, missing }。
function checkInstalledProgramArguments() {
  if (!isLaunchdInstalled()) return null;
  const args = installedProgramArguments();
  if (args == null) return null;
  const missing = findMissingProgramFiles(args);
  return { ok: missing.length === 0, missing };
}

function programMissingResult(missing) {
  return {
    status: 'program_missing',
    missing_paths: missing,
    reason: programMissingReason(missing)
  };
}

// `ccmem admin diagnose` 的 failure 判据：已装的 plist 指向不存在的程序，
// 或 launchd 自己报的 last exit code 非零。未安装时不是失败（doctor 常在没有
// launchd 的环境里跑）。
export function describeInstalledPlistHealth() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { installed: false, path: plistPath, ok: true, problems: [] };
  }

  const programArguments = installedProgramArguments() ?? [];
  const missingPaths = findMissingProgramFiles(programArguments);
  const job = readLaunchdJob();
  const problems = [];

  if (missingPaths.length) {
    problems.push(programMissingReason(missingPaths));
  }
  if (job.loaded && job.last_exit_code != null && job.last_exit_code !== 0) {
    problems.push(`launchd reports last exit code ${job.last_exit_code} for ${LAUNCHD_LABEL}`);
  }

  return {
    installed: true,
    path: plistPath,
    program_arguments: programArguments,
    missing_paths: missingPaths,
    launchd: job,
    problems,
    ok: problems.length === 0
  };
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
    alive: isLockRowAlive(lock),
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
  const cfg = loadConfig();
  const claudeRequired = (cfg.llm?.backend ?? 'claude') === 'claude';
  const warnings = [];

  if (!claudeCommand && claudeRequired) {
    return {
      status: 'version_check_failed',
      plist_path: plistPath,
      reason: 'could not resolve `claude` from the install shell PATH; install from a shell where Claude Code is available'
    };
  }

  if (!claudeCommand) {
    warnings.push('claude not found; failover to claude will not work');
  } else {
    const capability = probeClaudeJsonSchemaSupport(claudeCommand, daemonEnv);
    if (!capability.ok) {
      if (claudeRequired) {
        return {
          status: 'version_check_failed',
          plist_path: plistPath,
          reason: capability.reason
        };
      }
      warnings.push(capability.reason);
    }
  }

  const others = checkOtherBackends(cfg, daemonEnv);
  if (others.error) {
    return {
      status: 'version_check_failed',
      plist_path: plistPath,
      reason: others.error
    };
  }
  warnings.push(...others.warnings);

  const nodePath = resolveInstallNodePath(process.env);
  const missing = findMissingProgramFiles(buildLaunchdProgramArguments(nodePath));
  if (missing.length) {
    return { ...programMissingResult(missing), plist_path: plistPath };
  }

  const stderrLog = oversizedStderrLog();

  mkdirSync(getLaunchAgentDir(), { recursive: true });
  writeFileSync(plistPath, renderPlist());
  // An explicit install is a fresh operator intent: a start history left by a
  // crash loop must not keep the new job from starting for the rest of the hour.
  clearStartHistory();

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
      pid: child.pid,
      ...(warnings.length ? { warnings } : {}),
      ...(stderrLog ? { stderr_log: stderrLog } : {})
    };
  }

  clearFallbackWrapperFiles();
  clearInstallState();
  return {
    status: 'installed',
    plist_path: plistPath,
    plist: readPlist(),
    ...(warnings.length ? { warnings } : {}),
    ...(stderrLog ? { stderr_log: stderrLog } : {})
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

    if (!started) {
      return { status: 'start_timeout', via: 'launchctl' };
    }

    const job = readLaunchdJob();
    if (!job.loaded || (job.pid != null && job.pid !== started.pid)) {
      const seen = job.loaded ? `launchd runs pid=${job.pid}` : job.reason;
      return { ...started, status: 'started_unmanaged', via: 'launchctl', launchd_job: 'absent', reason: `${LAUNCHD_JOB_ABSENT_HINT} (${seen})` };
    }

    return { status: 'started', via: 'launchctl', ...started };
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

/**
 * Tester #460: stop signals only what it can prove is this store's daemon. A global.db restored or copied from elsewhere
 * carries another host's or another process's pid in its lock row; a launchd job is global (one label per user) and may
 * serve another data root. Returns the refusal reason, or null when stopping is safe.
 */
function lockRowRefusal(current) {
  // A pid with no live process here is a stale row: the ESRCH path below clears it, whichever host wrote it.
  if (!current.pid || !isProcessAlive(current.pid)) return null;
  if (current.hostname && current.hostname !== os.hostname()) {
    return `the lock row names pid ${current.pid} on host ${current.hostname}, not ${os.hostname()}: this store was copied or is shared, and pid ${current.pid} here is some other process; nothing was signalled`;
  }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(current.pid)], { encoding: 'utf8' });
  const command = ps.status === 0 ? ps.stdout.trim() : '';
  if (command === '') return `cannot read the command of pid ${current.pid} to check it is a ccmem daemon; nothing was signalled (run from a normal terminal, not a sandbox)`;
  if (!command.includes('daemon/main.mjs')) return `pid ${current.pid} is not a ccmem daemon (${command.slice(0, 120)}); nothing was signalled`;
  return null;
}

function launchdDataRootRefusal() {
  let plist;
  try { plist = readPlist(); } catch { return null; }
  const match = plist.match(/<key>CCMEM_DATA_ROOT<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) return null;
  const served = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const here = getDataRoot();
  if (path.resolve(served) === path.resolve(here)) return null;
  return `the installed launchd daemon serves ${served}, not ${here}; nothing was booted out`;
}

async function stopDaemon(db, { checkLaunchdRoot = false } = {}) {
  const current = loadDaemonStatus(db);

  if (isFallbackInstalled()) {
    const hadWrapper = stopFallbackWrapper();
    const stopped = await waitFor(() => {
      const lock = db.prepare(`SELECT 1 FROM daemon_lock WHERE id = 1`).get();
      return lock ? null : true;
    }, STOP_WAIT_TIMEOUT_MS);

    clearFallbackWrapperFiles();
    if (stopped) {
      return { status: hadWrapper ? 'stopped' : 'not_running', via: 'wrapper', ...current };
    }

    return { status: 'stop_timeout', via: 'wrapper', ...current };
  }

  if (isLaunchdInstalled()) {
    // `daemon stop` and `daemon restart` check the plist's data root (tester #460).
    const refusal = checkLaunchdRoot ? launchdDataRootRefusal() : null;
    if (refusal) return { ...current, status: 'refused', via: 'launchctl', reason: refusal };
    const error = bootoutDaemon();
    if (error) {
      if (!readLaunchdJob().loaded) {
        return { ...current, ...error, launchd_job: 'absent', reason: `${LAUNCHD_JOB_ABSENT_HINT} (bootout: ${error.reason})` };
      }
      return { ...current, ...error };
    }

    return { status: current.pid ? 'stopped' : 'not_running', via: 'launchctl', ...current };
  }

  if (!current.pid) {
    return { status: 'not_running', ...current };
  }

  const refusal = lockRowRefusal(current);
  if (refusal) return { ...current, status: 'refused', reason: refusal };

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
  }, STOP_WAIT_TIMEOUT_MS);

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
  // Verify before stopping anything: an installed plist whose program has moved
  // is the shape launchd keeps restarting into daemon.err.log. Refusing here
  // leaves the plist, the lock and the logs untouched and names the dead path,
  // instead of booting out a job that cannot come back.
  const programCheck = checkInstalledProgramArguments();
  if (programCheck && !programCheck.ok) {
    return { ...programMissingResult(programCheck.missing), phase: 'check', plist_rewrite: null };
  }

  const current = loadDaemonStatus(db);
  const stopped = await stopDaemon(db, { checkLaunchdRoot: true });

  // Tester #460: a refusal is reported as itself (`daemon restart refused — …`, exit 1), not as a failed stop phase.
  if (stopped.status === 'refused') return { ...stopped, phase: 'stop', previous_pid: current.pid ?? null };
  if (!['stopped', 'not_running'].includes(stopped.status)) {
    return { ...stopped, status: 'restart_failed', failed_status: stopped.status, phase: 'stop', previous_pid: current.pid ?? null };
  }

  const rewrite = rewritePlistIfAllowed();
  clearStartHistory();

  const started = await startDaemon(db);
  if (!['started', 'already_running'].includes(started.status)) {
    return { ...started, status: 'restart_failed', failed_status: started.status, phase: 'start', previous_pid: current.pid ?? null, plist_rewrite: rewrite };
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

// Tester #445: a live daemon whose every summarize_pending run fails (backend
// exit 1) looked healthy for weeks. Read the outcome straight from `tasks`; no
// LLM probe (it would cost money). Successful rows are 'success' since #444;
// older stores also hold 'completed', which counts the same.
// The real store holds millions of task rows (mostly vec_backfill) and no index serves this question: the
// unbounded scan took 24.68 s there. Only the newest EXTRACTION_SCAN_ROWS rows by rowid are read (0.36 s,
// same answers); when the table is larger than that, `scanned_rows` says how far the answer reaches.
const EXTRACTION_SCAN_ROWS = 200000;

export function describeExtractionHealth(db, now = Date.now(), scanRows = EXTRACTION_SCAN_ROWS) {
  const floor = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM tasks').get().n) - scanRows;
  const lastSuccess = db.prepare(
    `SELECT finished_at AS at FROM tasks
     WHERE id > ? AND type = 'summarize_pending' AND status IN ('success', 'completed')
     ORDER BY id DESC LIMIT 1`
  ).get(floor);
  const failed24h = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE id > ? AND type = 'summarize_pending' AND status = 'failed' AND finished_at >= ?`
  ).get(floor, now - 24 * 60 * 60 * 1000);
  const lastFailed = db.prepare(
    `SELECT error_excerpt FROM tasks
     WHERE id > ? AND type = 'summarize_pending' AND status = 'failed'
     ORDER BY id DESC LIMIT 1`
  ).get(floor);
  // Tester #496: a summarize task with no transcript could only ever be recorded
  // 'success', so "nothing was extracted" and "extraction worked" read the same.
  // The task is 'skipped' now; both counts come straight from the rows they name,
  // so a store full of them can no longer look green.
  const skipped24h = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE id > ? AND type = 'summarize_pending' AND status = 'skipped' AND finished_at >= ?`
  ).get(floor, now - 24 * 60 * 60 * 1000);
  // The audit also covers bad payloads that older builds recorded as successes.
  const badPayload24h = db.prepare(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE action = 'summarize_pending_bad_payload' AND ts >= ?`
  ).get(now - 24 * 60 * 60 * 1000);
  return {
    last_success_at: lastSuccess?.at ?? null,
    failed_24h: Number(failed24h?.n ?? 0),
    skipped_24h: Number(skipped24h?.n ?? 0),
    bad_payload_24h: Number(badPayload24h?.n ?? 0),
    last_error: lastFailed ? String(lastFailed.error_excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    scanned_rows: floor > 0 ? scanRows : null
  };
}

// Tester #475: "queued" alone could not tell a task waiting out the idle sleep from one the daemon
// would never pick up. Age of the oldest due task plus the age of the last wake; `overdue` uses the
// same threshold as `admin cron --issues`. Bounded like describeExtractionHealth: `tasks` has no
// index on status, and an unbounded scan of the real store took 24.68 s.
export function describeQueue(db, now = Date.now(), scanRows = EXTRACTION_SCAN_ROWS) {
  const floor = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM tasks').get().n) - scanRows;
  const row = db.prepare(
    `SELECT COUNT(*) AS n, MIN(scheduled_for) AS oldest FROM tasks
     WHERE id > ? AND status = 'queued' AND scheduled_for <= ?`
  ).get(floor, now);
  const due = Number(row?.n ?? 0);
  const oldestAgeMs = due > 0 ? Math.max(0, now - Number(row.oldest)) : null;
  const wakeAt = lastWakeAt();
  return {
    due,
    oldest_age_ms: oldestAgeMs,
    overdue: oldestAgeMs !== null && oldestAgeMs >= QUEUE_OVERDUE_MS,
    last_wake_age_ms: wakeAt === null ? null : Math.max(0, Math.round(now - wakeAt)),
    scanned_rows: floor > 0 ? scanRows : null
  };
}

export async function cmdAdminDaemon(db, { verb, keepBytes } = {}) {
  if (verb === 'status') {
    const status = loadDaemonStatus(db);
    // Which backend runs LLM work, and any exhaustion or switch waiting for
    // the human (spec G5: visible in the existing status output).
    return {
      ...status,
      plist_drift: describePlistDrift(),
      llm: describeBackendState(db, loadConfig()),
      extraction: describeExtractionHealth(db),
      queue: describeQueue(db)
    };
  }

  if (verb === 'start') {
    return startDaemon(db);
  }

  if (verb === 'stop') {
    return stopDaemon(db, { checkLaunchdRoot: true });
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

  if (verb === 'rotate-log') {
    return rotateDaemonLog({ keepBytes });
  }

  throw new Error(`unsupported admin daemon verb: ${verb}`);
}
