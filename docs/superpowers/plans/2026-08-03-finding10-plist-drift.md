# Finding 10 — plist drift 检测与带门禁的重写 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `daemon status` 报出 launchd plist 与当前代码求值结果的分歧，并让 `daemon restart` 在四道门禁全过时自动重写 plist。

**Architecture:** 新增一个纯函数模块承载解析、三轴比对、key 分类与门禁谓词；`daemon.mjs` 只做接线（`status` 报告、`restart` 判门禁并决定写不写）。检测不启子进程，探针只在真要写之前跑一次。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、`node:assert/strict`、`node:child_process` 的 `spawnSync`。

**设计依据：** `docs/superpowers/specs/2026-08-02-finding10-plist-drift-design.md`。**动手前必须整篇读完**——本计划不重复其中的取舍理由，只落实做法。

## Global Constraints

- **跑测试的命令固定为**：`CCMEM_DATA_ROOT=<临时目录> npm test -- <文件>`，并且**必须 `-u CCMEM_CONFIG_PATH`**（`env -u CCMEM_CONFIG_PATH`）。两者缺一，测试会读到 `~/.claude/ccmem/config.json`，那里面有真实 API key。
- **每条测试必须先被亲眼看着变红，且确认红的原因是预期的那个**（不是表名写错、不是桩没回调、不是 import 路径错）。红因不符就重写测试，不要往下走。
- **测试一律打在 `cmdAdminDaemon(db, { verb })` 这一层**，不打在被测纯函数上。理由：本项目栽过"纯函数有测试但接线没接上"。
- **测试用 `CCMEM_LAUNCHAGENT_DIR` 指向临时目录**，任何测试都不得读写真实的 `~/Library/LaunchAgents`。
- **输出中值一律不打印，只打印 key 名**，唯一例外是 `CCMEM_CONFIG_PATH` 与 `CCMEM_DATA_ROOT` 的新旧值。`ANTHROPIC_API_KEY`/`ANTHROPIC_FOUNDRY_API_KEY` 在 `DAEMON_ENV_PASSTHROUGH` 里，**只在安装那一刻的 shell 里该变量确实非空时才会被复制进 plist**（`daemon.mjs:84-87`）——plist **可能**含这些凭据，不是必然（本机当前那份就不含）。规则不因此放松：打印值仍然等于把凭据写进终端和日志。
- **探针 timeout = 5000，写成模块常量，不进配置文件。**
- **重写的条件是：字节不等 且 环境字典可解析 且 G1–G4 全过。**不是 `status === 'drifted'`。`status` 属报警轴，`in_sync` 时照样可能要写。
- **提交信息里不写 commit SHA；文档里也不写。**
- 每个 Task 结束时工作树必须干净、`npm test` 全绿。

## File Structure

| 文件 | 职责 |
|---|---|
| `scripts/lib/admin/plist-drift.mjs`（**新建**） | key 分类表、plist 三轴拆分与环境字典解析、比对、门禁谓词。除 `existsSync` 外无 I/O，不启子进程。 |
| `scripts/lib/admin/daemon.mjs`（**改**） | 接线：`status` 附 `plist_drift`；`restart` 判门禁并决定写不写、附 `plist_rewrite`；`installDaemon` 改调 `renderPlist()`。 |
| `tests/integration/plist-drift.test.mjs`（**新建**） | 全部 13 条测试，均经由 `cmdAdminDaemon`。 |
| `docs/ccmem-v0.13-spec.md`（**改**） | 附录 A 新增不变量 #143。 |
| `docs/ccmem-v0.13-dogfood.md`（**改**） | Finding 10 条目状态由「未修」改为「已修复」。 |

分成独立模块而不是塞进 `daemon.mjs`：`daemon.mjs` 已 700+ 行，且比对逻辑是纯函数、可单独推理；接线留在 `daemon.mjs` 里保持它"命令编排"的单一职责。

---

### Task 1: key 分类表与全覆盖断言

**Files:**
- Create: `scripts/lib/admin/plist-drift.mjs`
- Create: `tests/integration/plist-drift.test.mjs`
- Modify: `scripts/lib/admin/daemon.mjs`（仅导出 `DAEMON_ENV_PASSTHROUGH`，供断言枚举）

**Interfaces:**
- Consumes: `daemon.mjs` 的 `DAEMON_ENV_PASSTHROUGH`（本 Task 新增导出）。
- Produces:
  - `classifyKey(key: string) => 'pointing' | 'credential' | 'free' | null`（未分类返回 `null`）
  - `ALL_CLASSIFIED_KEYS: string[]` —— 三桶并集，供断言使用

- [ ] **Step 1: 写失败的测试**

在 `tests/integration/plist-drift.test.mjs` 写入：

```javascript
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
```

第二条是第一条的正面对照：证明 `classifyKey` 真的会对陌生 key 返回 `null`，
否则"零个未分类"可能只是因为它对什么都返回一个桶。

