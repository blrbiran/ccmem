# W0 通用「非默认配置上报」机制 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ccmem admin diagnose` 报出"哪些配置键的生效值与产品默认值不同"以及"哪些键 ccmem 根本不认识"，只报键路径、永不报值。

**Architecture:** 新增一个纯函数模块 `scripts/lib/config-delta.mjs`，把 `loadConfig()` 的结果与 `DEFAULT_CONFIG` 做深度 diff，产出两组排好序的 dotted 键路径。`cmdAdminDiagnose` 无条件调用它并把结果放进返回对象的 `config` 字段；`scripts/cli.mjs` 在默认分支打一行摘要、在新增的 `--config` 分支打全量列表。函数的 `base` 参数可注入，`cmdAdminDiagnose` 的 `cfg` 参数可注入 —— 这两个注入点是全部测试策略的支点。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、`node:assert/strict`、`node:child_process` 的 `execFileSync`。

**Spec:** `docs/superpowers/specs/2026-08-20-w0-non-default-config-reporting-design.md`（已过自审 + 一轮 review，review 抓到 1 Critical / 3 Important，均已改，见提交 `docs(spec): fix one critical and three important review findings in the W0 design`）

## Global Constraints

- 🔴 **实现必须等 `openai_timeout_ms` 测量窗口关闭。** 本计划现在写，**不代表现在可以动手**。窗口状态见 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`。
- 🔴 **跑全量套件时，起止时间必须当场记进** `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md` 末尾的批次表。**不记就等于污染了窗口而无法剔除。**
- **不要 push。删分支 / worktree 先问人类。**
- 🔴 **只报键路径，永不报值** —— 任何形式，包括打码后的值。`embedding.openai_api_key` / `embedding.jina_api_key` 一旦被设置就是非默认键，**报值等于把凭据打到 stdout**。
- **不改 `loadConfig()` 的返回形状**，不改 `DEFAULT_CONFIG` 的内容。
- **不加 `--json`**；**不在 daemon 日志、hook metrics 或别处上报**。
- Node 解释器一律 `/usr/local/bin/node`（与 `package.json` 的 `test` 脚本一致）。**PATH 上的 `node` 是 nvm v22.13.1，没有 fts5。**
- 🔴 **spawn CLI 时不要走 `./bin/ccmem`** —— 它最后一行是 `exec node …`，用的正是那个裸 `node`。照既有测试的写法用 `/usr/local/bin/node` + `<repo>/scripts/cli.mjs`（详见 Task 3 Step 1）。
- 单文件测试命令模板：
  ```bash
  env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <测试文件路径>
  ```
- 全量套件：`npm test`。**只在 Task 6 跑一次。**
- 🔴 **测试对真实 `DEFAULT_CONFIG` 的内容零假设** —— 唯一的例外是**顶层 `version` 键存在**，
  理由：`tests/unit/v013-config-sync.test.mjs` 已经依赖它，这不是本计划新引入的耦合。
  **除此之外不许在测试里写死任何真实键名**，尤其不许用这三个：
  `security.tier3.block_user_explicit`（W1 会删）、`security.quarantine_all_sources_at_write`（W1 才加）、
  `eval.disable_scope_isolation`（W2 才加）。
- **每个测试任务都有一步"故意改坏、确认变红"**，且**红必须落在被断言的行为上** —— "函数不存在"式的红不算（handoff Ⅴ）。本仓库出过全绿但测的是别的 checkout（A2），**绿色本身不算证据**。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `scripts/lib/config-delta.mjs` | 纯函数：深度 diff，产出两组 dotted 键路径 | **Create** |
| `tests/unit/v014-config-delta.test.mjs` | 纯函数的全部分类规则，**只用合成 fixture** | **Create** |
| `scripts/lib/admin/diagnose.mjs` | `cmdAdminDiagnose` 加可注入的 `cfg`；返回对象加 `config` 字段 | Modify |
| `tests/integration/v014-diagnose-config.test.mjs` | 结构化对象（注入 cfg）+ CLI 可见性（spawn） | **Create** |
| `scripts/cli.mjs` | 默认分支加摘要行；新增 `--config` 分支；`printHelp` 补一行 | Modify |
| `docs/ccmem-v0.14-spec.md` | §二 从"四条工作流"改为把 W0 纳入；§三 时机表加 W0 一行；W2 那条"这是 W2 的一部分真实工作量"就地更正 | Modify |

**任务顺序即依赖顺序**：Task 1 产出函数 → Task 2 接进结构化对象 → Task 3 接到默认输出 → Task 4 接到 `--config` → Task 5 文档 → Task 6 闸门。

---

### Task 1: `collectConfigDeltas` 纯函数（分类规则全覆盖）

**Files:**
- Create: `scripts/lib/config-delta.mjs`
- Test: `tests/unit/v014-config-delta.test.mjs`（Create）

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`（从 `scripts/lib/config.mjs` 具名导入，仅用作 `base` 的默认值）
- Produces:
  ```js
  collectConfigDeltas(cfg, base = DEFAULT_CONFIG) → { nonDefault: string[], unknown: string[] }
  ```
  两个数组**恒存在**（无内容时是 `[]`，**不是 `null`、不省略**），**各自按字典序排序**。
  Task 2 依赖这个签名与这两个字段名。

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/v014-config-delta.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectConfigDeltas } from '../../scripts/lib/config-delta.mjs';

