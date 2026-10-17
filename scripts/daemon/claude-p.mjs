import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getDataRoot } from '../lib/paths.mjs';
import { recordDaemonCost } from '../lib/metrics.mjs';
import { clearExhaustion, exhaustedError, exhaustedUntil, recordExhaustion, resolveActiveBackend } from './backend-state.mjs';
import { claudeBackend, RATE_LIMIT_PATTERN, resolveCommand } from './backends/claude.mjs';
import { codexBackend } from './backends/codex.mjs';
import { ompBackend } from './backends/omp.mjs';

const BLACKLIST_TTL_MS = 30 * 60 * 1000;

const BACKENDS = {
  claude: claudeBackend,
  codex: codexBackend,
  omp: ompBackend
};

let tail = Promise.resolve();

export { resolveCommand };

// The active backend (backend-state.mjs: the preferred one, or one the human
// approved while it is exhausted). An active codex/omp that is itself
// exhausted is not run: the call fails at once with a retryAfter that keeps
// the task queued until the reset. Claude is still run: its 429 hands back its
// own retry-after, which its retries have always followed (and which the
// rate-limit tests pin), so failing it early would only replace a known wait
// with a guessed one.
function resolveBackend(cfg) {
  const db = openDb();
  try {
    const now = Date.now();
    const id = resolveActiveBackend(db, cfg, now);
    const backend = BACKENDS[id];
    if (!backend) {
      throw new Error(`llm.backend '${id}' is not one of ${Object.keys(BACKENDS).join(', ')}`);
    }
    const until = exhaustedUntil(db, id, now);
    if (until != null && id !== 'claude') {
      throw exhaustedError(id, until, now);
    }
    return { backend, recordedExhausted: until != null };
  } finally {
    db.close();
  }
}

// Backend-state writes must not replace the call's own outcome (its error is
// what keeps the task queued): a failure is reported and yields null.
function withDb(work) {
  let db;
  try {
    db = openDb();
    return work(db);
  } catch (error) {
    process.stderr.write(`ccmem: could not update llm backend state (${error?.message ?? error})\n`);
    return null;
  } finally {
    db?.close();
  }
}

function configuredString(map, id) {
  const value = map?.[id];
  return typeof value === 'string' && value ? value : null;
}

// A fresh, private directory per call, used as an isolated backend's cwd: no
// repo, so no AGENTS.md / rules get loaded into a summarization, and a place
// for per-call files (Codex's last.txt and schema.json).
function makeWorkDir(backendId) {
  const root = path.join(getDataRoot(), 'tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(root, `llm-${backendId}-`));
}

function removeWorkDir(workDir) {
  if (!workDir) {
    return;
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`ccmem: could not remove ${workDir} (${error?.code ?? error?.message})\n`);
  }
}

function readOutputFile(file) {
  if (!file) {
    return null;
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// An exhausted backend's task waits until its recorded reset, and at least a
// minute, the same way a Claude 429 waits out its retry-after.
function retryAfterFromReset(resetAt) {
  const wait = resetAt == null ? 0 : resetAt - Date.now();
  return wait > 60000 ? wait : 60000;
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
  if (!RATE_LIMIT_PATTERN.test(text)) {
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
  const cfg = loadConfig();
  const { backend, recordedExhausted } = resolveBackend(cfg);
  const workDir = backend.isolatedCwd ? makeWorkDir(backend.id) : null;
  let invocation;
  try {
    invocation = backend.buildInvocation(prompt, {
      jsonSchema: opts.jsonSchema,
      taskType: opts.taskType,
      model: configuredString(cfg.llm?.models, backend.id),
      // Claude resolves its own command (caller, then CCMEM_CLAUDE_P_COMMAND,
      // then llm.commands.claude); the others have no env override.
      command: backend.id === 'claude' ? opts.command : (opts.command ?? configuredString(cfg.llm?.commands, backend.id)),
      args: opts.args,
      workDir
    });
  } catch (error) {
    removeWorkDir(workDir);
    throw error;
  }
  const { command, args, outputFormat } = invocation;
  const timeoutMs = resolveTimeoutMs(opts);
  const tStart = Date.now();
  // Same clock libuv schedules the timeout on, on both macOS and Linux, so the
  // recorded elapsed is measured against the budget's own clock rather than
  // against the world. See the header of
  // tests/integration/v015-timeout-cost-visibility.test.mjs for what the pair
  // of numbers is able to tell apart.
  const tStartMono = performance.now();
  const childEnv = {
    ...process.env,
    ...opts.env,
    ...invocation.env,
    CCMEM_INTERNAL: '1'
  };

  // Only a claude child is a Claude Code session whose own hooks could report
  // back to ccmem; blacklisting its id is that backend's second guard.
  if (backend.id === 'claude') {
    const childSessionId = opts.env?.CLAUDE_CODE_SESSION_ID ?? randomUUID();
    childEnv.CLAUDE_CODE_SESSION_ID = childSessionId;
    registerBlacklistedSession(childSessionId);
  } else {
    // An id inherited from whatever Claude session launched this process
    // (a CLI run, a test) is not this child's and must not travel with it.
    delete childEnv.CLAUDE_CODE_SESSION_ID;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(workDir ? { cwd: workDir } : {}),
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
      removeWorkDir(workDir);

      // Telemetry must never change control flow: recordDaemonCost swallows its
      // own failures, and this call sits before fn() only so a throw here could
      // not skip settling.
      recordDaemonCost({
        backend: backend.id,
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
        ...backend.extractUsage({ stdout, outputFormat })
      });

      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new Error(`${backend.label} timeout after ${timeoutMs}ms`);
      // loop.mjs retries on this flag, whichever backend timed out.
      error.timedOut = true;
      finish(reject, error, { exitCode: null, timedOut: true });
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
        // Read before finish(): finish removes the work dir the file lives in.
        let result;
        try {
          result = backend.readResult({ stdout, outputFileText: readOutputFile(invocation.outputFile) });
        } catch (error) {
          finish(reject, error, { exitCode: 0, timedOut: false });
          return;
        }
        if (recordedExhausted) {
          // It answered, so it is not exhausted after all: drop the record,
          // and with it the question put to the human.
          withDb((db) => clearExhaustion(db, backend.id));
        }
        finish(resolve, result, { exitCode: 0, timedOut: false });
        return;
      }

      const excerpt = stderr.trim().slice(0, 200);
      const error = new Error(`${backend.label} exit ${code}: ${excerpt}`);
      const exhaustion = backend.classifyExhaustion({ stderr, stdout, exitCode: code });
      if (exhaustion.exhausted) {
        error.exhaustion = { backend: backend.id, resetAt: exhaustion.resetAt };
      }
      // Claude keeps its retry-after parsing exactly. Its exhaustion is
      // recorded with no reset time (a 429 gives none), so it lasts
      // backend-state's default: long enough for an approved switch to be
      // worth making. The others wait until the recorded reset: the one they
      // reported, or that same default.
      let retryAfter = backend.id === 'claude' ? parseRetryAfterMs(stderr) : null;
      if (exhaustion.exhausted) {
        // Records the exhaustion and opens a switch proposal.
        const until = withDb((db) => recordExhaustion(db, backend.id, { resetAt: exhaustion.resetAt, error: excerpt, config: cfg }).exhaustedUntil);
        if (backend.id !== 'claude') {
          retryAfter = retryAfterFromReset(until ?? exhaustion.resetAt);
        }
      }
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

    child.stdin.end(invocation.stdin);
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
