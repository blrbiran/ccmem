const T_ENTRY = process.hrtime.bigint();
const mode = process.argv[2];

const hookData = JSON.parse(
  await new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw || '{}'));
  })
);

if (mode === 'session-start') {
  const { withHookSafety } = await import('./lib/hook-safety.mjs');
  const { handleSessionStart } = await import('./handlers/session-start.mjs');
  await withHookSafety('session_start', 200, () => handleSessionStart(hookData), T_ENTRY);
}

if (mode === 'prompt-submit') {
  const { withHookSafety } = await import('./lib/hook-safety.mjs');
  const { handlePromptSubmit } = await import('./handlers/prompt-submit.mjs');
  await withHookSafety('prompt_submit', 2000, () => handlePromptSubmit(hookData), T_ENTRY);
}
