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

test('permanent temporal_type does not decay', () => {
  const score = computePriority({
    type: 'consolidated',
    trust_score: 0.9,
    helpful_count: 0,
    unhelpful_count: 0,
    half_life_days: 7,
    temporal_type: 'permanent',
    last_touched_at: Date.now() - (200 * 86400000),
    consolidation_depth: 0,
    pinned: 0
  });

  assert.ok(score > 0.5, `expected non-decayed priority, got ${score}`);
});
