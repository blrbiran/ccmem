import test from 'node:test';
import assert from 'node:assert/strict';

import { collectConfigDeltas } from '../../scripts/lib/config-delta.mjs';

/**
 * W0's job is to make a non-default switch impossible to miss. That only works
 * if the report is trusted, and a report is trusted only while it has no false
 * positives — an operator who once sees a key they never touched learns to
 * ignore the whole line, which is worse than not printing it at all.
 *
 * Every case below is a specific way the diff could lie. They use synthetic
 * fixtures on BOTH sides: a test that reads the real DEFAULT_CONFIG would go
 * red whenever the product's defaults change, which is drift detection, not
 * delta-logic verification, and it already has an owner (v013-config-sync).
 */

test('a key whose value equals the default is not reported', () => {
  const base = { a: 1, nested: { b: 'x' } };
  const cfg = { a: 1, nested: { b: 'x' } };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('a key whose value differs from the default is reported by path only', () => {
  const base = { a: 1, nested: { b: 'x' } };
  const cfg = { a: 1, nested: { b: 'CHANGED' } };

  const deltas = collectConfigDeltas(cfg, base);

  assert.deepEqual(deltas.nonDefault, ['nested.b']);
  assert.deepEqual(deltas.unknown, []);
  // The value must never travel with the path: openai_api_key is a non-default
  // key the moment an operator sets it, and this repo forbids printing config
  // contents. Asserting the shape is how that stays true after a refactor.
  assert.equal(JSON.stringify(deltas).includes('CHANGED'), false);
});

test('a scalar the base does not know about is reported as unknown', () => {
  const base = { a: 1 };
  const cfg = { a: 1, stray: 7 };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: ['stray'] });
});

test('a whole subtree the base does not know about is reported down to its leaves', () => {
  const base = { a: 1 };
  const cfg = { a: 1, stray: { deep: { leaf: 7 }, other: 8 } };

  // Reporting the subtree root instead would hide how many keys are actually
  // orphaned, and the operator's next move is to delete specific lines from
  // their config.json — they need the lines, not the section.
  assert.deepEqual(collectConfigDeltas(cfg, base).unknown, ['stray.deep.leaf', 'stray.other']);
});

test('a path the base has and the config lacks is ignored entirely', () => {
  const base = { a: 1, only_in_base: { deep: 2 } };
  const cfg = { a: 1 };

  // mergeConfig starts from a deep clone of the base, so in production every
  // base key survives — this branch is unreachable there. It is reachable in
  // tests that inject a partial cfg, and if it reported anything, every unit
  // test would have to carry a full DEFAULT_CONFIG replica, which defeats the
  // synthetic-fixture decision this whole file rests on.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('a scalar standing where the base has an object is reported at that path and not below', () => {
  const base = { section: { x: 1, y: 2 } };
  const cfg = { section: 5 };

  // Writing "section": 5 makes mergeConfig replace the entire subtree with 5,
  // so section.x and section.y stop existing. Recursing would emit misleading
  // child paths; the honest statement is that `section` itself is off-default.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: ['section'], unknown: [] });
});

test('an object standing where the base has a scalar is reported at that path and not below', () => {
  const base = { section: 5 };
  const cfg = { section: { x: 1 } };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: ['section'], unknown: [] });
});

test('underscore-prefixed documentation keys are skipped on both sides', () => {
  const base = { a: 1, _base_doc: 'ignored' };
  const cfg = { a: 1, _comment: 'config.default.json carries two of these' };

  // config.default.json is the template operators copy, and JSON cannot carry
  // comments, so it documents itself with _comment keys that DEFAULT_CONFIG
  // does not have. Without this rule every config started from the template
  // reports two unknown keys on day one.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('arrays are leaves: compared by content, never descended into', () => {
  const base = { list: [1, 2, 3] };

  assert.deepEqual(collectConfigDeltas({ list: [1, 2, 3] }, base).nonDefault, []);
  assert.deepEqual(collectConfigDeltas({ list: [1, 2] }, base).nonDefault, ['list']);
  // Descending would emit list.0 / list.1, which are not config keys anyone
  // can set in config.json.
  assert.deepEqual(collectConfigDeltas({ list: [9, 2, 3] }, base).nonDefault, ['list']);
});

test('both arrays come back sorted so callers can assert them directly', () => {
  const base = { zeta: 1, alpha: 1 };
  const cfg = { zeta: 2, alpha: 2, z_stray: 1, a_stray: 1 };

  const deltas = collectConfigDeltas(cfg, base);

  assert.deepEqual(deltas.nonDefault, ['alpha', 'zeta']);
  assert.deepEqual(deltas.unknown, ['a_stray', 'z_stray']);
});

test('an unknown section with no reportable keys is still reported, at the section itself', () => {
  const base = { a: 1 };

  // Second exception to "objects produce no path" (the first is the scalar/
  // object-mismatch case above): a subtree with zero leaves — because it's
  // empty, or because every key inside it is a `_`-prefixed doc key — has
  // nothing to descend into, so descending would silently drop it from the
  // report. An empty or documentation-only section is still something the
  // operator wrote; the honest statement is the section path itself.
  assert.deepEqual(collectConfigDeltas({ a: 1, stray: {} }, base).unknown, ['stray']);
  assert.deepEqual(collectConfigDeltas({ a: 1, stray: { _c: 'x' } }, base).unknown, ['stray']);
});

test('an empty result is two empty arrays, never null and never a missing field', () => {
  const deltas = collectConfigDeltas({ a: 1 }, { a: 1 });

  // Omitting the fields would make "the mechanism did not run" and "the
  // mechanism ran and found nothing" indistinguishable, which is exactly the
  // failure the diagnose line exists to prevent.
  assert.deepEqual(Object.keys(deltas).sort(), ['nonDefault', 'unknown']);
  assert.deepEqual(deltas.nonDefault, []);
  assert.deepEqual(deltas.unknown, []);
});
