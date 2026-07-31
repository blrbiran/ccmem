import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { DEFAULT_CONFIG, loadConfig } = await import('../../scripts/lib/config.mjs');

test('DEFAULT_CONFIG.version matches current release version', () => {
  assert.equal(DEFAULT_CONFIG.version, '0.13');
});

test('loadConfig() returns version === 0.13', () => {
  const config = loadConfig();
  assert.equal(config.version, '0.13');
});

test('config.default.json version matches DEFAULT_CONFIG.version', () => {
  const configDefaultPath = path.join(repoRoot, 'config.default.json');
  const fileContent = readFileSync(configDefaultPath, 'utf8');
  const fileConfig = JSON.parse(fileContent);

  assert.equal(fileConfig.version, DEFAULT_CONFIG.version,
    `config.default.json version (${fileConfig.version}) does not match DEFAULT_CONFIG.version (${DEFAULT_CONFIG.version})`);
});

test('config.default.json and DEFAULT_CONFIG share the same top-level keys', () => {
  const configDefaultPath = path.join(repoRoot, 'config.default.json');
  const fileContent = readFileSync(configDefaultPath, 'utf8');
  const fileConfig = JSON.parse(fileContent);

  const fileKeys = Object.keys(fileConfig).sort();
  const defaultKeys = Object.keys(DEFAULT_CONFIG).sort();

  // Enforce symmetric key-set match in both directions:
  // - Keys in DEFAULT_CONFIG missing from config.default.json = undocumented config sections
  // - Keys in config.default.json missing from DEFAULT_CONFIG = documented but unimplemented sections
  // Both directions indicate drift that must be caught
  assert.deepEqual(fileKeys, defaultKeys,
    `config.default.json and DEFAULT_CONFIG have different top-level keys:\n` +
    `file keys:   ${fileKeys.join(', ')}\n` +
    `runtime keys: ${defaultKeys.join(', ')}`);
});
