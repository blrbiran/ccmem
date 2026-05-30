import { openDb } from '../lib/db.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';

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
    if (getMode(db) === 'off') {
      return { additionalContext: '' };
    }

    const projectKey = resolveProjectKey(hookData.cwd);
    const tokens = sanitizeFtsQuery((hookData.prompt || '').slice(0, 2000)).map((token) => token.toLowerCase());
    if (!tokens.length) {
      return { additionalContext: '' };
    }

    const candidates = db.prepare(
      `SELECT id, type, content, scope, pinned, last_touched_at
       FROM memories
       WHERE scope = 'global' OR project_key = ?
       ORDER BY pinned DESC, last_touched_at DESC`
    ).all(projectKey);

    const rows = candidates
      .filter((row) => {
        const content = row.content.toLowerCase();
        return tokens.some((token) => content.includes(token));
      })
      .slice(0, 6)
      .map(({ id, type, content, scope }) => ({ id, type, content, scope }));

    return {
      additionalContext: rows.length ? renderRetrievedBlock(rows) : ''
    };
  } finally {
    db.close();
  }
}
