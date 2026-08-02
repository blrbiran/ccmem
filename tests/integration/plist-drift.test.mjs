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
