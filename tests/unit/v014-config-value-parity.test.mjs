import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

/**
 * Test A of the two-part config-consistency split.
 *
 * `v013-config-sync.test.mjs` already compares `version` and the set of key
 * paths. Shape parity passed while a VALUE could differ on the two sides — the
 * documented default a user reads in config.default.json would then not be the
 * default the runtime actually applies, and nothing would say so.
 *
 * Why this is a SEPARATE test rather than more asserts in the sync test: the
 * failure signals must stay distinguishable. Shape drift is a different defect
 * with a different fix than value drift, and `block_user_explicit` proved a
 * third kind exists — value-consistent, shape-consistent, and dead. That third
 * one is test B's job (see specs/2026-08-14-default-config-dead-keys.md);
 * this file deliberately says nothing about whether a key has a consumer.
 *
 * Keys prefixed with `_` are documentation-only: config.default.json is JSON
 * and cannot carry comments. Arrays are leaves — their contents are values.
 */
function leafValues(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      leafValues(child, keyPath, out);
    } else {
      out.set(keyPath, child);
    }
  }
  return out;
}

function valueDrift(fileConfig, runtimeConfig) {
  const fileLeaves = leafValues(fileConfig);
  const runtimeLeaves = leafValues(runtimeConfig);
  const drift = [];
  // Only shared paths: paths present on one side alone are SHAPE drift, and
  // v013-config-sync.test.mjs owns that signal. Reporting it here too would
  // make one defect turn two tests red and blur which one to act on.
  for (const [keyPath, runtimeValue] of runtimeLeaves) {
    if (!fileLeaves.has(keyPath)) continue;
    const fileValue = fileLeaves.get(keyPath);
    if (JSON.stringify(fileValue) !== JSON.stringify(runtimeValue)) {
      drift.push(`  ${keyPath}: config.default.json = ${JSON.stringify(fileValue)}, DEFAULT_CONFIG = ${JSON.stringify(runtimeValue)}`);
    }
  }
  return drift;
}

test('config.default.json and DEFAULT_CONFIG agree on every shared leaf VALUE', () => {
  const fileConfig = JSON.parse(readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));
  const drift = valueDrift(fileConfig, DEFAULT_CONFIG);

  assert.deepEqual(drift, [],
    'the documented default and the applied default have drifted:\n' + drift.join('\n'));
});

/**
 * A green regression guard is worth nothing until it is shown it can go red.
 * This repo has already been burned once by tests that passed while testing
 * the wrong checkout ("547/547 green" included two files pointing at another
 * repository), so "it passes" is not accepted here as evidence that it looks.
 *
 * Built entirely from synthetic fixtures, NOT from the real config pair: this
 * test must answer "is the comparator awake" and nothing else. An earlier draft
 * asserted the real pair was clean as a precondition, which made one genuine
 * drift turn BOTH tests in this file red — destroying the very signal
 * separation this file exists to keep (see the header comment).
 */
test('the comparison actually detects value drift (guard against a vacuous test)', () => {
  const base = { embedding: { openai_timeout_ms: 1200, model: 'x' }, list: [1, 2] };

  assert.deepEqual(valueDrift(base, structuredClone(base)), [],
    'identical inputs must produce no drift');

  const changed = structuredClone(base);
  changed.embedding.openai_timeout_ms = 1201;
  const drift = valueDrift(changed, base);
  assert.equal(drift.length, 1, 'a one-value change must produce exactly one drift row');
  assert.match(drift[0], /embedding\.openai_timeout_ms/);

  // Arrays are leaves: a changed element is value drift, not shape drift.
  const arrayChanged = structuredClone(base);
  arrayChanged.list = [1, 3];
  assert.equal(valueDrift(arrayChanged, base).length, 1, 'array contents must be compared');

  // Shape-only difference belongs to v013-config-sync, so it must NOT show up here.
  const extra = structuredClone(base);
  extra.embedding.brand_new_key = true;
  assert.deepEqual(valueDrift(extra, base), [], 'a path missing on one side is shape drift, not value drift');
});
