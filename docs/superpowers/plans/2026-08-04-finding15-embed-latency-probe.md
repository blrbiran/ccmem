# Finding 15 带外嵌入延迟探针 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `openai_timeout_ms` 能基于**无截断**的实测延迟分布被重新推导，而不是再换一个拍脑袋的常数。

**Architecture:** 新增一个默认关闭的 daemon 任务 `embed_latency_probe`，用 10s 超时对本地记忆文本做单条 embed 计时，结果落在一个永不轮转的 jsonl 里。它与熔断器、查询向量缓存**完全隔离** —— 测量工具不得制造被测现象。另在 `prompt_submit` 的 metrics 行补一个 `prompt_chars` 整数，用于日后校准探针取样长度的效度。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:sqlite`（同步 API）、`node --test`、无新依赖。

**设计文档（动手前整篇读）：** `docs/superpowers/specs/2026-08-04-finding15-embed-latency-probe-design.md`

## Global Constraints

- **不 push。** 人类自己处理所有 push。**删分支必须先问。**
- **不要把 plist 或配置文件内容打印 / 落盘 / 写进文档。** `~/.claude/ccmem/config.json` 含 API key。
- **每个测试必须先被亲眼看着变红，且红在它自己命名的那个行为上。** 本仓库已因跳过这步栽过三次。
- **跑单文件用 `node --test <文件>`，不要用 `npm test -- <文件>`**（npm 把参数追加到脚本原有 glob 后面，结果仍是全量）。**两个环境变量一个都不能少**，否则测试会读到含 API key 的真配置：
  ```bash
  env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/<path>.test.mjs
  ```
- **测试不得发任何真实 API 请求**，一律用假 provider + `:memory:` DB。
- **测试不得触达真实 launchctl / 真实 `~/Library/LaunchAgents`**（本仓库已因此劫持过本机 daemon 注册一次）。本计划的任务都不碰 daemon 生命周期，但改 `loop.mjs` 时不要顺手引入。
- **不要"改进"相邻代码**（Rule 3）。只动本计划点名的位置。
- 提交信息写根因与取舍，不写流水账。每个 Task 独立提交。

---

### Task 1: 在 prompt_submit 的 metrics 行记录 `prompt_chars`

**为什么先做这个：** 它与探针无依赖，且是**唯一**能让"探针取样文本长度是否代表真实负载"日后被验证的手段。实测记忆内容最长 500 字符，而 hook 把 prompt 截到 2000 —— 真实 prompt 的长度分布至今**从未被记录过**。

**Files:**
- Modify: `scripts/handlers/prompt-submit.mjs`（`_metricFields` 对象，约 :129-144）
- Test: `tests/integration/prompt-submit-retrieval.test.mjs`

**Interfaces:**
- Consumes: `hookData.prompt`（同一函数内 :54 已在用，作用域已确认）
- Produces: metrics 行新增整数字段 `prompt_chars`

- [ ] **Step 1: 写失败的测试**

在 `tests/integration/prompt-submit-retrieval.test.mjs` 末尾追加。**先读该文件现有的 setup helper 并复用**（它已有建库、写 metrics、读回 metrics 行的模式；不要另起一套）：

```js
test('prompt_submit records the embedded prompt length as prompt_chars', async () => {
  // 用该文件既有的 harness 建库并跑一次 prompt-submit。
  // 关键断言：长度是「实际送去 embed 的那个长度」，即截断到 2000 之后的值。
  const long = 'x'.repeat(2500);
  const row = await runPromptSubmitAndReadMetric({ prompt: long });
  assert.equal(row.prompt_chars, 2000, 'must record the post-truncation length — that is what drives latency');

  const short = '你好世界';
  const row2 = await runPromptSubmitAndReadMetric({ prompt: short });
  assert.equal(row2.prompt_chars, 4);
});
```

> 若该文件没有名为 `runPromptSubmitAndReadMetric` 的 helper，**照它已有的写法内联展开**，不要新建抽象（Rule 2）。

- [ ] **Step 2: 跑测试确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/prompt-submit-retrieval.test.mjs
```

Expected: FAIL，`row.prompt_chars` 为 `undefined`。**确认红在 `prompt_chars` 上，不是红在 helper 不存在上** —— 后者是廉价红，不算数。

- [ ] **Step 3: 实现**

