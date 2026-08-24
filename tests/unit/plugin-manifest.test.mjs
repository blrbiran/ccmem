import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const readManifest = () =>
  JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

const readPackageJson = () =>
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('plugin.json includes required Claude plugin fields', () => {
  const manifest = readManifest();
  assert.equal(manifest.name, 'ccmem');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(manifest.commands));
  assert.ok(Array.isArray(manifest.skills));
  assert.deepEqual(manifest.mcpServers, {});
});

// 形状断言挡不住版本漂移：`0.2.0` 一样匹配 semver 正则，所以 plugin.json 从 v0.2 一路
// 陈到 v0.13.1 都没人发现（tag 是 v0.13.1，package.json 是 0.7.0，plugin.json 是 0.2.0，
// 三个各说各话）。断言两个文件相等，漂移才会当场变红。
// 刻意不拿 git tag 当基准：新克隆或浅克隆里可能没有 tag，那样断言会假红。
test('plugin.json version matches package.json version', () => {
  assert.equal(readManifest().version, readPackageJson().version);
});

test('plugin.json carries the marketplace metadata every shipped plugin has', () => {
  const manifest = readManifest();
  assert.equal(typeof manifest.author?.name, 'string');
  assert.match(manifest.homepage, /^https:\/\//);
  assert.match(manifest.repository, /^https:\/\//);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
});

test('plugin.json omits hooks and agents', () => {
  const manifest = readManifest();
  assert.ok(!('hooks' in manifest));
  assert.ok(!('agents' in manifest));
});