- [ ] **Step 2: 跑测试，确认它变红，且红因正确**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t1 npm test -- tests/integration/plist-drift.test.mjs`

Expected: FAIL，报错应为**模块找不到**（`Cannot find module '.../plist-drift.mjs'`）。
若红因是别的（例如 `DAEMON_ENV_PASSTHROUGH is not exported`），先把那个修掉再回到这一步——
红得不对就不算验过红。

- [ ] **Step 3: 导出 `DAEMON_ENV_PASSTHROUGH`**

`scripts/lib/admin/daemon.mjs`，把常量声明改为导出（位置在文件顶部常量区）：

```javascript
export const DAEMON_ENV_PASSTHROUGH = [
```

其余不动。

- [ ] **Step 4: 写最小实现**

新建 `scripts/lib/admin/plist-drift.mjs`：

```javascript
// key 分类。原则（设计文档 §四）：凡决定"daemon 用谁的身份、把数据发到哪、
// 读哪个文件"的 key，值不得静默变；凡只决定"怎么做"的 key，自由变。
//
// CCMEM_CLAUDE_P_COMMAND 是唯一的刻意例外：它决定哪个本地二进制被执行，按字面
// 也算"身份"，但归自由变 —— 它消失由 G1 挡、它指向变坏由 G4 的探针挡。
const POINTING_KEYS = new Set([
  'CCMEM_DATA_ROOT',
  'CCMEM_CONFIG_PATH',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_FOUNDRY'
]);

const CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY'
]);

const FREE_KEYS = new Set([
  'PATH',
  'CCMEM_CLAUDE_P_COMMAND',
  'CCMEM_CLAUDE_P_ARGS_JSON',
  'CCMEM_CLAUDE_P_TIMEOUT_MS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL'
]);

export function classifyKey(key) {
  if (POINTING_KEYS.has(key)) return 'pointing';
  if (CREDENTIAL_KEYS.has(key)) return 'credential';
  if (FREE_KEYS.has(key)) return 'free';
  return null;
}

export const ALL_CLASSIFIED_KEYS = [
  ...POINTING_KEYS,
  ...CREDENTIAL_KEYS,
  ...FREE_KEYS
];
```

- [ ] **Step 5: 跑测试，确认转绿**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t1 npm test -- tests/integration/plist-drift.test.mjs`
Expected: PASS，2 条。

- [ ] **Step 6: 跑全量套件，确认没打破别处**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t1 npm test`
Expected: 全绿。**先记下基线数字**（本计划撰写时的已知基线为 480 pass / 0 fail）。
已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿；**红了先确认是它**，是它就重跑，不是它就停下来查。

- [ ] **Step 7: 提交**

```bash
git add scripts/lib/admin/plist-drift.mjs tests/integration/plist-drift.test.mjs scripts/lib/admin/daemon.mjs
git commit -m "feat(daemon): sort every plist env key into a class, and assert none escapes"
```

---

### Task 2: plist 三轴拆分与环境字典解析

**Files:**
- Modify: `scripts/lib/admin/plist-drift.mjs`
- Modify: `tests/integration/plist-drift.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `classifyKey`。
- Produces:
  - `splitPlist(text: string) => { envText: string | null, programArgs: string | null, template: string }`
    —— `envText` 是 `EnvironmentVariables` 那个 `<dict>` 的**内部**文本；`template` 是剔除前两者后的残余。任一段截不出来时对应字段为 `null`。
  - `parseEnvDict(envText: string) => { ok: true, env: Record<string,string> } | { ok: false }`
    —— 有未被匹配吃掉的非空白残留即 `{ ok: false }`。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/integration/plist-drift.test.mjs`：

```javascript
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
```

最后一条是倒数第二条的正面对照：证明 `{ ok: false }` 是残留触发的，不是解析器对什么都失败。

- [ ] **Step 2: 跑测试，确认它变红，且红因正确**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t2 npm test -- tests/integration/plist-drift.test.mjs`
Expected: FAIL，红因应为 `splitPlist is not a function`。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/admin/plist-drift.mjs`：

```javascript
const ENV_OPEN = '<key>EnvironmentVariables</key><dict>';
const PROGRAM_ARGS_RE = /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/;

export function splitPlist(text) {
  let envText = null;
  let rest = text;

  const open = text.indexOf(ENV_OPEN);
  if (open !== -1) {
    const bodyStart = open + ENV_OPEN.length;
    const close = text.indexOf('</dict>', bodyStart);
    if (close !== -1) {
      envText = text.slice(bodyStart, close);
      rest = text.slice(0, open) + text.slice(close + '</dict>'.length);
    }
  }

  const argsMatch = rest.match(PROGRAM_ARGS_RE);
  const programArgs = argsMatch ? argsMatch[0] : null;
  const template = argsMatch ? rest.replace(PROGRAM_ARGS_RE, '') : rest;

  return { envText, programArgs, template };
}

