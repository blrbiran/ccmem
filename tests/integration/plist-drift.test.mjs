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

const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import('node:fs');
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
  '    rm -f "$STATE"',
  '    sqlite3 "$DB" "DELETE FROM daemon_lock;" >/dev/null 2>&1',
  '    ;;',
  '  bootstrap)',
  '    : > "$STATE"',
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
    delete process.env.CCMEM_LAUNCHAGENT_DIR;
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

  assert.doesNotMatch(result.stderr, /plist not rewritten/, 'a clean write must not report a block that did not happen');
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
