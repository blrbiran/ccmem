import { openDb } from '../lib/db.mjs';
import { inferPositiveFeedback, inferPrevTurnOutcome } from '../lib/feedback.mjs';
import { loadConfig } from '../lib/config.mjs';
import { clearContextFile, contextFileName, writeContextFile } from '../lib/context-file.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { getNextPromptIdx, writeRecentInjection } from '../lib/recent-injections.mjs';
import { renderRetrievedBlock } from '../lib/render.mjs';
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
    const useFileBased = config.injection?.file_based !== false;
    let contextFileWritten = false;
    let contextFileBytes = 0;

    if (useFileBased) {
      try {
        if (rows.length) {
          const result = writeContextFile(hookData.cwd, rows, hookData.session_id, db);
          contextFileWritten = result.written;
          contextFileBytes = result.bytes;
        } else {
          contextFileBytes = clearContextFile(hookData.cwd, hookData.session_id, db);
        }
      } catch (error) {
        process.stderr.write(`ccmem: context file write failed (${error.message})\n`);
        contextFileBytes = -1;
      }
    }

    if (hookData.session_id && rows.length) {
      const injectedIds = rows.map((row) => row.id);
      const promptIdx = getNextPromptIdx(db, hookData.session_id);
      writeRecentInjection(
        db,
        hookData.session_id,
        promptIdx,
        'user_prompt_submit',
        injectedIds,
        retrieval.timing
          ? rows.map((row) => ({
              id: row.id,
              fts: Number((row.score?.fts ?? 0).toFixed(3)),
              jac: Number((row.score?.jaccard ?? 0).toFixed(3)),
              cos: Number((row.score?.semantic ?? 0).toFixed(3)),
              f: Number((row.score?.fused ?? 0).toFixed(3))
            }))
          : null
      );
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

    if (useFileBased) {
      process.stderr.write(`ccmem: RETRIEVE ${rows.length} mems → .ccmem/${contextFileName(hookData.session_id)}\n`);
    }

    const path = retrieval.retrievalPath ?? (retrieval.timing?.embedError ? 'B-fail' : (retrieval.timing ? 'A' : 'B-off'));
    const embedError = retrieval.timing?.embedError ?? null;
    const fallback = path === 'B-fail';

    return {
      additionalContext: useFileBased ? '' : (rows.length ? renderRetrievedBlock(rows) : ''),
      _metricFields: {
        matched: rows.length,
        fused_count: rows.filter((row) => row.score).length,
        cosine_contribution: retrieval.cosineContribution ?? null,
        retrieval_embed_ms: retrieval.timing?.embedMs ?? null,
        retrieval_db_ms: retrieval.timing?.dbReadMs ?? null,
        retrieval_cosine_ms: retrieval.timing?.cosineMs ?? null,
        retrieval_pool: retrieval.timing?.candidatePool ?? null,
        retrieval_stale_vecs: retrieval.timing?.retrieval_stale_vecs ?? null,
        retrieval_path: path,
        retrieval_embed_error: embedError,
        retrieval_fallback: fallback,
        context_file_written: useFileBased ? contextFileWritten : false,
        context_file_bytes: useFileBased ? contextFileBytes : null,
        additional_context_empty: useFileBased
      }
    };
  } finally {
    db.close();
  }
}