const PAIR_RE = /<key>([\s\S]*?)<\/key><string>([\s\S]*?)<\/string>/g;

// escapeXml 的逆。& 必须最后还原，否则 "&amp;lt;" 会被错还原成 "<"。
function unescapeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseEnvDict(envText) {
  if (typeof envText !== 'string') return { ok: false };

  const env = {};
  let residue = envText;

  for (const match of envText.matchAll(PAIR_RE)) {
    env[unescapeXml(match[1])] = unescapeXml(match[2]);
    residue = residue.replace(match[0], '');
  }

  // 有吃不掉的非空白残留 ⇒ 这不是我们渲染的形状，判不可解析。
  if (residue.trim() !== '') return { ok: false };

  return { ok: true, env };
}
```

- [ ] **Step 4: 跑测试，确认转绿**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t2 npm test -- tests/integration/plist-drift.test.mjs`
Expected: PASS，6 条（Task 1 的 2 条 + 本 Task 的 4 条）。

- [ ] **Step 5: 跑全量套件**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t2 npm test`
Expected: 全绿，数字与 Task 1 Step 6 记下的基线相比只多本 Task 新增的条数。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/admin/plist-drift.mjs tests/integration/plist-drift.test.mjs
git commit -m "feat(daemon): split a plist into its three comparable axes"
```

---

### Task 3: 三轴比对与 `status` 接线

**Files:**
- Modify: `scripts/lib/admin/plist-drift.mjs`
- Modify: `scripts/lib/admin/daemon.mjs`（`cmdAdminDaemon` 的 `status` 分支，`:710`）
- Modify: `tests/integration/plist-drift.test.mjs`

**Interfaces:**
- Consumes: Task 1 `classifyKey`、Task 2 `splitPlist` / `parseEnvDict`。
- Produces:
  - `comparePlist(oldText: string, newText: string) => { status, added, removed, changed, benign_changed, template_changed }`
    —— `status` 取 `'in_sync' | 'drifted' | 'unknown'`；五个数组元素均为字符串，`template_changed` 的取值只可能是 `'ProgramArguments'` 和 `'template'`。
  - `cmdAdminDaemon(db, { verb: 'status' })` 的返回值新增 `plist_drift` 字段。

**报警轴与重写轴是两件事。** 本 Task 只做报警轴。
`status` 三态只回答"值不值得人看一眼"：自由变 key 的差异、`ProgramArguments` 差异、
模板差异**都不影响三态**，各自单列。重写条件在 Task 4，与 `status` 无关。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/integration/plist-drift.test.mjs`：

```javascript
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
```

- [ ] **Step 2: 跑测试，确认它变红，且红因正确**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t3 npm test -- tests/integration/plist-drift.test.mjs`
Expected: FAIL，红因应为 `comparePlist is not a function`。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/admin/plist-drift.mjs`：

```javascript
const EMPTY_LISTS = {
  added: [], removed: [], changed: [], benign_changed: [], template_changed: []
};

export function comparePlist(oldText, newText) {
  const oldParts = splitPlist(oldText);
  const newParts = splitPlist(newText);

  const oldEnv = parseEnvDict(oldParts.envText);
  const newEnv = parseEnvDict(newParts.envText);

  // 判不了就是判不了。不得从解析失败推出 in_sync。
  if (!oldEnv.ok || !newEnv.ok) {
    return { status: 'unknown', ...EMPTY_LISTS };
  }

  const added = [];
  const removed = [];
  const changed = [];
  const benign_changed = [];

  for (const key of Object.keys(newEnv.env)) {
    if (!(key in oldEnv.env)) added.push(key);
  }
  for (const key of Object.keys(oldEnv.env)) {
    if (!(key in newEnv.env)) removed.push(key);
  }
  for (const key of Object.keys(newEnv.env)) {
    if (!(key in oldEnv.env)) continue;
    if (oldEnv.env[key] === newEnv.env[key]) continue;
    // 自由变 key 的值变化不进报警轴 —— 但它仍会让字节不等，从而进重写轴。
    if (classifyKey(key) === 'free') benign_changed.push(key);
    else changed.push(key);
  }

  const template_changed = [];
  if (oldParts.programArgs !== newParts.programArgs) template_changed.push('ProgramArguments');
  if (oldParts.template !== newParts.template) template_changed.push('template');

  const raisesVerdict = added.length || removed.length || changed.length;
  return {
    status: raisesVerdict ? 'drifted' : 'in_sync',
    added, removed, changed, benign_changed, template_changed
  };
}
```

- [ ] **Step 4: 跑测试，确认转绿**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t3 npm test -- tests/integration/plist-drift.test.mjs`
Expected: PASS，11 条。

- [ ] **Step 5: 写 `status` 接线的失败测试**

追加：