在 `scripts/handlers/prompt-submit.mjs` 的 `_metricFields` 对象里，`retrieval_path` 那一行**之前**插入：

```js
        prompt_chars: String(hookData.prompt ?? '').slice(0, 2000).length,
```

> `2000` 这个常量与 `scripts/lib/retrieval.mjs:335` 的截断保持一致。**两处必须同值** —— 记录的必须是真正送去 embed 的长度，否则这个字段用来校准取样长度时会系统性偏大。

- [ ] **Step 4: 跑测试确认绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/prompt-submit-retrieval.test.mjs
```

Expected: PASS，且该文件原有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add scripts/handlers/prompt-submit.mjs tests/integration/prompt-submit-retrieval.test.mjs
git commit -m "feat(metrics): record the embedded prompt length

The real prompt length distribution has never been recorded — metrics carried
only timings, the query cache only hashes. That gap is why no sampling scheme
for the latency probe can be validated against real load: memory contents top
out at 500 characters while a prompt is truncated at 2000. One integer closes
it, and it is the post-truncation length because that is what the provider
actually sees."
```

---

### Task 2: 探针模块本身 + 隔离测试

**Files:**
- Create: `scripts/daemon/tasks/embed-latency-probe.mjs`
- Modify: `scripts/lib/config.mjs`（`DEFAULT_CONFIG.embedding`，约 :10-23）
- Modify: `config.default.json`（`embedding` 块，约 :22）
- Test: `tests/unit/v014-embed-latency-probe.test.mjs`（新建）

**Interfaces:**
- Consumes: `getDataRoot()`（`scripts/lib/paths.mjs`）、`loadConfig()`（`scripts/lib/config.mjs`）、`openaiEmbedding`（`scripts/lib/embedding/openai.mjs`）
- Produces:
  - `runEmbedLatencyProbe(db, task, deps = {}) -> Promise<{ ok?, ms?, skipped? }>` —— Task 3 的 `dispatch.mjs` 调它
  - `probeFile(probeCfg) -> string` —— Task 4 的 `diagnose --feedback` 调它
  - `DEFAULT_PROBE_FILE = 'embed-latency-probe.jsonl'`

- [ ] **Step 1: 写失败的测试**

新建 `tests/unit/v014-embed-latency-probe.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 模块级隔离：本文件永远不碰真实数据根。
const ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-probe-'));
process.env.CCMEM_DATA_ROOT = ROOT;
delete process.env.CCMEM_CONFIG_PATH;

const { runEmbedLatencyProbe, probeFile } = await import('../../scripts/daemon/tasks/embed-latency-probe.mjs');
const { CIRCUIT_KEYS } = await import('../../scripts/lib/embedding/provider.mjs');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
           CREATE TABLE config_kv (key TEXT PRIMARY KEY, value TEXT);
           CREATE TABLE query_embedding_cache (prompt_hash TEXT PRIMARY KEY, vec BLOB);`);
  db.prepare('INSERT INTO memories (content) VALUES (?)').run('hello probe');
  return db;
}

const openaiCfg = (probe) => ({
  embedding: {
    provider: 'openai', openai_api_key: 'sk-test', openai_model: 'text-embedding-3-small',
    openai_dim: 1536, openai_timeout_ms: 800, latency_probe: { enabled: true, timeout_ms: 10000, ...probe }
  }
});

test('a probe failure never touches the circuit breaker or the query cache', async () => {
  const db = freshDb();
  const throwing = { async embed() { throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: throwing });

  const kv = db.prepare('SELECT count(*) AS n FROM config_kv').get();
  assert.equal(kv.n, 0, 'the probe must not write any circuit-breaker key — it would open the gate on real retrieval');
  const cache = db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get();
  assert.equal(cache.n, 0, 'the probe must not pollute the query-vector cache');
});

test('a probe success also leaves the breaker and cache untouched', async () => {
  const db = freshDb();
  const ok = { async embed() { return [new Float32Array(1536)]; } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg(), provider: ok });

  assert.equal(db.prepare('SELECT count(*) AS n FROM config_kv').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM query_embedding_cache').get().n, 0);
});

