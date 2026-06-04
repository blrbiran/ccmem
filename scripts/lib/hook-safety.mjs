import { recordMetric } from './metrics.mjs';

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
    error: result._error ?? null
  });

  process.exit(0);
}
