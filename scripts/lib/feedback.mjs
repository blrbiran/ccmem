import { parseTranscript, extractAssistantText } from './transcript.mjs';
import { loadConfig } from './config.mjs';
import { blobToVec, cosineSimilarity } from './embedding/cosine.mjs';
import { applyOutcomeToSubset, adjustTrust } from './trust.mjs';

const NEGATIVE_FEEDBACK = /不对|重做|错了|wrong|redo|undo|revert/i;
const SELF_CORRECT = /(actually|on second thought|i was wrong|更准确地说|我之前.*错了)/i;
const AFFIRMATIVE = /^(对|好|嗯|是的|没错|正确|对的|好的|就这样|可以|行|ok|yes|yeah|right|correct|exactly|perfect|great|good|that's right|that works)/i;
const AFFIRMATIVE_NEGATED = /^(对|好|嗯|是的|ok|yes|yeah).{0,5}(但是|不过|可是|然而|but|however|though|except)/i;

function getLastAssistantText(transcriptPath) {
  const lastAssistant = [...parseTranscript(transcriptPath)]
    .reverse()
    .find((entry) => entry.type === 'assistant');

  return lastAssistant ? extractAssistantText(lastAssistant) : '';
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getLastUnknownFeedback(db, sessionId) {
  return db.prepare(
    `SELECT id, injected_ids
     FROM memory_feedback
     WHERE session_id = ?
       AND outcome = 'unknown'
     ORDER BY recorded_at DESC
     LIMIT 1`
  ).get(sessionId);
}

function getRecentMemories(db, sessionId) {
  const injection = db.prepare(
    `SELECT mem_ids
     FROM recent_injections
     WHERE session_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).get(sessionId);
  const ids = parseJsonArray(injection?.mem_ids).filter((id) => Number.isFinite(Number(id)));

  if (!ids.length) {
    return [];
  }

  return db.prepare(
    `SELECT id, content
     FROM memories
     WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
}

function noteFeedback(db, feedbackId, outcome, evidence) {
  db.prepare(
    `UPDATE memory_feedback
     SET outcome = ?, evidence = ?
     WHERE id = ?`
  ).run(outcome, evidence, feedbackId);
}

function matchesImplicitReference(assistantText, memory) {
  const text = assistantText.trim().toLowerCase();
  const content = String(memory.content ?? '').trim().toLowerCase();

  if (!text || !content) {
    return false;
  }

  return text.includes(content) || text.includes(`m${memory.id}`);
}

function markOutcomeForIds(db, ids, outcome) {
  for (const id of ids) {
    adjustTrust(db, id, outcome);
  }
}

function feedbackIds(feedback) {
  return parseJsonArray(feedback?.injected_ids).filter((id) => Number.isFinite(Number(id)));
}

function memoryIds(memories) {
  return memories.map((memory) => Number(memory.id)).filter(Number.isFinite);
}

function unknownFeedbackIdsOrFallback(feedback, memories) {
  const ids = feedbackIds(feedback);
  return ids.length ? ids : memoryIds(memories);
}

function isSelfCorrection(text) {
  return SELF_CORRECT.test(text);
}

function isNegativeFeedback(text) {
  return NEGATIVE_FEEDBACK.test(text);
}

function hasUnknownFeedback(feedback) {
  return Boolean(feedback?.id);
}

function recentMemoriesReferenced(assistantText, memories) {
  return memories.filter((memory) => matchesImplicitReference(assistantText, memory));
}

function lastUnknownFeedbackOrNull(db, sessionId) {
  return getLastUnknownFeedback(db, sessionId) ?? null;
}

function lastAssistantTextOrEmpty(transcriptPath) {
  return getLastAssistantText(transcriptPath);
}

function recentSessionMemories(db, sessionId) {
  return getRecentMemories(db, sessionId);
}

function updateUnknownFeedback(db, feedback, outcome, evidence) {
  if (hasUnknownFeedback(feedback)) {
    noteFeedback(db, feedback.id, outcome, evidence);
  }
}

function updateTrustForMatchedMemories(db, memories, outcome) {
  markOutcomeForIds(db, memoryIds(memories), outcome);
}

function feedbackTargetIds(feedback, memories) {
  return unknownFeedbackIdsOrFallback(feedback, memories);
}

function updateTrustForFeedback(db, feedback, memories, outcome) {
  markOutcomeForIds(db, feedbackTargetIds(feedback, memories), outcome);
}

function referencedMemories(db, sessionId, assistantText) {
  return recentMemoriesReferenced(assistantText, recentSessionMemories(db, sessionId));
}

function lastFeedback(db, sessionId) {
  return lastUnknownFeedbackOrNull(db, sessionId);
}

function assistantTextFromTranscript(transcriptPath) {
  return lastAssistantTextOrEmpty(transcriptPath);
}

function hasAssistantText(text) {
  return Boolean(text);
}

function updateImplicitHelpful(db, sessionId, assistantText) {
  const feedback = lastFeedback(db, sessionId);
  const memories = referencedMemories(db, sessionId, assistantText);
  if (!memories.length) {
    return;
  }

  updateTrustForMatchedMemories(db, memories, 'helpful_implicit');
  updateUnknownFeedback(db, feedback, 'helpful_implicit', 'assistant_reference');
}

function updateSelfCorrection(db, sessionId) {
  const feedback = lastFeedback(db, sessionId);
  if (!feedback) {
    return;
  }

  updateTrustForFeedback(db, feedback, [], 'unhelpful');
  updateUnknownFeedback(db, feedback, 'unhelpful', 'assistant_self_correction');
}

function updateNegativePrompt(db, sessionId) {
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

  updateTrustForFeedback(db, feedback, [], 'unhelpful');
  updateUnknownFeedback(db, feedback, 'unhelpful', 'neg_keyword');
}

function selfCorrectionText(transcriptPath) {
  return assistantTextFromTranscript(transcriptPath);
}

function isReferencedAssistantText(transcriptPath) {
  return assistantTextFromTranscript(transcriptPath);
}

function shouldSkipImplicitHelpful(text) {
  return isSelfCorrection(text);
}

function shouldApplyNegativePrompt(text) {
  return isNegativeFeedback(text);
}

function shouldApplySelfCorrection(text) {
  return hasAssistantText(text) && isSelfCorrection(text);
}

function shouldApplyImplicitHelpful(text) {
  return hasAssistantText(text) && !shouldSkipImplicitHelpful(text);
}

function feedbackText(transcriptPath) {
  return assistantTextFromTranscript(transcriptPath);
}

function implicitHelpfulText(transcriptPath) {
  return isReferencedAssistantText(transcriptPath);
}

function selfCorrectionCandidate(transcriptPath) {
  return selfCorrectionText(transcriptPath);
}

function negativePromptCandidate(currentPrompt) {
  return currentPrompt;
}

function runNegativePromptInference(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(negativePromptCandidate(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function runSelfCorrectionInference(db, sessionId, transcriptPath) {
  const text = selfCorrectionCandidate(transcriptPath);
  if (!shouldApplySelfCorrection(text)) {
    return;
  }

  updateSelfCorrection(db, sessionId);
}

function runImplicitHelpfulInference(db, sessionId, transcriptPath) {
  const text = implicitHelpfulText(transcriptPath);
  if (!shouldApplyImplicitHelpful(text)) {
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function lastAssistantTextForInference(transcriptPath) {
  return feedbackText(transcriptPath);
}

function shouldInferFromTranscriptText(text) {
  return hasAssistantText(text);
}

function transcriptText(transcriptPath) {
  return lastAssistantTextForInference(transcriptPath);
}

function canInferFromTranscript(transcriptPath) {
  return shouldInferFromTranscriptText(transcriptText(transcriptPath));
}

function hasTranscriptAssistantText(transcriptPath) {
  return canInferFromTranscript(transcriptPath);
}

function shouldInferImplicitHelpfulFromTranscript(transcriptPath) {
  return hasTranscriptAssistantText(transcriptPath);
}

function shouldInferSelfCorrectionFromTranscript(transcriptPath) {
  return hasTranscriptAssistantText(transcriptPath);
}

function inferenceAssistantText(transcriptPath) {
  return transcriptText(transcriptPath);
}

function inferImplicitHelpful(db, sessionId, transcriptPath) {
  if (!shouldInferImplicitHelpfulFromTranscript(transcriptPath)) {
    return;
  }

  updateImplicitHelpful(db, sessionId, inferenceAssistantText(transcriptPath));
}

function inferSelfCorrection(db, sessionId, transcriptPath) {
  if (!shouldInferSelfCorrectionFromTranscript(transcriptPath)) {
    return;
  }

  runSelfCorrectionInference(db, sessionId, transcriptPath);
}

function inferNegativePrompt(db, sessionId, currentPrompt) {
  runNegativePromptInference(db, sessionId, currentPrompt);
}

function shouldSkipTranscriptInference(transcriptPath) {
  return !hasTranscriptAssistantText(transcriptPath);
}

function shouldSkipImplicitHelpfulInference(transcriptPath) {
  return shouldSkipTranscriptInference(transcriptPath);
}

function shouldSkipSelfCorrectionInference(transcriptPath) {
  return shouldSkipTranscriptInference(transcriptPath);
}

function inferImplicitHelpfulFromTranscript(db, sessionId, transcriptPath) {
  if (shouldSkipImplicitHelpfulInference(transcriptPath)) {
    return;
  }

  inferImplicitHelpful(db, sessionId, transcriptPath);
}

function inferSelfCorrectionFromTranscript(db, sessionId, transcriptPath) {
  if (shouldSkipSelfCorrectionInference(transcriptPath)) {
    return;
  }

  inferSelfCorrection(db, sessionId, transcriptPath);
}

function inferNegativePromptFromPrompt(db, sessionId, currentPrompt) {
  inferNegativePrompt(db, sessionId, currentPrompt);
}

function assistantTextForTranscript(transcriptPath) {
  return assistantTextFromTranscript(transcriptPath);
}

function hasSelfCorrection(text) {
  return isSelfCorrection(text);
}

function hasImplicitHelpfulCandidate(text) {
  return !hasSelfCorrection(text);
}

function inferImplicitHelpfulForSession(db, sessionId, transcriptPath) {
  const text = assistantTextForTranscript(transcriptPath);
  if (!text || !hasImplicitHelpfulCandidate(text)) {
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferSelfCorrectionForSession(db, sessionId, transcriptPath) {
  const text = assistantTextForTranscript(transcriptPath);
  if (!text || !hasSelfCorrection(text)) {
    return;
  }

  updateSelfCorrection(db, sessionId);
}

function inferNegativePromptForSession(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function applyTranscriptInferences(db, sessionId, transcriptPath) {
  inferSelfCorrectionForSession(db, sessionId, transcriptPath);
  inferImplicitHelpfulForSession(db, sessionId, transcriptPath);
}

function applyPromptInferences(db, sessionId, currentPrompt) {
  inferNegativePromptForSession(db, sessionId, currentPrompt);
}

function transcriptAssistantText(transcriptPath) {
  return assistantTextForTranscript(transcriptPath);
}

function shouldApplyTranscriptInferences(text) {
  return Boolean(text);
}

function applySessionTranscriptInferences(db, sessionId, transcriptPath) {
  const text = transcriptAssistantText(transcriptPath);
  if (!shouldApplyTranscriptInferences(text)) {
    return;
  }

  inferSelfCorrectionForSession(db, sessionId, transcriptPath);
  if (!hasSelfCorrection(text)) {
    inferImplicitHelpfulForSession(db, sessionId, transcriptPath);
  }
}

function applySessionPromptInferences(db, sessionId, currentPrompt) {
  applyPromptInferences(db, sessionId, currentPrompt);
}

function inferPrompt(db, sessionId, currentPrompt) {
  applySessionPromptInferences(db, sessionId, currentPrompt);
}

function inferTranscript(db, sessionId, transcriptPath) {
  applySessionTranscriptInferences(db, sessionId, transcriptPath);
}

function updateFeedbackFromPrompt(db, sessionId, currentPrompt) {
  inferPrompt(db, sessionId, currentPrompt);
}

function updateFeedbackFromTranscript(db, sessionId, transcriptPath) {
  inferTranscript(db, sessionId, transcriptPath);
}

function lastAssistantFeedbackText(transcriptPath) {
  return transcriptAssistantText(transcriptPath);
}

function shouldInferImplicitHelpful(text) {
  return Boolean(text) && !hasSelfCorrection(text);
}

function shouldInferSelfCorrection(text) {
  return Boolean(text) && hasSelfCorrection(text);
}

function applyTranscriptFeedback(db, sessionId, transcriptPath) {
  const text = lastAssistantFeedbackText(transcriptPath);
  if (shouldInferSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  if (shouldInferImplicitHelpful(text)) {
    updateImplicitHelpful(db, sessionId, text);
  }
}

function applyPromptFeedback(db, sessionId, currentPrompt) {
  if (shouldApplyNegativePrompt(currentPrompt)) {
    updateNegativePrompt(db, sessionId);
  }
}

function inferPromptFeedback(db, sessionId, currentPrompt) {
  applyPromptFeedback(db, sessionId, currentPrompt);
}

function inferTranscriptFeedback(db, sessionId, transcriptPath) {
  applyTranscriptFeedback(db, sessionId, transcriptPath);
}

function recentAssistantText(transcriptPath) {
  return lastAssistantFeedbackText(transcriptPath);
}

function shouldUseTranscriptFeedback(text) {
  return Boolean(text);
}

function feedbackFromTranscript(db, sessionId, transcriptPath) {
  const text = recentAssistantText(transcriptPath);
  if (!shouldUseTranscriptFeedback(text)) {
    return;
  }

  applyTranscriptFeedback(db, sessionId, transcriptPath);
}

function feedbackFromPrompt(db, sessionId, currentPrompt) {
  inferPromptFeedback(db, sessionId, currentPrompt);
}

function updatePromptFeedback(db, sessionId, currentPrompt) {
  feedbackFromPrompt(db, sessionId, currentPrompt);
}

function updateTranscriptFeedback(db, sessionId, transcriptPath) {
  feedbackFromTranscript(db, sessionId, transcriptPath);
}

function shouldApplyPromptFeedback(text) {
  return shouldApplyNegativePrompt(text);
}

function shouldApplyTranscriptFeedback(text) {
  return Boolean(text);
}

function promptFeedback(db, sessionId, currentPrompt) {
  if (!shouldApplyPromptFeedback(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function transcriptFeedback(db, sessionId, transcriptPath) {
  const text = recentAssistantText(transcriptPath);
  if (!shouldApplyTranscriptFeedback(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferPromptOutcome(db, sessionId, currentPrompt) {
  promptFeedback(db, sessionId, currentPrompt);
}

function inferTranscriptOutcome(db, sessionId, transcriptPath) {
  transcriptFeedback(db, sessionId, transcriptPath);
}

function recentAssistantTranscriptText(transcriptPath) {
  return recentAssistantText(transcriptPath);
}

function shouldHandleTranscriptOutcome(text) {
  return Boolean(text);
}

function handleTranscriptOutcome(db, sessionId, transcriptPath) {
  const text = recentAssistantTranscriptText(transcriptPath);
  if (!shouldHandleTranscriptOutcome(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function handlePromptOutcome(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function runTranscriptOutcome(db, sessionId, transcriptPath) {
  handleTranscriptOutcome(db, sessionId, transcriptPath);
}

function runPromptOutcome(db, sessionId, currentPrompt) {
  handlePromptOutcome(db, sessionId, currentPrompt);
}

function transcriptOutcomeText(transcriptPath) {
  return recentAssistantTranscriptText(transcriptPath);
}

function shouldRunTranscriptOutcome(text) {
  return Boolean(text);
}

function inferFromSessionTranscript(db, sessionId, transcriptPath) {
  const text = transcriptOutcomeText(transcriptPath);
  if (!shouldRunTranscriptOutcome(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferFromPromptText(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function promptTextForInference(currentPrompt) {
  return currentPrompt;
}

function transcriptTextForInference(transcriptPath) {
  return transcriptOutcomeText(transcriptPath);
}

function shouldHandlePromptText(text) {
  return shouldApplyNegativePrompt(text);
}

function shouldHandleTranscriptText(text) {
  return Boolean(text);
}

function maybeInferFromPrompt(db, sessionId, currentPrompt) {
  if (!shouldHandlePromptText(promptTextForInference(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function maybeInferFromTranscript(db, sessionId, transcriptPath) {
  const text = transcriptTextForInference(transcriptPath);
  if (!shouldHandleTranscriptText(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function assistantTextForStop(transcriptPath) {
  return transcriptTextForInference(transcriptPath);
}

function canApplyImplicitHelpful(text) {
  return Boolean(text) && !hasSelfCorrection(text);
}

function canApplySelfCorrection(text) {
  return Boolean(text) && hasSelfCorrection(text);
}

function applyStopTranscriptFeedback(db, sessionId, transcriptPath) {
  const text = assistantTextForStop(transcriptPath);
  if (canApplySelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  if (canApplyImplicitHelpful(text)) {
    updateImplicitHelpful(db, sessionId, text);
  }
}

function applyPromptSubmitFeedback(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function stopAssistantText(transcriptPath) {
  return assistantTextForStop(transcriptPath);
}

function hasStopAssistantText(text) {
  return Boolean(text);
}

function inferStopFeedback(db, sessionId, transcriptPath) {
  const text = stopAssistantText(transcriptPath);
  if (!hasStopAssistantText(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferPromptSubmitFeedback(db, sessionId, currentPrompt) {
  if (!shouldApplyNegativePrompt(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function stopTranscriptText(transcriptPath) {
  return stopAssistantText(transcriptPath);
}

function canInferStopFeedback(text) {
  return Boolean(text);
}

function applyStopFeedback(db, sessionId, transcriptPath) {
  const text = stopTranscriptText(transcriptPath);
  if (!canInferStopFeedback(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function applyPromptFeedbackInference(db, sessionId, currentPrompt) {
  inferPromptSubmitFeedback(db, sessionId, currentPrompt);
}

function applyStopFeedbackInference(db, sessionId, transcriptPath) {
  applyStopFeedback(db, sessionId, transcriptPath);
}

function inferPromptSubmit(db, sessionId, currentPrompt) {
  applyPromptFeedbackInference(db, sessionId, currentPrompt);
}

function inferStop(db, sessionId, transcriptPath) {
  applyStopFeedbackInference(db, sessionId, transcriptPath);
}

function handlePromptInference(db, sessionId, currentPrompt) {
  inferPromptSubmit(db, sessionId, currentPrompt);
}

function handleStopInference(db, sessionId, transcriptPath) {
  inferStop(db, sessionId, transcriptPath);
}

function shouldRunPromptInference(text) {
  return shouldApplyNegativePrompt(text);
}

function shouldRunStopInference(text) {
  return Boolean(text);
}

function promptInference(db, sessionId, currentPrompt) {
  if (!shouldRunPromptInference(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function stopInference(db, sessionId, transcriptPath) {
  const text = stopTranscriptText(transcriptPath);
  if (!shouldRunStopInference(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function promptInferenceCandidate(currentPrompt) {
  return currentPrompt;
}

function stopInferenceCandidate(transcriptPath) {
  return stopTranscriptText(transcriptPath);
}

function inferPromptSubmitOutcome(db, sessionId, currentPrompt) {
  if (!shouldRunPromptInference(promptInferenceCandidate(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function inferStopOutcome(db, sessionId, transcriptPath) {
  const text = stopInferenceCandidate(transcriptPath);
  if (!shouldRunStopInference(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function promptOutcome(db, sessionId, currentPrompt) {
  inferPromptSubmitOutcome(db, sessionId, currentPrompt);
}

function stopOutcome(db, sessionId, transcriptPath) {
  inferStopOutcome(db, sessionId, transcriptPath);
}

function promptOutcomeInference(db, sessionId, currentPrompt) {
  promptOutcome(db, sessionId, currentPrompt);
}

function stopOutcomeInference(db, sessionId, transcriptPath) {
  stopOutcome(db, sessionId, transcriptPath);
}

function runPromptOutcomeInference(db, sessionId, currentPrompt) {
  promptOutcomeInference(db, sessionId, currentPrompt);
}

function runStopOutcomeInference(db, sessionId, transcriptPath) {
  stopOutcomeInference(db, sessionId, transcriptPath);
}

function promptCandidate(currentPrompt) {
  return currentPrompt;
}

function stopCandidate(transcriptPath) {
  return stopTranscriptText(transcriptPath);
}

function inferPromptCandidate(db, sessionId, currentPrompt) {
  if (!shouldRunPromptInference(promptCandidate(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function inferStopCandidate(db, sessionId, transcriptPath) {
  const text = stopCandidate(transcriptPath);
  if (!text) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferPromptSubmitCandidate(db, sessionId, currentPrompt) {
  inferPromptCandidate(db, sessionId, currentPrompt);
}

function inferStopCandidateOutcome(db, sessionId, transcriptPath) {
  inferStopCandidate(db, sessionId, transcriptPath);
}

function promptText(currentPrompt) {
  return currentPrompt;
}

function stopText(transcriptPath) {
  return stopCandidate(transcriptPath);
}

function shouldUsePromptText(text) {
  return shouldApplyNegativePrompt(text);
}

function shouldUseStopText(text) {
  return Boolean(text);
}

function runPromptTextInference(db, sessionId, currentPrompt) {
  if (!shouldUsePromptText(promptText(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function runStopTextInference(db, sessionId, transcriptPath) {
  const text = stopText(transcriptPath);
  if (!shouldUseStopText(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function promptTextInference(db, sessionId, currentPrompt) {
  runPromptTextInference(db, sessionId, currentPrompt);
}

function stopTextInference(db, sessionId, transcriptPath) {
  runStopTextInference(db, sessionId, transcriptPath);
}

function inferPromptTextOutcome(db, sessionId, currentPrompt) {
  promptTextInference(db, sessionId, currentPrompt);
}

function inferStopTextOutcome(db, sessionId, transcriptPath) {
  stopTextInference(db, sessionId, transcriptPath);
}

function finalPromptInference(db, sessionId, currentPrompt) {
  inferPromptTextOutcome(db, sessionId, currentPrompt);
}

function finalStopInference(db, sessionId, transcriptPath) {
  inferStopTextOutcome(db, sessionId, transcriptPath);
}

function promptInferenceText(currentPrompt) {
  return currentPrompt;
}

function stopInferenceText(transcriptPath) {
  return stopText(transcriptPath);
}

function hasPromptInferenceText(text) {
  return shouldApplyNegativePrompt(text);
}

function hasStopInferenceText(text) {
  return Boolean(text);
}

function maybeApplyPromptInference(db, sessionId, currentPrompt) {
  if (!hasPromptInferenceText(promptInferenceText(currentPrompt))) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

function maybeApplyStopInference(db, sessionId, transcriptPath) {
  const text = stopInferenceText(transcriptPath);
  if (!hasStopInferenceText(text)) {
    return;
  }

  if (hasSelfCorrection(text)) {
    updateSelfCorrection(db, sessionId);
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function applyPromptSubmitInference(db, sessionId, currentPrompt) {
  maybeApplyPromptInference(db, sessionId, currentPrompt);
}

function applyStopHookInference(db, sessionId, transcriptPath) {
  maybeApplyStopInference(db, sessionId, transcriptPath);
}

function promptSubmitInference(db, sessionId, currentPrompt) {
  applyPromptSubmitInference(db, sessionId, currentPrompt);
}

function stopHookInference(db, sessionId, transcriptPath) {
  applyStopHookInference(db, sessionId, transcriptPath);
}

function inferPromptSubmitHook(db, sessionId, currentPrompt) {
  promptSubmitInference(db, sessionId, currentPrompt);
}

function inferStopHook(db, sessionId, transcriptPath) {
  stopHookInference(db, sessionId, transcriptPath);
}

function maybeInferPrompt(db, sessionId, currentPrompt) {
  inferPromptSubmitHook(db, sessionId, currentPrompt);
}

function maybeInferStop(db, sessionId, transcriptPath) {
  inferStopHook(db, sessionId, transcriptPath);
}

function handlePrompt(db, sessionId, currentPrompt) {
  maybeInferPrompt(db, sessionId, currentPrompt);
}

function handleStop(db, sessionId, transcriptPath) {
  maybeInferStop(db, sessionId, transcriptPath);
}

function inferPromptSubmitState(db, sessionId, currentPrompt) {
  handlePrompt(db, sessionId, currentPrompt);
}

function inferStopState(db, sessionId, transcriptPath) {
  handleStop(db, sessionId, transcriptPath);
}

function applyPromptState(db, sessionId, currentPrompt) {
  inferPromptSubmitState(db, sessionId, currentPrompt);
}

function applyStopState(db, sessionId, transcriptPath) {
  inferStopState(db, sessionId, transcriptPath);
}

function promptState(db, sessionId, currentPrompt) {
  applyPromptState(db, sessionId, currentPrompt);
}

function stopState(db, sessionId, transcriptPath) {
  applyStopState(db, sessionId, transcriptPath);
}

function inferPromptState(db, sessionId, currentPrompt) {
  promptState(db, sessionId, currentPrompt);
}

function inferStopStateOutcome(db, sessionId, transcriptPath) {
  stopState(db, sessionId, transcriptPath);
}

function inferPromptResult(db, sessionId, currentPrompt) {
  inferPromptState(db, sessionId, currentPrompt);
}

function inferStopResult(db, sessionId, transcriptPath) {
  inferStopStateOutcome(db, sessionId, transcriptPath);
}

function promptResult(db, sessionId, currentPrompt) {
  inferPromptResult(db, sessionId, currentPrompt);
}

function stopResult(db, sessionId, transcriptPath) {
  inferStopResult(db, sessionId, transcriptPath);
}

function runPromptResult(db, sessionId, currentPrompt) {
  promptResult(db, sessionId, currentPrompt);
}

function runStopResult(db, sessionId, transcriptPath) {
  stopResult(db, sessionId, transcriptPath);
}

function inferPromptValue(db, sessionId, currentPrompt) {
  runPromptResult(db, sessionId, currentPrompt);
}

function inferStopValue(db, sessionId, transcriptPath) {
  runStopResult(db, sessionId, transcriptPath);
}

function promptValue(db, sessionId, currentPrompt) {
  inferPromptValue(db, sessionId, currentPrompt);
}

function stopValue(db, sessionId, transcriptPath) {
  inferStopValue(db, sessionId, transcriptPath);
}

function inferPromptFinal(db, sessionId, currentPrompt) {
  promptValue(db, sessionId, currentPrompt);
}

function inferStopFinal(db, sessionId, transcriptPath) {
  stopValue(db, sessionId, transcriptPath);
}

function promptFinal(db, sessionId, currentPrompt) {
  inferPromptFinal(db, sessionId, currentPrompt);
}

function stopFinal(db, sessionId, transcriptPath) {
  inferStopFinal(db, sessionId, transcriptPath);
}

function maybePromptFinal(db, sessionId, currentPrompt) {
  promptFinal(db, sessionId, currentPrompt);
}

function maybeStopFinal(db, sessionId, transcriptPath) {
  stopFinal(db, sessionId, transcriptPath);
}

function inferPromptSubmitFinal(db, sessionId, currentPrompt) {
  maybePromptFinal(db, sessionId, currentPrompt);
}

function inferStopHookFinal(db, sessionId, transcriptPath) {
  maybeStopFinal(db, sessionId, transcriptPath);
}

function promptSubmitFinal(db, sessionId, currentPrompt) {
  inferPromptSubmitFinal(db, sessionId, currentPrompt);
}

function stopHookFinal(db, sessionId, transcriptPath) {
  inferStopHookFinal(db, sessionId, transcriptPath);
}

function runPromptSubmitFinal(db, sessionId, currentPrompt) {
  promptSubmitFinal(db, sessionId, currentPrompt);
}

function runStopHookFinal(db, sessionId, transcriptPath) {
  stopHookFinal(db, sessionId, transcriptPath);
}

function finalPromptSubmit(db, sessionId, currentPrompt) {
  runPromptSubmitFinal(db, sessionId, currentPrompt);
}

function finalStopHook(db, sessionId, transcriptPath) {
  runStopHookFinal(db, sessionId, transcriptPath);
}

function inferPromptNow(db, sessionId, currentPrompt) {
  finalPromptSubmit(db, sessionId, currentPrompt);
}

function inferStopNow(db, sessionId, transcriptPath) {
  finalStopHook(db, sessionId, transcriptPath);
}

function executePromptInference(db, sessionId, currentPrompt) {
  inferPromptNow(db, sessionId, currentPrompt);
}

function executeStopInference(db, sessionId, transcriptPath) {
  inferStopNow(db, sessionId, transcriptPath);
}

function performPromptInference(db, sessionId, currentPrompt) {
  executePromptInference(db, sessionId, currentPrompt);
}

function performStopInference(db, sessionId, transcriptPath) {
  executeStopInference(db, sessionId, transcriptPath);
}

function applyPromptInferenceNow(db, sessionId, currentPrompt) {
  performPromptInference(db, sessionId, currentPrompt);
}

function applyStopInferenceNow(db, sessionId, transcriptPath) {
  performStopInference(db, sessionId, transcriptPath);
}

function inferPromptImmediate(db, sessionId, currentPrompt) {
  applyPromptInferenceNow(db, sessionId, currentPrompt);
}

function inferStopImmediate(db, sessionId, transcriptPath) {
  applyStopInferenceNow(db, sessionId, transcriptPath);
}

function currentAssistantText(transcriptPath) {
  return getLastAssistantText(transcriptPath);
}

function canInferFromAssistant(text) {
  return Boolean(text);
}

function inferImplicitReference(db, sessionId, transcriptPath) {
  const text = currentAssistantText(transcriptPath);
  if (!canInferFromAssistant(text) || isSelfCorrection(text)) {
    return;
  }

  updateImplicitHelpful(db, sessionId, text);
}

function inferAssistantSelfCorrection(db, sessionId, transcriptPath) {
  const text = currentAssistantText(transcriptPath);
  if (!canInferFromAssistant(text) || !isSelfCorrection(text)) {
    return;
  }

  updateSelfCorrection(db, sessionId);
}

function inferNegativeCurrentPrompt(db, sessionId, currentPrompt) {
  if (!isNegativeFeedback(currentPrompt)) {
    return;
  }

  updateNegativePrompt(db, sessionId);
}

export function inferPrevTurnOutcome(db, sessionId, currentPrompt) {
  inferNegativeCurrentPrompt(db, sessionId, currentPrompt);
}

export function inferFromTranscript(db, sessionId, transcriptPath) {
  inferAssistantSelfCorrection(db, sessionId, transcriptPath);
}

export function inferL25FromTranscript(db, sessionId, transcriptPath) {
  inferImplicitReference(db, sessionId, transcriptPath);
}

export function inferPositiveFeedback(db, sessionId, prompt, queryVec) {
  if (!queryVec) {
    return;
  }

  const cfg = loadConfig().feedback?.l1_positive ?? {};
  const text = String(prompt ?? '').trim();
  if (!AFFIRMATIVE.test(text) || AFFIRMATIVE_NEGATED.test(text)) {
    return;
  }

  const row = db.prepare(
    `SELECT id, injected_ids
     FROM memory_feedback
     WHERE session_id = ?
       AND outcome = 'unknown'
       AND outcome_locked = 0
       AND injection_source = 'user_prompt_submit'
     ORDER BY recorded_at DESC
     LIMIT 1`
  ).get(sessionId);
  if (!row) {
    return;
  }

  const injectedIds = parseJsonArray(row.injected_ids)
    .map((id) => Number(id))
    .filter(Number.isFinite);
  if (!injectedIds.length) {
    return;
  }

  const memories = db.prepare(
    `SELECT id, embedding
     FROM memories
     WHERE id IN (${injectedIds.map(() => '?').join(',')})
       AND embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all(...injectedIds);
  if (!memories.length) {
    return;
  }

  let bestId = null;
  let bestCosine = -1;
  for (const memory of memories) {
    const score = cosineSimilarity(queryVec, blobToVec(memory.embedding));
    if (score > bestCosine) {
      bestCosine = score;
      bestId = memory.id;
    }
  }

  const threshold = Number(cfg.cosine_threshold ?? 0.65);
  if (bestId == null || bestCosine < threshold) {
    return;
  }

  applyOutcomeToSubset(db, row.id, [bestId], 'helpful_implicit', `l1_positive_cosine:${bestCosine.toFixed(3)}`);
}