/**
 * W0's job is to make a non-default switch impossible to miss. That only works
 * if the report is trusted, and a report is trusted only while it has no false
 * positives — an operator who once sees a key they never touched learns to
 * ignore the whole line, which is worse than not printing it at all.
 *
 * Every case below is a specific way the diff could lie. They use synthetic
 * fixtures on BOTH sides: a test that reads the real DEFAULT_CONFIG would go
 * red whenever the product's defaults change, which is drift detection, not
 * delta-logic verification, and it already has an owner (v013-config-sync).
 */

test('a key whose value equals the default is not reported', () => {
  const base = { a: 1, nested: { b: 'x' } };
  const cfg = { a: 1, nested: { b: 'x' } };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('a key whose value differs from the default is reported by path only', () => {
  const base = { a: 1, nested: { b: 'x' } };
  const cfg = { a: 1, nested: { b: 'CHANGED' } };

  const deltas = collectConfigDeltas(cfg, base);

  assert.deepEqual(deltas.nonDefault, ['nested.b']);
  assert.deepEqual(deltas.unknown, []);
  // The value must never travel with the path: openai_api_key is a non-default
  // key the moment an operator sets it, and this repo forbids printing config
  // contents. Asserting the shape is how that stays true after a refactor.
  assert.equal(JSON.stringify(deltas).includes('CHANGED'), false);
});

test('a scalar the base does not know about is reported as unknown', () => {
  const base = { a: 1 };
  const cfg = { a: 1, stray: 7 };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: ['stray'] });
});

test('a whole subtree the base does not know about is reported down to its leaves', () => {
  const base = { a: 1 };
  const cfg = { a: 1, stray: { deep: { leaf: 7 }, other: 8 } };

  // Reporting the subtree root instead would hide how many keys are actually
  // orphaned, and the operator's next move is to delete specific lines from
  // their config.json — they need the lines, not the section.
  assert.deepEqual(collectConfigDeltas(cfg, base).unknown, ['stray.deep.leaf', 'stray.other']);
});

test('a path the base has and the config lacks is ignored entirely', () => {
  const base = { a: 1, only_in_base: { deep: 2 } };
  const cfg = { a: 1 };

  // mergeConfig starts from a deep clone of the base, so in production every
  // base key survives — this branch is unreachable there. It is reachable in
  // tests that inject a partial cfg, and if it reported anything, every unit
  // test would have to carry a full DEFAULT_CONFIG replica, which defeats the
  // synthetic-fixture decision this whole file rests on.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('a scalar standing where the base has an object is reported at that path and not below', () => {
  const base = { section: { x: 1, y: 2 } };
  const cfg = { section: 5 };

  // Writing "section": 5 makes mergeConfig replace the entire subtree with 5,
  // so section.x and section.y stop existing. Recursing would emit misleading
  // child paths; the honest statement is that `section` itself is off-default.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: ['section'], unknown: [] });
});

test('an object standing where the base has a scalar is reported at that path and not below', () => {
  const base = { section: 5 };
  const cfg = { section: { x: 1 } };

  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: ['section'], unknown: [] });
});

test('underscore-prefixed documentation keys are skipped on both sides', () => {
  const base = { a: 1, _base_doc: 'ignored' };
  const cfg = { a: 1, _comment: 'config.default.json carries two of these' };

  // config.default.json is the template operators copy, and JSON cannot carry
  // comments, so it documents itself with _comment keys that DEFAULT_CONFIG
  // does not have. Without this rule every config started from the template
  // reports two unknown keys on day one.
  assert.deepEqual(collectConfigDeltas(cfg, base), { nonDefault: [], unknown: [] });
});

test('arrays are leaves: compared by content, never descended into', () => {
  const base = { list: [1, 2, 3] };

  assert.deepEqual(collectConfigDeltas({ list: [1, 2, 3] }, base).nonDefault, []);
  assert.deepEqual(collectConfigDeltas({ list: [1, 2] }, base).nonDefault, ['list']);
  // Descending would emit list.0 / list.1, which are not config keys anyone
  // can set in config.json.
  assert.deepEqual(collectConfigDeltas({ list: [9, 2, 3] }, base).nonDefault, ['list']);
});

test('both arrays come back sorted so callers can assert them directly', () => {
  const base = { zeta: 1, alpha: 1 };
  const cfg = { zeta: 2, alpha: 2, z_stray: 1, a_stray: 1 };

  const deltas = collectConfigDeltas(cfg, base);

  assert.deepEqual(deltas.nonDefault, ['alpha', 'zeta']);
  assert.deepEqual(deltas.unknown, ['a_stray', 'z_stray']);
});

test('an empty result is two empty arrays, never null and never a missing field', () => {
  const deltas = collectConfigDeltas({ a: 1 }, { a: 1 });

  // Omitting the fields would make "the mechanism did not run" and "the
  // mechanism ran and found nothing" indistinguishable, which is exactly the
  // failure the diagnose line exists to prevent.
  assert.deepEqual(Object.keys(deltas).sort(), ['nonDefault', 'unknown']);
  assert.deepEqual(deltas.nonDefault, []);
  assert.deepEqual(deltas.unknown, []);
});
```

- [ ] **Step 2: 跑测试，确认它因为"模块不存在"而失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-config-delta.test.mjs
```