test('hitting the probe ceiling is recorded as its own field, not collapsed into a failure', async () => {
  const db = freshDb();
  const slow = { async embed() { await new Promise((r) => setTimeout(r, 60)); throw new Error('Request timed out.'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 50 }), provider: slow });

  const rows = readFileSync(probeFile({ }), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = rows.at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.timed_out_at_probe_limit, true, 'second censoring must stay visible — this probe exists because censoring was invisible');
  assert.equal(last.signature, 'openai:text-embedding-3-small:1536');
  assert.equal(last.text_chars, 'hello probe'.length);
});

test('a fast failure is not mislabelled as hitting the ceiling', async () => {
  const db = freshDb();
  const fast = { async embed() { throw new Error('401 Unauthorized'); } };

  await runEmbedLatencyProbe(db, {}, { config: openaiCfg({ timeout_ms: 10000 }), provider: fast });

  const rows = readFileSync(probeFile({}), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).timed_out_at_probe_limit, false);
});

test('a non-openai provider is skipped without writing a row', async () => {
  const db = freshDb();
  const cfg = { embedding: { provider: 'transformers-local', latency_probe: { enabled: true } } };
  const result = await runEmbedLatencyProbe(db, {}, { config: cfg, provider: { async embed() { throw new Error('must not be called'); } } });
  assert.equal(result.skipped, 'provider');
});
```

> **`CIRCUIT_KEYS` 若未从 `provider.mjs` 导出**，不要为测试去导出它 —— 上面的断言用的是 `config_kv` 全表计数，本就不需要它。把那行 import 删掉即可。

- [ ] **Step 2: 跑测试确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/unit/v014-embed-latency-probe.test.mjs
```

Expected: FAIL，模块不存在。

⚠️ **这是廉价红，不算数。** 完成 Step 3 之后必须补一次**定向变异验红**（Step 5），否则第一条隔离测试等于没验。

- [ ] **Step 3: 实现探针模块**

新建 `scripts/daemon/tasks/embed-latency-probe.mjs`：

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../lib/config.mjs';
import { openaiEmbedding } from '../../lib/embedding/openai.mjs';
import { getDataRoot } from '../../lib/paths.mjs';

export const DEFAULT_PROBE_FILE = 'embed-latency-probe.jsonl';

/** Resolved by both the writer here and diagnose --feedback, so the path rule
 * lives in exactly one place and cannot drift. */
export function probeFile(probeCfg) {
  return path.join(getDataRoot(), probeCfg?.file || DEFAULT_PROBE_FILE);
}

/**
 * Measures one query-embedding round trip against a deliberately loose ceiling,
 * so the latency distribution can be read WITHOUT the 800ms censoring that
 * openai_timeout_ms imposes on the hook path.
 *
 * It is isolated from the circuit breaker and the query-vector cache on purpose:
 * a probe that reported its own timeouts to recordEmbedFailure would open the
 * gate on real retrieval — the instrument would manufacture the phenomenon it
 * measures. Do not "unify" this with the retrieval path.
 */
export async function runEmbedLatencyProbe(db, _task, deps = {}) {
  const cfg = deps.config ?? loadConfig();
  const embedding = cfg?.embedding ?? {};
  const probeCfg = embedding.latency_probe ?? {};

  if (embedding.provider !== 'openai') {
    return { skipped: 'provider' };
  }

  const apiKey = process.env.OPENAI_API_KEY ?? embedding.openai_api_key ?? null;
  if (!apiKey) {
    return { skipped: 'no_api_key' };
  }

  const picked = db.prepare('SELECT content FROM memories ORDER BY RANDOM() LIMIT 1').get();
  const text = String(picked?.content ?? '').slice(0, 2000);
  if (!text) {
    return { skipped: 'no_text' };
  }

  const timeoutMs = Number(probeCfg.timeout_ms ?? 10000);
  const provider = deps.provider ?? openaiEmbedding;
  const override = {
    embedding: { ...embedding, openai_timeout_ms: timeoutMs, api_timeout_ms: timeoutMs }
  };

  const t0 = Date.now();
  let ok = true;
  let error = null;
  try {
    await provider.embed([text], override);
  } catch (caught) {
    ok = false;
    error = String(caught?.message ?? caught).slice(0, 200);
  }
  const ms = Date.now() - t0;

  const signature = `${embedding.provider}:${embedding.openai_model ?? 'text-embedding-3-small'}:${embedding.openai_dim ?? 1536}`;

  mkdirSync(getDataRoot(), { recursive: true });
  appendFileSync(
    probeFile(probeCfg),
    `${JSON.stringify({
      ts: Date.now(),
      ms,
      ok,
      error,
      timed_out_at_probe_limit: !ok && ms >= timeoutMs,
      text_chars: text.length,
      signature
    })}\n`
  );

  return { ok, ms };
}
```

**这个文件里不得出现的东西**（每一条都是设计里的硬要求）：`recordEmbedFailure`、`recordEmbedSuccess`、`writeQueryEmbeddingCache`、任何熔断状态预检、任何对返回向量的使用。

- [ ] **Step 4: 加配置默认值（默认关）**

`scripts/lib/config.mjs` 的 `DEFAULT_CONFIG.embedding` 里，`openai_dim: null` 之后加：

```js
    latency_probe: {
      // Strictly `enabled === true` to run. Note this is the OPPOSITE of the
      // adjacent decision-data flag (metrics.mjs recordDecisionMetric treats
      // anything but an explicit `false` as on): recording must default to on,
      // sending real API requests must default to off. Read the design doc
      // before changing either.
      enabled: false,
      interval_ms: 300000,
      timeout_ms: 10000,
      file: 'embed-latency-probe.jsonl'
    }
