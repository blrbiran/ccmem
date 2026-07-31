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

// Script-aware threshold (controller ruling): .length treats a CJK char the same
// as a Latin one, but CJK is far denser, so one flat threshold can't serve both
// scripts. This 69-char English failure sits ABOVE the CJK threshold (50) but
// BELOW the Latin one (120) — it proves the 120 branch is actually live for
// Latin text; without it, a regression to a flat 50-everywhere threshold would
// stay green.
test('env_failure: a mid-length English environment failure is still rejected', () => {
  const midEnglish = 'Error: ENOENT no such file or directory when running the setup script';
  assert.equal(midEnglish.length > 50 && midEnglish.length < 120, true,
    'fixture must sit strictly between the CJK and Latin thresholds');
  assert.deepEqual(checkQuality(midEnglish), { pass: false, reason: 'env_failure' });
});

// Short CJK failure report must still be rejected — exercises the CJK
// threshold (50) on the rejecting side, not just the passing side covered by
// the "does not reject a remedy" test above.
test('env_failure: a short CJK environment failure is rejected', () => {
  const shortCjk = '找不到命令，请先安装 Node';
  assert.equal(shortCjk.length < 50, true, 'fixture must sit under the CJK threshold');
  assert.deepEqual(checkQuality(shortCjk), { pass: false, reason: 'env_failure' });
});

// Ledger T5, folded into I5. The blanket-negation regex anchored on `\bwork\b`,
// which does not match "working" — so the single most common phrasing of "this
// tool is broken" walked straight past the gate that exists to stop refusal
// hardening. Same category as "does not work", which IS caught.
test('negative_assertion catches the "is not working" family, not just "does not work"', () => {
  for (const text of [
    'the mcp server is not working and never has been',
    'the mcp server isn’t working and never has been',
    'these hooks are not working on this machine at all',
    'these hooks aren’t working on this machine at all'
  ]) {
    assert.equal(checkQuality(text).reason, 'negative_assertion', `must reject: ${text}`);
  }
});

// The gate must not widen into ordinary conventions that merely contain the
// word "working" — the whole point of the narrow regex is that legitimate
// convention memories outnumber refusal-hardening ones.
test('negative_assertion does not fire on ordinary text containing "working"', () => {
  for (const text of [
    'when working on the parser prefer small pure functions over classes',
    'the working directory for all scripts is the repository root'
  ]) {
    assert.equal(checkQuality(text).pass, true, `must pass: ${text}`);
  }
});

// Invariant #127 as an executable test rather than only a CI grep: these tokens
// are high-frequency in legitimate bilingual conventions, and the plan-mandated
// regex was reviewed as if it contained the first one. It does not, and must
// not start to.
test('negative_assertion spares constraint memories that use 不支持 / never use / avoid', () => {
  for (const text of [
    '这个 API 不支持批量请求，需要逐条调用',
    'never use console.log in committed code, use the logger instead',
    'avoid default exports in this package, prefer named exports'
  ]) {
    assert.equal(checkQuality(text).pass, true, `must pass: ${text}`);
  }
});