Expected: FAIL —— `Cannot find module .../scripts/lib/config-delta.mjs`。
📌 **这一步的红不算"看着它变红"**（handoff Ⅴ），真正的变红验证在 Step 5。

- [ ] **Step 3: 写实现**

创建 `scripts/lib/config-delta.mjs`：

```javascript
import { DEFAULT_CONFIG } from './config.mjs';

/**
 * Reports which config keys are in effect at a value other than the product
 * default, and which keys ccmem does not recognise at all — BY PATH ONLY.
 *
 * Paths, never values: two of the keys that can legitimately differ from the
 * default are API credentials (embedding.openai_api_key, embedding.jina_api_key),
 * and this repo forbids printing config contents. A denylist of sensitive names
 * was considered and rejected: a list nobody maintains rots, and this codebase
 * has just finished cataloguing eight config keys that rotted exactly that way.
 */

/** JSON documents itself with `_`-prefixed keys; they are not configuration. */
const DOC_KEY_PREFIX = '_';

/** Arrays are leaves here — their contents are a value, not a key namespace. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configKeys(value) {
  return Object.keys(value).filter((key) => !key.startsWith(DOC_KEY_PREFIX));
}

/** Every leaf path under `value`, for a subtree the base knows nothing about. */
function collectLeafPaths(value, prefix, out) {
  if (!isPlainObject(value)) {
    out.push(prefix);
    return;
  }

  const keys = configKeys(value);
  if (keys.length === 0) {
    // An empty object has no leaves but is still something the operator wrote,
    // so the object itself is the reportable path.
    out.push(prefix);
    return;
  }

  for (const key of keys) {
    collectLeafPaths(value[key], `${prefix}.${key}`, out);
  }
}

function walk(cfg, base, prefix, out) {
  for (const key of configKeys(cfg)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const cfgValue = cfg[key];
    const baseHasKey = isPlainObject(base) && Object.prototype.hasOwnProperty.call(base, key);

    if (!baseHasKey) {
      collectLeafPaths(cfgValue, keyPath, out.unknown);
      continue;
    }

    const baseValue = base[key];

    if (isPlainObject(cfgValue) && isPlainObject(baseValue)) {
      walk(cfgValue, baseValue, keyPath, out);
      continue;
    }

    if (isPlainObject(cfgValue) !== isPlainObject(baseValue)) {
      // One side is a subtree and the other is a scalar. mergeConfig resolves
      // this by letting the scalar replace the whole subtree, so the child
      // paths genuinely stop existing — emitting them would be a lie.
      out.nonDefault.push(keyPath);
      continue;
    }

    if (JSON.stringify(cfgValue) !== JSON.stringify(baseValue)) {
      out.nonDefault.push(keyPath);
    }
  }

  // Paths present in `base` but absent from `cfg` are deliberately not walked.
  // mergeConfig builds every merged config from a deep clone of DEFAULT_CONFIG,
  // so in production a base key can only disappear by being overwritten with a
  // scalar — which the branch above already reports at the parent path. The
  // reachable case is a test injecting a partial cfg, and reporting there would
  // force every unit test to carry a full DEFAULT_CONFIG replica.
  // If mergeConfig ever stops cloning the base, this becomes a silent gap.
}

export function collectConfigDeltas(cfg, base = DEFAULT_CONFIG) {
  const out = { nonDefault: [], unknown: [] };

  if (!isPlainObject(cfg)) {
    return out;
  }

  walk(cfg, base, '', out);
  out.nonDefault.sort();
  out.unknown.sort();

  return out;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-config-delta.test.mjs
```

Expected: PASS，11 个测试全过。

- [ ] **Step 5: 🔴 故意改坏三处，逐处确认红在被断言的行为上**

**这一步不能跳，也不能只做一处。** 逐个做，每次只坏一处，看完就改回来。

| # | 怎么改坏 | 必须变红的测试 | 红的内容必须是 |
|---|---|---|---|
| 1 | 把 `configKeys` 里的 `.filter(...)` 删掉 | `underscore-prefixed documentation keys are skipped on both sides` | `unknown` 多出 `_comment` —— **不是**崩溃 |
| 2 | 把 `isPlainObject` 里的 `&& !Array.isArray(value)` 删掉 | `arrays are leaves: compared by content, never descended into` | `nonDefault` 出现 `list.0` 之类的子路径 |
| 3 | 把 `walk` 末尾那段注释对应的行为反过来（在循环后补一段遍历 `base` 独有键并推进 `unknown`） | `a path the base has and the config lacks is ignored entirely` | `unknown` 出现 `only_in_base.deep` |

每处改坏后跑同一条命令，**看到红、读一眼失败信息确认它说的是上表最后一列那件事**，再 `git checkout -- scripts/lib/config-delta.mjs` 恢复。

- [ ] **Step 6: 确认工作区干净后提交**

```bash
git diff --stat            # 必须只剩两个新文件，没有 Step 5 的残留
git add scripts/lib/config-delta.mjs tests/unit/v014-config-delta.test.mjs
git commit -m "feat(config): report non-default and unknown config keys by path"
```

⚠️ **`git diff --stat` 这一步不是仪式**：本仓库出过一次"编辑脚本静默丢光全部改动而 `git commit` 照样成功"的事故，提交信息宣称已修而实际未修。**别把"命令退出了"当成"改动落盘了"。**

