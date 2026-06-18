import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { writeRecentInjection } from '../lib/recent-injections.mjs';
import { runSessionStartMiniPrelude } from '../lib/tier15.mjs';
import { cleanupStaleContextFiles, contextFileName } from '../lib/context-file.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

export function buildReadInstruction(sessionId) {
  const fileName = contextFileName(sessionId);
  return [
    '## ccmem context',
    `Read \`.ccmem/${fileName}\` at session start and after each /compact.`,
    'After /compact, ALWAYS re-read regardless of compressed summary content.',
    "Re-read if you haven't read it in the last 5 turns or when switching to a different task.",
    "Context is session-scoped; prioritize the user's current prompt over cached context.",
    'If file contains only "<!-- ccmem: no relevant memories -->" or is missing, proceed normally.'
  ].join('\n');
}

export const CCMEM_READ_INSTRUCTION = buildReadInstruction('unknown');

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
    const stableContext = rows.map((row) => row.rendered_text).filter(Boolean).join('\n\n');

    if (mode === 'shadow') {
      process.stderr.write(SHADOW_NOTICE);
      return { additionalContext: '' };
    }

    upsertSessionContext(db, hookData.session_id, projectKey);

    if (hookData.session_id && stableContext) {
      const injectedIds = [...new Set(rows.flatMap((row) => parseMemberIds(row.member_ids)))];
      writeRecentInjection(db, hookData.session_id, 0, 'session_start', injectedIds);
    }

    try {
      runSessionStartMiniPrelude(db);
    } catch {}

    const config = loadConfig();
    const useFileBased = config.injection?.file_based !== false;
    if (useFileBased) {
      cleanupStaleContextFiles(hookData.cwd, hookData.session_id);
    }

    const additionalContext = useFileBased
      ? [stableContext, buildReadInstruction(hookData.session_id)].filter(Boolean).join('\n\n')
      : stableContext;
    return { additionalContext };
  } finally {
    db.close();
  }
}
