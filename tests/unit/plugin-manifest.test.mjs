import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const readManifest = () =>
  JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

test('plugin.json includes required Claude plugin fields', () => {
  const manifest = readManifest();
  assert.equal(manifest.name, 'ccmem');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(manifest.commands));
  assert.ok(Array.isArray(manifest.skills));
  assert.deepEqual(manifest.mcpServers, {});
});

test('plugin.json omits hooks and agents', () => {
  const manifest = readManifest();
  assert.ok(!('hooks' in manifest));
  assert.ok(!('agents' in manifest));
});