```javascript
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');

// 接线测试。纯函数有测试 ≠ 接线有测试 —— 这里要证明 verb 分发真的调到了检测。
test('T1 wiring: daemon status reports plist_drift', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  writeFileSync(join(agentDir, 'com.ccmem.daemon.plist'), plistWith(BASE_ENV));

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'status' });
  assert.ok(result.plist_drift, 'status must carry plist_drift');
  assert.ok(['in_sync', 'drifted', 'unknown'].includes(result.plist_drift.status));
});
```

- [ ] **Step 6: 跑它，确认红因是 `plist_drift` 缺失**

Run: 同上命令。
Expected: FAIL，`status must carry plist_drift`。**若红因是 `openDb is not a function` 之类，
先按仓库里现有测试的写法对齐 db 打开方式，再回到这一步。**

- [ ] **Step 7: 接线**

`scripts/lib/admin/daemon.mjs`，在 `cmdAdminDaemon` 的 `status` 分支（`:710` 附近）：

```javascript
  if (verb === 'status') {
    const status = loadDaemonStatus(db);
    return { ...status, plist_drift: describePlistDrift() };
  }
```

并在同文件新增：

```javascript
// 检测不启子进程 —— 探针只属于门禁。这就是 status 能顺带报 drift 的原因。
function describePlistDrift() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { status: 'not_installed', added: [], removed: [], changed: [], benign_changed: [], template_changed: [] };
  }

  const onDisk = readFileSync(plistPath, 'utf8');
  const expected = renderPlist();
  if (onDisk === expected) {
    return { status: 'in_sync', added: [], removed: [], changed: [], benign_changed: [], template_changed: [] };
  }

  return comparePlist(onDisk, expected);
}
```

在文件顶部加 import：

```javascript
import { comparePlist, classifyKey } from './plist-drift.mjs';
```

- [ ] **Step 8: 跑测试，确认转绿**

Run: 同上。Expected: PASS，12 条。

- [ ] **Step 9: 跑全量套件**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t3 npm test`
Expected: 全绿。

- [ ] **Step 10: 提交**

```bash
git add scripts/lib/admin/plist-drift.mjs scripts/lib/admin/daemon.mjs tests/integration/plist-drift.test.mjs
git commit -m "feat(daemon): report plist drift from status without spawning anything"
```

---

### Task 4: 四道门禁与 `restart` 的重写

**Files:**
- Modify: `scripts/lib/admin/plist-drift.mjs`
- Modify: `scripts/lib/admin/daemon.mjs`（`restartDaemon`，`:693`）
- Modify: `tests/integration/plist-drift.test.mjs`

**Interfaces:**
- Consumes: Task 3 `comparePlist`；`daemon.mjs` 内部的 `probeClaudeJsonSchemaSupport`。
- Produces:
  - `effectiveConfigPath(env: Record<string,string>, defaultDataRoot: string) => string`
  - `evaluateGates(oldEnv, newEnv, { defaultDataRoot, probe }) => { ok: boolean, blocked_by: 'G1'|'G2'|'G3'|'G4'|null, reason: string }`
    —— `probe` 是 `(command, env) => { ok: boolean, reason?: string }`，由调用方注入，便于测试替身。
  - `restartDaemon` 返回值新增 `plist_rewrite: { written, blocked_by, reason }`。

**重写条件（不要写成 `status === 'drifted'`）：**

> **字节不等 且 环境字典可解析 且 G1–G4 全过 ⇒ 重写。**

`in_sync` 但 `benign_changed` / `template_changed` 非空时**照写**——
这正是 `PATH`、node 路径、模板变更得以传播到既有安装的路径，
也是 Finding 10 点名的三类静默无效里能自动修掉的那两类。

- [ ] **Step 1: 写门禁的失败测试**

追加：

```javascript
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
  const real = join(mkdtempSync(join(tmpdir(), 'ccmem-cfg-')), 'other.json');
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
  assert.match(verdict.reason, /uninstall && install/);
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
```

- [ ] **Step 2: 跑测试，确认红因是 `evaluateGates is not a function`**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t4 npm test -- tests/integration/plist-drift.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 写最小实现**

在 `scripts/lib/admin/plist-drift.mjs` 顶部加 import：

```javascript
import { existsSync } from 'node:fs';
import path from 'node:path';
```

追加：

```javascript
const REMEDY = 'run `ccmem admin daemon uninstall && ccmem admin daemon install` from the shell you want the daemon to inherit';

// 直接复用 loadConfig 的解析规则（config.mjs），不另发明一套：
// 比的是 daemon 实际会读哪个文件，不是字典里有没有那个 key。
export function effectiveConfigPath(env, defaultDataRoot) {
  const root = env.CCMEM_DATA_ROOT ?? defaultDataRoot;
  const userPath = env.CCMEM_CONFIG_PATH;
  return userPath && existsSync(userPath) ? userPath : path.join(root, 'config.json');
}

const POINTING_LITERAL_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'CLAUDE_CODE_USE_FOUNDRY'];

