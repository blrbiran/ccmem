const T_ENTRY = process.hrtime.bigint();
const mode = process.argv[2];

function buildHookOutput(hookMode, additionalContext = '') {
  if (hookMode === 'stop' || hookMode === 'session-end') {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: hookMode === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext
    }
  };
}

async function writeHookOutput(hookMode, additionalContext = '') {
  const payload = JSON.stringify(buildHookOutput(hookMode, additionalContext));
  await new Promise((resolve) => process.stdout.write(payload, resolve));
}

const hookData = JSON.parse(
  await new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw || '{}'));
  })
);

async function isBlacklistedSession(sessionId) {
  if (!sessionId) {
    return false;
  }

  const { openDb } = await import('./lib/db.mjs');
  const db = openDb();

  try {
    const row = db.prepare(
      `SELECT 1
       FROM ccmem_blacklisted_sessions
       WHERE session_id = ?
         AND expires_at > ?`
    ).get(sessionId, Date.now());

    return Boolean(row);
  } finally {
    db.close();
  }
}

if (process.env.CCMEM_INTERNAL === '1' || await isBlacklistedSession(hookData.session_id)) {
  await writeHookOutput(mode, '');
  process.exit(0);
}

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

if (mode === 'stop') {
  const { withHookSafety } = await import('./lib/hook-safety.mjs');
  const { openDb } = await import('./lib/db.mjs');
  const { handleStop } = await import('./handlers/stop.mjs');
  const db = openDb();
  await withHookSafety('stop', 200, async () => {
    try {
      return await handleStop(db, hookData);
    } finally {
      db.close();
    }
  }, T_ENTRY);
}
