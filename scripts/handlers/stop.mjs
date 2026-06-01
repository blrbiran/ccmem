import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { computeSessionStats, countTranscriptLines } from '../lib/transcript.mjs';

export async function handleStop(db, hookData) {
  if (getMode(db) === 'off') {
    return { additionalContext: '' };
  }

  const stats = computeSessionStats(hookData.transcript_path);
  const seq = countTranscriptLines(hookData.transcript_path);

  db.prepare(
    `INSERT INTO session_context (
      session_id,
      project_key,
      tool_calls,
      message_count,
      duration_ms,
      last_seq,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      tool_calls = excluded.tool_calls,
      message_count = excluded.message_count,
      duration_ms = excluded.duration_ms,
      last_seq = excluded.last_seq,
      updated_at = excluded.updated_at`
  ).run(
    hookData.session_id,
    resolveProjectKey(hookData.cwd),
    stats.toolCalls,
    stats.messageCount,
    stats.durationMs,
    seq,
    Date.now()
  );

  db.prepare(
    `INSERT OR IGNORE INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(
    JSON.stringify({
      session_id: hookData.session_id,
      transcript_path: hookData.transcript_path,
      last_message_seq: seq
    }),
    Date.now(),
    Date.now()
  );

  return { additionalContext: '' };
}
