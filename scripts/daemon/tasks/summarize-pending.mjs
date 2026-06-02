import { callClaudeP } from '../claude-p.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { evaluateTier1 } from '../../lib/threat-scan.mjs';
import { extractAssistantText, parseTranscript } from '../../lib/transcript.mjs';
import { getSourceInitialTrust } from '../../lib/trust.mjs';

const TRANSCRIPT_EXCERPT_MAX = 1000;

function logAudit(db, action, details = null) {
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, NULL, ?)`
  ).run(Date.now(), action, details ? JSON.stringify(details) : null);
}

function extractEntryText(entry) {
  if (entry?.type === 'assistant') {
    return extractAssistantText(entry);
  }

  return entry?.message?.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n') ?? '';
}

function readTranscriptExcerpt(transcriptPath, lastMessageSeq) {
  const entries = parseTranscript(transcriptPath).slice(0, lastMessageSeq);
  const lines = entries
    .map((entry) => {
      const text = extractEntryText(entry).trim();
      if (!text) {
        return null;
      }

      return `${entry.type ?? 'unknown'}: ${text}`;
    })
    .filter(Boolean);

  return {
    entryCount: entries.length,
    excerpt: lines.join('\n').slice(0, TRANSCRIPT_EXCERPT_MAX)
  };
}

function buildSummarizePrompt(transcript) {
  return [
    'You are a memory extraction assistant.',
    'Extract durable cross-session memories as JSON.',
    'Return an array or an object with a synthesized array.',
    '',
    transcript
  ].join('\n');
}

function shouldUseClaudeBridge(payload) {
  return typeof payload.llm_output === 'string' || process.env.CCMEM_ENABLE_REAL_CLAUDE_P === '1';
}

export async function runSummarizePending(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  const lastMessageSeq = Number(payload.last_message_seq ?? 0);
  const now = Date.now();

  if (!sessionId || !transcriptPath || !Number.isFinite(lastMessageSeq)) {
    logAudit(db, 'summarize_pending_bad_payload', { task_id: task.id });
    return;
  }

  db.prepare(
    `UPDATE tasks
     SET status = 'superseded', finished_at = ?
     WHERE type = 'summarize_pending'
       AND status = 'queued'
       AND id <> ?
       AND json_extract(payload, '$.session_id') = ?
       AND json_extract(payload, '$.last_message_seq') < ?`
  ).run(now, task.id, sessionId, lastMessageSeq);

  const newer = db.prepare(
    `SELECT id
     FROM tasks
     WHERE type = 'summarize_pending'
       AND status IN ('queued', 'running')
       AND id <> ?
       AND json_extract(payload, '$.session_id') = ?
       AND json_extract(payload, '$.last_message_seq') > ?
     LIMIT 1`
  ).get(task.id, sessionId, lastMessageSeq);

  if (newer) {
    db.prepare(
      `UPDATE tasks
       SET status = 'superseded', finished_at = ?
       WHERE id = ?`
    ).run(now, task.id);
    logAudit(db, 'summarize_pending_superseded', {
      task_id: task.id,
      session_id: sessionId,
      last_message_seq: lastMessageSeq,
      newer_task_id: newer.id
    });
    return;
  }

  const ctx = db.prepare(
    `SELECT project_key, message_count, tool_calls
     FROM session_context
     WHERE session_id = ?`
  ).get(sessionId);

  if (ctx && ctx.message_count < 2) {
    logAudit(db, 'summarize_pending_skipped', {
      task_id: task.id,
      session_id: sessionId,
      reason: 'short_session'
    });
    return;
  }

  const transcript = readTranscriptExcerpt(transcriptPath, lastMessageSeq);
  if (!transcript.excerpt) {
    logAudit(db, 'summarize_pending_skipped', {
      task_id: task.id,
      session_id: sessionId,
      reason: 'empty_transcript'
    });
    return;
  }

  let llmOutput = null;
  if (shouldUseClaudeBridge(payload)) {
    llmOutput = await callClaudeP(buildSummarizePrompt(transcript.excerpt), {
      taskType: 'summarize_pending',
      mockOutput: payload.llm_output
    });
  }

  if (!llmOutput) {
    logAudit(db, 'summarize_pending_stub', {
      task_id: task.id,
      session_id: sessionId,
      last_message_seq: lastMessageSeq,
      project_key: ctx?.project_key ?? null,
      message_count: ctx?.message_count ?? null,
      tool_calls: ctx?.tool_calls ?? null,
      transcript_entry_count: transcript.entryCount,
      transcript_excerpt: transcript.excerpt
    });
    return;
  }

  const items = parseLlmJson(llmOutput);
  const insertedIds = [];
  let skippedCount = 0;

  for (const item of items) {
    const gate = evaluateTier1(item.content);
    if (!gate.ok) {
      skippedCount += 1;
      continue;
    }

    const scope = item.scope === 'global' ? 'global' : 'project';
    const projectKey = scope === 'global' ? null : (ctx?.project_key ?? null);
    const timestamp = Date.now();
    const result = db.prepare(
      `INSERT INTO memories (
        scope,
        project_key,
        type,
        content,
        pinned,
        source,
        trust_score,
        tags,
        last_touched_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 0, 'auto_inferred', ?, ?, ?, ?, ?)`
    ).run(
      scope,
      projectKey,
      item.type,
      item.content,
      getSourceInitialTrust('auto_inferred'),
      JSON.stringify(item.tags),
      timestamp,
      timestamp,
      timestamp
    );

    insertedIds.push(Number(result.lastInsertRowid));
  }

  if (insertedIds.length) {
    rebuildInjectionCache(db, ctx?.project_key ?? null);
  }

  logAudit(db, 'summarize_pending_applied', {
    task_id: task.id,
    session_id: sessionId,
    last_message_seq: lastMessageSeq,
    inserted_count: insertedIds.length,
    skipped_count: skippedCount,
    transcript_entry_count: transcript.entryCount,
    transcript_excerpt: transcript.excerpt
  });
}
