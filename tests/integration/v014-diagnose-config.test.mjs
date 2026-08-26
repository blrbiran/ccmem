import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Module-level data root, set BEFORE importing anything that reads it. This is
// the established pattern in this repo (see admin-diagnose-command.test.mjs and
// plist-drift.test.mjs): `npm test` gives every test file ONE shared
// CCMEM_DATA_ROOT, and getConfigPath() is $CCMEM_DATA_ROOT/config.json — so a
// config.json written into the shared root would be visible to every other test
// file's loadConfig(). node --test runs each file in its own process, which is
// what makes overriding the variable here safe.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-config-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

const db = openDb();

/**
 * Task 1 proves the diff logic. This file proves the WIRING: that diagnose
 * actually calls it and actually publishes the result. Those fail separately —
 * a correct diff nobody reads is precisely the failure W0 exists to prevent.
 *
 * The injected cfg starts from a clone of DEFAULT_CONFIG rather than a hand-
 * written object so this file asserts nothing about what DEFAULT_CONFIG
 * contains. The one exception is the top-level `version` key, which
 * v013-config-sync.test.mjs already depends on.
 */

test('a config identical to the defaults produces two empty arrays', async () => {
  const result = await cmdAdminDiagnose(db, { cfg: structuredClone(DEFAULT_CONFIG) });

  assert.deepEqual(result.config.non_default_keys, []);
  assert.deepEqual(result.config.unknown_keys, []);
});

test('an off-default value reaches result.config.non_default_keys', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.version = 'w0-probe';

  const result = await cmdAdminDiagnose(db, { cfg });

  assert.deepEqual(result.config.non_default_keys, ['version']);
  assert.deepEqual(result.config.unknown_keys, []);
});

test('a key ccmem does not know reaches result.config.unknown_keys', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.zz_w0_probe = { sample: 1 };

  const result = await cmdAdminDiagnose(db, { cfg });

  assert.deepEqual(result.config.non_default_keys, []);
  assert.deepEqual(result.config.unknown_keys, ['zz_w0_probe.sample']);
});

test('result.config carries paths only, never the values behind them', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.version = 'secret-looking-value';

  const result = await cmdAdminDiagnose(db, { cfg });

  // embedding.openai_api_key is a non-default key the moment an operator sets
  // it. Anything that lets a value ride along with the path leaks credentials.
  assert.equal(JSON.stringify(result.config).includes('secret-looking-value'), false);
});
