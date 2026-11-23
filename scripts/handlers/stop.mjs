import { touchWakeFile } from '../daemon/wake.mjs';
import { inferFromTranscript, inferL25FromTranscript, recordL25Probe } from '../lib/feedback.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { computeSessionStatsOf, countTranscriptLinesOf, parseTranscriptWindow } from '../lib/transcript.mjs';

const SHADOW_NOTICE = 'ccmem: mode=shadow (read-only diagnostic — no writes, no inject)\n';

export async function handleStop(db, hookData, deps = {}) {
  const mode = getMode(db);
  if (mode === 'off') {
    return { additionalContext: '' };
  }

  if (mode === 'shadow') {
    process.stderr.write(SHADOW_NOTICE);
    return { additionalContext: '' };
  }

  const agent = hookData.ccmem_agent ?? 'claude-code';
  // #395: one read of the transcript for the whole Stop hook. The stats, the
  // sequence, both inferences and the L2.5 probe all consume the same entries;
  // before this each consumer opened and parsed the file again.
  const transcriptWindow = deps.parseTranscript
    ? { entries: deps.parseTranscript(hookData.transcript_path, agent) }
    : parseTranscriptWindow(hookData.transcript_path, agent);
  const entries = transcriptWindow.entries;
  const stats = computeSessionStatsOf(entries);
  const seq = countTranscriptLinesOf(entries);

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      tool_calls = excluded.tool_calls,
      message_count = excluded.message_count,
      duration_ms = excluded.duration_ms,
      last_seq = excluded.last_seq,
      updated_at = excluded.updated_at,
      agent = excluded.agent`
  ).run(
    hookData.session_id,
    resolveProjectKey(hookData.cwd),
    stats.toolCalls,
    stats.messageCount,
    stats.durationMs,
    seq,
    Date.now(),
    agent
  );

  db.prepare(
    `INSERT OR IGNORE INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(
    JSON.stringify({
      session_id: hookData.session_id,
      transcript_path: hookData.transcript_path,
      last_message_seq: seq,
      agent,
      ...(transcriptWindow.startByte === undefined ? {} : {
        transcript_window: { startByte: transcriptWindow.startByte, endByte: transcriptWindow.endByte }
      })
    }),
    Date.now(),
    Date.now()
  );

  inferFromTranscript(db, hookData.session_id, hookData.transcript_path, agent, entries);
  inferL25FromTranscript(db, hookData.session_id, hookData.transcript_path, agent, entries);

  try {
    recordL25Probe(db, hookData.session_id, hookData.transcript_path, loadConfig(), agent, entries);
  } catch (e) {
    // Pure observation — never let it affect the Stop hook's real work.
    process.stderr.write(`ccmem: l25 probe skipped (${e.message})\n`);
  }

  touchWakeFile();

  return { additionalContext: '' };
}