```

`config.default.json` 的 `embedding` 块里加同样的四项（JSON，无注释）。

- [ ] **Step 5: 跑测试确认绿，然后做定向变异验红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/unit/v014-embed-latency-probe.test.mjs
```

Expected: 全绿。

**然后必须做这一步**，它是本任务唯一有效的红证据：

1. 在 `runEmbedLatencyProbe` 的 `catch` 里临时插入 `const { recordEmbedFailure } = await import('../../lib/embedding/provider.mjs'); recordEmbedFailure(db, cfg);`
2. 重跑：第一条隔离测试**必须红**，且红在 `config_kv` 计数上（`the probe must not write any circuit-breaker key`）。
3. **确认其余四条测试保持绿** —— 证明这次变异是定向的，不是把整个文件打坏了。
4. 撤销变异，重跑，全绿。

> 这一步不做，第一条隔离测试就只被"模块不存在"验过红，等于没验。本仓库为此栽过三次。

- [ ] **Step 6: 提交**

```bash
git add scripts/daemon/tasks/embed-latency-probe.mjs scripts/lib/config.mjs config.default.json tests/unit/v014-embed-latency-probe.test.mjs
git commit -m "feat(daemon): measure embed latency without the timeout that censors it

openai_timeout_ms: 800 cuts off 34% of real query-embed attempts, which puts it
near the 66th percentile of the true distribution rather than at a bound only
anomalies reach. The surviving samples are conditioned on finishing under that
bound, so they cannot yield the p99 the value should be derived from. This probe
measures the same round trip against a 10s ceiling and records whether that
ceiling was itself hit, so the second censoring stays visible instead of
collapsing into a bare failure.

It is isolated from the circuit breaker and the query-vector cache deliberately:
reporting its own timeouts to recordEmbedFailure would open the gate on real
retrieval, and the instrument would manufacture the phenomenon it measures. Off
by default — it sends real API requests, and that is not a decision to make on
someone else's behalf."
```

---

### Task 3: 接线 —— 注册与调度

**Files:**
- Modify: `scripts/daemon/dispatch.mjs`
- Modify: `scripts/daemon/loop.mjs`（`scheduleCronTasks`，约 :106-129；模块顶部加状态）
- Test: `tests/integration/daemon-loop.test.mjs`

**Interfaces:**
- Consumes: `runEmbedLatencyProbe`（Task 2）
- Produces: 任务类型字符串 `'embed_latency_probe'`；`_resetProbeSchedule()`（仅供测试）

- [ ] **Step 1: 写失败的测试**

在 `tests/integration/daemon-loop.test.mjs` 追加（**复用该文件既有的建库 helper**，它已有 `tasks` 表与 `scheduleCronTasks` 的调用模式）：

