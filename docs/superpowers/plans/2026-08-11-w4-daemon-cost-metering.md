# W4 — daemon 成本计量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ccmem 能答出审稿意见 P1#5 的第 2、3 个数 —— 单 daemon 周期的 model call 次数与 token 用量、以及稳态周成本。

**Architecture:** 在 `daemon/claude-p.mjs` 的唯一出口漏斗 `finish()` 上挂一次记录，每次真实 spawn 写一行到**独立的** `daemon-cost.jsonl`（不写 `metrics.jsonl`，理由见 Global Constraints）。JSON 输出路径解析 `claude -p` 的结果信封拿 `usage` 与 `total_cost_usd`；文本路径诚实记 `null`。再加一个 `diagnose --cost` 读数出口做周聚合。

**Tech Stack:** Node ESM（`node:test` + `node:assert/strict`）、`node:sqlite`、无新依赖。

## Global Constraints

以下每条都来自 `docs/ccmem-v0.14-spec.md` §二 W4 / §三 / §五，**每个 task 的要求都隐含包含本节**：

- **JSON 路径是主路径**：7 个 `callClaudeP` 调用点中 6 个已传 `jsonSchema`，只有 `daemon/tasks/security-audit.mjs:257` 走文本。**解析 `usage` / `total_cost_usd` 是首要需求**，`null` 纪律是次要规则。
- **验收判据**：读数出口能答出 token 与稳态周成本。**只出次数与耗时不算完成 W4。**
- **判"这次有没有 usage"必须看最终生效的 args 数组**，不是看 `opts.jsonSchema` —— `resolveCommand`（`scripts/daemon/claude-p.mjs:44-50`）的优先级是 `opts.args` → `CCMEM_CLAUDE_P_ARGS_JSON` → 文本默认值，**任何一个都能独立选中 JSON**。
- **记录失败绝不能让 daemon 任务失败**：吞掉并继续（与 v0.13 A1 探针"probe 失败不阻断 Stop hook 其余逻辑"同构）。
- **走 `mockOutput` 的调用不产生任何行**（`scripts/daemon/claude-p.mjs:180-182` 在 `runClaudeP` 之前就返回）。
- **超时路径（`:146-149`）与 `child.on('error')`（`:159`）都没有退出码 ⇒ 一律记 `null`。**
- **不改 `recordMetric`。** 它是 `metrics.jsonl` 的写入器，而**现在有一个预登记的测量窗口正在跑**（起点 `2026-08-10 01:53:30`）。宁可让新写入器重复一小段轮转逻辑，也不动那个热写入器。
- **跑单文件测试必须显式用 `/usr/local/bin/node`**：`env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>`。**两个环境变量缺一不可**，PATH 上的 `node` 是 nvm v22.13.1，能力不同（handoff Ⅳ.2 / Ⅳ.20）。
- **落地时机**：W4 可先行，**但在本仓库跑批会往 `metrics.jsonl` 追加行**。预登记要求"剔除本机跑批窗口，并在跑批发生时**当场记下起止时间**"。⇒ **执行本计划期间每次跑全量套件，起止时间当场记进 ledger。**
- **不 push。删分支/worktree 先问。**

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `scripts/lib/claude-p-usage.mjs` | 两个纯函数：判 args 是否选中 JSON、从结果信封抽 usage/cost。**无 I/O，可单测** | 新建 |
| `scripts/lib/metrics.mjs` | 新增 `daemonCostFile()` + `recordDaemonCost(event)`。**`recordMetric` 一个字不动** | 修改 |
| `scripts/daemon/claude-p.mjs` | 在 `finish()` 漏斗上记录；计时分排队与执行两段 | 修改 |
| `scripts/lib/admin/diagnose.mjs` | 新增 `--cost` 子命令，做周聚合 | 修改 |
| `tests/unit/v014-claude-p-usage.test.mjs` | Task 1 的纯函数测试 | 新建 |
| `tests/unit/v014-daemon-cost-file.test.mjs` | Task 2 的写入器测试 | 新建 |
| `tests/integration/v014-daemon-cost-metering.test.mjs` | Task 3 的真 spawn 打桩测试 | 新建 |
| `tests/unit/v014-diagnose-cost.test.mjs` | Task 4 的聚合测试 | 新建 |

