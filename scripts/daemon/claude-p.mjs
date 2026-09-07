import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { argsSelectJson, extractUsage } from '../lib/claude-p-usage.mjs';
import { recordDaemonCost } from '../lib/metrics.mjs';

const BLACKLIST_TTL_MS = 30 * 60 * 1000;

let tail = Promise.resolve();

function parseArgsEnv(raw) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((arg) => String(arg)) : null;
  } catch {
    return null;
  }
}

function withStructuredOutputArgs(args, jsonSchema) {
  if (!jsonSchema) {
    return args;
  }

  const nextArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--output-format' || arg === '--json-schema') {
      i += 1;
      continue;
    }
    nextArgs.push(arg);
  }

  nextArgs.push('--output-format', 'json', '--json-schema', JSON.stringify(jsonSchema));
  return nextArgs;
}

function resolveExtraArgs(taskType) {
  if (!taskType) {
    return [];
  }

  const extra = loadConfig().llm?.claude_p_extra_args_per_task?.[taskType];
  return Array.isArray(extra) ? extra.map((arg) => String(arg)) : [];
}

export function resolveCommand(opts) {
  const envArgs = parseArgsEnv(process.env.CCMEM_CLAUDE_P_ARGS_JSON);
  const suppliedArgs = Array.isArray(opts.args) ? opts.args : envArgs;

  // Extra args ride on the built-in argv only. A caller that spells out argv --
  // including every integration test, which substitutes a fake binary through
  // CCMEM_CLAUDE_P_ARGS_JSON -- owns it completely and gets nothing added.
  const baseArgs = suppliedArgs
    ?? ['-p', ...resolveExtraArgs(opts.taskType), '--output-format', 'text'];

  return {
    command: opts.command ?? process.env.CCMEM_CLAUDE_P_COMMAND ?? 'claude',
    args: withStructuredOutputArgs(baseArgs, opts.jsonSchema)
  };
}

function resolveTimeoutMs(opts) {
  const cfg = loadConfig();
  const raw = opts.timeoutMs
    ?? cfg.llm?.claude_p_timeout_per_task?.[opts.taskType]
    ?? process.env.CCMEM_CLAUDE_P_TIMEOUT_MS
    ?? 60000;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

function parseRetryAfterMs(stderr) {
  const text = String(stderr ?? '').trim();
  if (!/(rate limit|too many requests|\b429\b)/i.test(text)) {
    return null;
  }

  const match = text.match(/retry[- ]after[: ]+(\d+)(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i);
  if (!match) {
    return 60000;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 60000;
  }

  const unit = String(match[2] ?? 'ms').toLowerCase();
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minutes') {
    return value * 60000;
  }

  if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'seconds') {
    return value * 1000;
  }

  return value;
}

function registerBlacklistedSession(sessionId) {
  if (!sessionId) {
    return;
  }

  const now = Date.now();
  const db = openDb();

  try {
    db.prepare(
      `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
       VALUES (?, 'cron_llm_child', ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         reason = excluded.reason,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    ).run(sessionId, now, now + BLACKLIST_TTL_MS);
  } finally {
    db.close();
  }
}

function runClaudeP(prompt, opts, queuedAt) {
  const { command, args } = resolveCommand(opts);
  const timeoutMs = resolveTimeoutMs(opts);
  const tStart = Date.now();
  // Same clock libuv schedules the timeout on, on both macOS and Linux, so the
  // recorded elapsed is measured against the budget's own clock rather than
  // against the world. See the header of
  // tests/integration/v015-timeout-cost-visibility.test.mjs for what the pair
  // of numbers is able to tell apart.
  const tStartMono = performance.now();
  const outputFormat = argsSelectJson(args) ? 'json' : 'text';
  const childSessionId = opts.env?.CLAUDE_CODE_SESSION_ID ?? randomUUID();
  const childEnv = {
    ...process.env,
    ...opts.env,
    CLAUDE_CODE_SESSION_ID: childSessionId,
    CCMEM_INTERNAL: '1'
  };

  registerBlacklistedSession(childSessionId);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value, outcome) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      // Telemetry must never change control flow: recordDaemonCost swallows its
      // own failures, and this call sits before fn() only so a throw here could
      // not skip settling.
      recordDaemonCost({
        task_type: opts.taskType ?? null,
        output_format: outputFormat,
        queue_wait_ms: tStart - queuedAt,
        wall_clock_ms: Date.now() - tStart,
        // wall_clock_ms counts seconds the world spent; this counts seconds the
        // timer's clock spent. monotonic_ms ~= timeout_ms means the call used
        // its budget; monotonic_ms >> timeout_ms means the callback could not
        // run on time (a saturated machine); a large wall_clock_ms with a small
        // gap-free monotonic_ms means the clock itself stopped (suspend).
        monotonic_ms: Math.round(performance.now() - tStartMono),
        // The budget the timer was actually armed with, so a consumer can tell
        // a call the cap cut off (wall_clock_ms ~= timeout_ms) from one whose
        // timer was starved while the machine slept (wall_clock_ms >>
        // timeout_ms). timed_out alone conflates the two.
        timeout_ms: timeoutMs,
        // A killed call keeps no usage -- that lives in a result envelope it
        // never finished printing -- but it was still billed for what it
        // generated. This is the only surviving measure of that.
        stdout_chars: stdout.length,
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        ...(outputFormat === 'json'
          ? extractUsage(stdout)
          : { input_tokens: null, output_tokens: null, total_cost_usd: null })
      });

      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`claude -p timeout after ${timeoutMs}ms`), { exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => finish(reject, error, { exitCode: null, timedOut: false }));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, stdout, { exitCode: 0, timedOut: false });
        return;
      }

      const excerpt = stderr.trim().slice(0, 200);
      const error = new Error(`claude -p exit ${code}: ${excerpt}`);
      const retryAfter = parseRetryAfterMs(stderr);
      if (retryAfter != null) {
        error.retryAfter = retryAfter;
      }
      finish(reject, error, { exitCode: code, timedOut: false });
    });

    // A child that exits before the prompt is fully written takes the read end
    // of this pipe with it, and the in-flight write fails EPIPE. A stream that
    // emits 'error' with no listener throws, and nothing under scripts/ installs
    // a process.on('uncaughtException') -- so that throw would kill the daemon
    // in the middle of whatever task it was running. The production tasks table
    // carries six rows reading "daemon exited while this task was running".
    //
    // EPIPE is dropped rather than reported because it is the symptom, not the
    // cause: the child's own 'error'/'close' handler above settles this call
    // with the real exit reason. Any other stdin failure is genuinely unknown
    // and still has to settle the call rather than escape as a crash.
    child.stdin.on('error', (error) => {
      if (error?.code === 'EPIPE') {
        return;
      }
      finish(reject, error, { exitCode: null, timedOut: false });
    });

    child.stdin.end(String(prompt ?? ''));
  });
}

export function callClaudeP(prompt, opts = {}) {
  if (typeof opts.mockOutput === 'string') {
    return Promise.resolve(opts.mockOutput);
  }

  const queuedAt = Date.now();
  const run = () => runClaudeP(prompt, opts, queuedAt);
  const pending = tail.then(run, run);
  tail = pending.catch(() => {});
  return pending;
}
