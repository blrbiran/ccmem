import test from 'node:test';
import assert from 'node:assert/strict';
import {
  featureTokens,
  memoryCoverage,
  longestCommonPhrase
} from '../../scripts/lib/feedback.mjs';

test('featureTokens lowercases and drops single-character tokens', () => {
  const t = featureTokens('Use PNPM a b');
  assert.ok(t.has('use'));
  assert.ok(t.has('pnpm'));
  assert.equal(t.has('a'), false, 'single-char tokens are noise');
});

test('featureTokens handles CJK text', () => {
  const t = featureTokens('这个项目使用 pnpm');
  assert.ok(t.has('pnpm'));
  assert.ok(t.size > 1, 'CJK run must produce at least one token');
});

test('memoryCoverage is the fraction of memory tokens present in the reply', () => {
  const mem = featureTokens('use pnpm not npm');
  const reply = featureTokens('we should use pnpm here');
  // memory tokens: use, pnpm, not, npm -> reply contains use, pnpm => 2/4
  assert.equal(memoryCoverage(mem, reply), 0.5);
});

test('memoryCoverage returns 0 for an empty memory rather than dividing by zero', () => {
  assert.equal(memoryCoverage(new Set(), featureTokens('anything')), 0);
});

test('longestCommonPhrase finds the longest verbatim run of words', () => {
  const memWords = ['always', 'use', 'pnpm', 'in', 'this', 'repo'];
  assert.equal(longestCommonPhrase(memWords, 'I will always use pnpm in this repo now'), 6);
});

test('longestCommonPhrase returns 0 when nothing overlaps', () => {
  assert.equal(longestCommonPhrase(['alpha', 'beta'], 'completely different text'), 0);
});
