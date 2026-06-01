import { parseTranscript, extractAssistantText } from './transcript.mjs';
import { adjustTrust } from './trust.mjs';

const NEGATIVE_FEEDBACK = /不对|重做|错了|wrong|redo|undo|revert/i;
const SELF_CORRECT = /(actually|on second thought|i was wrong|更准确地说|我之前.*错了)/i;

export function inferPrevTurnOutcome(db, sessionId, currentPrompt) {
  if (!NEGATIVE_FEEDBACK.test(currentPrompt)) {
    return;
  }

  const feedback = db.prepare(
    `SELECT id, injected_ids
     FROM memory_feedback
     WHERE session_id = ?
       AND outcome = 'unknown'
       AND injection_source = 'user_prompt_submit'
     ORDER BY recorded_at DESC
     LIMIT 1`
  ).get(sessionId);

  if (!feedback) {
    return;
  }

  for (const id of JSON.parse(feedback.injected_ids)) {
    adjustTrust(db, id, 'unhelpful');
  }

  db.prepare(
    `UPDATE memory_feedback
     SET outcome = 'unhelpful', evidence = ?
     WHERE id = ?`
  ).run('neg_keyword', feedback.id);
}

export function inferFromTranscript(db, sessionId, transcriptPath) {
  const lastAssistant = [...parseTranscript(transcriptPath)]
    .reverse()
    .find((entry) => entry.type === 'assistant');

  if (!lastAssistant) {
    return;
  }

  if (!SELF_CORRECT.test(extractAssistantText(lastAssistant))) {
    return;
  }

  const feedback = db.prepare(
    `SELECT id, injected_ids
     FROM memory_feedback
     WHERE session_id = ?
       AND outcome = 'unknown'
     ORDER BY recorded_at DESC
     LIMIT 1`
  ).get(sessionId);

  if (!feedback) {
    return;
  }

  for (const id of JSON.parse(feedback.injected_ids)) {
    adjustTrust(db, id, 'unhelpful');
  }

  db.prepare(
    `UPDATE memory_feedback
     SET outcome = 'unhelpful', evidence = ?
     WHERE id = ?`
  ).run('assistant_self_correction', feedback.id);
}