**为什么不扩 audit 行**：per-run 的次数与耗时**已经**在 audit 行里（`contradiction-audit.mjs:176-177`、`security-audit.mjs:270-271`、`weekly-synthesis.mjs:534`、`monthly-meta-synthesis.mjs:57`）。W4 要的是 **per-call 粒度 + token/成本**，audit 行是 per-run 的，装不下。**这个取舍在 spec 里被要求"实现计划里再确认一次"—— 本节即为确认。**

**为什么不加 config 开关**：Rule 2（最小代码）。spec 未要求，且这是纯观测、零行为影响。**若将来要关，再加。**

---

### Task 1: 两个纯判定函数

**Files:**
- Create: `scripts/lib/claude-p-usage.mjs`
- Test: `tests/unit/v014-claude-p-usage.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `argsSelectJson(args: string[]) => boolean`
  - `extractUsage(stdout: string) => { input_tokens: number|null, output_tokens: number|null, total_cost_usd: number|null }`

- [ ] **Step 1: 写会失败的测试**

创建 `tests/unit/v014-claude-p-usage.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { argsSelectJson, extractUsage } from '../../scripts/lib/claude-p-usage.mjs';

test('argsSelectJson: the text default does not select json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format', 'text']), false);
});

test('argsSelectJson: an explicit json output format selects json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format', 'json']), true);
});

// This is the whole point of the function: CCMEM_CLAUDE_P_ARGS_JSON can select
// json with no jsonSchema in sight, so keying off opts.jsonSchema mis-records.
test('argsSelectJson: json selected without any jsonSchema still counts', () => {
  assert.equal(argsSelectJson(['--output-format', 'json']), true);
});

test('argsSelectJson: a trailing --output-format with no value is not json', () => {
  assert.equal(argsSelectJson(['-p', '--output-format']), false);
});

test('argsSelectJson: a non-array is not json', () => {
  assert.equal(argsSelectJson(undefined), false);
});

test('extractUsage: pulls tokens and cost off the result envelope', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: '{"synthesized":[]}',
    usage: { input_tokens: 1200, output_tokens: 340 },
    total_cost_usd: 0.0123
  });

  assert.deepEqual(extractUsage(stdout), {
    input_tokens: 1200,
    output_tokens: 340,
    total_cost_usd: 0.0123
  });
});

// The text path has no envelope at all. It must read as "not measured",
// never as zero — a zero here would silently understate the weekly cost.
test('extractUsage: plain text yields nulls, not zeros', () => {
  const got = extractUsage('just some prose the model wrote');
  assert.deepEqual(got, { input_tokens: null, output_tokens: null, total_cost_usd: null });
});

test('extractUsage: a json envelope missing usage yields nulls', () => {
  const stdout = JSON.stringify({ type: 'result', result: 'ok' });
  assert.deepEqual(extractUsage(stdout), {
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null
  });
});

test('extractUsage: non-numeric usage values are rejected, not coerced', () => {
  const stdout = JSON.stringify({
    type: 'result',
    usage: { input_tokens: 'lots', output_tokens: null },
    total_cost_usd: 'free'
  });
  assert.deepEqual(extractUsage(stdout), {
    input_tokens: null,
    output_tokens: null,
    total_cost_usd: null
  });
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-claude-p-usage.test.mjs
```

Expected: FAIL，报 `Cannot find module '.../scripts/lib/claude-p-usage.mjs'`。
⚠️ **这是"廉价红"（模块不存在），不算数** —— 它只证明测试跑起来了。真正的红证据在 Step 4。

- [ ] **Step 3: 写最小实现**

创建 `scripts/lib/claude-p-usage.mjs`：

```javascript
/**
 * Whether the effective argv selects claude -p's JSON envelope.
 *
 * This must be decided from the final args array, never from opts.jsonSchema:
 * resolveCommand() takes opts.args, then CCMEM_CLAUDE_P_ARGS_JSON, then the
 * text default, and either of the first two can select JSON on its own. Keying
 * off jsonSchema mis-records every env-var-driven invocation.
 */
export function argsSelectJson(args) {
  if (!Array.isArray(args)) {
    return false;
  }

  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '--output-format' && args[i + 1] === 'json') {
      return true;
    }
  }

  return false;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const EMPTY = { input_tokens: null, output_tokens: null, total_cost_usd: null };

/**
 * Token counts and cost off claude -p's result envelope.
 *
 * Deliberately separate from llm-parse.mjs: that module unwraps the envelope
 * and throws these fields away, which is correct for its callers. Every field
 * is null unless it is present AND numeric — the text path has no envelope at
 * all, and a zero here would silently understate the weekly cost rather than
 * reporting "not measured".
 */
export function extractUsage(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { ...EMPTY };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ...EMPTY };
  }

  return {
    input_tokens: finiteOrNull(parsed.usage?.input_tokens),
    output_tokens: finiteOrNull(parsed.usage?.output_tokens),
    total_cost_usd: finiteOrNull(parsed.total_cost_usd)
  };
}
```

- [ ] **Step 4: 跑测试，确认全绿；再做一次定向变异确认它们有牙齿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-claude-p-usage.test.mjs
```

