import { touchWakeFile } from '../daemon/wake.mjs';
import { inferFromTranscript, inferL25FromTranscript, recordL25Probe } from '../lib/feedback.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { computeSessionStats, countTranscriptLines } from '../lib/transcript.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

export async function handleStop(db, hookData) {
  const mode = getMode(db);
  if (mode === 'off') {
    return { additionalContext: '' };
  }

  if (mode === 'shadow') {
    process.stderr.write(SHADOW_NOTICE);
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

  inferFromTranscript(db, hookData.session_id, hookData.transcript_path);
  inferL25FromTranscript(db, hookData.session_id, hookData.transcript_path);

  try {
    recordL25Probe(db, hookData.session_id, hookData.transcript_path, loadConfig());
  } catch (e) {
    // Pure observation — never let it affect the Stop hook's real work.
    process.stderr.write(`ccmem: l25 probe skipped (${e.message})\n`);
  }

  touchWakeFile();

  return { additionalContext: '' };
}
