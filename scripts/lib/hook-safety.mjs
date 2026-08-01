import { recordMetric } from './metrics.mjs';

/**
 * Per-hook budgets, exported so hooks.json can be checked against them.
 *
 * A budget is the point at which ccmem gives up and returns an empty context.
 * The harness timeout in hooks.json must be strictly larger, or the process is
 * killed before the graceful path can write stdout and its metrics row.
 *
 * Read the limitation below before trusting these numbers: the budget only
 * bounds ASYNC work. It cannot interrupt a synchronous run, and ccmem's hooks
 * are mostly synchronous — node:sqlite is a synchronous API and the stop hook
 * reads the whole transcript before touching the database. Measured: the stop
 * hook exceeded its 200ms budget in 50.2% of 2547 runs and recorded a timeout
 * in exactly none of them. So the harness timeout is not merely a backstop
 * behind the budget — for synchronous work it is the ONLY limit, and it has to
 * be sized against the work's real p99, not against the budget.
 */
export const HOOK_BUDGET_MS = {
  session_start: 200,
  prompt_submit: 2000,
  stop: 200
};

/** Kept for callers that import the prompt-submit budget by name. */
export const PROMPT_SUBMIT_BUDGET_MS = HOOK_BUDGET_MS.prompt_submit;

const HOOK_EVENT_NAMES = {
  session_start: 'SessionStart',
  prompt_submit: 'UserPromptSubmit'
};

function buildHookPayload(hookName, result) {
  if (hookName === 'stop' || hookName === 'session_end') {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAMES[hookName],
      additionalContext: result.additionalContext ?? ''
    }
  };
}

export async function withHookSafety(hookName, timeoutMs, fn, tEntry = process.hrtime.bigint()) {
  const tBusinessStart = process.hrtime.bigint();
  let result;

  try {
    result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
  } catch (error) {
    process.stderr.write(`ccmem: ${hookName} failed (${error.message})\n`);
    result = { additionalContext: '', _error: error.message };
  }

  const tBusinessEnd = process.hrtime.bigint();
  const payload = JSON.stringify(buildHookPayload(hookName, result));

  await new Promise((resolve) => process.stdout.write(payload, resolve));
  const tStdoutDone = process.hrtime.bigint();

  recordMetric({
    hook: hookName,
    ms_business: Number(tBusinessEnd - tBusinessStart) / 1e6,
    ms_total: Number(tStdoutDone - tEntry) / 1e6,
    error: result._error ?? null,
    ...(result._metricFields && typeof result._metricFields === 'object' ? result._metricFields : {})
  });

  process.exit(0);
}
