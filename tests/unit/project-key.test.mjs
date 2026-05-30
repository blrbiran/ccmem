import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteUrl, fallbackProjectKey } from '../../scripts/lib/project-key.mjs';

test('normalizeRemoteUrl converts GitHub ssh remote to host/path key', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:me/repo.git'), 'github.com/me/repo');
});

test('normalizeRemoteUrl converts https remote to host/path key', () => {
  assert.equal(normalizeRemoteUrl('https://gitlab.com/acme/tool.git'), 'gitlab.com/acme/tool');
});

test('fallbackProjectKey uses path prefix for non-git directories', () => {
  assert.match(fallbackProjectKey('/tmp/demo'), /^path:/);
});