export function evaluateGates(oldEnv, newEnv, { defaultDataRoot, probe }) {
  // G1 —— key 非缩减。
  const removed = Object.keys(oldEnv).filter((key) => !(key in newEnv));
  if (removed.length) {
    return { ok: false, blocked_by: 'G1', reason: `refusing to drop ${removed.join(', ')} from the daemon environment; ${REMEDY}` };
  }

  // G2 —— 指向类有效值。CCMEM_CONFIG_PATH 指向一个不存在的文件时，
  // 有效值虽然回落成默认，但写进 plist 就是一颗延时地雷：那个文件一旦被创建，
  // daemon 下次启动就跟着走了，而它已经过了这道门。所以拦。
  if (newEnv.CCMEM_CONFIG_PATH && !existsSync(newEnv.CCMEM_CONFIG_PATH)) {
    return { ok: false, blocked_by: 'G2', reason: `CCMEM_CONFIG_PATH names ${newEnv.CCMEM_CONFIG_PATH}, which does not exist; ${REMEDY}` };
  }

  const oldConfig = effectiveConfigPath(oldEnv, defaultDataRoot);
  const newConfig = effectiveConfigPath(newEnv, defaultDataRoot);
  if (oldConfig !== newConfig) {
    return { ok: false, blocked_by: 'G2', reason: `refusing to repoint the daemon config from ${oldConfig} to ${newConfig}; ${REMEDY}` };
  }

  for (const key of POINTING_LITERAL_KEYS) {
    if ((oldEnv[key] ?? null) !== (newEnv[key] ?? null)) {
      return { ok: false, blocked_by: 'G2', reason: `refusing to change ${key}, which decides where the daemon sends data; ${REMEDY}` };
    }
  }

  // G3 —— 凭据类。只报 key 名，永不报值。
  for (const key of Object.keys(newEnv)) {
    if (classifyKey(key) !== 'credential') continue;
    if ((oldEnv[key] ?? null) !== newEnv[key]) {
      return { ok: false, blocked_by: 'G3', reason: `refusing to change ${key}; ${REMEDY}` };
    }
  }

  // G4 —— 探针。新 env 没有 claude 可探时空过（正常路径已被 G1 拦下），
  // 但空过不得记成"探针通过"。
  const command = newEnv.CCMEM_CLAUDE_P_COMMAND;
  if (command) {
    const probed = probe(command, newEnv);
    if (!probed.ok) {
      return { ok: false, blocked_by: 'G4', reason: probed.reason ?? 'claude capability probe failed' };
    }
  }

  return { ok: true, blocked_by: null, reason: 'all gates passed' };
}
```

- [ ] **Step 4: 跑测试，确认转绿**

Run: 同上。Expected: PASS，21 条。

- [ ] **Step 5: 写 `restart` 接线的失败测试（含 T9、T11）**

追加：

```javascript
// T9。restart 的本职是把 daemon 起回来；用一个可疑的配置问题去阻断重启，
// 是拿一个可疑问题换一个确定的停机。
test('T9: a blocked gate still lets the restart finish', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  writeFileSync(plistPath, plistWith({ ...BASE_ENV, ANTHROPIC_API_KEY: 'old' }));
  const before = readFileSync(plistPath, 'utf8');

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  assert.equal(result.status, 'restarted');
  assert.equal(result.plist_rewrite.written, false);
  assert.equal(readFileSync(plistPath, 'utf8'), before, 'a blocked gate must leave the plist byte-identical');
});

// T11。解析不出旧 env 就判不了 G1–G3，此时重写等于在看不见的前提下改配置。
test('T11: an unparsable plist blocks the rewrite', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  writeFileSync(plistPath, plistWith(BASE_ENV).replace('<string>/usr/bin</string>', '<data>zz</data>'));
  const before = readFileSync(plistPath, 'utf8');

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  assert.equal(result.plist_rewrite.blocked_by, 'unparsable');
  assert.equal(result.plist_rewrite.written, false);
  assert.equal(readFileSync(plistPath, 'utf8'), before);
});
```

- [ ] **Step 6: 跑它，确认红因是 `plist_rewrite` 缺失**

Run: 同上。Expected: FAIL，`Cannot read properties of undefined (reading 'written')`。
**这条红因是可接受的**——它证明 `plist_rewrite` 还不存在。

- [ ] **Step 7: 接线**

`scripts/lib/admin/daemon.mjs`，新增常量与函数：

```javascript
// 本地进程启动，量级远低于此；restart 是人为动作，宁可等也不要误判。
// 这个值是设计决定，不是实测导出的。不进配置 —— 新增配置项就是新增一个
// 可与代码分歧的面（Finding 12 的形状）。
const PLIST_PROBE_TIMEOUT_MS = 5000;

