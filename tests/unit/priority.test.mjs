import test from 'node:test';
import assert from 'node:assert/strict';
import { computePriority } from '../../scripts/lib/priority.mjs';

test('computePriority increases with pinned high-trust recent memories', () => {
  const score = computePriority({
    type: 'rule',
    consolidation_depth: 0,
    last_touched_at: Date.now(),
    half_life_days: 60,
    helpful_count: 2,
    unhelpful_count: 0,
    trust_score: 0.9
  });

  assert.ok(score > 1);
});
