import { loadConfig } from '../../lib/config.mjs';
import { argsSelectJson, extractUsage as extractEnvelopeUsage } from '../../lib/claude-p-usage.mjs';

// What claude -p prints on stderr when it is rate limited. claude-p.mjs reads a
// retry-after out of the same text.
export const RATE_LIMIT_PATTERN = /(rate limit|too many requests|\b429\b)/i;

// What claude prints when the subscription's usage limit is hit, e.g.
// "Claude AI usage limit reached|1760000000" or "5-hour limit reached ∙ resets 3pm".
const USAGE_LIMIT_PATTERN = /usage limit reached|limit reached.*resets/i;

// The result envelope's text, only when the envelope says it is an error.
function errorEnvelopeText(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '').trim());
    return parsed && typeof parsed === 'object' && parsed.is_error === true ? String(parsed.result ?? '') : null;
  } catch {
    return null;
  }
}

// The reset in a usage-limit message: a unix epoch after '|' (seconds), or a
// local clock time after "resets" (the next such time from now). null when
// neither is there.
export function parseClaudeResetAt(text, now = new Date()) {
  const source = String(text ?? '');
  const epoch = source.match(/usage limit reached\|(\d{9,})/i);
  if (epoch) {
    return Number(epoch[1]) * 1000;
  }
  const clock = source.match(/resets(?: at)? (\d{1,2})(?::(\d{2}))? ?(am|pm)/i);
  if (clock) {
    const hour = Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    const reset = new Date(now);
    reset.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (reset.getTime() <= now.getTime()) {
      reset.setDate(reset.getDate() + 1);
    }
    return reset.getTime();
  }
  return null;
}

// The wait a 429 asks for: its retry-after, or a minute when it names none;
// null when stderr is not a rate limit.
export function parseRetryAfterMs(stderr) {
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

// A rate limit asking for at least this long is a quota running out, not a
// burst: it is recorded as exhaustion (and may lead to a switch proposal). A
// shorter one just retries, as it always did.
const EXHAUSTED_RETRY_AFTER_MS = 300_000;

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

function resolveExtraArgs(llm, taskType) {
  if (!taskType) {
    return [];
  }

  const extra = llm?.claude_p_extra_args_per_task?.[taskType];
  return Array.isArray(extra) ? extra.map((arg) => String(arg)) : [];
}

export function resolveCommand(opts) {
  const llm = loadConfig().llm;
  const envArgs = parseArgsEnv(process.env.CCMEM_CLAUDE_P_ARGS_JSON);
  const suppliedArgs = Array.isArray(opts.args) ? opts.args : envArgs;
  const model = typeof opts.model === 'string' && opts.model ? opts.model : null;
  const configuredCommand = typeof llm?.commands?.claude === 'string' && llm.commands.claude
    ? llm.commands.claude
    : null;

  // Extra args (and a configured model) ride on the built-in argv only. A
  // caller that spells out argv -- including every integration test, which
  // substitutes a fake binary through CCMEM_CLAUDE_P_ARGS_JSON -- owns it
  // completely and gets nothing added.
  const baseArgs = suppliedArgs
    ?? ['-p', ...(model ? ['--model', model] : []), ...resolveExtraArgs(llm, opts.taskType), '--output-format', 'text'];

  return {
    command: opts.command ?? process.env.CCMEM_CLAUDE_P_COMMAND ?? configuredCommand ?? 'claude',
    args: withStructuredOutputArgs(baseArgs, opts.jsonSchema)
  };
}

export const claudeBackend = {
  id: 'claude',
  label: 'claude -p',
  // Keeps the daemon's cwd: claude -p stores each session under a directory
  // named after its cwd, so a per-call dir would create one per call in the
  // human's ~/.claude/projects.
  isolatedCwd: false,

  buildInvocation(prompt, { jsonSchema, taskType, model, command, args }) {
    const resolved = resolveCommand({ jsonSchema, taskType, model, command, args });
    return {
      command: resolved.command,
      args: resolved.args,
      env: {},
      stdin: String(prompt ?? ''),
      // Decided from the final argv, never from jsonSchema: an env-supplied
      // argv can select the JSON envelope on its own (claude-p-usage.mjs).
      outputFormat: argsSelectJson(resolved.args) ? 'json' : 'text'
    };
  },

  // Callers unwrap the result envelope themselves (llm-parse.mjs).
  readResult({ stdout }) {
    return stdout;
  },

  extractUsage({ stdout, outputFormat }) {
    return outputFormat === 'json'
      ? extractEnvelopeUsage(stdout)
      : { input_tokens: null, output_tokens: null, total_cost_usd: null };
  },

  // A short 429 is not exhaustion: claude-p.mjs turns its retry-after into
  // error.retryAfter as before. A long one, or a subscription usage limit, is
  // -- the latter with its reset when it prints one. Only stderr and an is_error result envelope are read: model
  // text that merely mentions a limit is not an exhaustion.
  classifyExhaustion({ stderr, stdout }) {
    const errText = String(stderr ?? '');
    const envelope = errorEnvelopeText(stdout);
    if (USAGE_LIMIT_PATTERN.test(errText) || (envelope != null && USAGE_LIMIT_PATTERN.test(envelope))) {
      return { exhausted: true, resetAt: parseClaudeResetAt(`${errText}\n${envelope ?? ''}`) };
    }
    const retryAfter = parseRetryAfterMs(errText);
    if (retryAfter != null && retryAfter >= EXHAUSTED_RETRY_AFTER_MS) {
      return { exhausted: true, resetAt: Date.now() + retryAfter };
    }
    return { exhausted: false, resetAt: null };
  }
};