function rewritePlistIfAllowed() {
  const plistPath = getLaunchAgentPath();
  if (!existsSync(plistPath)) {
    return { written: false, blocked_by: null, reason: 'daemon is not installed under launchd' };
  }

  const onDisk = readFileSync(plistPath, 'utf8');
  const expected = renderPlist();
  if (onDisk === expected) {
    return { written: false, blocked_by: null, reason: 'plist already matches the current environment' };
  }

  const oldEnv = parseEnvDict(splitPlist(onDisk).envText);
  const newEnv = parseEnvDict(splitPlist(expected).envText);
  if (!oldEnv.ok || !newEnv.ok) {
    return { written: false, blocked_by: 'unparsable', reason: 'the installed plist is not in a shape this build can read; leaving it alone' };
  }

  const verdict = evaluateGates(oldEnv.env, newEnv.env, {
    defaultDataRoot: getDataRoot(),
    probe: (command, env) => probeClaudeJsonSchemaSupport(command, env, PLIST_PROBE_TIMEOUT_MS)
  });
  if (!verdict.ok) {
    return { written: false, blocked_by: verdict.blocked_by, reason: verdict.reason };
  }

  writeFileSync(plistPath, expected);
  return { written: true, blocked_by: null, reason: 'plist regenerated from the current environment' };
}
```

改 `restartDaemon`（`:693`），在 `stopDaemon` 成功之后、`startDaemon` 之前插入重写，
使新 plist 在 `kickstart` 时被读到：

```javascript
  const rewrite = rewritePlistIfAllowed();

  const started = await startDaemon(db);
```

并把 `rewrite` 并进两个返回点：

```javascript
  if (!['started', 'already_running'].includes(started.status)) {
    return { status: 'restart_failed', phase: 'start', previous_pid: current.pid ?? null, plist_rewrite: rewrite, ...started };
  }

  return { ...started, status: 'restarted', previous_pid: current.pid ?? null, plist_rewrite: rewrite };
```

给探针加可选 timeout（`:263`），**不改 `installDaemon()` 的调用点**：

```javascript
function probeClaudeJsonSchemaSupport(command, daemonEnv, timeoutMs) {
  const result = spawnSync(command, ['-p', '--help'], {
    encoding: 'utf8',
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    env: { ...process.env, ...daemonEnv }
  });
```

补 import：

```javascript
import { comparePlist, classifyKey, evaluateGates, parseEnvDict, splitPlist } from './plist-drift.mjs';
```

- [ ] **Step 8: 跑测试，确认转绿**

Run: 同上。Expected: PASS，23 条。

- [ ] **Step 9: 补 T2 / T2b 的重写侧断言**

上面 Task 3 的 T2 / T2b 只验了报警侧。**报警轴与重写轴是两个轴**，重写侧必须单独验，
否则"PATH 变不报警"很容易被实现成"PATH 变不重写"——那会让 Finding 10 点名的
`PATH` 拼装修复继续静默无效。追加：

```javascript
test('T2 rewrite side: a benign-only difference is still written', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;
  const plistPath = join(agentDir, 'com.ccmem.daemon.plist');
  // 磁盘上是一份除 PATH 外与当前求值一致的 plist：构造法是先取当前期望值，
  // 再把 PATH 那一行改掉，确保唯一差异落在自由变桶。
  const expected = (await import('../../scripts/lib/admin/daemon.mjs')).renderPlist();
  writeFileSync(plistPath, expected.replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '<key>PATH</key><string>/stale/bin</string>'));

  const db = openDb();
  const result = await cmdAdminDaemon(db, { verb: 'restart' });

  assert.equal(result.plist_drift?.status ?? 'in_sync', 'in_sync');
  assert.equal(result.plist_rewrite.written, true, 'a PATH refresh must reach the installed plist');
  assert.doesNotMatch(readFileSync(plistPath, 'utf8'), /\/stale\/bin/);
});
```

- [ ] **Step 10: 跑它，确认它变红，且红因是"没写"而不是别的**

Run: 同上。
Expected: 若实现把不写的条件写成了 `status === 'in_sync'`，红因是
`a PATH refresh must reach the installed plist`。**这正是要防的那个错**。
若一次就绿，**手动把 `rewritePlistIfAllowed` 里的字节比较改成
`if (comparePlist(onDisk, expected).status === 'in_sync')` 跑一次，确认它变红，再改回来**——
不变红的测试不算测试。

- [ ] **Step 11: 跑全量套件**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t4 npm test`
Expected: 全绿。

- [ ] **Step 12: 提交**

```bash
git add scripts/lib/admin/plist-drift.mjs scripts/lib/admin/daemon.mjs tests/integration/plist-drift.test.mjs
git commit -m "feat(daemon): rewrite the plist on restart only when four gates allow it"
```

---

### Task 5: 让 `installDaemon` 复用 `renderPlist()`

**Files:**
- Modify: `scripts/lib/admin/daemon.mjs`（`installDaemon`，`:523-526`）
- Modify: `tests/integration/plist-drift.test.mjs`

