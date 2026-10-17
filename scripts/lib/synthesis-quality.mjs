import { loadConfig } from './config.mjs';

// The length cap a synthesized memory of this output type must meet.
export function synthesisMaxChars(outputType) {
  const cfg = loadConfig();
  const fallbackMax = Number(cfg.save?.max_chars_per_memory ?? 500);
  const quality = cfg.consolidation?.quality ?? {};
  return outputType === 'rule'
    ? Number(quality.rule_max_chars ?? fallbackMax)
    : Number(quality.consolidated_max_chars ?? fallbackMax);
}

export function scoreSynthesisOutput(_db, synthesized, batch) {
  const batchIds = new Set((batch ?? []).map((memory) => Number(memory.id)));
  const validSources = (synthesized?.source_ids ?? []).filter((id) => batchIds.has(Number(id)));

  if (!validSources.length) {
    return { pass: false, reason: 'source_invalid', score: 0 };
  }

  const maxLen = synthesisMaxChars(synthesized?.output_type === 'rule' ? 'rule' : 'consolidated');

  // Over-long output is rejected, never sliced to fit (spec A2): the caller
  // rewrites it to this limit first, so reaching here over it is a real reject.
  if (typeof synthesized?.content === 'string' && Number.isFinite(maxLen) && synthesized.content.length > maxLen) {
    return { pass: false, reason: 'too_long', score: 0 };
  }

  return { pass: true, reason: null, score: 1 };
}
