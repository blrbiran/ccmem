import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyKey } = await import('../../scripts/lib/admin/plist-drift.mjs');
const { DAEMON_ENV_PASSTHROUGH } = await import('../../scripts/lib/admin/daemon.mjs');

// T12。Finding 10 的教训就是"别处改了、这里静默不覆盖"。分类若靠人肉清单，
// 下次有人往 DAEMON_ENV_PASSTHROUGH 加 key，它会默默落进自由变桶而无人察觉。
// 这条断言的价值不在今天通过，在将来有人加 key 时变红。
test('T12: every key that can reach the plist env dict is classified', () => {
  const sources = [
    'PATH',
    'CCMEM_DATA_ROOT',
    'CCMEM_CLAUDE_P_COMMAND',
    'CCMEM_CLAUDE_P_ARGS_JSON',
    'CCMEM_CLAUDE_P_TIMEOUT_MS',
    'CCMEM_CONFIG_PATH',
    ...DAEMON_ENV_PASSTHROUGH
  ];

  const unclassified = sources.filter((key) => classifyKey(key) === null);
  assert.deepEqual(unclassified, [], `unclassified keys: ${unclassified.join(', ')}`);
});

test('T12 control: an unknown key is reported as unclassified', () => {
  assert.equal(classifyKey('CCMEM_SOMETHING_NOBODY_SORTED'), null);
});

const { splitPlist, parseEnvDict } = await import('../../scripts/lib/admin/plist-drift.mjs');

// renderDaemonPlist 渲染七块，比对必须拆三轴。只解析环境字典的实现会在
// "模板变了但环境相同"时落进未定义分支 —— 那恰恰是最该自动修的一类 drift。
const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.ccmem.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin</string>
    <key>CCMEM_DATA_ROOT</key><string>/tmp/a &amp; b</string>
  </dict>
</dict></plist>
`;

test('splitPlist separates env dict, ProgramArguments and the rest', () => {
  const parts = splitPlist(SAMPLE_PLIST);
  assert.match(parts.envText, /CCMEM_DATA_ROOT/);
  assert.match(parts.programArgs, /\/usr\/bin\/node/);
  assert.match(parts.template, /com\.ccmem\.daemon/);
  // 三轴不得互相污染
  assert.doesNotMatch(parts.template, /CCMEM_DATA_ROOT/);
  assert.doesNotMatch(parts.template, /usr\/bin\/node/);
});

test('parseEnvDict unescapes the five entities escapeXml produces', () => {
  const parsed = parseEnvDict(splitPlist(SAMPLE_PLIST).envText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.env.CCMEM_DATA_ROOT, '/tmp/a & b');
  assert.equal(parsed.env.PATH, '/usr/bin');
});

// 不能从"解析不出来"推出"没有 drift"。手改过或旧格式的 plist 是不可判定，不是一致。
test('parseEnvDict refuses a dict with unrecognised residue', () => {
  const parsed = parseEnvDict('<key>A</key><string>1</string><key>B</key><data>zz</data>');
  assert.equal(parsed.ok, false);
});

test('parseEnvDict control: clean input still parses', () => {
  const parsed = parseEnvDict('<key>A</key><string>1</string>');
  assert.equal(parsed.ok, true);
});

test('parseEnvDict refuses garbage sitting between two valid pairs', () => {
  const parsed = parseEnvDict('<key>A</key><garbage/><key>B</key><string>1</string>');
  assert.equal(parsed.ok, false);
});

const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const { comparePlist } = await import('../../scripts/lib/admin/plist-drift.mjs');

function plistWith(envPairs, { programArg = '/usr/bin/node', extra = '' } = {}) {
  const dict = Object.entries(envPairs)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join('\n');
  return `<plist version="1.0"><dict>
  <key>Label</key><string>com.ccmem.daemon</string>${extra}
  <key>ProgramArguments</key>
  <array>
    <string>${programArg}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${dict}
  </dict>
</dict></plist>
`;
}

const BASE_ENV = { PATH: '/usr/bin', CCMEM_DATA_ROOT: '/tmp/root', CCMEM_CONFIG_PATH: '/tmp/root/config.json' };

// T1
test('T1: a missing pointing key is drift', () => {
  const { CCMEM_CONFIG_PATH, ...without } = BASE_ENV;
  const result = comparePlist(plistWith(without), plistWith(BASE_ENV));
  assert.equal(result.status, 'drifted');
  assert.ok(result.added.includes('CCMEM_CONFIG_PATH'));
});

// T2 报警侧。PATH 取自调用方 shell，换个终端就不同；若它计入三态，
// status 会常态报 drifted，把新报警训练成噪声（Finding 2 的读法）。
test('T2: a PATH-only difference does not raise the verdict', () => {
  const result = comparePlist(plistWith(BASE_ENV), plistWith({ ...BASE_ENV, PATH: '/opt/bin:/usr/bin' }));
  assert.equal(result.status, 'in_sync');
  assert.deepEqual(result.benign_changed, ['PATH']);
  assert.deepEqual(result.changed, []);
});

// T2b 报警侧。模板变了而环境字典相同 —— 纯代码版本差异。
test('T2b: a template-only difference does not raise the verdict either', () => {
  const result = comparePlist(plistWith(BASE_ENV), plistWith(BASE_ENV, { extra: '\n  <key>ProcessType</key><string>Background</string>' }));
  assert.equal(result.status, 'in_sync');
  assert.deepEqual(result.template_changed, ['template']);
});

test('T2b-2: a ProgramArguments-only difference is reported on its own axis', () => {
  const result = comparePlist(plistWith(BASE_ENV), plistWith(BASE_ENV, { programArg: '/opt/homebrew/bin/node' }));
  assert.equal(result.status, 'in_sync');
  assert.deepEqual(result.template_changed, ['ProgramArguments']);
});

// T10
test('T10: an unparsable env dict is unknown, never in_sync', () => {
  const broken = plistWith(BASE_ENV).replace('<key>PATH</key><string>/usr/bin</string>', '<key>PATH</key><data>zz</data>');
  const result = comparePlist(broken, plistWith(BASE_ENV));
  assert.equal(result.status, 'unknown');
  // 解析不出来就是没有可报的条目，不是"没有条目"—— 五个列表一律空数组，不缺省。
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.benign_changed, []);
  assert.deepEqual(result.template_changed, []);
});

// 接线用的独立 data root —— 跟前面纯函数测试共用的 shell 级 CCMEM_DATA_ROOT
// 分开，避免 openDb() 落进一个被其他测试写过的目录。
const wiringDataRoot = mkdtempSync(join(tmpdir(), 'ccmem-t3-wiring-'));
process.env.CCMEM_DATA_ROOT = wiringDataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');

test.after(() => rmSync(wiringDataRoot, { recursive: true, force: true }));

// 接线测试。纯函数有测试 ≠ 接线有测试 —— 这里要证明 verb 分发真的调到了检测。
test('T1 wiring: daemon status reports plist_drift', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  const db = openDb();
  try {
    const result = await cmdAdminDaemon(db, { verb: 'status' });
    assert.ok(result.plist_drift, 'status must carry plist_drift');
    assert.ok(['in_sync', 'drifted', 'unknown'].includes(result.plist_drift.status));
  } finally {
    db.close();
    delete process.env.CCMEM_LAUNCHAGENT_DIR;
  }
});
