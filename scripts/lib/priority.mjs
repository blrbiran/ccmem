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

export function effectiveHalfLifeDays(mem) {
  if (mem?.temporal_type === 'permanent') {
    return Number.POSITIVE_INFINITY;
  }

  const halfLife = Number(mem?.half_life_days ?? 60);
  return Number.isFinite(halfLife) && halfLife > 0 ? halfLife : 60;
}

export function computePriority(mem) {
  const base = {
    rule: 1.8,
    fact: 1.2,
    episode: 0.8,
    consolidated: Math.min(1.5 + (0.2 * Number(mem?.consolidation_depth ?? 0)), 2.5)
  }[mem?.type] ?? 1.0;

  const lastTouchedAt = Number(mem?.last_touched_at ?? Date.now());
  const daysSinceTouched = Math.max(0, (Date.now() - lastTouchedAt) / 86400000);
  const trustScore = Number(mem?.trust_score ?? 0);

  return base
    * recencyFactor(daysSinceTouched, effectiveHalfLifeDays(mem))
    * frequencyFactor(Number(mem?.helpful_count ?? 0), Number(mem?.unhelpful_count ?? 0), trustScore)
    * Math.max(trustScore, 0.2);
}
