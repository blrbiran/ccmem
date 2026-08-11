/**
 * Whether the effective argv selects claude -p's JSON envelope.
 *
 * This must be decided from the final args array, never from opts.jsonSchema:
 * resolveCommand() takes opts.args, then CCMEM_CLAUDE_P_ARGS_JSON, then the
 * text default, and either of the first two can select JSON on its own. Keying
 * off jsonSchema mis-records every env-var-driven invocation.
 */
export function argsSelectJson(args) {
  if (!Array.isArray(args)) {
    return false;
  }

  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '--output-format' && args[i + 1] === 'json') {
      return true;
    }
  }

  return false;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const EMPTY = { input_tokens: null, output_tokens: null, total_cost_usd: null };

/**
 * Token counts and cost off claude -p's result envelope.
 *
 * Deliberately separate from llm-parse.mjs: that module unwraps the envelope
 * and throws these fields away, which is correct for its callers. Every field
 * is null unless it is present AND numeric — the text path has no envelope at
 * all, and a zero here would silently understate the weekly cost rather than
 * reporting "not measured".
 */
export function extractUsage(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { ...EMPTY };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ...EMPTY };
  }

  return {
    input_tokens: finiteOrNull(parsed.usage?.input_tokens),
    output_tokens: finiteOrNull(parsed.usage?.output_tokens),
    total_cost_usd: finiteOrNull(parsed.total_cost_usd)
  };
}