Expected: PASS（8 个测试）。

然后**临时**把 `finiteOrNull` 改成 `return Number(value) || null;` 并重跑：
Expected: FAIL 在 `non-numeric usage values are rejected, not coerced`（`'lots'` 会变成 `null` 但 `'free'` 也是 —— 若这条没红，改成 `return Number(value) ?? null;` 再试，必须看到红在这一条）。**看到红之后把改动撤回。**

⚠️ 这一步是 handoff Ⅴ 的硬性纪律：**"本来就绿的测试要用定向变异补红证据"**。不做这一步，Step 2 那个"模块不存在"的红什么都没证明。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/claude-p-usage.mjs tests/unit/v014-claude-p-usage.test.mjs
git commit -m "feat(cost): decide json-ness from argv and pull usage off the envelope"
```

---

### Task 2: 独立的成本流写入器

**Files:**
- Modify: `scripts/lib/metrics.mjs`（**只新增，`recordMetric` 一个字不动**）
- Test: `tests/unit/v014-daemon-cost-file.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `daemonCostFile() => string`（绝对路径）
  - `recordDaemonCost(event: object) => void`（写一行 `{ts, ...event}`；失败吞掉）

- [ ] **Step 1: 写会失败的测试**

创建 `tests/unit/v014-daemon-cost-file.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-'));

const { daemonCostFile, recordDaemonCost, metricsFile, MAX_METRICS_BYTES } =
  await import('../../scripts/lib/metrics.mjs');

test('the cost stream is its own file, not metrics.jsonl', () => {
  // The live pre-registered measurement window reads metrics.jsonl. Daemon cost
  // rows landing there would add rotation pressure to the file that window is
  // anchored in, so this separation is load-bearing, not cosmetic.
  assert.notEqual(daemonCostFile(), metricsFile());
  assert.equal(path.basename(daemonCostFile()), 'daemon-cost.jsonl');
});

test('a recorded row is one json line carrying ts plus the event', () => {
  recordDaemonCost({ task_type: 'weekly_synthesis', wall_clock_ms: 1234 });

  const lines = readFileSync(daemonCostFile(), 'utf8').trim().split('\n');
  const row = JSON.parse(lines.at(-1));

  assert.equal(row.task_type, 'weekly_synthesis');
  assert.equal(row.wall_clock_ms, 1234);
  assert.equal(typeof row.ts, 'number');
});

test('an oversized cost file rotates to .1 instead of growing forever', () => {
  const file = daemonCostFile();
  writeFileSync(file, 'x'.repeat(MAX_METRICS_BYTES + 1));

  recordDaemonCost({ task_type: 'security_audit', wall_clock_ms: 1 });

  assert.ok(existsSync(`${file}.1`), 'the oversized generation must be kept as .1');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'the live file must restart with just the new row');
});

test('a write failure never throws at the caller', () => {
  // The daemon tasks must not fail because telemetry could not be written.
  const dir = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-ro-'));
  const prevRoot = process.env.CCMEM_DATA_ROOT;
  process.env.CCMEM_DATA_ROOT = path.join(dir, 'nested');
  chmodSync(dir, 0o500);

  try {
    assert.doesNotThrow(() => recordDaemonCost({ task_type: 't', wall_clock_ms: 1 }));
  } finally {
    chmodSync(dir, 0o700);
    process.env.CCMEM_DATA_ROOT = prevRoot;
  }
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
env -u CCMEM_CONFIG_PATH /usr/local/bin/node --test tests/unit/v014-daemon-cost-file.test.mjs
```

（本文件自己设 `CCMEM_DATA_ROOT`，所以只需 unset 配置路径。）
Expected: FAIL，报 `daemonCostFile is not a function`。

- [ ] **Step 3: 写最小实现**

在 `scripts/lib/metrics.mjs` 末尾追加（**不要修改文件里已有的任何函数**）：

