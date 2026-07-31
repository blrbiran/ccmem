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

// C2 regression. The memory side is normalized to alphanumeric runs joined by
// single spaces before it reaches this function, so the reply MUST be
// normalized the same way. Searching the raw reply makes a perfect verbatim
// quote score 3/7 here — two commas truncate it — which would make v0.14's
// analyst conclude l25_lcp carries no signal when in fact the measurement was
// broken. Comma-separated convention memories are the dominant form ccmem's
// extractor produces, so this is not an edge case.
test('longestCommonPhrase scores a verbatim quote at its full word count despite punctuation in the reply', () => {
  const memory = 'Use pnpm, not npm, for installing dependencies';
  const memWords = [...memory.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
  assert.equal(memWords.length, 7, 'fixture sanity: the memory is 7 words');

  assert.equal(
    longestCommonPhrase(memWords, 'You should use pnpm, not npm, for installing dependencies in this repo.'),
    7,
    'a verbatim match must score the FULL word count; searching the raw reply scores 3 because the first comma breaks the run'
  );
});

// The same asymmetry in CJK clothing: CJK replies carry full-width punctuation
// (，。、) between runs, which truncated the phrase exactly the same way.
test('longestCommonPhrase is not truncated by full-width CJK punctuation in the reply', () => {
  assert.equal(
    longestCommonPhrase(['总是', '使用', '拼音输入法'], '好的，总是、使用。拼音输入法'),
    3,
    'full-width punctuation between CJK runs must not break the verbatim run'
  );
});