---

### Task 2: `cmdAdminDiagnose` 吐出 `result.config`（可注入 `cfg`）

**Files:**
- Modify: `scripts/lib/admin/diagnose.mjs`（`cmdAdminDiagnose` 的参数表与返回对象）
- Test: `tests/integration/v014-diagnose-config.test.mjs`（Create）

**Interfaces:**
- Consumes: `collectConfigDeltas(cfg, base = DEFAULT_CONFIG)`（Task 1）
- Produces:
  - `cmdAdminDiagnose(db, { …既有选项, cfg = loadConfig() })` —— **新增一个可注入的 `cfg`**
  - 返回对象新增字段：
    ```js
    config: { non_default_keys: string[], unknown_keys: string[] }
    ```
    **两个字段恒存在**。Task 3 与 Task 4 依赖这两个字段名。
  ⚠️ **注意 camelCase → snake_case 的转换就发生在这里**：函数返回 `nonDefault` / `unknown`，
  诊断对象用 `non_default_keys` / `unknown_keys`（与 `project_key` / `startup_schema_version` 同风格）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/integration/v014-diagnose-config.test.mjs`：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Module-level data root, set BEFORE importing anything that reads it. This is
// the established pattern in this repo (see admin-diagnose-command.test.mjs and
// plist-drift.test.mjs): `npm test` gives every test file ONE shared
// CCMEM_DATA_ROOT, and getConfigPath() is $CCMEM_DATA_ROOT/config.json — so a
// config.json written into the shared root would be visible to every other test
// file's loadConfig(). node --test runs each file in its own process, which is
// what makes overriding the variable here safe.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-config-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');

const db = openDb();

/**
 * Task 1 proves the diff logic. This file proves the WIRING: that diagnose
 * actually calls it and actually publishes the result. Those fail separately —
 * a correct diff nobody reads is precisely the failure W0 exists to prevent.
 *
 * The injected cfg starts from a clone of DEFAULT_CONFIG rather than a hand-
 * written object so this file asserts nothing about what DEFAULT_CONFIG
 * contains. The one exception is the top-level `version` key, which
 * v013-config-sync.test.mjs already depends on.
 */

test('a config identical to the defaults produces two empty arrays', async () => {
  const result = await cmdAdminDiagnose(db, { cfg: structuredClone(DEFAULT_CONFIG) });

  assert.deepEqual(result.config.non_default_keys, []);
  assert.deepEqual(result.config.unknown_keys, []);
});

test('an off-default value reaches result.config.non_default_keys', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.version = 'w0-probe';

  const result = await cmdAdminDiagnose(db, { cfg });

  assert.deepEqual(result.config.non_default_keys, ['version']);
  assert.deepEqual(result.config.unknown_keys, []);
});

test('a key ccmem does not know reaches result.config.unknown_keys', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.zz_w0_probe = { sample: 1 };

  const result = await cmdAdminDiagnose(db, { cfg });

  assert.deepEqual(result.config.non_default_keys, []);
  assert.deepEqual(result.config.unknown_keys, ['zz_w0_probe.sample']);
});

test('result.config carries paths only, never the values behind them', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.version = 'secret-looking-value';

  const result = await cmdAdminDiagnose(db, { cfg });

  // embedding.openai_api_key is a non-default key the moment an operator sets
  // it. Anything that lets a value ride along with the path leaks credentials.
  assert.equal(JSON.stringify(result.config).includes('secret-looking-value'), false);
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: FAIL —— `Cannot read properties of undefined (reading 'non_default_keys')`（`result.config` 还不存在）。

- [ ] **Step 3: 改 `diagnose.mjs`**

**3a.** 在文件顶部的 import 区加一行（跟既有 import 的字母顺序，`./config.mjs` 之后）：

```javascript
import { collectConfigDeltas } from '../config-delta.mjs';
```

⚠️ 路径是 `../config-delta.mjs` —— `diagnose.mjs` 在 `scripts/lib/admin/` 下，比 `scripts/lib/` 深一层。

**3b.** 在 `cmdAdminDiagnose` 的解构参数表里，**在 `days = 14` 之后**加一项：

```javascript
    days = 14,
    cfg = loadConfig()
  } = {}
```

**3c.** 删掉函数体里原有的那一行：

```javascript
  const cfg = loadConfig();
```

它在 `const daemonAlive = isLockRowAlive(lock);` 之后（写作当时约 `:1258`）。
🔴 **必须删**：留着会用 `const` 重复声明同名变量，直接 `SyntaxError`。
**用 `grep -n 'const cfg = loadConfig' scripts/lib/admin/diagnose.mjs` 确认只有那一处、且删干净。**

**3d.** 在返回对象里，**紧挨着 `tier2` 之后**插入：

```javascript
    config: (() => {
      const deltas = collectConfigDeltas(cfg);
      return { non_default_keys: deltas.nonDefault, unknown_keys: deltas.unknown };
    })(),
```

📌 **为什么无条件算、不挂 flag**：默认输出那一行要用它（Task 3），而代价是一次遍历。
挂 flag 会让"没传 flag"和"机制没跑"变得不可区分。

- [ ] **Step 4: 跑测试，确认全绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: PASS，4 个测试全过。

- [ ] **Step 5: 🔴 故意改坏，确认红在接线上**

把 Step 3d 那段改成写死的空结果：

```javascript
    config: { non_default_keys: [], unknown_keys: [] },
