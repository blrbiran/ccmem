export function recencyFactor(daysSinceTouched, halfLifeDays) {
  return Math.pow(0.5, daysSinceTouched / halfLifeDays);
}

export function frequencyFactor(helpfulCount, unhelpfulCount, trustScore) {
  const signal = helpfulCount - (2.0 * unhelpfulCount);

  if (signal >= 0) {
    return Math.min(1 + (0.08 * signal * trustScore), 1.8);
  }

  return Math.max(0.1, 1 / (1 + 0.15 * Math.abs(signal)));
}

export function computePriority(mem) {
  const base = {
    rule: 1.8,
    fact: 1.2,
    episode: 0.8,
    consolidated: Math.min(1.5 + 0.2 * mem.consolidation_depth, 2.5)
  }[mem.type] ?? 1.0;

  const daysSinceTouched = (Date.now() - mem.last_touched_at) / 86400000;

  return base
    * recencyFactor(daysSinceTouched, mem.half_life_days)
    * frequencyFactor(mem.helpful_count, mem.unhelpful_count, mem.trust_score)
    * Math.max(mem.trust_score, 0.2);
}
