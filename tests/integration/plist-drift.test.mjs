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

const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } = await import('node:fs');
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

// T1b 回归测试。design §五："其余（含只有自由变 key、轴②、轴③ 有差异）"应判 in_sync；
// §三：自由变 key 不拦不报警。CCMEM_CLAUDE_P_COMMAND 是 FREE_KEYS 里的一员 —— 它整个消失
// （不只是值变了）也不该翻 status，但仍要留在 removed 里给人看，"消失了"这件事不能被吞掉。
// G1（Task 4）另外挡它彻底消失的情形；这里只是不让它污染报警轴。
test('T1b: a missing free key does not raise the verdict, but still appears in removed', () => {
  const withFree = { ...BASE_ENV, CCMEM_CLAUDE_P_COMMAND: 'claude' };
  const result = comparePlist(plistWith(withFree), plistWith(BASE_ENV));
  assert.equal(result.status, 'in_sync');
  assert.ok(result.removed.includes('CCMEM_CLAUDE_P_COMMAND'));
});

test('T1c: an added free key does not raise the verdict, but still appears in added', () => {
  const withFree = { ...BASE_ENV, CCMEM_CLAUDE_P_COMMAND: 'claude' };
  const result = comparePlist(plistWith(BASE_ENV), plistWith(withFree));
  assert.equal(result.status, 'in_sync');
  assert.ok(result.added.includes('CCMEM_CLAUDE_P_COMMAND'));
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

// restart/stop/start reach launchd through a FIXED label (com.ccmem.daemon),
// so pointing CCMEM_LAUNCHAGENT_DIR at a temp dir isolates the plist *file*
// but not the launchd *registration* — a real ccmem daemon installed on the
// machine running this suite shares that exact label, and driving cmdAdminDaemon
// with verb:'restart' against a real `launchctl` was observed to bootout and
// re-bootstrap the developer's actual installed service (confirmed via
// `launchctl print gui/<uid>/com.ccmem.daemon` before/after this test ran).
// daemon.mjs already supports swapping the launchctl binary for this reason
// (CCMEM_LAUNCHCTL_BIN / CCMEM_LAUNCHCTL_LOG — see admin-daemon-command.test.mjs's
// launchdLifecycleScript()); reuse the identical mechanism here so any test
// that reaches restartDaemon()'s launchd branch never touches the real system.
const { chmodSync } = await import('node:fs');
const fakeLaunchctlDir = mkdtempSync(join(tmpdir(), 'ccmem-fake-launchctl-'));
const fakeLaunchctlPath = join(fakeLaunchctlDir, 'fake-launchctl.sh');
const fakeLaunchctlLog = join(fakeLaunchctlDir, 'fake-launchctl.log');
const fakeLaunchctlStatePath = join(fakeLaunchctlDir, 'fake-launchctl.loaded');

writeFileSync(fakeLaunchctlPath, [
  '#!/bin/sh',
  'printf \'%s\\n\' "$@" >> "$CCMEM_LAUNCHCTL_LOG"',
  'DB="$CCMEM_DATA_ROOT/global.db"',
  `STATE=${JSON.stringify(fakeLaunchctlStatePath)}`,
  'NOW=$(($(date +%s) * 1000))',
  'set_lock() {',
  '  sqlite3 "$DB" "INSERT OR REPLACE INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive) VALUES (1, 9876, \'fake-launchd-host\', $NOW, $NOW, 1);" >/dev/null 2>&1',
  '}',
  'case "$1" in',
  '  bootout)',
  // bug-063 缺陷 2 需要一次"stop 阶段失败"的重启。默认不触发，只有显式设了这个
  // 变量的测试才会走到 —— 与 CCMEM_FAKE_BOOTSTRAP_SNAPSHOT 同一种 opt-in。
  '    if [ -n "$CCMEM_FAKE_BOOTOUT_FAIL" ]; then printf %s\\n "bootout refused by the fake" >&2; exit 1; fi',
  '    rm -f "$STATE"',
  '    sqlite3 "$DB" "DELETE FROM daemon_lock;" >/dev/null 2>&1',
  '    ;;',
  '  bootstrap)',
  '    : > "$STATE"',
  // Opt-in snapshot of the plist bootstrap was actually handed ($3 is the
  // plist path argument to `launchctl bootstrap <domain> <plist>`). Only
  // ordering test T13 sets CCMEM_FAKE_BOOTSTRAP_SNAPSHOT; everyone else is
  // unaffected. This is what makes the ordering between rewritePlistIfAllowed()
  // and startDaemon() (which falls through to bootstrap after a failed
  // kickstart) observable from the test side at all.
  '    if [ -n "$CCMEM_FAKE_BOOTSTRAP_SNAPSHOT" ]; then cp "$3" "$CCMEM_FAKE_BOOTSTRAP_SNAPSHOT"; fi',
  // job 被接受了，但锁永远不由 fake 写出来 —— 谁来写、什么时候写，交给测试自己决定。
  '    if [ -n "$CCMEM_FAKE_START_NEVER" ]; then exit 0; fi',
  '    set_lock',
  '    ;;',
  '  kickstart)',
  '    if [ ! -f "$STATE" ]; then',
  '      printf %s\\n "service not loaded" >&2',
  '      exit 1',
  '    fi',
  '    set_lock',
  '    ;;',
  'esac',
  'exit 0',
  ''
].join('\n'));
chmodSync(fakeLaunchctlPath, 0o755);

// Set at module scope, not per-test: a per-test opt-in has to be remembered by
// whoever adds the next test, and forgetting it reproduces the incident above
// silently (the test still passes while hijacking the real system — T9 only
// surfaced it because of an unrelated start_timeout). Fixing it here means this
// file structurally cannot reach real `launchctl`, regardless of what any test
// — present or future — does or doesn't opt into.
//
// CCMEM_LAUNCHAGENT_DIR needs the identical treatment for the identical reason
// (see the module-scope assignment below, after `trackedMkdtemp` is defined):
// the launchctl fake only protects the launchd *registration* — nothing protects
// the plist *file* itself, and `rewritePlistIfAllowed()`'s `writeFileSync` will
// happily target the developer's real ~/Library/LaunchAgents/com.ccmem.daemon.plist
// if this variable is ever unset (which it used to be, at the end of T1 wiring).
process.env.CCMEM_LAUNCHCTL_BIN = fakeLaunchctlPath;
process.env.CCMEM_LAUNCHCTL_LOG = fakeLaunchctlLog;

// Per-test state still needs resetting (the fake script's "loaded" marker
// persists on disk across tests), so keep a helper for that alone.
async function withFakeLaunchctl(run) {
  rmSync(fakeLaunchctlStatePath, { force: true });
  return run();
}

test.after(() => rmSync(fakeLaunchctlDir, { recursive: true, force: true }));

// Some of these dirs hold a REAL `renderPlist()` output (T2-rewrite-side, the
// two CLI tests), which on a real machine contains the plaintext
// ANTHROPIC_API_KEY from DAEMON_ENV_PASSTHROUGH — left in /tmp indefinitely
// if nothing cleans it up. mkdtempSync's 0700 mode limits this to one user,
// but "never leave plist contents on disk after the test" is a standing
// constraint on this task regardless.
const tempDirsToClean = [];
function trackedMkdtemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirsToClean) rmSync(dir, { recursive: true, force: true });
});