```

跑同一条命令。**必须红**，且红的是 `an off-default value reaches result.config.non_default_keys`
与 `a key ccmem does not know reaches result.config.unknown_keys` 两条，
**失败信息是 `[] !== ['version']` 这种**——不是崩溃。
⚠️ **注意第一条测试（全等于默认）此时仍然是绿的** —— 这正说明为什么光有那一条不够。
看完 `git checkout -- scripts/lib/admin/diagnose.mjs` 恢复，然后重新做一遍 Step 3。

- [ ] **Step 6: 确认落盘后提交**

```bash
git diff --stat
grep -n 'const cfg = loadConfig' scripts/lib/admin/diagnose.mjs   # 应无输出
git add scripts/lib/admin/diagnose.mjs tests/integration/v014-diagnose-config.test.mjs
git commit -m "feat(diagnose): publish non-default and unknown config keys in the result object"
```

---

### Task 3: 默认输出那一行（判据 4：干净配置下也必须出现）

**Files:**
- Modify: `scripts/cli.mjs`（`admin diagnose` 的默认 `else` 分支，写作当时约 `:951`）
- Test: `tests/integration/v014-diagnose-config.test.mjs`（追加）

**Interfaces:**
- Consumes: `result.config.non_default_keys` / `result.config.unknown_keys`（Task 2）
- Produces: 默认输出固定新增一行，格式：
  ```
  ccmem: config <N> non-default key(s), <M> unknown key(s)
  ```
  Task 4 的摘要行**与本行逐字相同**。

- [ ] **Step 1: 追加失败的测试**

在 `tests/integration/v014-diagnose-config.test.mjs` **末尾**追加。先在文件顶部的 import 区补上：

```javascript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
```

（`mkdtempSync` 已经 import 过了，把 `writeFileSync` 并进同一行即可。）

然后追加：

```javascript
// Spawning the real CLI is the ONLY test in this plan that exercises the real
// loadConfig() -> collectConfigDeltas -> stdout path. The in-process tests above
// inject cfg, so they can all stay green while the wiring from the config file
// to the printed line is broken. Do not "optimise" this into an in-process call.
//
// It runs scripts/cli.mjs directly rather than ./bin/ccmem: bin/ccmem ends with
// `exec node …`, and the `node` on PATH here is nvm v22.13.1, a different
// interpreter from the /usr/local/bin/node v24.13.0 that npm test and the real
// daemon use.
const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

function runDiagnose(configJson, extraArgs = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-cli-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-w0-cwd-'));

  if (configJson !== null) {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify(configJson), 'utf8');
  }

  return execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', ...extraArgs], {
    cwd,
    env: { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: root },
    encoding: 'utf8'
  });
}

test('the default diagnose output reports the config line when there is no config.json', () => {
  // A brand-new install has no config.json at all. The line must still appear:
  // a line that shows up only when there is something to say is indistinguishable
  // from a mechanism that is not running, which is how eight config keys in this
  // repo stayed dead across eleven versions.
  const output = runDiagnose(null);

  assert.match(output, /^ccmem: config 0 non-default keys, 0 unknown keys$/m);
});

test('documentation keys copied from the template do not show up as unknown', () => {
  // config.default.json is the file operators copy, and it carries two _comment
  // keys because JSON cannot hold comments. If those were reported, every
  // template-derived config would show two phantom unknown keys on day one.
  const output = runDiagnose({ _comment: 'documentation, not configuration' });

  assert.match(output, /^ccmem: config 0 non-default keys, 0 unknown keys$/m);
});

