import { touchWakeFile } from '../daemon/wake.mjs';
import { inferFromTranscript, inferL25FromTranscript, recordL25Probe } from '../lib/feedback.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getMode } from '../lib/mode.mjs';
import { resolveProjectKey } from '../lib/project-key.mjs';
import { computeSessionStatsOf, parseTranscriptWindow, scanTranscript } from '../lib/transcript.mjs';

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
  // The window's entries are what the inferences read, but the two stored
  // counts keep meaning "the whole transcript" (see scanTranscript): a daemon
  // that predates the window parses the full file and slices it with
  // last_message_seq, so a window-relative count would make it summarize the
  // opening turns. One streaming pass, no full parse, nothing kept.
  const whole = deps.parseTranscript
    ? { entryCount: entries.length, toolCalls: computeSessionStatsOf(entries).toolCalls }
    : scanTranscript(hookData.transcript_path, agent);
  const stats = { toolCalls: whole.toolCalls, messageCount: whole.entryCount, durationMs: 0 };
  const seq = whole.entryCount;
  const observedAt = Date.now();

  db.prepare(
    `INSERT INTO session_context (
      session_id,
      project_key,
      tool_calls,
      message_count,
      duration_ms,
      last_seq,
      updated_at,
      agent,
      transcript_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_key = excluded.project_key,
      tool_calls = excluded.tool_calls,
      message_count = excluded.message_count,
      duration_ms = excluded.duration_ms,
      last_seq = excluded.last_seq,
      updated_at = excluded.updated_at,
      agent = excluded.agent,
      transcript_path = excluded.transcript_path`
  ).run(
    hookData.session_id,
    resolveProjectKey(hookData.cwd),
    stats.toolCalls,
    stats.messageCount,
    stats.durationMs,
    seq,
    Date.now(),
    agent,
    hookData.transcript_path ?? null
  );

  // No supersede here any more. last_message_seq counts the WHOLE transcript, so
  // two Stops over the same file carry the same sequence and the unique index
  // dedupes them; a grown file carries a larger one and the two rows coexist
  // until runSummarizePending's ordering retires the older one (a running older
  // row is left alone, as before). Superseding by time here turned every repeat
  // Stop into a second row.

  db.prepare(
    `INSERT OR IGNORE INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(
    JSON.stringify({
      session_id: hookData.session_id,
      transcript_path: hookData.transcript_path,
      last_message_seq: seq,
      snapshot_observed_at: observedAt,
      agent,
      ...(transcriptWindow.startByte === undefined ? {} : {
        transcript_window: {
          startByte: transcriptWindow.startByte,
          endByte: transcriptWindow.endByte,
          completeLinesOnly: transcriptWindow.completeLinesOnly,
          complete: transcriptWindow.complete
        }
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