// Same structural fix as CCMEM_LAUNCHCTL_BIN/LOG above, same reason: set at module
// scope so this file cannot fall back to the real ~/Library/LaunchAgents, regardless
// of what any individual test does. Individual tests may still repoint this at their
// own temp dir (most below do, to control what plist is on "disk"); this is only the
// safe floor for any test that doesn't.
process.env.CCMEM_LAUNCHAGENT_DIR = trackedMkdtemp('ccmem-launchagent-default-');

// 接线测试。纯函数有测试 ≠ 接线有测试 —— 这里要证明 verb 分发真的调到了检测。
test('T1 wiring: daemon status reports plist_drift', async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  const db = openDb();
  try {
    const result = await cmdAdminDaemon(db, { verb: 'status' });
    assert.ok(result.plist_drift, 'status must carry plist_drift');
    assert.ok(['in_sync', 'drifted', 'unknown'].includes(result.plist_drift.status));
  } finally {
    db.close();
  }
});

const { evaluateGates, effectiveConfigPath } = await import('../../scripts/lib/admin/plist-drift.mjs');

const okProbe = () => ({ ok: true });
const ROOT = '/tmp/root';
const gates = (oldEnv, newEnv, probe = okProbe) =>
  evaluateGates(oldEnv, newEnv, { defaultDataRoot: ROOT, probe });