**Interfaces:**
- Consumes: 已有的 `renderPlist()`。
- Produces: 无新接口。这是消除重复求值点。

**为什么值得单独一个 Task：** drift 检测的整个前提是"`renderPlist()` 产出的就是
`installDaemon` 会写的"。今天两者逐字相同，但**它们是两处独立求值**——谁改了一边没改另一边，
检测就会在和一个错的基准比，而且不会有任何症状。让 install 复用 `renderPlist()` 后，
分歧在结构上不可能存在，这比加一条"断言两者相等"的测试更彻底。

- [ ] **Step 1: 写失败的测试**

追加：

```javascript
// drift 检测的基准必须与 install 实际写入的内容同源。
test('install writes exactly what renderPlist produces', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'ccmem-la-'));
  process.env.CCMEM_LAUNCHAGENT_DIR = agentDir;

  const mod = await import('../../scripts/lib/admin/daemon.mjs');
  const source = readFileSync(new URL('../../scripts/lib/admin/daemon.mjs', import.meta.url), 'utf8');

  // installDaemon 体内不得再出现第二个 renderDaemonPlist 调用点。
  const directCalls = source.match(/renderDaemonPlist\(/g) ?? [];
  assert.equal(directCalls.length, 1, 'renderDaemonPlist must have exactly one caller: renderPlist');
  assert.match(source, /writeFileSync\(plistPath, renderPlist\(\)\)/);
});
```

- [ ] **Step 2: 跑测试，确认它变红**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t5 npm test -- tests/integration/plist-drift.test.mjs`
Expected: FAIL，`renderDaemonPlist must have exactly one caller`（当前是 2 个）。

- [ ] **Step 3: 改 `installDaemon`**

`:523-526` 原为：

```javascript
  const nodePath = resolveInstallNodePath(process.env);

  mkdirSync(getLaunchAgentDir(), { recursive: true });
  writeFileSync(plistPath, renderDaemonPlist(dataRoot, daemonEnv, nodePath));
```

改为：

```javascript
  mkdirSync(getLaunchAgentDir(), { recursive: true });
  writeFileSync(plistPath, renderPlist());
```

`nodePath` 在本函数后续（container fallback 分支 `:538`、`:539`）仍在用，
**所以 `const nodePath = resolveInstallNodePath(process.env);` 这一行必须保留**，
只删掉 `renderDaemonPlist(...)` 那次调用。同理 `dataRoot`、`daemonEnv` 上文仍在用于
门禁判断（`:504`、`:514`），一并保留。

- [ ] **Step 4: 跑测试，确认转绿**

Run: 同上。Expected: PASS，25 条。

- [ ] **Step 5: 跑全量套件——这一步尤其要看 install 相关的既有测试**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t5 npm test`
Expected: 全绿。`tests/integration/v013-daemon-config-path.test.mjs` 三条必须仍绿——
它们钉的是 `CCMEM_CONFIG_PATH` 进 plist、`OPENAI_API_KEY` 不进 plist。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/admin/daemon.mjs tests/integration/plist-drift.test.mjs
git commit -m "refactor(daemon): give the plist a single point of evaluation"
```

---

### Task 6: 不变量 #143、文档回填、实测复核

**Files:**
- Modify: `docs/ccmem-v0.13-spec.md`（附录 A）
- Modify: `docs/ccmem-v0.13-dogfood.md`（Finding 10 条目，`:405` 与 `:921` 附近）
- Modify: `docs/handoff/handoff.md`

**Interfaces:** 无代码接口。

- [ ] **Step 1: 加不变量 #143**

`docs/ccmem-v0.13-spec.md` 附录 A，在 #142 之后追加：

```markdown
143. `restart` 只在**字节不等、环境字典可解析、G1–G4 全过**时重写 plist；
     其余一切情形（字节相等 / 不可解析 / 任一门不过）plist 字节不变，且 restart 仍成功。
