import { loadConfig } from './config.mjs';

export function scoreSynthesisOutput(_db, synthesized, batch) {
  const cfg = loadConfig().consolidation?.quality ?? {};
  const batchIds = new Set((batch ?? []).map((memory) => Number(memory.id)));
  const validSources = (synthesized?.source_ids ?? []).filter((id) => batchIds.has(Number(id)));

  if (!validSources.length) {
    return { pass: false, reason: 'source_invalid', score: 0 };
  }

  const outputType = synthesized?.output_type === 'rule' ? 'rule' : 'consolidated';
  const maxLen = outputType === 'consolidated'
    ? Number(cfg.consolidated_max_chars ?? 160)
    : Number(cfg.rule_max_chars ?? 300);

  if (typeof synthesized?.content === 'string' && Number.isFinite(maxLen) && synthesized.content.length > maxLen) {
    synthesized.content = synthesized.content.slice(0, maxLen);
  }

  return { pass: true, reason: null, score: 1 };
}