test('the default output counts a real off-default value and a real unknown key', () => {
  const output = runDiagnose({ version: 'w0-probe', zz_w0_probe: { sample: 1 } });

  assert.match(output, /^ccmem: config 1 non-default key, 1 unknown key$/m);
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: 新增的 3 条 FAIL（stdout 里没有 `ccmem: config …` 那一行）；Task 2 的 4 条仍 PASS。

- [ ] **Step 3: 改 `cli.mjs` 的默认分支**

在 `admin diagnose` 那条链最后的 `} else {` 分支里，**在 `ccmem: tier2 …` 那一行之后、`if (result.migrations)` 之前**插入：

```javascript
      const nonDefaultCount = result.config.non_default_keys.length;
      const unknownCount = result.config.unknown_keys.length;
      process.stdout.write(
        `ccmem: config ${nonDefaultCount} non-default ${nonDefaultCount === 1 ? 'key' : 'keys'}, ` +
        `${unknownCount} unknown ${unknownCount === 1 ? 'key' : 'keys'}\n`
      );
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: PASS，7 个测试全过。

- [ ] **Step 5: 🔴 故意改坏，确认红在"干净配置下也要出现"这条上**

把 Step 3 那段包进一个条件里：

```javascript
      if (nonDefaultCount > 0 || unknownCount > 0) {
```

跑同一条命令。**必须红**，且红的是前两条（无 `config.json` / 只有 `_comment`），
**第三条仍然绿** —— 这正是判据 4 存在的理由：**只测"有内容时能报"的测试，挡不住"没内容时消失"。**
看完 `git checkout -- scripts/cli.mjs` 恢复，重做 Step 3。

- [ ] **Step 6: 确认落盘后提交**

```bash
git diff --stat
git add scripts/cli.mjs tests/integration/v014-diagnose-config.test.mjs
git commit -m "feat(cli): always print the config delta summary in admin diagnose"
```

---

### Task 4: `--config` 全量列表

**Files:**
- Modify: `scripts/cli.mjs`（新增分支 + `printHelp`）
- Test: `tests/integration/v014-diagnose-config.test.mjs`（追加）

**Interfaces:**
- Consumes: `result.config.non_default_keys` / `result.config.unknown_keys`（Task 2）、`runDiagnose(configJson, extraArgs)`（Task 3 Step 1）
- Produces: 无（终端输出，无下游任务依赖）

- [ ] **Step 1: 追加失败的测试**

在同一文件末尾追加：

```javascript
test('--config lists every key under a summary line identical to the default one', () => {
  const output = runDiagnose(
    { version: 'w0-probe', zz_w0_probe: { sample: 1 } },
    ['--config']
  );

  // The summary line is byte-identical to the one the flagless run prints, so
  // an operator learns one format, and the assertion has one shape.
  assert.match(output, /^ccmem: config 1 non-default key, 1 unknown key$/m);
  assert.match(output, /^non-default:\n {2}version$/m);
  assert.match(output, /^unknown:\n {2}zz_w0_probe\.sample$/m);
});

test('--config prints the group headers even when a group is empty', () => {
  const output = runDiagnose({ version: 'w0-probe' }, ['--config']);

  assert.match(output, /^ccmem: config 1 non-default key, 0 unknown keys$/m);
  assert.match(output, /^non-default:\n {2}version$/m);
  // A vanishing header would leave the reader unsure whether the group was
  // empty or the mechanism skipped it — the same ambiguity Task 3 removed
  // from the summary line.
  assert.match(output, /^unknown:$/m);
});

test('--config never prints the value behind a key', () => {
  const output = runDiagnose({ version: 'secret-looking-value' }, ['--config']);

  assert.equal(output.includes('secret-looking-value'), false);
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: 新增 3 条 FAIL —— `--config` 没被识别，走的是默认分支，所以摘要行在但两个分组不在。

- [ ] **Step 3: 加分支**

在 `cli.mjs` 的 `admin diagnose` 链里，**在 `} else if (args.includes('--restart-history')) {` 那一段之后、最后那个 `} else {` 之前**插入：

```javascript
    } else if (args.includes('--config')) {
      const nonDefaultCount = result.config.non_default_keys.length;
      const unknownCount = result.config.unknown_keys.length;
      process.stdout.write(
        `ccmem: config ${nonDefaultCount} non-default ${nonDefaultCount === 1 ? 'key' : 'keys'}, ` +
        `${unknownCount} unknown ${unknownCount === 1 ? 'key' : 'keys'}\n`
      );
      process.stdout.write('non-default:\n');
      for (const keyPath of result.config.non_default_keys) {
        process.stdout.write(`  ${keyPath}\n`);
      }
      process.stdout.write('unknown:\n');
      for (const keyPath of result.config.unknown_keys) {
        process.stdout.write(`  ${keyPath}\n`);
      }
```

🔴 **位置不能随便放**：`--feedback` 与 `--cost` 在这条链**更靠前**的地方就把 `admin diagnose` 整个截走了
（`cli.mjs` 写作当时约 `:768` 与 `:772`）。放到它们前面，`--config` 会被永远吃不到。
📌 同时传 `--config` 与别的 section flag 时，**链上靠前的那个赢** —— 这是既有 flag 全族的行为，**不做特殊处理，也不报错**。

- [ ] **Step 4: 在 `printHelp` 里把 `--config` 加进那串括号**

⚠️ **help 不是多行选项表，是一整行。** `printHelp()` 里 `admin diagnose` 只有**一行**
（`scripts/cli.mjs` 写作当时 `:48`），所有互斥 flag 挤在同一个方括号里用 `|` 分隔：

```
'  admin diagnose [--retrieval] [--embedding-circuit <open|close|status>] [--migrations|--key|--sessions|--security|--tuning|--metrics|--synthesis|--restart-history|--injections|--context-history|--feedback|--cost] [--session ID] [--hash HASH] [--days N]\n' +
```

**只改一处：把 `--config|` 插进那个 `|` 列表**（放在 `--cost` 之后，与代码里分支的相对位置一致）：

```
…|--context-history|--feedback|--cost|--config] [--session ID]…
```

📌 **不要新起一行、不要改这一行的其余部分。** 那串 flag 是互斥的，`--config` 也是（见 Step 3 的位置说明）。

- [ ] **Step 5: 跑测试，确认全绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-diagnose-config.test.mjs
```

Expected: PASS，10 个测试全过。

- [ ] **Step 6: 🔴 故意改坏，确认红在"分支被前面吃掉"这条上**

把 Step 3 新增分支的判定条件改成一个永远不成立的名字：

```javascript
    } else if (args.includes('--config-never')) {
```

这一改等价于"这个分支被链上更靠前的分支吃掉了"—— 也就是 spec §四点名的**死法 2**：
命令照跑、退出码为 0、摘要行还在，**只有分组悄悄没了**。

跑同一条命令。**必须红**，且红的是新增那 3 条，**失败信息是"缺 `non-default:` 那一行"**，
而 Task 3 的 3 条**仍然绿**（摘要行还在）—— 这说明测试确实分得清"摘要在"和"分组在"。
看完 `git checkout -- scripts/cli.mjs` 恢复，重做 Step 3 与 Step 4。

- [ ] **Step 7: 确认落盘后提交**

```bash
git diff --stat
git add scripts/cli.mjs tests/integration/v014-diagnose-config.test.mjs
git commit -m "feat(cli): add admin diagnose --config to list the config deltas"
```

---

### Task 5: 把 W0 接进 v0.14 spec（**独立提交，不含代码**）

**Files:**
- Modify: `docs/ccmem-v0.14-spec.md`（§二 标题与新增小节、§三 时机表、W2 那节被 W0 接管的一句）

**Interfaces:**
- Consumes: 无
- Produces: 无（纯文档）

**为什么单独一步、单独提交：** `docs/ccmem-v0.14-spec.md` §二 现在写着"**四条互相独立的工作流**"（W1/W2/W3/W4），
**它不知道 W0 存在**。本仓库栽过三次"撤回一条说法只在新章节宣布、旧措辞原地不动"，
所以这一步的动作是**逐处就地改**，不是补一段。**独立提交便于单独回滚。**

- [ ] **Step 1: 找出所有需要就地改的位置**

```bash
grep -n '四条互相独立\|四条\|W1 — \|W2 — \|没有.*任何.*报告非默认配置\|真实工作量' docs/ccmem-v0.14-spec.md
```

至少会命中三处（行号会漂，以 grep 结果为准）：
1. §二 开头的「**范围：四条互相独立的工作流**」与其下「四条之间没有共享状态」
2. §二 W2 那节末尾的「`admin/diagnose.mjs` 目前**没有**任何"报告非默认配置"的机制，⇒ **这是 W2 的一部分真实工作量，不是免费的**」
3. §三「落地时机」那张表（只有 W4 / W1·W2 / W3 三行）

- [ ] **Step 2: 逐处改**

**2a.** §二 标题与首句改为：

```markdown
## 二、范围：五条工作流（W0 是 W1 与 W2 的共同前置件）

W1–W4 之间没有共享状态，可任意顺序甚至并行实现。**W0 是例外：它是 W1 与 W2 都要消费的机制，必须先落。**
```

**2b.** 在 §二 的 `### W1 — …` **之前**插入一节：

```markdown
### W0 — 通用「非默认配置上报」机制（**前置件**）

- 由人类 2026-08-19 从 W1 验收判据 4 与 W2 的同一条需求里抽出，**避免两份互不知情的实现**。
- 设计：`docs/superpowers/specs/2026-08-20-w0-non-default-config-reporting-design.md`
- 计划：`docs/superpowers/plans/2026-08-20-w0-non-default-config-reporting.md`
- **只报键路径，永不报值** —— `openai_api_key` / `jina_api_key` 一旦被设置就是非默认键。
- **W0 先落，W1 才算验收完整**（W1 计划 Task 9 是这条依赖的闸门）。
```

**2c.** §二 W2 那节末尾那句就地改（**保留原文划掉**，本仓库既有做法）：

```markdown
- **本开关必须在 `diagnose` 里显式可见**：处于非默认值时要报出来（见 §五 5.2 的测试要求）。
  ~~`admin/diagnose.mjs` 目前**没有**任何"报告非默认配置"的机制，⇒ **这是 W2 的一部分真实工作量，不是免费的**。~~
  ✅ **已于 2026-08-19 抽成独立前置件 W0**（见上文 W0 一节）⇒ **这部分工作量不再属于 W2**；
  W2 只需保证新键进 `DEFAULT_CONFIG`，可见性由 W0 提供。
```

**2d.** §三 那张时机表加一行（放在 W1/W2 那行**之前**，因为 W0 先落）：

```markdown
| **W0** | 等**窗口关闭** | 它新增测试、改 `diagnose` 输出 ⇒ 会改套件时序。**与 W1/W2 同等对待** |
```

- [ ] **Step 3: 确认改动真的落盘了**

```bash
git diff --stat docs/ccmem-v0.14-spec.md      # 必须有改动行数
grep -n 'W0' docs/ccmem-v0.14-spec.md         # 至少命中 2b/2c/2d 三处
grep -n '四条互相独立' docs/ccmem-v0.14-spec.md  # 必须无输出
```

🔴 **最后那条 grep 是关键**：它验证的是"旧措辞真的被就地改掉了"，
而不是"新说法被追加在了别处"。**这三次栽过的坑就是这一条。**

- [ ] **Step 4: 提交**

```bash
git add docs/ccmem-v0.14-spec.md
git commit -m "docs(spec): wire W0 into the v0.14 scope — it is a prerequisite, not a fifth peer"
```

---

### Task 6: 🔴 全量套件 + 批次窗口记录 + 交接闸门

**Files:**
- Modify: `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`（末尾的批次表）

**Interfaces:**
- Consumes: Task 1–5 的全部产出
- Produces: 无

**这个任务不产生功能代码。** 它存在的理由有两条，都栽过：
① 全量套件是**唯一**能发现 W0 是否碰坏了别人的东西的地方（尤其 `cmdAdminDiagnose` 的参数表被改过）；
② 跑全量套件会抬本机负载，而一个预登记的测量窗口正在跑，**起止时间必须当场记，不能事后回忆**。

- [ ] **Step 1: 记下开始时刻**

```bash
date '+%Y-%m-%d %H:%M:%S'
```

**把这个时刻抄下来**，Step 3 要用。

- [ ] **Step 2: 跑全量套件**

```bash
npm test
```

Expected: 全绿。**新增测试数应为 18**（Task 1 的 11 + Task 2 的 4 + Task 3 的 3 …
⚠️ **不要照抄这个数字当断言** —— 以实际输出为准，本行只是让你注意到套件规模变了，
而**任何历史红率基线都与新数字不可比**。）

🔴 **若有红**：先判断是本次改动引起的还是既有抖动（谱见 handoff Ⅹ）。
**不要把"重跑一次绿了"当成已解决。**

- [ ] **Step 3: 当场把跑批窗口记进计划文件**

打开 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`，
在末尾**批次表**里追加一行，格式照既有行：

```markdown
| <开始时刻> – <结束时刻> | W0 落地后的全量套件（1 次） | 见本节「每日巡检记录」 |
```

⚠️ **窄义剔除要的是全量套件运行期 + 前后各 ≥60s 余量**（补遗 3）。
**单文件测试（Task 1–4 里那些亚秒级的）不构成需剔除的窗口，但仍照纪律当场记一笔。**

- [ ] **Step 4: 提交**

```bash
git diff --stat
git add docs/superpowers/plans/2026-08-10-raise-openai-timeout.md
git commit -m "docs(plan): record the W0 full-suite run window while it is still contemporaneous"
```

- [ ] **Step 5: 🔴 交接给 W1 —— 只做检查，不做改动**

W1 计划的 **Task 9** 是一个闸门，它检查的就是"W0 已落地并覆盖了本键"。跑一次：

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node scripts/cli.mjs admin -- diagnose --config
```

**现在的预期是两组都空**（本机配置若确实全默认），或列出本机真实的非默认键。
**无论哪种，只要那一行出现了，W0 就算对 W1 就位。**

⚠️ **不要在这里去实现 W1 的任何东西**，也**不要把 `security.quarantine_all_sources_at_write`
加进 `DEFAULT_CONFIG`** —— 那是 W1 的活。**W0 到此为止。**

- [ ] **Step 6: 按 `superpowers:verification-before-completion` 宣布完成**

宣布前必须能贴出：全量套件的实际输出、批次窗口那一行的 `git diff`、以及 Step 5 那条命令的真实 stdout。
**没有输出就没有结论。**

---

## 自审记录（写完计划后逐条对 spec 核过）

**1. Spec 覆盖率** —— 逐节点名，都有归属：

| spec 章节 | 落在哪 |
|---|---|
| §3.1 落点与签名 | Task 1 |
| §3.2 遍历规则三条 | Task 1 Step 1 的第 8、9 条测试 + Step 3 的 `configKeys` / `isPlainObject` |
| §3.3 分类规则五行 | Task 1 Step 1 的第 1–7 条测试逐行对应 |
| §3.4 输出契约（永不含值 / 排序 / 恒存在 / 无条件算） | Task 1 第 2、10、11 条测试 + Task 2 Step 3d 与第 4 条测试 |
| §3.5 CLI 两处输出 + flag 位置 | Task 3、Task 4 |
| §四 判据 1 | Task 1 |
| §四 判据 2 | Task 2 |
| §四 判据 3 | Task 3 Step 1 的 `runDiagnose` + Task 4 |
| §四 判据 4（两种"干净配置"） | Task 3 前两条测试 |
| §五 三层测试策略 + 模块级 data root + spawn 写法 | Task 2 Step 1 的注释块、Task 3 Step 1 |
| §五 判据 2/3 分工 | Task 3 Step 1 顶部注释 |
| §六 时序与依赖 | Global Constraints + Task 5 + Task 6 Step 5 |
| §六 三个受保护的真键 | Global Constraints |
| §七 明确不做 | Global Constraints |

**2. 占位符扫描** —— 无 TBD / TODO / "类似 Task N" / "适当处理错误"。每段代码都是可直接粘贴的完整内容。

**3. 类型一致性** —— 全计划只有一个跨任务接口：
`collectConfigDeltas → { nonDefault, unknown }`（camelCase，Task 1 定义、Task 2 消费），
`result.config → { non_default_keys, unknown_keys }`（snake_case，Task 2 定义、Task 3/4 消费）。
**转换点唯一，就在 Task 2 Step 3d**，且已在 Task 2 的 Interfaces 段显式点名，
避免实现者在 Task 3 里去找一个叫 `nonDefault` 的字段。

**4. 一条对 spec 的已知收窄（**故意的，写出来供人类裁决**）**：
spec §六 要求"测试对真实 `DEFAULT_CONFIG` 零假设"。本计划**保留了一个假设：顶层 `version` 键存在**
（Task 2、Task 3、Task 4 都用它当"改一个已存在的键"的样本）。
理由：`tests/unit/v013-config-sync.test.mjs` 已经依赖 `version`，这不是新引入的耦合；
而完全零假设就没有任何"已存在的键"可改，`nonDefault` 那条链路在集成层就测不到了。
**若人类不接受这个收窄**，替代方案是在集成测试里运行时挑一个叶子来改，
代价是测试变得难读、且失败时不知道改的是哪个键。
