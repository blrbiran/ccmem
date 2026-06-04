import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';

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

function resolveCommand(opts) {
  const envArgs = parseArgsEnv(process.env.CCMEM_CLAUDE_P_ARGS_JSON);
  const baseArgs = Array.isArray(opts.args) ? opts.args : (envArgs ?? ['-p', '--output-format', 'text']);

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

function runClaudeP(prompt, opts) {
  const { command, args } = resolveCommand(opts);
  const timeoutMs = resolveTimeoutMs(opts);
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

    const finish = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`claude -p timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, stdout);
        return;
      }

      const excerpt = stderr.trim().slice(0, 200);
      const error = new Error(`claude -p exit ${code}: ${excerpt}`);
      const retryAfter = parseRetryAfterMs(stderr);
      if (retryAfter != null) {
        error.retryAfter = retryAfter;
      }
      finish(reject, error);
    });

    child.stdin.end(String(prompt ?? ''));
  });
}

export function callClaudeP(prompt, opts = {}) {
  if (typeof opts.mockOutput === 'string') {
    return Promise.resolve(opts.mockOutput);
  }

  const run = () => runClaudeP(prompt, opts);
  const pending = tail.then(run, run);
  tail = pending.catch(() => {});
  return pending;
}
