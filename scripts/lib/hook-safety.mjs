import { recordMetric } from './metrics.mjs';

/**
 * The prompt-submit budget, exported so hooks.json can be checked against it.
 * It is the point at which ccmem gives up and returns an empty context; the
 * harness timeout in hooks.json must be strictly larger, or the process is
 * killed before the graceful path can write stdout and its metrics row.
 */
export const PROMPT_SUBMIT_BUDGET_MS = 2000;

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