```

**措辞注意**：条件是**字节不等**，不是 `status === 'drifted'`。
`status` 属报警轴，`in_sync` 时照样可能要写——写成 `drifted` 就复刻了设计初稿那个错。

- [ ] **Step 2: 验这条不变量能变红**

附录 A **没有 runner，是人工 checklist**，所以按既定做法：

```bash
cp scripts/lib/admin/daemon.mjs /tmp/daemon-mirror.mjs
```

把 `rewritePlistIfAllowed` 里的门禁判断整段注释掉（让它无条件写），
跑 `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-t6 npm test -- tests/integration/plist-drift.test.mjs`，
**确认 T3–T7、T11 变红**。然后：

```bash
cp /tmp/daemon-mirror.mjs scripts/lib/admin/daemon.mjs && rm /tmp/daemon-mirror.mjs
```

再跑一次确认恢复全绿。**没看着它红过，这条不变量就不算数。**

- [ ] **Step 3: 实测复核影响面——不用读码结论**

Finding 5 被读码推断误判过两次，此步不可省。在真实环境（不是临时目录）：

```bash
ccmem admin daemon install
# 临时往 buildDaemonEnv 的 passthroughKeys 加一个自由变测试 key（改动不提交）
ccmem admin daemon restart
grep -c 'CCMEM_CLAUDE_P_TIMEOUT_MS' ~/Library/LaunchAgents/com.ccmem.daemon.plist
```

**取证只 grep key 名，不打印 plist 内容、不落盘、不进任何文档**——
本机那份 plist 含 `ANTHROPIC_API_KEY`。

判读：修复前该 grep 返回 `0`，修复后返回 `1`。
**这个 `0` 必须配正面对照**：同一条 grep 对一个确定存在的 key（如 `CCMEM_DATA_ROOT`）
必须返回非 0，否则这个 0 只能证明 grep 本身失效。
用完把临时 key 从 `buildDaemonEnv` 撤掉，`git status --porcelain` 应为空。

- [ ] **Step 4: 回填 dogfood**

`docs/ccmem-v0.13-dogfood.md`：
- `:405` 标题的 `（P1 → **未修，仅有人工绕过**）` 改为 `（P1 → **已修复**）`；
- `:437` 的「**验证状态**：**未修**」段改写为已修复，并写明**自动重写不覆盖指向类**
  （Finding 9 自己那类仍需人工 `uninstall && install`，这是刻意的）；
- `:921` 那句把 Finding 10 列入 v0.14 待办的话删掉。

**根因与取舍不写进文档**——按本项目惯例，那些只活在提交信息里。

- [ ] **Step 5: 更新 handoff**

`docs/handoff/handoff.md`：把「未修的只剩 Finding 10 和 Finding 15」改为只剩 Finding 15；
v0.14 待办来源一节删去 Finding 10 那条；附录 A 计数由 23 改为 24。
**不写 commit SHA。**

- [ ] **Step 6: 末次全量套件 + 工作树核对**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT=/tmp/ccmem-final npm test
git status --porcelain
```

Expected: 全绿；工作树只剩本 Task 要提交的文档改动。

- [ ] **Step 7: 提交**

```bash
git add docs/ccmem-v0.13-spec.md docs/ccmem-v0.13-dogfood.md docs/handoff/handoff.md
git commit -m "docs: close out Finding 10 and add its invariant"
```

**不要 push。** 本项目所有 push 由人类执行。

---

## 计划自检

**1. spec 覆盖度**（逐节核对，非凭记忆）

| spec 章节 | 落在哪 |
|---|---|
| §四 key 分类 + 全覆盖断言 | Task 1 |
| §五 三轴拆分、解析、`unknown` | Task 2、Task 3 |
| §五 报警轴 / 重写轴解耦 | Task 3（报警侧）、Task 4 Step 9–10（重写侧） |
| §六 G1–G4、有效值、time-of-check | Task 4 |
| §六 边界语义（`unparsable` / 字节相等 / G4 空过） | Task 4 Step 3、Step 5 |
| §六 探针 timeout 5000 只走 restart | Task 4 Step 7 |
| §七 输出形状、只打 key 名、reason 带补救 | Task 3 Step 7、Task 4 Step 3（T6 断言） |
| §八 T1–T12 及 T2b | Task 1–5 分散落实，编号在测试名里保留 |
| §八 不变量 #143 + 镜像验红 | Task 6 Step 1–2 |
| §九 `installDaemon` 单一求值点 | Task 5 |
| §十 验收判据 1–5 | Task 1 Step 6（基线）、各 Task 的验红步、Task 6 Step 3（实测 + 正面对照） |

**未覆盖项：无。**

**2. 占位符扫描**：无 TBD / TODO / "类似 Task N" / "加上适当的错误处理"。每个代码步都带可执行代码。

**3. 类型一致性**：`classifyKey` → `'pointing'|'credential'|'free'|null` 在 Task 1 定义、
Task 3（`=== 'free'`）与 Task 4（`=== 'credential'`）消费，取值一致；
`parseEnvDict` 的 `{ ok, env }` 形状在 Task 2 定义，Task 3、Task 4 Step 7 一致解构；
`evaluateGates` 的 `{ ok, blocked_by, reason }` 在 Task 4 定义并被 `rewritePlistIfAllowed` 原样消费。

**4. 已知的执行期风险**（不是占位符，是要留神的地方）

- Task 3 Step 5 的 `openDb` 导入方式按仓库现有集成测试对齐，**本计划未逐字核过该 import**；
  若红因是它，先对齐再继续（Step 6 已写明）。
- Task 4 Step 9 构造"只有 PATH 不同"的 plist 依赖 `renderPlist()` 的 `PATH` 行形状，
  正则若匹配不上会让测试假绿——**Step 10 要求手动制造一次红来证伪**。
- `stop-daemon-flow.test.mjs` 已知偶发红 2 条，重跑即绿；**红了先确认是它**。
