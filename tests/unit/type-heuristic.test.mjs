import test from 'node:test';
import assert from 'node:assert/strict';
import { inferType } from '../../scripts/lib/type-heuristic.mjs';

test('inferType returns rule for explicit instruction language', () => {
  assert.equal(inferType('必须用 TypeScript').type, 'rule');
  assert.equal(inferType('always use pnpm').type, 'rule');
});

test('inferType falls back to fact', () => {
  assert.equal(inferType('Repository uses App Router').type, 'fact');
});
