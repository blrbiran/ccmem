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