```javascript
const DAEMON_COST_FILE = 'daemon-cost.jsonl';

/** The daemon-cost stream's on-disk path. Exported for the same reason
 * metricsFile() and decisionDataFile() are: the reader (diagnose --cost) must
 * resolve the exact path this writer uses rather than re-deriving it. */
export function daemonCostFile() {
  return path.join(getDataRoot(), DAEMON_COST_FILE);
}

/**
 * One row per real `claude -p` spawn: what the daemon actually spent.
 *
 * Deliberately NOT metrics.jsonl. A pre-registered measurement window is
 * anchored in that file; adding a second writer to it would raise rotation
 * pressure on the exact stream that window is read from. The rotation block
 * below duplicates a few lines of recordMetric on purpose — refactoring the
 * two into a shared helper would mean editing the hot writer while that window
 * is live, and this telemetry is not worth that risk.
 *
 * Never throws: a daemon task must not fail because its telemetry could not be
 * written. A rotation failure is still announced, because a silently
 * unenforced size cap is how a log eats a disk.
 */
export function recordDaemonCost(event) {
  try {
    mkdirSync(getDataRoot(), { recursive: true });
    const file = daemonCostFile();

    try {
      if (statSync(file).size > MAX_METRICS_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        process.stderr.write(`ccmem: daemon-cost rotation failed (${err?.code ?? err?.message}) — size cap not enforced\n`);
      }
    }

    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  } catch (err) {
    process.stderr.write(`ccmem: daemon-cost record failed (${err?.code ?? err?.message})\n`);
  }
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
env -u CCMEM_CONFIG_PATH /usr/local/bin/node --test tests/unit/v014-daemon-cost-file.test.mjs
```

Expected: PASS（4 个测试）。

然后**临时**把 `recordDaemonCost` 里的 `daemonCostFile()` 换成 `metricsFile()` 并重跑：
Expected: FAIL 在 `the cost stream is its own file` 之外的写入类断言上（行会落到 metrics.jsonl）。**看到红之后撤回。**
这条变异守的是本 task 唯一真正重要的不变量：**成本行不许流进 `metrics.jsonl`。**

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/metrics.mjs tests/unit/v014-daemon-cost-file.test.mjs
git commit -m "feat(cost): give daemon spend its own stream, separate from metrics.jsonl"
```

---

### Task 3: 在 `claude-p.mjs` 的出口漏斗上记录

**Files:**
- Modify: `scripts/daemon/claude-p.mjs`
- Test: `tests/integration/v014-daemon-cost-metering.test.mjs`

**Interfaces:**
- Consumes: `argsSelectJson` / `extractUsage`（Task 1）、`recordDaemonCost` / `daemonCostFile`（Task 2）
- Produces: `daemon-cost.jsonl` 的行结构 —— 后续 Task 4 依赖这些字段名：

  ```
  { ts, task_type, output_format, queue_wait_ms, wall_clock_ms,
    exit_code, timed_out, input_tokens, output_tokens, total_cost_usd }
  ```

  - `output_format`: `'json'` | `'text'`
  - `exit_code`: 数字，**超时与 spawn error 两条路径均为 `null`**
  - `timed_out`: boolean
  - `queue_wait_ms`: `callClaudeP` 入口 → `runClaudeP` 真正开始 spawn 的等待（`tail` 串行链造成的排队）
  - `wall_clock_ms`: spawn → close/timeout/error 的执行耗时

  🔴 **两个都记，不许只记一个**：`callClaudeP` 经 `tail` promise 链串行化（`:185-187`），排队可以任意长，而"稳态周成本"需要的是墙上时间的全貌。

- [ ] **Step 1: 写会失败的测试**

创建 `tests/integration/v014-daemon-cost-metering.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cost-int-'));

const STUB_DIR = mkdtempSync(path.join(tmpdir(), 'ccmem-stub-'));

// A stub that impersonates `claude -p --output-format json`. We drive it
// through CCMEM_CLAUDE_P_COMMAND / CCMEM_CLAUDE_P_ARGS_JSON because that is
// the ONLY seam that reaches runClaudeP: callClaudeP returns on opts.mockOutput
// at claude-p.mjs:180-182, before the recording point ever runs.
const JSON_STUB = path.join(STUB_DIR, 'stub-json.mjs');
writeFileSync(JSON_STUB, `
process.stdin.resume();
process.stdout.write(JSON.stringify({
  type: 'result',
  result: '{"ok":true}',
  usage: { input_tokens: 900, output_tokens: 120 },
  total_cost_usd: 0.0042
}));
process.exit(0);
`);

