import { openDb } from '../lib/db.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';

export async function handleSessionStart(hookData) {
  const db = openDb();

  try {
    if (getMode(db) === 'off') {
      return { additionalContext: '' };
    }

    const projectKey = resolveProjectKey(hookData.cwd);
    const rows = db.prepare(
      `SELECT rendered_text
       FROM injection_cache
       WHERE scope = 'global' OR scope = ?
       ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END`
    ).all(`project:${projectKey}`);

    return {
      additionalContext: rows.map((row) => row.rendered_text).filter(Boolean).join('\n\n')
    };
  } finally {
    db.close();
  }
}