```js
test('the latency probe is not scheduled while disabled', () => {
  const db = freshDaemonDb();               // ← 用该文件已有的 helper
  _resetProbeSchedule();
  withConfig({ embedding: { latency_probe: { enabled: false, interval_ms: 1000 } } }, () => {
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
  });
  const n = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
  assert.equal(n, 0, 'default-off must mean no API requests are ever enqueued');
});

test('a truthy-but-not-true enabled value does not turn the probe on', () => {
  const db = freshDaemonDb();
  _resetProbeSchedule();
  withConfig({ embedding: { latency_probe: { enabled: 'yes', interval_ms: 1000 } } }, () => {
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n, 0);
});

test('the probe enqueues once per interval, not once per tick', () => {
  const db = freshDaemonDb();
  _resetProbeSchedule();
  const cfg = { embedding: { latency_probe: { enabled: true, interval_ms: 300000 } } };
  withConfig(cfg, () => {
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));   // 首次：入队
    scheduleCronTasks(db, new Date('2026-08-04T12:01:00'));   // 1 分钟后：未满间隔，不入队
    scheduleCronTasks(db, new Date('2026-08-04T12:06:00'));   // 6 分钟后：入队
  });
  const n = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
  assert.equal(n, 2, 'interval gating, not per-tick enqueueing');
});

test('the probe leaves no rows in task_runs', () => {
  const db = freshDaemonDb();
  _resetProbeSchedule();
  withConfig({ embedding: { latency_probe: { enabled: true, interval_ms: 1000 } } }, () => {
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
  });
  const n = db.prepare("SELECT count(*) AS n FROM task_runs WHERE type = 'embed_latency_probe'").get().n;
  assert.equal(n, 0, 'leases are never pruned; a 5-minute probe would add 288 rows a day for an idempotency guarantee a single-writer daemon does not need');
});
```

> `withConfig` 若该文件没有等价 helper，用它已有的配置注入方式内联展开。**不要新建抽象。**

- [ ] **Step 2: 跑测试确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs
```

Expected: FAIL（`_resetProbeSchedule` 不存在 / 第三条断言得到 0）。

- [ ] **Step 3: 注册进 dispatch**

`scripts/daemon/dispatch.mjs`：顶部 import 后加

```js
import { runEmbedLatencyProbe } from './tasks/embed-latency-probe.mjs';
```

在 `vec_backfill` 那个 if 之后、`throw` 之前加：

```js
  if (task.type === 'embed_latency_probe') {
    return runEmbedLatencyProbe(db, task);
  }
```

- [ ] **Step 4: 加调度**

`scripts/daemon/loop.mjs` 模块作用域（`scheduleCronTasks` 之前）加：

```js
/**
 * Deliberately NOT a task_runs lease. Leases exist for cross-process
 * idempotency (daemon / opportunistic / manual can race for one period), which
 * a daemon-only probe never needs — and nothing in this repo prunes task_runs,
 * so a 5-minute probe would add 288 rows a day forever. A restart resets this
 * and the probe fires once immediately; that is acceptable.
 */
let lastProbeAtMs = 0;

/** Test seam only. */
export function _resetProbeSchedule() {
  lastProbeAtMs = 0;
}
```

在 `scheduleCronTasks` 内部、`daily_maintenance` 那个 if **之前**加：

```js
  const probeCfg = cfg.embedding?.latency_probe ?? {};
  if (probeCfg.enabled === true) {
    const probeIntervalMs = Number(probeCfg.interval_ms ?? 300000);
    if (nowMs - lastProbeAtMs >= probeIntervalMs) {
      lastProbeAtMs = nowMs;
      db.prepare(
        `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
         VALUES ('embed_latency_probe', '{}', ?, ?, 'queued')`
      ).run(nowMs, nowMs);
    }
  }
```

- [ ] **Step 5: 跑测试确认绿 + 跑全量套件**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs
npm test
```

Expected: 单文件全绿；`npm test` **514+ pass / 0 fail**。
已知抖动：`stop-daemon-flow.test.mjs` 偶发红 2 条，重跑即绿 —— **红了先确认是它**，不要当成本任务引入的。

- [ ] **Step 6: 提交**

```bash
git add scripts/daemon/dispatch.mjs scripts/daemon/loop.mjs tests/integration/daemon-loop.test.mjs
git commit -m "feat(daemon): schedule the latency probe on an interval, without a lease

Every other daemon task dedupes through tryClaimLease, and this one does not.
A lease is a row in task_runs, nothing in this repo prunes that table, and a
five-minute probe would add 288 rows a day forever — to buy cross-process
idempotency that a probe only the daemon ever enqueues has no use for. The
deviation is deliberate and argued in the design doc rather than made silently.

The actual cadence is irregular by construction: the loop sleeps 300s when idle
and 30s when it isn't, so interval_ms is a floor, not a period. That is sampling
cadence, not the quantity being measured, and it does not bias the distribution."
```

