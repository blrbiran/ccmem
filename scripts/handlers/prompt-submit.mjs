import { openDb } from '../lib/db.mjs';
import { inferPrevTurnOutcome } from '../lib/feedback.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { getNextPromptIdx, writeRecentInjection } from '../lib/recent-injections.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

function upsertSessionContext(db, sessionId, projectKey) {
  if (!sessionId) {
    return;
  }

  db.prepare(
    `INSERT INTO session_context (
      session_id,
      project_key,
      tool_calls,
      message_count,
      duration_ms,
      last_seq,
      updated_at
    ) VALUES (?, ?, 0, 0, 0, 0, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      updated_at = excluded.updated_at`
  ).run(sessionId, projectKey, Date.now());
}

export function sanitizeFtsQuery(prompt) {
  return prompt
    .replace(/["':(){}\[\]]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 20);
}

export function renderRetrievedBlock(rows) {
  const lines = ['=== ccmem: retrieved for current prompt ===', ''];
  for (const row of rows) {
    lines.push(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}`);
  }
  return lines.join('\n');
}

export async function handlePromptSubmit(hookData) {
  const db = openDb();

  try {
    const mode = getMode(db);
    if (mode === 'off') {
      return { additionalContext: '' };
    }

    if (mode === 'shadow') {
      process.stderr.write(SHADOW_NOTICE);
      return { additionalContext: '' };
    }

    const projectKey = resolveProjectKey(hookData.cwd);
    upsertSessionContext(db, hookData.session_id, projectKey);

    if (hookData.session_id) {
      inferPrevTurnOutcome(db, hookData.session_id, hookData.prompt ?? '');
    }

    const tokens = sanitizeFtsQuery((hookData.prompt || '').slice(0, 2000)).map((token) => token.toLowerCase());
    if (!tokens.length) {
      return { additionalContext: '' };
    }

    const candidates = db.prepare(
      `SELECT id, type, content, scope, pinned, last_touched_at
       FROM memories
       WHERE (scope = 'global' OR project_key = ?)
         AND decay_status IN ('active', 'probation')
       ORDER BY pinned DESC, last_touched_at DESC`
    ).all(projectKey);

    const rows = candidates
      .filter((row) => {
        const content = row.content.toLowerCase();
        return tokens.some((token) => content.includes(token));
      })
      .slice(0, 6)
      .map(({ id, type, content, scope }) => ({ id, type, content, scope }));

    if (hookData.session_id && rows.length) {
      const injectedIds = rows.map((row) => row.id);
      const promptIdx = getNextPromptIdx(db, hookData.session_id);
      writeRecentInjection(db, hookData.session_id, promptIdx, 'user_prompt_submit', injectedIds);
      db.prepare(
        `INSERT INTO memory_feedback (
          session_id,
          injection_source,
          injected_ids,
          outcome,
          recorded_at
        ) VALUES (?, 'user_prompt_submit', ?, 'unknown', ?)`
      ).run(hookData.session_id, JSON.stringify(injectedIds), Date.now());
    }

    return {
      additionalContext: rows.length ? renderRetrievedBlock(rows) : ''
    };
  } finally {
    db.close();
  }
}
