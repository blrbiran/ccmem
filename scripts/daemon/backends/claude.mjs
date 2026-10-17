import { loadConfig } from '../../lib/config.mjs';
import { argsSelectJson, extractUsage as extractEnvelopeUsage } from '../../lib/claude-p-usage.mjs';

// What claude -p prints on stderr when it is rate limited. claude-p.mjs reads a
// retry-after out of the same text.
export const RATE_LIMIT_PATTERN = /(rate limit|too many requests|\b429\b)/i;

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

  // A 429 carries a relative retry-after, not a reset time; claude-p.mjs turns
  // it into error.retryAfter as before.
  classifyExhaustion({ stderr }) {
    return { exhausted: RATE_LIMIT_PATTERN.test(String(stderr ?? '')), resetAt: null };
  }
};