const TEXT_STUB = path.join(STUB_DIR, 'stub-text.mjs');
writeFileSync(TEXT_STUB, `
process.stdin.resume();
process.stdout.write('plain prose, no envelope');
process.exit(0);
`);

const FAIL_STUB = path.join(STUB_DIR, 'stub-fail.mjs');
writeFileSync(FAIL_STUB, `
process.stdin.resume();
process.stderr.write('boom');
process.exit(3);
`);

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');

function rows() {
  if (!existsSync(daemonCostFile())) return [];
  return readFileSync(daemonCostFile(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function withStub(stub, extraArgs = []) {
  process.env.CCMEM_CLAUDE_P_COMMAND = '/usr/local/bin/node';
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub, ...extraArgs]);
}

test('a json-path call records tokens and cost', async () => {
  const before = rows().length;
  withStub(JSON_STUB, ['--output-format', 'json']);

  await callClaudeP('prompt', { taskType: 'weekly_synthesis' });

  const row = rows().at(-1);
  assert.equal(rows().length, before + 1);
  assert.equal(row.task_type, 'weekly_synthesis');
  assert.equal(row.output_format, 'json');
  assert.equal(row.input_tokens, 900);
  assert.equal(row.output_tokens, 120);
  assert.equal(row.total_cost_usd, 0.0042);
  assert.equal(row.exit_code, 0);
  assert.equal(row.timed_out, false);
  assert.ok(typeof row.wall_clock_ms === 'number' && row.wall_clock_ms >= 0);
  assert.ok(typeof row.queue_wait_ms === 'number' && row.queue_wait_ms >= 0);
});

test('a text-path call records null tokens, never zero', async () => {
  withStub(TEXT_STUB);

  await callClaudeP('prompt', { taskType: 'security_audit' });

  const row = rows().at(-1);
  assert.equal(row.output_format, 'text');
  // Zero here would silently understate the weekly cost. It must read as
  // "not measured".
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.total_cost_usd, null);
});

test('a non-zero exit still records a row, with its exit code', async () => {
  withStub(FAIL_STUB);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'contradiction_audit' }));

  const row = rows().at(-1);
  assert.equal(row.task_type, 'contradiction_audit');
  assert.equal(row.exit_code, 3);
  assert.equal(row.timed_out, false);
});

test('a timeout records timed_out with a null exit code', async () => {
  const HANG_STUB = path.join(STUB_DIR, 'stub-hang.mjs');
  writeFileSync(HANG_STUB, 'process.stdin.resume(); setTimeout(() => {}, 60000);');
  withStub(HANG_STUB);

  await assert.rejects(() => callClaudeP('prompt', { taskType: 'monthly_meta_synthesis', timeoutMs: 300 }));

  const row = rows().at(-1);
  assert.equal(row.timed_out, true);
  // SIGTERM leaves no exit code. Recording 0 here would read as success.
  assert.equal(row.exit_code, null);
});

