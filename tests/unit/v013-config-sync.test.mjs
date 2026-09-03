import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { DEFAULT_CONFIG, loadConfig } = await import('../../scripts/lib/config.mjs');

test('DEFAULT_CONFIG.version matches current release version', () => {
  assert.equal(DEFAULT_CONFIG.version, '0.14');
});

test('loadConfig() returns version === 0.14', () => {
  const config = loadConfig();
  assert.equal(config.version, '0.14');
});

test('config.default.json version matches DEFAULT_CONFIG.version', () => {
  const configDefaultPath = path.join(repoRoot, 'config.default.json');
  const fileContent = readFileSync(configDefaultPath, 'utf8');
  const fileConfig = JSON.parse(fileContent);

  assert.equal(fileConfig.version, DEFAULT_CONFIG.version,
    `config.default.json version (${fileConfig.version}) does not match DEFAULT_CONFIG.version (${DEFAULT_CONFIG.version})`);
});

/**
 * Every key path, not just the top level. A depth-1 comparison passed while
 * `metrics.decision_data.file` could be renamed in config.mjs alone — pointing
 * the writer and the documented reader at DIFFERENT FILES — and while a whole
 * quality-gate rule could vanish from one side. Those are exactly the nested
 * additions v0.13 made.
 *
 * Keys prefixed with `_` are documentation-only (config.default.json is JSON
 * and cannot carry comments) and are excluded from the comparison. Nothing
 * reads them; if a user copies the file into place they merge harmlessly.
 * Arrays are leaves — their contents are values, not configuration keys.
 */
function keyPaths(value, prefix = '', out = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const keyPath = prefix ? `${prefix}.${key}` : key;
    out.add(keyPath);
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      keyPaths(child, keyPath, out);
    }
  }
  return out;
}

test('config.default.json and DEFAULT_CONFIG share the same key paths at every depth', () => {
  const fileConfig = JSON.parse(readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));

  const fileKeys = [...keyPaths(fileConfig)].sort();
  const defaultKeys = [...keyPaths(DEFAULT_CONFIG)].sort();

  // Symmetric in both directions:
  // - in DEFAULT_CONFIG only  = an undocumented knob users cannot discover
  // - in config.default.json only = a documented knob the runtime ignores
  assert.deepEqual(fileKeys, defaultKeys,
    'config.default.json and DEFAULT_CONFIG have drifted:\n' +
    `  only in config.default.json: ${fileKeys.filter((k) => !defaultKeys.includes(k)).join(', ') || '(none)'}\n` +
    `  only in DEFAULT_CONFIG:      ${defaultKeys.filter((k) => !fileKeys.includes(k)).join(', ') || '(none)'}`);
});

// Object.freeze is shallow, so every nested section of the authoritative
// runtime config was writable process-wide — one caller mutating
// DEFAULT_CONFIG.metrics.decision_data in place would silently change what
// every later loadConfig() returns.
test('DEFAULT_CONFIG is frozen all the way down, not just at the top level', () => {
  assert.throws(() => { DEFAULT_CONFIG.version = 'nope'; }, TypeError);
  assert.throws(() => { DEFAULT_CONFIG.metrics.decision_data.enabled = false; }, TypeError);
  assert.throws(() => { DEFAULT_CONFIG.summarize.quality_gate.rules_enabled.env_failure = false; }, TypeError);
  assert.throws(() => { DEFAULT_CONFIG.feedback.l25_probe.control_sample_size = 99; }, TypeError);
  assert.throws(() => { DEFAULT_CONFIG.daemon.platform_install_fallback_node_paths.push('/nope'); }, TypeError);
});

// Freezing must not make the config unusable: loadConfig clones before merging.
test('loadConfig still returns a mutable copy despite the deep freeze', () => {
  const config = loadConfig();
  config.metrics.decision_data.enabled = false;
  assert.equal(config.metrics.decision_data.enabled, false);
  assert.equal(DEFAULT_CONFIG.metrics.decision_data.enabled, true, 'the frozen original must be unaffected');
});

// 这一个键必须两份配置源逐字相等，否则 bump 它就是 no-op：
// config.default.json 是新用户拷贝的模板，而没有 config.json 的进程（包括每一次
// npm test，它 env -u 掉 CCMEM_CONFIG_PATH 又指向空的 mktemp -d 数据根）读的是
// DEFAULT_CONFIG。两者漂移时，重扫机制在一半的进程里静默不触发 —— 实测本机
// ~/.claude/ccmem/config.json 只有 embedding 一段、没有 security，所以生效值来自
// DEFAULT_CONFIG，而 scripts/threat-report.mjs:125 的抬头读的是 config.default.json：
// 只改后者，报告会照印新版本号而 revalidation.mjs:28 仍读旧值。
//
// 🔴 刻意只钉这一个键，不做通用值级 parity —— 那份测试在 config-value-parity 分支上，
// 人类裁决"不合并"（handoff ⅩⅩⅥ.8 禁令 1）。这里沿用的是 §ⅩⅩ 给 plugin.json
// 加 `version === package.json.version` 断言的先例：一个键，一条断言，漂移当场变红。
test('scan_patterns_version is identical in both config sources', () => {
  const fileConfig = JSON.parse(readFileSync(path.join(repoRoot, 'config.default.json'), 'utf8'));
  assert.equal(
    fileConfig.security.scan_patterns_version,
    DEFAULT_CONFIG.security.scan_patterns_version,
    'bumping only one of the two makes the retroactive rescan a silent no-op for every ' +
    'process that has no config.json of its own'
  );
});
