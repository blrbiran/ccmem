import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSafePattern } from '../../scripts/lib/pattern-safety.mjs';
import { cleanTranscript } from '../../scripts/lib/transcript-cleaner.mjs';

test('cleanTranscript applies extra_rules when patterns are valid', () => {
  const input = [
    'keep this',
    'BEGIN NOISE',
    'noise line',
    'END NOISE',
    'keep that'
  ].join('\n');

  const result = cleanTranscript(input, {
    extra_rules: [
      {
        name: 'custom_noise',
        start_pattern: '^BEGIN NOISE$',
        end_pattern: '^END NOISE$'
      }
    ]
  });

  assert.equal(result.cleaned, 'keep this\nkeep that');
  assert.deepEqual(result.rules_hit, ['custom_noise']);
});

test('cleanTranscript ignores invalid extra_rules patterns', () => {
  const input = 'keep this\nBEGIN NOISE\nnoise\nEND NOISE\nkeep that';
  const result = cleanTranscript(input, {
    extra_rules: [
      {
        name: 'broken',
        start_pattern: '(',
        end_pattern: '^END NOISE$'
      }
    ]
  });

  assert.match(result.cleaned, /BEGIN NOISE/);
  assert.deepEqual(result.rules_hit, []);
});

test('compileSafePattern rejects nested-quantifier patterns', () => {
  assert.equal(compileSafePattern('(a+)+$'), null);
});

test('compileSafePattern rejects backreferences', () => {
  assert.equal(compileSafePattern('(foo)\\1'), null);
});
