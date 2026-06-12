import { openDb } from '../lib/db.mjs';
import { inferPositiveFeedback, inferPrevTurnOutcome } from '../lib/feedback.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { getNextPromptIdx, writeRecentInjection } from '../lib/recent-injections.mjs';
import { retrieveMemories, sanitizeFtsQuery as sanitizePromptQuery } from '../lib/retrieval.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

export const sanitizeFtsQuery = sanitizePromptQuery;

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

function renderScore(score) {
  if (!score) {
    return '';
  }

  return ` | score fused=${Number(score.fused ?? 0).toFixed(3)} fts=${Number(score.fts ?? 0).toFixed(3)} jaccard=${Number(score.jaccard ?? 0).toFixed(3)} semantic=${Number(score.semantic ?? 0).toFixed(3)}`;
}

export function renderRetrievedBlock(rows) {
  const lines = ['=== ccmem: retrieved for current prompt ===', ''];
  for (const row of rows) {
    lines.push(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}${renderScore(row.score)}`);
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

    const config = loadConfig();
    const projectKey = resolveProjectKey(hookData.cwd);
    upsertSessionContext(db, hookData.session_id, projectKey);

    const retrieval = await retrieveMemories(db, hookData.prompt ?? '', projectKey, config);

    if (hookData.session_id) {
      inferPrevTurnOutcome(db, hookData.session_id, hookData.prompt ?? '');
      if (config.feedback?.l1_positive?.enabled !== false) {
        inferPositiveFeedback(db, hookData.session_id, hookData.prompt ?? '', retrieval.queryVec);
      }
    }

    const rows = retrieval.rows;
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
      additionalContext: rows.length ? renderRetrievedBlock(rows) : '',
      _metricFields: {
        matched: rows.length,
        fused_count: rows.filter((row) => row.score).length,
        cosine_contribution: retrieval.cosineContribution ?? null
      }
    };
  } finally {
    db.close();
  }
}
