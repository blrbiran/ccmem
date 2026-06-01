import test from 'node:test';
import assert from 'node:assert/strict';
import { getSourceInitialTrust } from '../../scripts/lib/trust.mjs';

test('user_explicit starts above external', () => {
  assert.ok(getSourceInitialTrust('user_explicit') > getSourceInitialTrust('external'));
});
