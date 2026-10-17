import { existsSync } from 'node:fs';

import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { writeRecentInjection } from '../lib/recent-injections.mjs';
import { runSessionStartMiniPrelude } from '../lib/tier15.mjs';
import { proposalNotice } from '../daemon/backend-state.mjs';
import {
  cleanupStaleContextFiles,
  contextFileName,
  getContextFilePath,
  selectStableRows,
  writeContextFile
} from '../lib/context-file.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';
const SCOPE_ISOLATION_NOTICE =
  'ccmem: WARNING — eval.disable_scope_isolation is ON. Cross-project memory isolation is DISABLED;\n'
  + 'ccmem: memories from every project on this machine are visible. Do not use on a real data root.\n';

// Compaction wording per calling agent: only Claude Code has /compact.
const COMPACTION_WORDING = {
  'claude-code': { after: 'each /compact', afterCap: 'After /compact' },
  codex: { after: 'context compaction', afterCap: 'After context compaction' },
  omp: { after: 'compaction', afterCap: 'After compaction' }
};

export function buildReadInstruction(sessionId, agent = 'claude-code') {
  const fileName = contextFileName(sessionId);
  const wording = COMPACTION_WORDING[agent] ?? COMPACTION_WORDING['claude-code'];
  return [
    '## ccmem context',
    `Read \`.ccmem/${fileName}\` at session start and after ${wording.after}.`,
    `${wording.afterCap}, ALWAYS re-read regardless of compressed summary content.`,
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

function upsertSessionContext(db, sessionId, projectKey, agent) {
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
      updated_at,
      agent
    ) VALUES (?, ?, 0, 0, 0, 0, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      updated_at = excluded.updated_at,
      agent = excluded.agent`
  ).run(sessionId, projectKey, Date.now(), agent);
}

export async function handleSessionStart(hookData) {
  const agent = hookData.ccmem_agent ?? 'claude-code';
  const db = openDb();

  try {
    const mode = getMode(db);
    if (mode === 'off') {
      return { additionalContext: '' };
    }

    const projectKey = resolveProjectKey(hookData.cwd);
    // Hoisted from further down (was only reached on the active/non-shadow
    // path) so the scope-isolation switch can gate the SELECT below. This
    // crosses the `mode === 'shadow'` early return: shadow mode now calls
    // loadConfig() too, and a malformed config.json will throw ConfigError
    // here. That is accepted deliberately (design §4.4-1) — a config broken
    // enough to throw already fails every non-shadow session, and shadow
    // mode silently succeeding on a broken config is itself a silent
    // failure. Do not wrap this in try/catch.
    const config = loadConfig();
    const disableScopeIsolation = config?.eval?.disable_scope_isolation === true;
    const useFileBased = config.injection?.file_based !== false;
    const scopeClause = disableScopeIsolation ? '' : "WHERE scope = 'global' OR scope = ?";
    const scopeParams = disableScopeIsolation ? [] : [`project:${projectKey}`];
    // File-based (default): the stable rules go into the context file, ranked
    // and bounded (spec §5.2). Legacy inline path: the whole rendered cache.
    const stableRows = useFileBased ? selectStableRows(db, projectKey, { disableScopeIsolation }) : [];
    const rows = useFileBased ? [] : db.prepare(
      `SELECT rendered_text, member_ids
       FROM injection_cache
       ${scopeClause}
       ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, scope`
    ).all(...scopeParams);
    if (disableScopeIsolation) {
      // Fires iff the cross-project query above actually ran: `mode === 'off'`
      // already returned before this point (silent, correctly), and
      // `mode === 'shadow'` returns AFTER this point (below), so it still
      // warns — the query really did read across projects even though
      // shadow mode discards the result.
      process.stderr.write(SCOPE_ISOLATION_NOTICE);
    }
    const stableContext = rows.map((row) => row.rendered_text).filter(Boolean).join('\n\n');

    if (mode === 'shadow') {
      process.stderr.write(SHADOW_NOTICE);
      return { additionalContext: '' };
    }

    upsertSessionContext(db, hookData.session_id, projectKey, agent);

    let notice = null;
    if (useFileBased) {
      cleanupStaleContextFiles(hookData.cwd, hookData.session_id);
      let injectedIds = [];
      // A backend switch waiting for the human's approval leads the file: the
      // daemon is headless, so this is where the ask gets seen (spec §5.5).
      try {
        notice = proposalNotice(db);
      } catch (error) {
        process.stderr.write(`ccmem: llm proposal lookup failed (${error.message})\n`);
      }
      // An existing file is rewritten even when both are empty, so a notice
      // the human already answered does not linger in it.
      if (stableRows.length || notice || existsSync(getContextFilePath(hookData.cwd, hookData.session_id))) {
        try {
          const result = writeContextFile(hookData.cwd, [], hookData.session_id, db, { stableRows, projectKey, notice });
          injectedIds = result.stableIds;
        } catch (error) {
          process.stderr.write(`ccmem: context file write failed (${error.message})\n`);
        }
      }
      // Only the rows that landed in the file count as injected.
      if (hookData.session_id && injectedIds.length && !disableScopeIsolation) {
        writeRecentInjection(db, hookData.session_id, 0, 'session_start', injectedIds);
      }
    } else if (hookData.session_id && stableContext && !disableScopeIsolation) {
      const injectedIds = [...new Set(rows.flatMap((row) => parseMemberIds(row.member_ids)))];
      writeRecentInjection(db, hookData.session_id, 0, 'session_start', injectedIds);
    }

    try {
      runSessionStartMiniPrelude(db);
    } catch {}

    // File-based: the conversation gets the short, fixed read instruction
    // only, identical on every call of a session (stable cache prefix).
    // While a backend switch waits for approval, its one line rides along:
    // the read instruction then changes only for as long as the question is
    // open.
    const additionalContext = useFileBased
      ? [buildReadInstruction(hookData.session_id, agent), notice].filter(Boolean).join('\n')
      : stableContext;
    return { additionalContext };
  } finally {
    db.close();
  }
}
