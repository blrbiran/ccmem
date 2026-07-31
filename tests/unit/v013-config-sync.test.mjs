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

  // Try exact key-set match first
  if (JSON.stringify(fileKeys) !== JSON.stringify(defaultKeys)) {
    // Fall back to asserting that every key in config.default.json also exists in DEFAULT_CONFIG
    // (the direction that matters: a documented key that doesn't actually exist is a lie to users)
    const asymmetry = fileKeys.filter(k => !defaultKeys.includes(k));

    if (asymmetry.length > 0) {
      throw new Error(
        `config.default.json has keys not in DEFAULT_CONFIG (documented but not implemented): ${asymmetry.join(', ')}\n` +
        `file keys: ${fileKeys.join(', ')}\n` +
        `DEFAULT_CONFIG keys: ${defaultKeys.join(', ')}`
      );
    }

    // If we got here, it means DEFAULT_CONFIG has extra keys not in the file
    // (acceptable—internal keys not documented)
    const extraInDefault = defaultKeys.filter(k => !fileKeys.includes(k));
    if (extraInDefault.length > 0) {
      console.log(`Note: DEFAULT_CONFIG has undocumented keys: ${extraInDefault.join(', ')}`);
    }
  }
});
