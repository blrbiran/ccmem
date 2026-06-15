import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuality } from '../../scripts/lib/quality-gate.mjs';

test('checkQuality rejects short version snapshots', () => {
  assert.deepEqual(checkQuality('schema version 10'), {
    pass: false,
    reason: 'version_snapshot'
  });
});

test('checkQuality rejects test-count summaries after min length passes', () => {
  assert.deepEqual(checkQuality('regression summary 961/961 pass'), {
    pass: false,
    reason: 'test_count'
  });
});

test('checkQuality rejects timestamp-dominant content', () => {
  assert.deepEqual(checkQuality('2026-06-13 2026-06-13 2026-06-13 parser note'), {
    pass: false,
    reason: 'timestamp_dominant'
  });
});

test('checkQuality rejects plain path lists after too_specific is disabled', () => {
  assert.deepEqual(checkQuality('scripts/lib/a.mjs scripts/lib/b.mjs scripts/lib/c.mjs', {
    rules_enabled: { too_specific: false }
  }), {
    pass: false,
    reason: 'path_list'
  });
});

test('checkQuality allows disabling a specific rule', () => {
  assert.deepEqual(checkQuality('schema version 10', {
    rules_enabled: { version_snapshot: false }
  }), {
    pass: true,
    reason: null
  });
});
