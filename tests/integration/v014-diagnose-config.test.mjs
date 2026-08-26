import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-level data root, set BEFORE importing anything that reads it. This is
// the established pattern in this repo (see admin-diagnose-command.test.mjs and
// plist-drift.test.mjs): `npm test` gives every test file ONE shared
// CCMEM_DATA_ROOT, and getConfigPath() is $CCMEM_DATA_ROOT/config.json — so a
// config.json written into the shared root would be visible to every other test
// file's loadConfig(). node --test runs each file in its own process, which is
// what makes overriding the variable here safe.
//
// The spawned-CLI tests below have a second hazard: loadConfig() gives
// CCMEM_CONFIG_PATH priority over the data-root config path (scripts/lib/config.mjs
// :317-320). If that variable is set in the environment this file runs in, an
// inherited value silently points the spawned CLI at the operator's real config
// instead of the config.json the test just wrote — so runDiagnose() must not let
// the child inherit it.
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

// Spawning the real CLI is the ONLY test in this plan that exercises the real
// loadConfig() -> collectConfigDeltas -> stdout path. The in-process tests above
// inject cfg, so they can all stay green while the wiring from the config file
// to the printed line is broken. Do not "optimise" this into an in-process call.
//
// It runs scripts/cli.mjs directly rather than ./bin/ccmem: bin/ccmem ends with
// `exec node …`, and the `node` on PATH here is nvm v22.13.1, a different
// interpreter from the /usr/local/bin/node v24.13.0 that npm test and the real
// daemon use.
const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

function runDiagnose(configJson, extraArgs = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-cli-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-cwd-'));

  if (configJson !== null) {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify(configJson), 'utf8');
  }

  const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: root };
  delete env.CCMEM_CONFIG_PATH;

  return execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', ...extraArgs], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

test('the default diagnose output reports the config line when there is no config.json', () => {
  // A brand-new install has no config.json at all. The line must still appear:
  // a line that shows up only when there is something to say is indistinguishable
  // from a mechanism that is not running, which is how eight config keys in this
  // repo stayed dead across eleven versions.
  const output = runDiagnose(null);

  assert.match(output, /^ccmem: config 0 non-default keys, 0 unknown keys$/m);
});

test('documentation keys copied from the template do not show up as unknown', () => {
  // config.default.json is the file operators copy, and it carries two _comment
  // keys because JSON cannot hold comments. If those were reported, every
  // template-derived config would show two phantom unknown keys on day one.
  const output = runDiagnose({ _comment: 'documentation, not configuration' });

  assert.match(output, /^ccmem: config 0 non-default keys, 0 unknown keys$/m);
});

test('the default output counts a real off-default value and a real unknown key', () => {
  const output = runDiagnose({ version: 'w0-probe', zz_w0_probe: { sample: 1 } });

  assert.match(output, /^ccmem: config 1 non-default key, 1 unknown key$/m);
});

test('--config lists every key under a summary line identical to the default one', () => {
  const output = runDiagnose(
    { version: 'w0-probe', zz_w0_probe: { sample: 1 } },
    ['--config']
  );

  // The summary line is byte-identical to the one the flagless run prints, so
  // an operator learns one format, and the assertion has one shape.
  assert.match(output, /^ccmem: config 1 non-default key, 1 unknown key$/m);
  assert.match(output, /^non-default:\n {2}version$/m);
  assert.match(output, /^unknown:\n {2}zz_w0_probe\.sample$/m);
});

test('--config prints the group headers even when a group is empty', () => {
  const output = runDiagnose({ version: 'w0-probe' }, ['--config']);

  assert.match(output, /^ccmem: config 1 non-default key, 0 unknown keys$/m);
  assert.match(output, /^non-default:\n {2}version$/m);
  // A vanishing header would leave the reader unsure whether the group was
  // empty or the mechanism skipped it — the same ambiguity Task 3 removed
  // from the summary line.
  assert.match(output, /^unknown:$/m);
});

test('--config never prints the value behind a key', () => {
  const output = runDiagnose({ version: 'secret-looking-value' }, ['--config']);

  assert.equal(output.includes('secret-looking-value'), false);
});