// T3 —— G1。claude 掉出 PATH 时 CCMEM_CLAUDE_P_COMMAND 会从新 env 里消失，
// 无条件重写会把一个本来好的安装改坏。这是反向的静默失败。
test('T3: G1 refuses a shrinking key set', () => {
  const verdict = gates(
    { PATH: '/usr/bin', CCMEM_CLAUDE_P_COMMAND: '/usr/bin/claude' },
    { PATH: '/usr/bin' }
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G1');
});

// T4 —— G2。旧 plist 多半没有 CCMEM_CONFIG_PATH（该变量无持久来源），
// 所以按"旧有才比"的写法，stray 值会被当成无害新增放行 —— 那正是重造 Finding 12。
test('T4: G2 refuses a stray CCMEM_CONFIG_PATH that names a real file', () => {
  const real = join(trackedMkdtemp('ccmem-cfg-'), 'other.json');
  writeFileSync(real, '{}');
  const verdict = gates({ PATH: '/usr/bin' }, { PATH: '/usr/bin', CCMEM_CONFIG_PATH: real });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G2');
});

// time-of-check ≠ time-of-use：放行会把这个 key 持久化进 plist，
// 哪天那个文件被创建出来，daemon 就跟着走了 —— 绕过 G2 自己。
test('T4b: G2 refuses a CCMEM_CONFIG_PATH naming a file that does not exist', () => {
  const verdict = gates({ PATH: '/usr/bin' }, { PATH: '/usr/bin', CCMEM_CONFIG_PATH: '/tmp/definitely-absent-8f3a.json' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G2');
});

// T5 —— G2。旧无 / 新有，缺省记为 null，所以判为不同。
test('T5: G2 refuses a newly appearing ANTHROPIC_BASE_URL', () => {
  const verdict = gates({ PATH: '/usr/bin' }, { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://elsewhere.example' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G2');
});

// T5b —— G2 回归。CCMEM_DATA_ROOT 被 classifyKey 分类为 pointing，但没进
// POINTING_LITERAL_KEYS：两侧钉同一个已存在的 CCMEM_CONFIG_PATH 时，
// effectiveConfigPath 直接照抄该显式路径，CCMEM_DATA_ROOT 整个跌出比较——
// 静默换库通过了所有四道门。Reviewer 发现，补回归测试。
test('T5b: G2 refuses a changed CCMEM_DATA_ROOT even when CCMEM_CONFIG_PATH is pinned the same', () => {
  const real = join(trackedMkdtemp('ccmem-cfg-'), 'shared.json');
  writeFileSync(real, '{}');
  const verdict = gates(
    { PATH: '/usr/bin', CCMEM_DATA_ROOT: '/tmp/root-a', CCMEM_CONFIG_PATH: real },
    { PATH: '/usr/bin', CCMEM_DATA_ROOT: '/tmp/root-b', CCMEM_CONFIG_PATH: real }
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G2');
});

// T5c —— 设计文档 §四/§七：CCMEM_DATA_ROOT 与 CCMEM_CONFIG_PATH 是"值一律不打印"的
// 唯二例外，人必须看见它想把你改指到哪。effectiveConfigPath 分支已经这样报
// CCMEM_CONFIG_PATH（见 reason 里的 oldConfig/newConfig）；这条钉 POINTING_LITERAL_KEYS
// 分支里的 CCMEM_DATA_ROOT 也做到同一件事。CCMEM_CONFIG_PATH 必须两侧钉同一个真实文件
// （T5b 的写法），否则 effectiveConfigPath 那道更早的 G2 检查会先触发——它自己也会在
// reason 里带出 /tmp/root-a 与 /tmp/root-b（因为它俩落在 oldConfig/newConfig 里），
// 让这条测试看起来通过，其实根本没走到 POINTING_LITERAL_KEYS 分支。
test('T5c: G2 prints old and new values for a changed CCMEM_DATA_ROOT', () => {
  const real = join(trackedMkdtemp('ccmem-cfg-'), 'shared.json');
  writeFileSync(real, '{}');
  const verdict = gates(
    { PATH: '/usr/bin', CCMEM_DATA_ROOT: '/tmp/root-a', CCMEM_CONFIG_PATH: real },
    { PATH: '/usr/bin', CCMEM_DATA_ROOT: '/tmp/root-b', CCMEM_CONFIG_PATH: real }
  );
  assert.equal(verdict.blocked_by, 'G2');
  assert.match(verdict.reason, /CCMEM_DATA_ROOT/);
  assert.match(verdict.reason, /\/tmp\/root-a/);
  assert.match(verdict.reason, /\/tmp\/root-b/);
});

// T5d —— 正面对照：其余指向类 key（未落在唯二例外里）仍只报 key 名，不报值。
test('T5d: G2 does not print the value for a changed ANTHROPIC_BASE_URL', () => {
  const verdict = gates(
    { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://old.example' },
    { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://new.example' }
  );
  assert.equal(verdict.blocked_by, 'G2');
  assert.doesNotMatch(verdict.reason, /old\.example/);
  assert.doesNotMatch(verdict.reason, /new\.example/);
  assert.match(verdict.reason, /ANTHROPIC_BASE_URL/);
});

// T6 —— G3。静默改写凭据是延迟发生、难归因的失败。
test('T6: G3 refuses a changed credential and never echoes its value', () => {
  const secret = 'sk-ant-do-not-echo-me';
  const verdict = gates({ ANTHROPIC_API_KEY: 'old-value' }, { ANTHROPIC_API_KEY: secret });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G3');
  const serialised = JSON.stringify(verdict);
  assert.equal(serialised.includes(secret), false, 'the credential value must not appear anywhere');
  // 正面对照：这个 0 不是因为 serialised 是空的 —— key 名必须在里面。
  assert.equal(serialised.includes('ANTHROPIC_API_KEY'), true);
  // 被拦下的人需要知道下一步，否则停在半路。
  // brief 里 REMEDY 的实际文本是 "uninstall && ccmem admin daemon install"（两条完整命令），
  // 与 REMEDY 保持一致而不是原样的 /uninstall && install/（那样永远匹配不上）。
  assert.match(verdict.reason, /uninstall && ccmem admin daemon install/);
});

// T7 —— G4。
test('T7: G4 refuses when the probe fails', () => {
  const verdict = gates(
    { CCMEM_CLAUDE_P_COMMAND: '/usr/bin/claude' },
    { CCMEM_CLAUDE_P_COMMAND: '/usr/bin/claude' },
    () => ({ ok: false, reason: 'no --json-schema' })
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocked_by, 'G4');
});

// T8 —— 正面对照。没有这条，上面所有"被拦下"都可能只是因为压根不会放行。
test('T8: a free-key addition passes every gate', () => {
  const verdict = gates(
    { PATH: '/usr/bin', CCMEM_CLAUDE_P_COMMAND: '/usr/bin/claude' },
    { PATH: '/usr/bin', CCMEM_CLAUDE_P_COMMAND: '/usr/bin/claude', CCMEM_CLAUDE_P_TIMEOUT_MS: '60000' }
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.blocked_by, null);
});

// 缺省的 CCMEM_CONFIG_PATH 与显式写成默认路径，有效值相同 —— 应放行。
test('effectiveConfigPath treats an absent key as the store default', () => {
  assert.equal(effectiveConfigPath({}, ROOT), join(ROOT, 'config.json'));
});

// T9。restart 的本职是把 daemon 起回来；用一个可疑的配置问题去阻断重启，
// 是拿一个可疑问题换一个确定的停机。
test('T9: a blocked gate still lets the restart finish', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  writeFileSync(plistPath, plistWith({ ...BASE_ENV, ANTHROPIC_API_KEY: 'old' }));
  const before = readFileSync(plistPath, 'utf8');

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  assert.equal(result.status, 'restarted');
  assert.equal(result.plist_rewrite.written, false);
  assert.equal(readFileSync(plistPath, 'utf8'), before, 'a blocked gate must leave the plist byte-identical');
}));

// bug-063 缺陷 2。restartDaemon 在 stop 阶段失败时把 `...stopped` 展开在最后，
// 于是它刚设好的 status:'restart_failed' 被 stopDaemon 的 'stop_failed' 覆盖掉。
// phase 字段还在，但没人会去读一个 status 已经说了别的事情的对象 —— 对调用方而言
// "restart 失败了" 这个事实就此丢失。
test('T14: a restart that fails in the stop phase still reports restart_failed', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  const db = openDb();
  process.env.CCMEM_FAKE_BOOTOUT_FAIL = '1';
  try {
    const result = await cmdAdminDaemon(db, { verb: 'restart' });

    assert.equal(result.status, 'restart_failed', 'the restart verb must report its own failure, not the stop phase sub-status');
    assert.equal(result.phase, 'stop', 'the phase must survive to tell the operator which half failed');
    assert.match(result.reason, /bootout refused/, 'the underlying launchctl error must not be dropped');
  } finally {
    delete process.env.CCMEM_FAKE_BOOTOUT_FAIL;
  }
}));

// bug-063 缺陷 1。一次冷启动（页缓存冷、上一个 daemon 已跑了 1.5 天）实测超过了
// 2000ms 的启动预算，于是一次成功的重启被报成失败。这条测试钉的不是那个常数，
// 是它存在的理由：3 秒之后才活过来的 daemon 必须被报成 started。
// 判据方向很重要 —— 等待期算错会把健康的系统判成故障，代价和相反的错误一样大。
test('T15: a daemon that takes three seconds to come up is reported as started', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  const db = openDb();
  // 慢启动由这条测试自己拥有的定时器模拟，不用后台子 shell：子 shell 会活过本测试，
  // 把锁写进下一条测试的等待窗口里（实测发生过，下一条测试看到 pid=9876 "启动成功"）。
  // 定时器归本测试所有，finally 里 clearTimeout，结构上不可能泄漏。
  // fake bootstrap 用 CCMEM_FAKE_START_NEVER 保证锁只可能由下面这一处写出来。
  process.env.CCMEM_FAKE_START_NEVER = '1';
  const lockAppears = setTimeout(() => {
    const at = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
       VALUES (1, 9876, 'fake-slow-start', ?, ?, 1)`
    ).run(at, at);
  }, 3000);

  try {
    const result = await cmdAdminDaemon(db, { verb: 'restart' });

    assert.equal(result.status, 'restarted', 'a slow-but-successful start must not be reported as a failure');
  } finally {
    clearTimeout(lockAppears);
    delete process.env.CCMEM_FAKE_START_NEVER;
    db.prepare(`DELETE FROM daemon_lock WHERE id = 1`).run();
  }
}));

// bug-063。Task 2 给 cli.mjs 加了 start_timeout / stop_timeout 分支却没有任何测试
// 覆盖它 —— 人类 2026-08-06 裁定在这里补上。注意 restart 到不了这个分支：
// restartDaemon 会把两个 timeout 状态都改写成 restart_failed，只有裸 start verb
// 才会把 start_timeout 原样交给 CLI。
// launchd 那条 start_timeout 返回值不带 pid，所以这里同时钉住"不许打印 pid"。
test('CLI reporting: a start that never comes up says it timed out, without inventing a pid', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  process.env.CCMEM_FAKE_START_NEVER = '1';
  try {
    const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'start'], {
      env: process.env,
      encoding: 'utf8'
    });

    assert.equal(result.status, 1, 'a start that never came up must exit non-zero');
    assert.match(result.stderr, /timed out/, 'the operator must be told this was a timeout, not a diagnosed failure');
    assert.match(result.stderr, /via=launchctl/, 'the path that timed out must be named');
    assert.match(result.stderr, /admin daemon status/, 'a timeout must point at the check that tells it apart from a real failure');
    assert.doesNotMatch(result.stderr, /pid=/, 'the launchd start_timeout carries no pid — the CLI must not print one');
  } finally {
    delete process.env.CCMEM_FAKE_START_NEVER;
  }
}));

// T11。解析不出旧 env 就判不了 G1–G3，此时重写等于在看不见的前提下改配置。
test('T11: an unparsable plist blocks the rewrite', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  writeFileSync(plistPath, plistWith(BASE_ENV).replace('<string>/usr/bin</string>', '<data>zz</data>'));
  const before = readFileSync(plistPath, 'utf8');

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  assert.equal(result.plist_rewrite.blocked_by, 'unparsable');
  assert.equal(result.plist_rewrite.written, false);
  assert.equal(readFileSync(plistPath, 'utf8'), before);
}));

test('T2 rewrite side: a benign-only difference is still written', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  // 磁盘上是一份除 PATH 外与当前求值一致的 plist：构造法是先取当前期望值，
  // 再把 PATH 那一行改掉，确保唯一差异落在自由变桶。
  const expected = (await import('../../scripts/lib/admin/daemon.mjs')).renderPlist();
  const before = expected.replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '<key>PATH</key><string>/stale/bin</string>');
  writeFileSync(plistPath, before);

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  // cmdAdminDaemon只在 verb:'status' 时才挂 plist_drift —— restart 分支没有这个字段，
  // 所以要验证"这个构造出来的差异确实只落在自由变桶"，必须直接对纯函数断言，
  // 而不是读一个 restart 永远不会返回的字段。
  assert.equal(comparePlist(before, expected).status, 'in_sync', 'the constructed diff must be benign-only');
  assert.equal(result.plist_rewrite.written, true, 'a PATH refresh must reach the installed plist');
  assert.doesNotMatch(readFileSync(plistPath, 'utf8'), /\/stale\/bin/);
}));

// T13 —— 排序不变量。rewritePlistIfAllowed() 必须夹在 stopDaemon 和 startDaemon 之间：
// stopDaemon 先把 job boot 出去，kickstart 因此在这之后必然失败（STATE 标记已被清），
// startDaemon 才会 fallthrough 到 bootstrap —— 而只有 bootstrap 会从磁盘重新读 plist,
// kickstart 用的是 launchd 缓存的 job 定义，压根不理会重写。挪动这一行不会让 T2/T9/T11
// 变红：它们只看 restart 返回值和"重写结束之后"磁盘上的最终字节，两者在 rewrite 挪到
// startDaemon 之后仍然一样。唯一能拆穿的证据是 bootstrap **那一刻**实际读到了什么——
// 假 launchctl 的 bootstrap 分支把它收到的 plist 路径参数原样复制走，这里读回那份快照。
test('T13: rewrite must land before bootstrap reads the plist off disk', () => withFakeLaunchctl(async () => {
  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  const expected = (await import('../../scripts/lib/admin/daemon.mjs')).renderPlist();
  const before = expected.replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '<key>PATH</key><string>/stale/bin</string>');
  writeFileSync(plistPath, before);

  const snapshotDir = trackedMkdtemp('ccmem-bootstrap-snapshot-');
  const snapshotPath = join(snapshotDir, 'bootstrap-saw.plist');
  process.env.CCMEM_FAKE_BOOTSTRAP_SNAPSHOT = snapshotPath;

  const db = openDb();
  let result;
  try {
    result = await cmdAdminDaemon(db, { verb: 'restart' });
  } finally {
    delete process.env.CCMEM_FAKE_BOOTSTRAP_SNAPSHOT;
  }

  assert.equal(result.status, 'restarted');
  assert.equal(result.plist_rewrite.written, true, 'a PATH refresh must reach the installed plist');
  assert.ok(existsSync(snapshotPath), 'bootstrap must have run and been snapshotted — otherwise this test proves nothing');
  const bootstrapSaw = readFileSync(snapshotPath, 'utf8');
  assert.doesNotMatch(bootstrapSaw, /\/stale\/bin/, 'bootstrap must not have been handed the stale, pre-rewrite plist');
  assert.equal(bootstrapSaw, expected, 'bootstrap must have been handed the freshly rewritten plist');
}));

// 报警轴到此为止都只对 JS 调用方可见——一个真人跑 `ccmem admin daemon restart`
// 只看得到 stdout 的 "restarted pid=..."，blocked_by / reason / REMEDY 全部
// 到不了终端。CCMEM_CONFIG_PATH 目标文件被删掉之后，G2 会在此后每一次 restart
// 都拦下重写，永久且无声——跟 Finding 10 本身同一类静默无效。
test('CLI reporting: a blocked gate writes the remedy to stderr', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  writeFileSync(plistPath, plistWith({ ...BASE_ENV, ANTHROPIC_API_KEY: 'old' }));

  const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'restart'], {
    env: process.env,
    encoding: 'utf8'
  });

  assert.match(result.stderr, /uninstall && ccmem admin daemon install/, 'a blocked gate must surface the remedy on stderr');
}));

test('CLI reporting: a successful rewrite adds no extra stderr noise', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  const expected = (await import('../../scripts/lib/admin/daemon.mjs')).renderPlist();
  writeFileSync(plistPath, expected.replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '<key>PATH</key><string>/stale/bin</string>'));

  const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'restart'], {
    env: process.env,
    encoding: 'utf8'
  });

  // 这三条缺一不可：只断言"没提到 not rewritten"，CLI 崩了或者压根没写都照样绿——
  // 那样这条测试对得起的名字是"没崩到打印那句话"，不是"成功重写"。
  assert.equal(result.status, 0, 'the CLI must exit cleanly, not merely avoid one particular stderr line');
  assert.doesNotMatch(result.stderr, /plist not rewritten/, 'a clean write must not report a block that did not happen');
  assert.doesNotMatch(readFileSync(plistPath, 'utf8'), /\/stale\/bin/, 'the rewrite must actually have landed on disk');
}));

// bug-063 缺陷 3。缺陷 2 修好之后 restart_failed 第一次真的能走到 CLI，而 CLI 的
// 十二个分支里没有它 —— 落到 :632 的兜底，phase / reason / previous_pid 全部丢掉，
// 打出来的正是 2026-08-05 那两次看到的 "daemon restart failed"。
// 断言打在进程边界（退出码 + stderr）：纯函数有测试不等于接线有测试。
test('CLI reporting: a failed restart names the phase and the reason on stderr', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  process.env.CCMEM_FAKE_BOOTOUT_FAIL = '1';
  try {
    const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'restart'], {
      env: process.env,
      encoding: 'utf8'
    });

    assert.equal(result.status, 1, 'a genuine failure must still exit non-zero');
    assert.match(result.stderr, /phase=stop/, 'the operator must be told which half failed');
    assert.match(result.stderr, /bootout refused/, 'the underlying launchctl reason must reach the terminal');
    assert.match(result.stderr, /admin daemon status/, 'the message must point at the check that distinguishes a real failure from a slow start');
  } finally {
    delete process.env.CCMEM_FAKE_BOOTOUT_FAIL;
  }
}));

// bug-063 收尾。restart 的 start 阶段超时会被 restartDaemon 改写成 restart_failed,
// 于是 cli.mjs 那条"超时不等于失败"的分支对 restart 永远不可达 —— 而 restart 正是
// 这个 bug 被报出来的动作。failed_status 把子状态带出来，操作者才分得清
// "我们等到放弃了" 和 "launchd 拒绝了"。这条测试同时是 phase:'start' 那条返回
// 路径的第一个专属回归测试。
test('CLI reporting: a restart whose start times out says it timed out, not just failed', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  process.env.CCMEM_FAKE_START_NEVER = '1';
  try {
    const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'restart'], {
      env: process.env,
      encoding: 'utf8'
    });

    assert.equal(result.status, 1, 'a restart that never came up must exit non-zero');
    assert.match(result.stderr, /phase=start/, 'the start half must be named as the one that failed');
    assert.match(result.stderr, /start_timeout/, 'the sub-status must survive restartDaemon rewriting it');
    assert.match(result.stderr, /timed out, not a diagnosed failure/, 'a timeout must not read like a diagnosed failure');
  } finally {
    delete process.env.CCMEM_FAKE_START_NEVER;
  }
}));

// 报警轴（status: 'drifted'）此前只算出来、从不落地：daemon.mjs 每次 status 都挂
// plist_drift，cli.mjs 的 status 分支从不提它——一个生产者，零个消费者，操作员永远看不到。
test('CLI reporting: daemon status surfaces plist drift by key name only', () => withFakeLaunchctl(async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url));

  const agentDir = trackedMkdtemp('ccmem-la-');
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  const expected = (await import('../../scripts/lib/admin/daemon.mjs')).renderPlist();
  // 去掉 CCMEM_DATA_ROOT 这一个指向类 key——非自由变 key 缺失必判 drifted。
  const stale = expected.replace(/<key>CCMEM_DATA_ROOT<\/key><string>[^<]*<\/string>/, '');
  writeFileSync(plistPath, stale);

  const db = openDb();
  const now = Date.now();
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, 4321, 'drift-host', ?, ?, 1)`
  ).run(now - 5000, now - 800);
  db.close();

  const result = spawnSync(process.execPath, [cliPath, 'admin', '--', 'daemon', 'status'], {
    env: process.env,
    encoding: 'utf8'
  });

  assert.match(result.stdout, /ccmem: daemon alive pid=4321/);
  assert.match(result.stdout, /plist=drifted/, 'the alive line must carry the drift status');
  assert.match(result.stderr, /CCMEM_DATA_ROOT/, 'the changed key name must be named');
  // key 名只是名字，不是值：这个 data root 目录的实际路径永不该出现在输出里。
  const escapedRoot = wiringDataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(result.stdout, new RegExp(escapedRoot), 'no value may leak to stdout');
  assert.doesNotMatch(result.stderr, new RegExp(escapedRoot), 'no value may leak to stderr');

  // 这条测试直接写 daemon_lock（不经过 cmdAdminDaemon），清干净给后面的测试留一个干净状态。
  const cleanupDb = openDb();
  cleanupDb.prepare(`DELETE FROM daemon_lock`).run();
  cleanupDb.close();
}));

// drift 检测的基准必须与 install 实际写入的内容同源——否则两处求值点分道扬镳
// 时不会有任何症状。见 task-5-brief：declaration 本身也匹配 renderDaemonPlist(
// 这个 pattern，所以要用负向前瞻排除声明行，断言的是"恰好一个调用方"。
test('install writes exactly what renderPlist produces', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../scripts/lib/admin/daemon.mjs', import.meta.url), 'utf8');

  // installDaemon 体内不得再出现第二个 renderDaemonPlist 调用点。
  const callSites = source.match(/(?<!function )renderDaemonPlist\(/g) ?? [];
  assert.equal(callSites.length, 1, 'renderDaemonPlist must have exactly one caller: renderPlist');
  assert.match(source, /writeFileSync\(plistPath, renderPlist\(\)\)/);
});
