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

test('featureTokens joins a mixed CJK+latin string into the CJK run plus the latin token', () => {
  const t = featureTokens('这个项目使用 pnpm');
  assert.ok(t.has('pnpm'));
  // The old ">1" assertion here passed solely because of the latin "pnpm"
  // token and created false confidence that CJK is tokenized usefully — see
  // the dedicated test below for the actual (documented) limitation.
  assert.equal(t.size, 2, 'exactly one CJK-run token plus one latin token');
});

test('featureTokens treats an unbroken CJK run as a single token (documented limitation)', () => {
  const t = featureTokens('这个项目使用拼音输入法');
  assert.equal(t.size, 1,
    'CJK is not word-segmented — a whole run collapses to one token, which is ' +
    'why the probe records has_cjk so v0.14 can segment the distribution');
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