test('a mockOutput call records nothing', async () => {
  const before = rows().length;

  await callClaudeP('prompt', { taskType: 'weekly_synthesis', mockOutput: 'canned' });

  assert.equal(rows().length, before, 'mocked calls never spawn, so they have no cost to record');
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
env -u CCMEM_CONFIG_PATH /usr/local/bin/node --test tests/integration/v014-daemon-cost-metering.test.mjs
```

Expected: FAIL —— 五条全红，因为 `daemon-cost.jsonl` 根本没有行（`rows()` 返回 `[]`，`.at(-1)` 是 `undefined`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/daemon/claude-p.mjs` 顶部补两个 import：

```javascript
import { argsSelectJson, extractUsage } from '../lib/claude-p-usage.mjs';
import { recordDaemonCost } from '../lib/metrics.mjs';
```

把 `runClaudeP(prompt, opts)` 改成 `runClaudeP(prompt, opts, queuedAt)`，并在其中：

```javascript
function runClaudeP(prompt, opts, queuedAt) {
  const { command, args } = resolveCommand(opts);
  const timeoutMs = resolveTimeoutMs(opts);
  const tStart = Date.now();
  const outputFormat = argsSelectJson(args) ? 'json' : 'text';
  const childSessionId = opts.env?.CLAUDE_CODE_SESSION_ID ?? randomUUID();
```

（其余 `childEnv` / `registerBlacklistedSession` 保持不动。）

然后把 `finish` 改成同时记录 —— **`finish` 是三条出口（close / timeout / error）的唯一漏斗，记在这里就不会漏也不会重**：

```javascript
    const finish = (fn, value, outcome) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      // Telemetry must never change control flow: recordDaemonCost swallows its
      // own failures, and this call sits before fn() only so a throw here could
      // not skip settling.
      recordDaemonCost({
        task_type: opts.taskType ?? null,
        output_format: outputFormat,
        queue_wait_ms: tStart - queuedAt,
        wall_clock_ms: Date.now() - tStart,
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        ...(outputFormat === 'json'
          ? extractUsage(stdout)
          : { input_tokens: null, output_tokens: null, total_cost_usd: null })
      });

      fn(value);
    };
```

三个调用点各自传出结局：

```javascript
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`claude -p timeout after ${timeoutMs}ms`), { exitCode: null, timedOut: true });
    }, timeoutMs);
```

```javascript
    child.on('error', (error) => finish(reject, error, { exitCode: null, timedOut: false }));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, stdout, { exitCode: 0, timedOut: false });
        return;
      }

      const excerpt = stderr.trim().slice(0, 200);
      const error = new Error(`claude -p exit ${code}: ${excerpt}`);
      const retryAfter = parseRetryAfterMs(stderr);
      if (retryAfter != null) {
        error.retryAfter = retryAfter;
      }
      finish(reject, error, { exitCode: code, timedOut: false });
    });
```

最后在 `callClaudeP` 里把入队时刻带进去（**`mockOutput` 的早返回位置一个字不动** —— 它必须继续在记录点之前返回）：

```javascript
export function callClaudeP(prompt, opts = {}) {
  if (typeof opts.mockOutput === 'string') {
    return Promise.resolve(opts.mockOutput);
  }

  const queuedAt = Date.now();
  const run = () => runClaudeP(prompt, opts, queuedAt);
  const pending = tail.then(run, run);
  tail = pending.catch(() => {});
  return pending;
}
```

- [ ] **Step 4: 跑测试，确认全绿；再做两次定向变异**

```bash
env -u CCMEM_CONFIG_PATH /usr/local/bin/node --test tests/integration/v014-daemon-cost-metering.test.mjs
```

Expected: PASS（5 个测试）。

变异 ①：把超时那条的 `{ exitCode: null, timedOut: true }` 改成 `{ exitCode: 0, timedOut: true }` 并重跑。
Expected: FAIL 在 `a timeout records timed_out with a null exit code`。**撤回。**

变异 ②：把 `outputFormat` 改成 `opts.jsonSchema ? 'json' : 'text'` 并重跑。
Expected: FAIL 在 `a json-path call records tokens and cost`（测试没传 `jsonSchema`，靠 `CCMEM_CLAUDE_P_ARGS_JSON` 选中 JSON）。**撤回。**
⚠️ **变异 ② 是本 task 最重要的一条**：它守的正是 Global Constraints 里"判据是最终生效的 args 数组，不是 `jsonSchema`"那条。

- [ ] **Step 5: 跑一次全量套件，并当场记下起止时间**

```bash
date '+%F %T'   # 记下起
npm test
date '+%F %T'   # 记下止
```

把这两个时间戳写进 `.superpowers/sdd/` 本轮的 ledger。
🔴 **这不是走过场**：预登记要求"剔除本机跑批窗口，并在跑批发生时当场记下起止时间，不要事后回忆"，
而 handoff Ⅰ 记过边界差 6 秒就把 5.1% 读成 9.2%。

Expected: 全绿，且**新增 9 个测试**（Task 1 的 8 个 + 本 task 的 5 个，减去尚未写的 Task 4；以实际数字为准，**不要把期望数字写死后照抄**）。

- [ ] **Step 6: 提交**

```bash
git add scripts/daemon/claude-p.mjs tests/integration/v014-daemon-cost-metering.test.mjs
git commit -m "feat(cost): record what every claude -p spawn actually spent"
```

---

### Task 4: `diagnose --cost` 周聚合出口

**Files:**
- Modify: `scripts/lib/admin/diagnose.mjs`
- Test: `tests/unit/v014-diagnose-cost.test.mjs`

**Interfaces:**
- Consumes: `daemonCostFile()`（Task 2）、Task 3 定义的行结构
- Produces: `summarizeDaemonCost(rows, nowMs, windowDays = 7)` —— 纯函数，导出以便单测：

  ```
  {
    window_days, calls, calls_by_task: { [task]: number },
    wall_clock_ms: { p50, p95, max },
    input_tokens, output_tokens,        // 数字；无任何可用样本时为 null
    total_cost_usd,                      // 同上
    unmeasured_calls                     // output_format === 'text' 的条数
  }
  ```

- [ ] **Step 1: 写会失败的测试**

创建 `tests/unit/v014-diagnose-cost.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeDaemonCost } from '../../scripts/lib/admin/diagnose.mjs';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function row(over) {
  return {
    ts: NOW - DAY,
    task_type: 'weekly_synthesis',
    output_format: 'json',
    queue_wait_ms: 0,
    wall_clock_ms: 1000,
    exit_code: 0,
    timed_out: false,
    input_tokens: 100,
    output_tokens: 10,
    total_cost_usd: 0.001,
    ...over
  };
}

test('rows outside the window are excluded', () => {
  const got = summarizeDaemonCost([row({ ts: NOW - 30 * DAY }), row()], NOW, 7);
  assert.equal(got.calls, 1);
});

test('tokens and cost are summed across the window', () => {
  const got = summarizeDaemonCost([row(), row({ input_tokens: 400, total_cost_usd: 0.003 })], NOW, 7);
  assert.equal(got.input_tokens, 500);
  assert.equal(got.output_tokens, 20);
  assert.ok(Math.abs(got.total_cost_usd - 0.004) < 1e-9);
});

// The whole reason W4 exists is to answer "what does a steady-state week
// cost". A text-path call contributes a call but no cost, and pretending
// its cost is 0 would understate the answer — so it is counted separately.
test('unmeasured text-path calls are counted, not silently summed as zero', () => {
  const got = summarizeDaemonCost(
    [row(), row({ output_format: 'text', input_tokens: null, output_tokens: null, total_cost_usd: null })],
    NOW,
    7
  );
  assert.equal(got.calls, 2);
  assert.equal(got.unmeasured_calls, 1);
  assert.equal(got.input_tokens, 100);
});

test('a window with no measured call reports null cost, not zero', () => {
  const got = summarizeDaemonCost(
    [row({ output_format: 'text', input_tokens: null, output_tokens: null, total_cost_usd: null })],
    NOW,
    7
  );
  assert.equal(got.total_cost_usd, null);
  assert.equal(got.input_tokens, null);
});

test('calls are broken down by task type', () => {
  const got = summarizeDaemonCost([row(), row({ task_type: 'security_audit' })], NOW, 7);
  assert.deepEqual(got.calls_by_task, { 'weekly_synthesis': 1, 'security_audit': 1 });
});

test('an empty window reports zero calls and null cost rather than throwing', () => {
  const got = summarizeDaemonCost([], NOW, 7);
  assert.equal(got.calls, 0);
  assert.equal(got.total_cost_usd, null);
  assert.equal(got.wall_clock_ms.p50, null);
});
```

- [ ] **Step 2: 跑测试，确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-diagnose-cost.test.mjs
```

Expected: FAIL，报 `summarizeDaemonCost is not a function`。

- [ ] **Step 3: 写最小实现**

在 `scripts/lib/admin/diagnose.mjs` 里新增（并 `export`）：

```javascript
function percentile(sorted, q) {
  if (!sorted.length) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/**
 * What the daemon spent in the trailing window.
 *
 * Text-path calls carry no usage envelope. They are counted in `calls` and in
 * `unmeasured_calls`, but contribute nothing to the sums, and a window with no
 * measured call reports null rather than 0 — the question this answers is
 * "what does a steady-state week cost", and a zero would be a wrong answer
 * where null is an honest "not measured".
 */
export function summarizeDaemonCost(rows, nowMs, windowDays = 7) {
  const cutoff = nowMs - windowDays * 86_400_000;
  const inWindow = rows.filter((r) => Number(r?.ts) >= cutoff);

  const callsByTask = {};
  for (const r of inWindow) {
    const key = r.task_type ?? 'unknown';
    callsByTask[key] = (callsByTask[key] ?? 0) + 1;
  }

  const sum = (field) => {
    const values = inWindow.map((r) => r[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const durations = inWindow
    .map((r) => r.wall_clock_ms)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);

  return {
    window_days: windowDays,
    calls: inWindow.length,
    calls_by_task: callsByTask,
    wall_clock_ms: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? durations.at(-1) : null
    },
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    total_cost_usd: sum('total_cost_usd'),
    unmeasured_calls: inWindow.filter((r) => r.output_format === 'text').length
  };
}
```

- [ ] **Step 4: 跑测试，确认全绿；做一次定向变异**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-diagnose-cost.test.mjs
```

Expected: PASS（6 个测试）。

变异：把 `sum` 的收尾改成 `return values.reduce((a, b) => a + b, 0);`（去掉 `values.length ?` 那一层）并重跑。
Expected: FAIL 在 `a window with no measured call reports null cost, not zero`。**撤回。**

- [ ] **Step 5: 接上 CLI 子命令**

在 `diagnose.mjs` 的子命令分发处新增 `--cost` 分支：读 `daemonCostFile()`（不存在则当空数组，**并明说"尚无数据"而不是打印一堆 0**），逐行 `JSON.parse`（**解析不了的行计数并报出来，不许静默丢**），调 `summarizeDaemonCost(rows, Date.now(), 7)`，按现有 `diagnose` 子命令的输出风格打印。

⚠️ **先读 `diagnose.mjs` 里已有的 `--feedback` / `--retrieval` 两个子命令，照它们的注册方式和输出格式写**（handoff Rule 11：conformance > taste）。

- [ ] **Step 6: 手工验证读数出口**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node ./bin/ccmem admin diagnose --cost
```

Expected: 打印"尚无数据"一类的提示，**不报错、不打印 0 成本**。

⚠️ **必须显式跑目标 checkout 的 `./bin/ccmem`** —— PATH 上的 `ccmem` 指向主仓库（handoff Ⅳ.13）。

- [ ] **Step 7: 跑全量套件（当场记起止时间）并提交**

```bash
date '+%F %T'; npm test; date '+%F %T'
git add scripts/lib/admin/diagnose.mjs tests/unit/v014-diagnose-cost.test.mjs
git commit -m "feat(cost): report the trailing week's daemon calls, tokens, and spend"
```

---

## Self-Review

**1. Spec coverage** —— 逐条对 `docs/ccmem-v0.14-spec.md` §二 W4：

| spec 要求 | 归属 |
|---|---|
| 落点 `runClaudeP`，写在 `finish()` 漏斗 | Task 3 Step 3 |
| JSON 是主路径，解析 `usage` / `total_cost_usd` 为首要需求 | Task 1 + Task 3 |
| 判据看最终 args 而非 `jsonSchema` | Task 1（`argsSelectJson`）+ Task 3 变异 ② |
| text 路径记 `null` 不记 `0` | Task 1、Task 3、Task 4 各有一条测试 |
| `mockOutput` 不产生行 | Task 3 最后一条测试 |
| 超时/error 路径 `exit_code = null` | Task 3 变异 ① |
| `wall_clock_ms` 说清量哪一段，排队时间不许丢 | Task 3 的 Interfaces（两个字段都记） |
| 记录失败不拖垮 daemon 任务 | Task 2 的第 4 条测试 + Task 3 的注释 |
| 写独立文件，不写 `metrics.jsonl` | Task 2 的第 1 条测试 + 变异 |
| 聚合出口能答出 token 与稳态周成本 | Task 4 |
| "另开文件 vs 扩 audit 行"要再确认一次 | File Structure 节已确认并写明理由 |
| 跑批当场记起止时间 | Task 3 Step 5、Task 4 Step 7 |

**无遗漏。**

**2. Placeholder scan** —— 无 TBD / TODO / "类似 Task N" / "适当处理错误"。唯二未给出逐字代码的地方是 Task 4 Step 5 的子命令注册（**要求先读 `--feedback` / `--retrieval` 照抄注册方式**，因为照搬一段我没读过的分发代码比让实现者对齐现有风格更容易出错）与 Task 3 Step 5 的期望测试数（**明确要求以实际为准，不许写死照抄**）。两处都写清了判据。

**3. Type consistency** —— `argsSelectJson` / `extractUsage` / `daemonCostFile` / `recordDaemonCost` / `summarizeDaemonCost` 五个名字在定义处与使用处一致；Task 3 的行结构字段名与 Task 4 测试 fixture 的字段名逐字对齐（`output_format` / `wall_clock_ms` / `input_tokens` / `output_tokens` / `total_cost_usd` / `task_type` / `ts`）。

## 已知不做的事

- **不加 config 开关**（Rule 2；spec 未要求，纯观测、零行为影响）。
- **不重构 `recordMetric`**，尽管两处轮转逻辑有重复 —— 理由写在 Task 2 的代码注释里（不在测量窗口期间动热写入器）。
- **不动 `llm-parse.mjs`** —— 它丢弃信封是对的，W4 另起一个解析器。
- **不改任何 daemon task 的调用点**，`taskType` 已经由现有调用方传入。