---

### Task 4: 让成本可见 + 回填文档与不变量

**Files:**
- Modify: `scripts/lib/admin/diagnose.mjs`（`--feedback` 分支，`decisionDataSizeBytes` 调用点附近）
- Modify: `docs/ccmem-v0.13-dogfood.md`（Finding 15 一节，:718-731 附近；:725 那句断言）
- Modify: `docs/ccmem-v0.13-spec.md`（附录 A，新增 #144）
- Modify: `.wolf/buglog.json`（`bug-062` 的 `fix` 字段）
- Test: `tests/integration/admin-diagnose-command.test.mjs`

**Interfaces:**
- Consumes: `probeFile`、`DEFAULT_PROBE_FILE`（Task 2）

- [ ] **Step 1: 写失败的测试**

在 `tests/integration/admin-diagnose-command.test.mjs` 追加（复用该文件既有的 diagnose 调用 helper）：

```js
test('diagnose --feedback reports the latency probe file size', async () => {
  // 造一个非空的探针文件，然后断言 --feedback 打印出它的字节数。
  const out = await runDiagnoseFeedbackWithProbeFile('{"ts":1,"ms":500,"ok":true}\n');
  assert.match(out, /embed-latency-probe\.jsonl/, 'runtime cost must stay visible — same reason l25-probe.jsonl size is printed');
  assert.match(out, /\b27\b/, 'the byte count itself must be printed, not just the name');
});
```

- [ ] **Step 2: 跑测试确认它红**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/admin-diagnose-command.test.mjs
```

Expected: FAIL，输出里没有该文件名。

- [ ] **Step 3: 实现**

在 `scripts/lib/admin/diagnose.mjs` 里 `grep -n "decisionDataSizeBytes" scripts/lib/admin/diagnose.mjs` 找到既有的 `l25-probe.jsonl` 大小打印点，**紧挨着它**加一行同样形态的输出，用 `probeFile(...)` 解析路径、`statSync().size` 取大小（文件不存在时取 0，照既有写法）。

> **不要另起一个 "diagnostics" 小节。** 人类裁决第 6 条要的是"运行时成本可见"，与既有那行并列即可。

- [ ] **Step 4: 改掉 dogfood 里已被证伪的那句**

`docs/ccmem-v0.13-dogfood.md` 第 725 行附近，把「修复后 6 次失败、零次熔断」替换为**带日期的**表述，并补上触发链：

```markdown
**⚠️ 这条曾被写成"修复后零次熔断"，已被证伪。** 该说法在 2026-08-02 12:20 落笔时为真，
当晚即不再成立：熔断在 **08-02 23:10:20–23:20:13 之间开了 7 次**，并在 **08-04 21:01:41
又开了第 8 次**。Finding 14 的"连续 3 次"语义工作正常 —— 喂给它的正是本条的超时。

触发链（同一快照实测）：

    22:55:51  B-fail          失败 1
    22:57:29  B-fail          失败 2
    23:07:35  A  (embedMs=0)  ← 查询向量缓存命中，未触碰 provider，因此不重置失败计数
    23:08:57  B-fail          失败 3
    23:10:20  B-circuit       闸门打开

**缓存命中不重置连续失败计数** —— 统计"连续"类计数器时，只有真正触达 provider 的调用才算数。
```

同时把该节的取证数字更新为冻结快照口径（193 行 / A 130（25 次缓存命中）/ B-fail 54 / B-circuit 8 / B-off 1；真实尝试 159，截尾率 34.0%，800ms ≈ p66），并注明**数字取自 2026-08-04 21:32 的 `metrics.jsonl` 冻结副本**。

- [ ] **Step 5: 加附录 A 不变量 #144，并镜像验红**

`docs/ccmem-v0.13-spec.md` 附录 A 末尾加：

```markdown
144. 延迟探针不得触碰熔断器与查询向量缓存。`runEmbedLatencyProbe` 不调用
     `recordEmbedFailure` / `recordEmbedSuccess`，不写 `query_embedding_cache`，
     也不预检熔断状态 —— 否则测量工具会制造被测现象：探针自己的超时会去开真实检索的闸门。
     由 `tests/unit/v014-embed-latency-probe.test.mjs` 的前两条测试守。
