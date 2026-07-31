import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuality } from '../../scripts/lib/quality-gate.mjs';

test('rejects a bare command-not-found report', () => {
  assert.deepEqual(checkQuality('npm: command not found on this machine'),
    { pass: false, reason: 'env_failure' });
});

test('rejects a short not-installed report', () => {
  assert.deepEqual(checkQuality('the sqlite-vec extension is not installed'),
    { pass: false, reason: 'env_failure' });
});

test('rejects a blanket negative assertion in English', () => {
  assert.deepEqual(checkQuality('The MCP server does not work at all in this setup'),
    { pass: false, reason: 'negative_assertion' });
});

test('rejects a blanket negative assertion in Chinese', () => {
  assert.deepEqual(checkQuality('sqlite-vec 在这台机器上跑不起来，别指望它'),
    { pass: false, reason: 'negative_assertion' });
});

// False-positive regressions: these are the most valuable memories in the store.
test('does not reject a legitimate negative convention (Chinese)', () => {
  assert.deepEqual(checkQuality('这个项目不支持 CommonJS，一律用 ESM'),
    { pass: true, reason: null });
});

test('does not reject a legitimate tool preference (Chinese)', () => {
  assert.deepEqual(checkQuality('不要用 npm，这个项目统一使用 pnpm 管理依赖'),
    { pass: true, reason: null });
});

test('does not reject a legitimate negative rule (English)', () => {
  assert.deepEqual(checkQuality('Never use console.log in production code paths'),
    { pass: true, reason: null });
});

// R2 regression: the prompt asks for exactly this shape, so the gate must allow it.
test('does not reject a remedy that mentions the failure it fixes', () => {
  assert.deepEqual(
    checkQuality('遇到 command not found 时先跑 nvm use 22 切换到项目要求的 Node 版本，再重试安装'),
    { pass: true, reason: null }
  );
});

test('env_failure length gate: same string passes once a remedy makes it long', () => {
  const short = 'pnpm: command not found';
  const long = 'pnpm: command not found means corepack is off; run corepack enable '
    + 'and then corepack prepare pnpm@latest --activate before installing anything else';
  assert.equal(checkQuality(short).reason, 'env_failure');
  assert.equal(checkQuality(long).pass, true);
});

test('env_failure can be disabled independently', () => {
  assert.equal(
    checkQuality('npm: command not found on this machine',
      { rules_enabled: { env_failure: false } }).reason,
    null
  );
});

test('negative_assertion can be disabled independently', () => {
  assert.equal(
    checkQuality('The MCP server does not work at all in this setup',
      { rules_enabled: { negative_assertion: false } }).reason,
    null
  );
});

test('negative_assertion has no length gate — long text is still rejected', () => {
  const long = 'After a long investigation across many files and several hours of work, '
    + 'the conclusion is that the MCP server does not work and we should give up on it';
  assert.equal(checkQuality(long).reason, 'negative_assertion');
});
