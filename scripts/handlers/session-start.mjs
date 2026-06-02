import { openDb } from '../lib/db.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { writeRecentInjection } from '../lib/recent-injections.mjs';
import { runSessionStartMiniPrelude } from '../lib/tier15.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

function parseMemberIds(memberIds) {
  try {
    const parsed = JSON.parse(memberIds ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

export async function handleSessionStart(hookData) {
  const db = openDb();

  try {
    const mode = getMode(db);
    if (mode === 'off') {
      return { additionalContext: '' };
    }

    const projectKey = resolveProjectKey(hookData.cwd);
    const rows = db.prepare(
      `SELECT rendered_text, member_ids
       FROM injection_cache
       WHERE scope = 'global' OR scope = ?
       ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END`
    ).all(`project:${projectKey}`);
    const additionalContext = rows.map((row) => row.rendered_text).filter(Boolean).join('\n\n');

    if (mode === 'shadow') {
      process.stderr.write(SHADOW_NOTICE);
      return { additionalContext: '' };
    }

    upsertSessionContext(db, hookData.session_id, projectKey);

    if (hookData.session_id && additionalContext) {
      const injectedIds = [...new Set(rows.flatMap((row) => parseMemberIds(row.member_ids)))];
      writeRecentInjection(db, hookData.session_id, 0, 'session_start', injectedIds);
    }

    try {
      runSessionStartMiniPrelude(db);
    } catch {}

    return { additionalContext };
  } finally {
    db.close();
  }
}