```

**附录 A 没有 runner，是人工 checklist**，所以这一步不能只是写下去：

1. 镜像 `scripts/daemon/tasks/embed-latency-probe.mjs`；
2. 在镜像里接上 `recordEmbedFailure`；
3. 跑测试，确认**红在隔离断言上**；
4. 恢复镜像，确认绿。

**把这次验红的范围如实写在 #144 下方**（本条为完整验红还是部分验红）。上一轮 #143 就是部分验红且已如实标注 —— 照做。

- [ ] **Step 6: 更新 bug-062 的 fix 字段**

`.wolf/buglog.json` 里 `bug-062` 的 `"fix"` 当前写着 "Not yet applied"。改成实际做法（带日期的表述 + 触发链已记入 dogfood）。

⚠️ **本机 `mv` 与 `cp` 都是交互式别名，会静默拒绝覆盖并打印 `not overwritten`，而外层脚本照报成功。** 用 `command cp -f`，**并在写完后用 `jq` 读回验证内容**，不要信退出码。

- [ ] **Step 7: 跑全量套件并提交**

```bash
npm test
git add scripts/lib/admin/diagnose.mjs tests/integration/admin-diagnose-command.test.mjs docs/ccmem-v0.13-dogfood.md docs/ccmem-v0.13-spec.md .wolf/buglog.json
git commit -m "docs+diagnose: void a claim the data outlived, and keep the probe's cost visible

dogfood.md asserted zero circuit opens after the Finding 14 fix. That was true
when measured at 12:20 on 2026-08-02 and false by that evening — the breaker
opened 7 times between 23:10 and 23:20, and an 8th time on 08-04. The claim is
now dated and carries the trigger chain, including the part worth remembering:
the successful retrieval between two failures was a cache hit that never
reached the provider, so it did not reset the consecutive-failure counter.

diagnose --feedback now prints the probe file's size next to l25-probe.jsonl's,
for the same reason that one is printed: the runtime cost of a decision stream
stays visible rather than being optimised out of sight."
```

---

## 完成后的下一步（不属本计划）

探针跑 ≥3 天、`enabled: true`、累积 ≥300 样本之后，才谈得上定值。届时要回答的是设计文档 §一 那个问题：**把超时从 800 抬到 ~1300，那批超时里能捞回几次**（样本中落在 800–1360ms 区间的占比）。

**取值的上界由实测约束，不由分布决定**：`embed_timeout + 回落成本(实测 max 638) < 2000ms` ⇒ **≲1360ms**。
超过这个上界，慢的那次会撞穿 hook 预算并返回**空上下文** —— 比今天的 lexical 回落更差。

**不作为判据的**：分位数对比（v0.14 已坐实不可用，不要复活）。

---

## 自查记录

- **Spec 覆盖**：设计 §三/§四 → Task 2+3；§五 隔离 → Task 2 的前两条测试 + 附录 A #144；§五.2 行结构 → Task 2 第三、四条测试；§五.3 落盘政策 → Task 2 实现 + Task 4 的成本可见；§六 错误处理 → Task 2 第五条测试（skip 分支）；§七 测试 → Task 1-4 各自的测试；§八 局限 3（`prompt_chars`）→ Task 1；§〇 的 dogfood 陈旧断言 → Task 4。
- **占位符扫描**：无 TBD/TODO。两处"复用该文件既有 helper"是**有意**的 —— 那些 helper 的确切签名需在实现时读取，计划里硬编一个猜的签名比让实现者去读更危险。
- **类型一致性**：`runEmbedLatencyProbe(db, task, deps)`、`probeFile(probeCfg)`、`DEFAULT_PROBE_FILE`、`_resetProbeSchedule()`、任务类型字符串 `'embed_latency_probe'` —— 全计划同名同签名。
- **已知缺口**：Task 4 Step 1 的测试断言 `\b27\b`（示例内容的字节数）依赖示例字符串长度；实现时以实际写入内容为准调整该数字。**这是计划里唯一一个会过期的数字**，本仓库上一轮为"计划里的陈旧数字"栽过四次，故在此显式标注。
