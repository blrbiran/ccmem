# W2 scope 隔离降级开关 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `eval.disable_scope_isolation`（默认 `false`，行为零变化），打开后让检索与注入两条通道都不再按 project 隔离，使评测的 `C-NAIVE` 成为真控制组。

**Architecture:** 一个布尔从 `config` 流到 **7 个接线处**，关掉 **5 处 SQL 谓词**。三个 lexical helper 加一个默认 `false` 的参数；`retrieveMemories` 在函数开头算一次布尔供三处共用（**其中两处是它自己复制的 lexical 块，不经过 `lexicalRetrieve`**）；`session-start` 消费者去掉 `WHERE` 并补次级排序。开关打开时**抑制 feedback 写入**，否则会持久改写别的项目的记忆。每一处 SQL 改动都用**子句 + 参数数组成对构造**，因为 `likeSearch` 的 `projectKey` 绑在可变参数之前，只去谓词不去参数会静默绑错列。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、`node:assert/strict`、better-sqlite3。

**Spec:** `docs/superpowers/specs/2026-08-20-w2-scope-isolation-switch-design.md`（已过自审 + 一轮 review，review 抓到 2 Critical / 5 Important / 6 Minor，均已改，处置表见 spec §十）

## Global Constraints

- 🔴 **实现必须等 `openai_timeout_ms` 测量窗口关闭。** 本计划现在写，**不代表现在可以动手**。窗口状态见 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`。
- 🔴 **落地顺序是 W0 → W1 → W2。** 本计划**不依赖 W1 的产物**，但 W1 先落可避免两次改 `DEFAULT_CONFIG` 撞车。
- 🔴 **跑全量套件时，起止时间必须当场记进** `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md` 末尾的批次表。**不记就等于污染了窗口而无法剔除。**
- **不要 push。删分支 / worktree 先问人类。**
- 🔴 **配置读法一律 `config?.eval?.disable_scope_isolation === true`。** **不许写 `!== false`** —— 同一个 `retrieval.mjs` 里 `like_fallback.enabled !== false` 是相反写法，那是因为它的安全默认相反。本开关的安全默认是"隔离开着"，`!== false` 会让任何拼写错误、`undefined`、类型意外都**关掉隔离**。
- 🔴 **布尔一律叫 `disableScopeIsolation`，不许叫 `crossProject`** —— 仓内已有一个无关的 `config.cross_project` 域（`config.mjs:108-122`、`daemon/tasks/cross-project-patterns.mjs`），同名会把读者引到错的配置段。
- 🔴 **每处 SQL 改动，子句与 bind 参数必须在同一处代码成对产出。** `likeSearch` 的绑定顺序是 `.all(projectKey, ...values, limit)` —— **`projectKey` 在可变长的 `values` 之前**。去掉谓词却留下参数，参数个数可能仍然合法，于是**静默绑错列**。
- **不改 `DEFAULT_CONFIG` 已有键的任何值**；不加 `--json`；不动 `injection-cache.mjs` 生产者；不给 `adjustTrust` 加 scope 校验。
- Node 解释器一律 `/usr/local/bin/node`。**PATH 上的 `node` 是 nvm v22.13.1，没有 fts5。**
- 🔴 **spawn CLI 时不要走 `./bin/ccmem`** —— 它最后一行是 `exec node …`，用的正是那个裸 `node`。用 `/usr/local/bin/node` + `<repo>/scripts/cli.mjs`。
- 单文件测试命令模板：
  ```bash
  env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <测试文件路径>
  ```
- 全量套件：`npm test`。**只在 Task 7 跑一次。**
- **每个测试任务都有一步"故意改坏、确认变红"**，且**红必须落在被断言的行为上** —— "函数不存在"式的红不算（handoff Ⅴ）。本仓库出过全绿但测的是别的 checkout，**绿色本身不算证据**。
- 🔴 **行号会漂。** 下面每处都同时给了**函数名或上下文锚点**，**按锚点找，不要按行号跳**。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `scripts/lib/config.mjs` | `DEFAULT_CONFIG` 新增 `eval.disable_scope_isolation: false` | Modify |
| `config.default.json` | 同键同值（值级 parity） | Modify |
| `scripts/lib/retrieval.mjs` | 三个 helper 加参数并 export 其二；`retrieveMemories` 算一次布尔供 3 处共用 | Modify |
| `scripts/handlers/session-start.mjs` | `loadConfig()` 上移；去 `WHERE`；补次级排序；stderr 警告；抑制 feedback 写入 | Modify |
| `scripts/handlers/prompt-submit.mjs` | 抑制 feedback 写入 | Modify |
| `tests/unit/v014-scope-isolation-defaults.test.mjs` | 不变量：默认值 + 值级 parity | **Create** |
| `tests/integration/v014-scope-isolation-retrieval.test.mjs` | 三条 lexical lane 直调 + 向量 lane + 端到端钉 `retrievalPath === 'A'` | **Create** |
| `tests/integration/v014-scope-isolation-injection.test.mjs` | session-start 行集与顺序、stderr 警告三态、feedback 抑制 | **Create** |
| `docs/ccmem-v0.14-spec.md` | 就地改掉"这是 W2 的一部分真实工作量" | Modify |

**任务顺序即依赖顺序**：Task 1 造键 → Task 2 三个 helper → Task 3 `retrieveMemories` 三处接线 → Task 4 session-start → Task 5 feedback 抑制 → Task 6 文档 → Task 7 闸门。

---

## 共用 fixture 约定（Task 2–5 都用，**在各自文件里各写一份，不要跨文件 import**）

两个测试文件互不依赖。下面这两个 helper 在**两个文件里各定义一次**（重复 20 行好过造一个只有测试用的共享模块）。

**`configWith(overrides)` —— 造一份最小 config 对象：**

```js
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';

function configWith(evalOverrides) {
  return structuredClone({ ...DEFAULT_CONFIG, eval: { ...DEFAULT_CONFIG.eval, ...evalOverrides } });
}
```

🔴 **两个文件的配置注入方式不同，别搞混：**

| 文件 | 怎么把 config 送进去 |
|---|---|
| `v014-scope-isolation-retrieval.test.mjs` | **直接传参** —— `retrieveMemories(db, prompt, projectKey, config)` 的第四个参数就是 config。**不需要碰 `CCMEM_CONFIG_PATH`。** |
| `v014-scope-isolation-injection.test.mjs` | **必须走 `CCMEM_CONFIG_PATH`** —— session-start / prompt-submit 内部自己调 `loadConfig()`，传参传不进去。 |

**注入文件那一侧的配置写法（spec §六 风险 3 的方案 b，比改 `CCMEM_DATA_ROOT` 轻，且完全不碰共享数据根）：**

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prevConfigPath = process.env.CCMEM_CONFIG_PATH;

function useConfig(evalOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmem-w2-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ eval: evalOverrides }));
  process.env.CCMEM_CONFIG_PATH = file;
  return file;
}

test.afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.CCMEM_CONFIG_PATH;
  else process.env.CCMEM_CONFIG_PATH = prevConfigPath;
});
```

✅ `loadConfig` 优先读 `CCMEM_CONFIG_PATH`（`config.mjs:317-318`），且 `npm test` 跑的是 `env -u CCMEM_CONFIG_PATH …` ⇒ **起点保证干净**，仓内已有 16 个测试文件用这条路。
⚠️ **`loadConfig()` 无缓存、每次读盘**（handoff Ⅳ.4），所以 `useConfig()` 可以在每个 test 里调，不必重启进程。

**`runSessionStart(db, evalOverrides)` —— 调一次 session-start handler：**

```js
async function runSessionStart(db, evalOverrides) {
  useConfig(evalOverrides);
  const mod = await import('../../scripts/handlers/session-start.mjs');
  return mod.handleSessionStart(db, { session_id: 's1', cwd: PROJ_A_CWD });
}
```

🔴 **Step 0（Task 4 与 Task 5 都要做）**：先打开 `scripts/handlers/session-start.mjs`，
**确认导出的函数名与参数形状**（上面写的 `handleSessionStart(db, hookData)` 是按现有代码推的，**没有跑过**），
以及 `resolveProjectKey(hookData.cwd)` 需要 `cwd` 长什么样才能解析成 `proj-a`。
**照实际签名改这个 helper，不要照抄。**

---

### Task 1: 配置键与不变量

**Files:**
- Modify: `scripts/lib/config.mjs`（`DEFAULT_CONFIG` 对象）
- Modify: `config.default.json`
- Test: `tests/unit/v014-scope-isolation-defaults.test.mjs`（Create）

**Interfaces:**
- Produces: `DEFAULT_CONFIG.eval.disable_scope_isolation === false`。后续所有任务都读 `config?.eval?.disable_scope_isolation === true`。

- [ ] **Step 1: 写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// WHY: 这个开关关掉的是跨项目隔离。默认值一旦漂成 true，每个装了 ccmem 的
// 项目都会开始互相看见对方的记忆，而且没有任何报错。这条断言是那件事的唯一闸门。
test('disable_scope_isolation defaults to false', () => {
  assert.equal(DEFAULT_CONFIG.eval.disable_scope_isolation, false);
});

// WHY: config.default.json 是给用户抄的模板。它和 DEFAULT_CONFIG 值不一致时，
// 照模板起手的用户拿到的生效值与产品默认值不同，而 diagnose 会把它报成"非默认"。
test('config.default.json carries the same value', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  assert.equal(tpl.eval.disable_scope_isolation, false);
});
```

- [ ] **Step 2: 跑它，确认失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v014-scope-isolation-defaults.test.mjs
```

Expected: 两条都 FAIL，报 `Cannot read properties of undefined (reading 'disable_scope_isolation')`。

- [ ] **Step 3: 加键**

在 `scripts/lib/config.mjs` 的 `DEFAULT_CONFIG` 里加一个顶层段（**实测当前没有 `eval` 段**）：

```js
  eval: {
    disable_scope_isolation: false
  },
```

在 `config.default.json` 顶层加：

```json
  "eval": {
    "_comment": "评测专用。true 会关掉跨项目 scope 隔离，让本机所有项目的记忆互相可见。默认 false，不要在真实数据目录上打开。",
    "disable_scope_isolation": false
  },
```

⚠️ **`_comment` 是仓内既有约定**（`config.default.json` 已有两个），值级 parity 测试按 `_` 前缀跳过它。**不要把 `_comment` 加进 `DEFAULT_CONFIG`** —— JSON 带不了注释，`DEFAULT_CONFIG` 里一个都没有。

- [ ] **Step 4: 跑测试，确认通过**

命令同 Step 2。Expected: 2 pass。

- [ ] **Step 5: 故意改坏，确认红在正确的地方**

把 `DEFAULT_CONFIG` 里的 `false` 改成 `true`，重跑。
Expected: **第一条**测试 FAIL 且信息是 `Expected values to be strictly equal: true !== false`；**第二条仍然绿**（它读的是 JSON 模板）。
⇒ 这正是两条测试要分开的理由：它们失败的信号可区分。改回 `false`。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/config.mjs config.default.json tests/unit/v014-scope-isolation-defaults.test.mjs
git commit -m "feat(config): add eval.disable_scope_isolation, default false"
```

---

### Task 2: 三个 lexical helper 加参数（谓词 1–3）

**Files:**
- Modify: `scripts/lib/retrieval.mjs`（`ftsSearch` / `likeSearch` / `legacySubstringSearch`）
- Test: `tests/integration/v014-scope-isolation-retrieval.test.mjs`（Create）

**Interfaces:**
- Produces:
  - `export function ftsSearch(db, ftsQuery, projectKey, limit, disableScopeIsolation = false)`
  - `export function likeSearch(db, prompt, projectKey, limit, disableScopeIsolation = false)`
  - `export function legacySubstringSearch(db, prompt, projectKey, limit, disableScopeIsolation = false)`
- ⚠️ `ftsSearch` 与 `legacySubstringSearch` **今天没有 export**，本任务给它们加上。**这是有意加宽的 test-only 公开面**，spec §4.3 已认定为已知代价。

- [ ] **Step 1: 先读既有测试的建库套路，不要自己发明**

读 `tests/integration/prompt-submit-retrieval.test.mjs` 的开头（import、临时 `CCMEM_DATA_ROOT`、建库与建表那一段），本任务的 fixture **照它写**。

- [ ] **Step 2: 写失败的测试**

新建 `tests/integration/v014-scope-isolation-retrieval.test.mjs`。fixture 播三条记忆：

- `own`：`scope='project'`、`project_key='proj-a'`
- `other`：`scope='project'`、`project_key='proj-b'`
- `glob`：`scope='global'`、`project_key=null`

三条 `content` 都含同一个词 `zebrafish`（保证三条 lane 都能命中）。全部 `status='active'`、`decay_status='active'`。

```js
// WHY: 这三条 lane 各自独立地拼 SQL，历史上 review 已经在其中一条上抓到过
// "改完了但不起作用"。逐条直调 helper，是为了让某一条漏改时，红的是那一条，
// 而不是被另外两条的绿色盖过去。
for (const [name, call] of [
  ['ftsSearch', (db, off) => ftsSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['likeSearch', (db, off) => likeSearch(db, 'zebrafish', 'proj-a', 50, off)],
  ['legacySubstringSearch', (db, off) => legacySubstringSearch(db, 'zebrafish', 'proj-a', 50, off)]
]) {
  test(`${name} isolates by project when the switch is off`, () => {
    const db = seed();
    const ids = call(db, false).map((r) => r.id).sort();
    assert.deepEqual(ids, ['glob', 'own']);
  });

  test(`${name} crosses projects when the switch is on`, () => {
    const db = seed();
    const ids = call(db, true).map((r) => r.id).sort();
    assert.deepEqual(ids, ['glob', 'other', 'own']);
  });
}
```

⚠️ **断言用 `deepEqual` 比全集，不要只断言"包含 other"** —— 只查包含的话，一个把谓词整段删光、连 `status` 过滤都丢掉的实现同样能过。

- [ ] **Step 3: 跑它，确认失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-scope-isolation-retrieval.test.mjs
```

Expected: 全部 FAIL，报 `The requested module … does not provide an export named 'ftsSearch'`。

- [ ] **Step 4: 加 export 与参数，子句与参数成对构造**

`ftsSearch`：

```js
export function ftsSearch(db, ftsQuery, projectKey, limit, disableScopeIsolation = false) {
  if (!ftsQuery) {
    return [];
  }

  const scopeClause = disableScopeIsolation ? '' : "AND (m.scope = 'global' OR m.project_key = ?)";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  return db.prepare(
    `SELECT m.id, m.type, m.content, m.scope, m.pinned, m.trust_score,
            m.last_touched_at, bm25(memories_fts) AS rank
     FROM memories_fts
     JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
       ${scopeClause}
       AND m.status = 'active'
       AND m.decay_status IN ('active', 'probation')
     ORDER BY m.pinned DESC, rank ASC
     LIMIT ?`
  ).all(ftsQuery, ...scopeParams, limit);
}
```

`likeSearch` —— 🔴 **注意绑定顺序**，`projectKey` 原本就在 `...values` 之前：

```js
export function likeSearch(db, prompt, projectKey, limit, disableScopeIsolation = false) {
  const tokens = extractShortTokens(prompt, 10);
  if (!tokens.length || limit <= 0) {
    return [];
  }

  const clauses = tokens.map(() => 'LOWER(content) LIKE ?').join(' OR ');
  const values = tokens.map((token) => `%${token}%`);
  const scopeClause = disableScopeIsolation ? '' : "(scope = 'global' OR project_key = ?) AND";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  return db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at, 0 AS rank
     FROM memories
     WHERE ${scopeClause}
       status = 'active'
       AND decay_status IN ('active', 'probation')
       AND (${clauses})
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(...scopeParams, ...values, limit);
}
```

`legacySubstringSearch`：

```js
export function legacySubstringSearch(db, prompt, projectKey, limit, disableScopeIsolation = false) {
  const tokens = sanitizeFtsQuery(String(prompt ?? '').slice(0, 2000))
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return [];
  }

  const scopeClause = disableScopeIsolation ? '' : "(scope = 'global' OR project_key = ?) AND";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  const candidates = db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at
     FROM memories
     WHERE ${scopeClause}
       status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY pinned DESC, last_touched_at DESC`
  ).all(...scopeParams);

  // 下面的打分与排序原样不动
```

⚠️ 后两个把谓词挪到 `WHERE` 开头并让它自带尾部 `AND`，是因为原文是 `WHERE (scope…) AND status…`；整条删掉时必须留下一个合法的 `WHERE status…`。**改完请把三条 SQL 都在两种状态下各跑一次**（Step 5 的测试就是干这个的）。

- [ ] **Step 5: 跑测试，确认通过**

命令同 Step 3。Expected: 6 pass。

- [ ] **Step 6: 故意改坏，确认红在正确的地方**

把 `likeSearch` 的 `.all(...scopeParams, ...values, limit)` 改回 `.all(projectKey, ...values, limit)`（**只去谓词、不去参数**），重跑。
Expected: `likeSearch crosses projects when the switch is on` **FAIL**，且**其余五条仍绿**。
⇒ 这就是 Global Constraints 里那条"静默绑错列"的实证。改回去。

- [ ] **Step 7: 提交**

```bash
git add scripts/lib/retrieval.mjs tests/integration/v014-scope-isolation-retrieval.test.mjs
git commit -m "feat(retrieval): thread disableScopeIsolation through the three lexical helpers"
```

---

### Task 3: 🔴 `retrieveMemories` 的三处接线（含初稿漏掉的两处）

**Files:**
- Modify: `scripts/lib/retrieval.mjs`（`retrieveMemories`，锚点：`export async function retrieveMemories`）
- Test: `tests/integration/v014-scope-isolation-retrieval.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的三个 helper 签名。
- Produces: `retrieveMemories` 返回对象里的 `retrievalPath` 字段（**已存在，本任务不新增**），测试要断言它等于 `'A'`。

🔴 **本任务是整个计划最容易做错的一处。** `retrieveMemories` 在**嵌入可用**时**自己复制了一份 lexical 块**，**不经过 `lexicalRetrieve`**。只改 `lexicalRetrieve` 的实现，在评测真正跑的那条路上开关**完全不生效**。

三处接线（按锚点找）：

| 锚点 | 处置 |
|---|---|
| `lexicalRetrieve(` 函数体内对三个 helper 的调用 | 由它自己算布尔并传下去 |
| `let ftsRows = useFts && ftsQuery ? ftsSearch(` | **传布尔** |
| `const likeRows = likeSearch(` | **传布尔** |
| `AND (scope = 'global' OR project_key = ?)`（`allVecs` 那条） | 子句 + 参数成对改 |

- [ ] **Step 1: 写失败的测试（端到端，钉死 `retrievalPath === 'A'`）**

追加到 Task 2 那个测试文件：

```js
// WHY: retrieveMemories 在嵌入可用时复制了一份 lexical 块（不走 lexicalRetrieve），
// 而那正是评测跑的路径。不钉死 retrievalPath，无 provider 的测试会回落进
// lexicalRetrieve —— 那条路是被覆盖的，于是漏接线的实现照样全绿。
// 这条断言存在的唯一目的，就是让那种漏接大声红掉。
test('end-to-end crosses projects on the embedding path', async () => {
  const db = seed();
  seedEmbeddings(db);                       // 见 Step 2
  const config = configWith({ disable_scope_isolation: true });
  const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
  assert.equal(out.retrievalPath, 'A', 'must exercise the embedding path, not the lexical fallback');
  assert.ok(out.rows.some((r) => r.id === 'other'), 'proj-b memory must be visible');
});

test('end-to-end isolates on the embedding path when the switch is off', async () => {
  const db = seed();
  seedEmbeddings(db);
  const config = configWith({ disable_scope_isolation: false });
  const out = await retrieveMemories(db, 'zebrafish', 'proj-a', config);
  assert.equal(out.retrievalPath, 'A');
  assert.ok(!out.rows.some((r) => r.id === 'other'), 'proj-b memory must NOT be visible');
});
```

- [ ] **Step 2: 造出走得通 `retrievalPath === 'A'` 的 fixture**

这一步**是本任务的真实工作量**，不许跳过或降级。需要：

1. 给三条记忆写 `embedding`（`Float32Array` 的 buffer）与 `embedding_sig`；
2. 让 `retrieveMemories` 拿到一个**不打网络**的 provider。

**先读 `scripts/lib/retrieval.mjs` 里 `getProvider` / `getProviderWithCircuit` / `currentEmbeddingSig` 的实现**，确认注入 provider 的最小合法方式（config 里选哪个 provider、`sig` 怎么算），再照它构造 `configWith(...)`。

🔴 **如果发现必须引入一个 provider stub 模块才做得到，那就单独做成本任务的一步并单独提交** —— **不许把这两条测试降级成"只断言 SQL 字符串"**，那正是 review 在向量站点抓到过的失败模式。
🔴 **如果试了之后判断在合理成本内做不到，停下来问人类，不要自己缩小判据。**

- [ ] **Step 3: 跑测试，确认失败**

Expected: 两条都 FAIL。**`assert.equal(out.retrievalPath, 'A')` 必须先过** —— 如果它先红，说明 fixture 还没把嵌入路走通，回到 Step 2，**不要**改断言。

- [ ] **Step 4: 三处接线**

在 `retrieveMemories` 函数开头（拿到 `config` 之后、任何查询之前）算一次：

```js
  const disableScopeIsolation = config?.eval?.disable_scope_isolation === true;
```

`lexicalRetrieve` 内同样算一次，并传给三个 helper。

`retrieveMemories` 内那两处复制的调用：

```js
  let ftsRows = useFts && ftsQuery
    ? ftsSearch(db, ftsQuery, projectKey, limit * 3, disableScopeIsolation)
    : [];
```

```js
    const likeRows = likeSearch(
      db,
      promptText,
      projectKey,
      useFts ? Math.max((limit * 3) - candidateRows.length, limit) : (limit * 3),
      disableScopeIsolation
    );
```

向量候选（锚点 `const allVecs = db.prepare(`）：

```js
  const vecScopeClause = disableScopeIsolation ? '' : "AND (scope = 'global' OR project_key = ?)";
  const vecScopeParams = disableScopeIsolation ? [] : [projectKey];
  const allVecs = db.prepare(
    `SELECT id, embedding
     FROM memories
     WHERE embedding IS NOT NULL AND embedding_sig = ?
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       ${vecScopeClause}`
  ).all(sig, ...vecScopeParams);
```

⚠️ **紧随其后的 `staleVecs` 那条 `COUNT(*)` 一个字都别动。** 它**没有** scope 谓词，与本开关无关；它经 `retrieval_stale_vecs` 出到 `admin/diagnose.mjs` 与 `handlers/prompt-submit.mjs`。（`:432-435` 那段注释描述的是它，不是上面那条查询。）

- [ ] **Step 5: 加向量 lane 的直接断言**

```js
// WHY: 向量 lane 不在那三个 helper 里，Task 2 的六条断言一条都覆盖不到它。
test('vector candidate query crosses projects when the switch is on', async () => {
  const db = seed();
  seedEmbeddings(db);
  const out = await retrieveMemories(db, 'zebrafish', 'proj-a', configWith({ disable_scope_isolation: true }));
  assert.equal(out.retrievalPath, 'A');
  assert.ok(out.rows.some((r) => r.id === 'other'));
});
```

- [ ] **Step 6: 跑测试，确认通过**

命令同 Task 2 Step 3。Expected: 全部 pass。

- [ ] **Step 7: 🔴 故意改坏 —— 这一步是本计划的关键验证**

把 `ftsSearch(db, ftsQuery, projectKey, limit * 3, disableScopeIsolation)` 那处的第五个参数**删掉**（回到漏接线的状态），重跑。

Expected: **`end-to-end crosses projects on the embedding path` FAIL**。

⚠️ **如果它仍然绿，说明测试没走到嵌入路，判据 3 就是失明的** —— 回到 Step 2 把 fixture 修好，**不要**因为"别的测试都绿了"就往下走。改回去。

- [ ] **Step 8: 提交**

```bash
git add scripts/lib/retrieval.mjs tests/integration/v014-scope-isolation-retrieval.test.mjs
git commit -m "feat(retrieval): wire disableScopeIsolation into retrieveMemories' own lexical and vector queries"
```

---

### Task 4: session-start 消费者

**Files:**
- Modify: `scripts/handlers/session-start.mjs`
- Test: `tests/integration/v014-scope-isolation-injection.test.mjs`（Create）

**Interfaces:**
- Consumes: Task 1 的配置键。
- Produces: 一个模块级常量 `SCOPE_ISOLATION_NOTICE`，放在 `SHADOW_NOTICE` 旁边。

- [ ] **Step 1: 先读既有测试的套路**

读 `tests/integration/save-list-session-start.test.mjs` 的建库与调用 session-start handler 那一段，本任务照它写。

- [ ] **Step 2: 写失败的测试**

fixture：往 `injection_cache` 播三行 —— `'global'`、`'project:proj-a'`、`'project:proj-b'`，`rendered_text` 分别是 `'G'`、`'A'`、`'B'`，`member_ids` 分别是 `'["g1"]'`、`'["a1"]'`、`'["b1"]'`。

```js
// 捕获 stderr。process.stderr.write 是仓内既有的报警通道，测它就得截它。
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk, ...rest) => { buf += String(chunk); return orig(chunk, ...rest); };
  return { read: () => buf, restore: () => { process.stderr.write = orig; } };
}

// WHY: 开关关掉时读两行、开时读全部，这是 W2 在注入通道上的全部效果。
test('session_start reads only own project + global when the switch is off', async () => {
  const db = seed();
  const out = await runSessionStart(db, { disable_scope_isolation: false });
  assert.equal(out.additionalContext, 'G\n\nA');
});

// WHY: 顺序也要断言。多个 project:* 行之间原本没有稳定排序，注入文本的拼接
// 顺序不确定就意味着评测不可复现 —— 所以次级排序是判据的一部分，不是风格问题。
test('session_start reads every row, global first, then project keys sorted', async () => {
  const db = seed();
  const out = await runSessionStart(db, { disable_scope_isolation: true });
  assert.equal(out.additionalContext, 'G\n\nA\n\nB');
});

// WHY: diagnose 的默认输出只有一个计数，不含键名。这行 stderr 是唯一按名字
// 说出"跨项目隔离关着"的信号；它沉默，操作员就不知道。
test('warns on stderr when the switch is on', async () => {
  const db = seed();
  const cap = captureStderr();
  try {
    await runSessionStart(db, { disable_scope_isolation: true });
  } finally {
    cap.restore();
  }
  assert.match(cap.read(), /disable_scope_isolation is ON/);
});

test('does not warn when the switch is off', async () => {
  const db = seed();
  const cap = captureStderr();
  try {
    await runSessionStart(db, { disable_scope_isolation: false });
  } finally {
    cap.restore();
  }
  assert.doesNotMatch(cap.read(), /disable_scope_isolation is ON/);
});

// WHY: shadow 模式下查询已经跑过了（它在 shadow 的提前 return 之前），
// 跨项目的行确实被读了。此时沉默等于撒谎。
test('warns in shadow mode too', async () => {
  const db = seed();
  setMode(db, 'shadow');                      // 见 Step 1：照既有测试怎么设 mode
  const cap = captureStderr();
  try {
    await runSessionStart(db, { disable_scope_isolation: true });
  } finally {
    cap.restore();
  }
  assert.match(cap.read(), /disable_scope_isolation is ON/);
});

// WHY: off 模式在查询之前就 return 了，什么都没读，报警就是假警报。
test('does not warn in off mode', async () => {
  const db = seed();
  setMode(db, 'off');
  const cap = captureStderr();
  try {
    await runSessionStart(db, { disable_scope_isolation: true });
  } finally {
    cap.restore();
  }
  assert.doesNotMatch(cap.read(), /disable_scope_isolation is ON/);
});
```

⚠️ 断言 `additionalContext` 的**完整字符串**，不要只断言"含 B" —— 只查包含就测不到顺序。
⚠️ `setMode(db, …)` 与返回字段名（`additionalContext`）**照 Step 1 读到的既有测试写**；
上面是按 `getMode(db)` / `return { additionalContext: … }` 现有代码推的，**没有跑过**。
⚠️ shadow 那条：既有代码在 shadow 分支会先写 `SHADOW_NOTICE` 再 return，
所以 `cap.read()` 里会同时有两段文本 —— 用 `assert.match` 查子串，**不要**断言整个 stderr 相等。

- [ ] **Step 3: 跑它，确认失败**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/v014-scope-isolation-injection.test.mjs
```

Expected: 「读全部行」「三条 warn」FAIL；「只读两行」「不 warn」应当已经绿（那是现状）。

- [ ] **Step 4: 改 handler**

1. **把 `const config = loadConfig();` 从原位置上移到 SELECT 之前**（锚点：`const projectKey = resolveProjectKey(hookData.cwd);` 之后）。
   ⚠️ **这会跨过 `mode === 'shadow'` 的提前 return** ⇒ shadow 模式今天不调 `loadConfig()`，改后会调，畸形 `config.json` 会让它抛 `ConfigError`。**这是已裁决接受的**（spec §4.4-1）：坏配置本来就会让所有非 shadow 会话失败，shadow 模式在坏配置上静默成功本身就是一种静默失败。**不要为它加 try/catch 吞掉错误。**

2. 常量放在 `SHADOW_NOTICE` 旁边：

```js
const SCOPE_ISOLATION_NOTICE =
  'ccmem: WARNING — eval.disable_scope_isolation is ON. Cross-project memory isolation is DISABLED;\n'
  + 'ccmem: memories from every project on this machine are visible. Do not use on a real data root.\n';
```

3. 查询：

```js
    const disableScopeIsolation = config?.eval?.disable_scope_isolation === true;
    const scopeClause = disableScopeIsolation ? '' : "WHERE scope = 'global' OR scope = ?";
    const scopeParams = disableScopeIsolation ? [] : [`project:${projectKey}`];
    const rows = db.prepare(
      `SELECT rendered_text, member_ids
       FROM injection_cache
       ${scopeClause}
       ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, scope`
    ).all(...scopeParams);
    if (disableScopeIsolation) {
      process.stderr.write(SCOPE_ISOLATION_NOTICE);
    }
```

⚠️ **`, scope` 这个次级排序无条件加**，两种状态下都成立。带 `WHERE` 时最多两行、分属两个主排序桶（`scope` 是 PRIMARY KEY），**次级键永远不会被用到** ⇒ 默认路径行为不变。
⚠️ **警告写在查询之后**：`mode === 'off'` 在 `:60` 一带就 return 了，查询根本没跑，所以自然不会报；shadow 的 return 在查询之后，所以会报。**这就是"查询真跑了才报"这条规则的实现方式，不要再加 mode 判断。**

- [ ] **Step 5: 跑测试，确认通过**

命令同 Step 3。Expected: 全部 pass。

- [ ] **Step 6: 故意改坏，确认红在正确的地方**

把 `ORDER BY … , scope` 里的 `, scope` 删掉，重跑。
Expected: **只有** `session_start reads every row, global first, then project keys sorted` FAIL（在 `'G\n\nA\n\nB'` 上），其余全绿。
⚠️ 若它偶然仍绿（SQLite 恰好返回了想要的顺序），**这条测试就是不可靠的** —— 加第四个项目 `project:proj-c` 再试，直到不加次级排序时它稳定红。改回去。

- [ ] **Step 7: 提交**

```bash
git add scripts/handlers/session-start.mjs tests/integration/v014-scope-isolation-injection.test.mjs
git commit -m "feat(session-start): honour disableScopeIsolation, add deterministic ordering and a stderr warning"
```

---

### Task 5: 🔴 抑制 feedback 写入（开关的持久副作用）

**Files:**
- Modify: `scripts/handlers/prompt-submit.mjs`（锚点：`if (hookData.session_id && rows.length) {`）
- Modify: `scripts/handlers/session-start.mjs`（锚点：`writeRecentInjection(db, hookData.session_id, 0, 'session_start', injectedIds);`）
- Test: `tests/integration/v014-scope-isolation-injection.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的配置键；Task 4 已经在 session-start 里算好的 `disableScopeIsolation`。

**为什么**：开关打开时，检索结果含**其他项目的记忆 id**，这些 id 会被写进 `recent_injections` 与 `memory_feedback`；结算时 `trust.mjs` 的 `adjustTrust` 执行 `UPDATE memories SET trust_score…, last_touched_at… WHERE id = ?`，**没有任何 scope 校验**。⇒ **跑一次评测就会持久改写别的项目的记忆，且关回开关也撤不回。** `last_touched_at` 还喂给衰减与注入排序。

- [ ] **Step 1: 写失败的测试**

```js
// WHY: 这个开关的定位是"只读降级"。它一旦留下写痕，评测就会污染真实记忆库，
// 而且是不可逆的 —— 关回开关不会把 trust_score 和 last_touched_at 改回来。
// 这条测试是"只读"这个定位的唯一强制点。
test('no feedback rows are written while the switch is on', async () => {
  const db = seed();
  await runSessionStart(db, configWith({ disable_scope_isolation: true }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_feedback').get().n, 0);
});

test('feedback rows are written as usual while the switch is off', async () => {
  const db = seed();
  await runSessionStart(db, configWith({ disable_scope_isolation: false }));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM recent_injections').get().n > 0);
});
```

⚠️ **第二条不能省** —— 没有它，一个把写入整个删掉的实现同样能过第一条。

- [ ] **Step 2: 跑它，确认失败**

Expected: 第一条 FAIL（`recent_injections` 有行），第二条 PASS。

- [ ] **Step 3: 在 session-start 里加守卫**

```js
    if (hookData.session_id && stableContext && !disableScopeIsolation) {
```

- [ ] **Step 4: 在 prompt-submit 里加守卫**

在 `if (hookData.session_id && rows.length) {` 之前算：

```js
    const disableScopeIsolation = config?.eval?.disable_scope_isolation === true;
```

（`config` 在该 handler 内已有；若不在作用域，按 Task 4 同样的方式上移 `loadConfig()`，并在提交信息里写明。）

然后：

```js
    if (hookData.session_id && rows.length && !disableScopeIsolation) {
```

⚠️ **`memory_feedback` 的 INSERT 就在这个 `if` 块内**，一并被挡住 —— 确认它确实在块内再改，不要挡漏。
⚠️ **不要去改 `trust.mjs`** —— 那是产品行为的改动，不在本开关范围内。这里是从源头掐断。

- [ ] **Step 5: 跑测试，确认通过**

Expected: 两条都 pass。

- [ ] **Step 6: 故意改坏，确认红在正确的地方**

把 session-start 的守卫改成 `&& disableScopeIsolation`（**反向**），重跑。
Expected: **两条都 FAIL** —— 第一条因为开着时写了，第二条因为关着时没写。**两条同时红，正是这对测试互为对照的证据。** 改回去。

- [ ] **Step 7: 提交**

```bash
git add scripts/handlers/session-start.mjs scripts/handlers/prompt-submit.mjs tests/integration/v014-scope-isolation-injection.test.mjs
git commit -m "fix(eval-switch): suppress feedback writes while scope isolation is disabled"
```

---

### Task 6: 文档同步（**独立提交，不含代码**）

**Files:**
- Modify: `docs/ccmem-v0.14-spec.md`（锚点：`这是 W2 的一部分真实工作量`）

- [ ] **Step 1: 就地改掉那句话**

现文：`admin/diagnose.mjs` 目前**没有**任何"报告非默认配置"的机制，⇒ **这是 W2 的一部分真实工作量，不是免费的**。

改成：该能力**归 W0**（通用非默认配置上报）。本键一旦存在于 `DEFAULT_CONFIG`，W0 自动接住，**W2 零 diagnose 工作量**。⚠️ 但 W0 的**默认** `diagnose` 输出只有**计数**，键名只在 `--config` 下出现 ⇒ 按名字点出本开关的唯一信号是 `session_start` 的 stderr 警告。

- [ ] **Step 2: 验证旧措辞真的没了**

```bash
grep -n '这是 W2 的一部分真实工作量' docs/ccmem-v0.14-spec.md
```

Expected: **无输出**。
⚠️ 验的是"旧措辞被就地改掉"，**不是"新说法被追加在别处"** —— 本仓库在"只在新章节宣布撤回"上栽过三次。

- [ ] **Step 3: 提交**

```bash
git add docs/ccmem-v0.14-spec.md
git commit -m "docs(spec): W2 no longer owns diagnose reporting — W0 does"
```

---

### Task 7: 🔴 全量套件 + 批次窗口记录 + 交接闸门（**不产生功能代码**）

- [ ] **Step 1: 记下开始时刻**

```bash
date '+%Y-%m-%d %H:%M:%S %z'
```

- [ ] **Step 2: 跑全量套件**

```bash
npm test
```

- [ ] **Step 3: 记下结束时刻，并当场写进批次表**

把起止时刻写进 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md` 的批次窗口表。
🔴 **当场记，不要事后回忆** —— 边界差 6 秒就能把 5.1% 读成 9.2%。
📌 如果测量窗口此时**已经关闭且读数已完成**，仍然记，并注明"窗口已闭，仅存档"。

- [ ] **Step 4: 确认全绿，且新测试真的跑了**

Expected: 0 失败、0 跳过。
🔴 **单独确认这三个新文件出现在输出里**：`v014-scope-isolation-defaults`、`v014-scope-isolation-retrieval`、`v014-scope-isolation-injection`。
本仓库出过"全绿但测的是别的 checkout" ⇒ **绿色本身不算证据，要看见文件名。**

- [ ] **Step 5: 走 verification-before-completion**

宣布做完之前，用 `superpowers:verification-before-completion`：每一条验收判据（spec §五 的 7 条）都要有一条**跑过的命令**和**看过的输出**撑着。

- [ ] **Step 6: 更新 handoff 并提交**

在 handoff 里记本轮：W2 已落地、覆盖 7 处接线 / 5 处谓词、feedback 抑制、以及 §3.1 那条**待重审项**（快照刷新、`S-SCOPE-03` 的 runner 补齐之后，覆盖面要按那时的事实重审一次）。

```bash
git add -A
git commit -m "docs(handoff): record the W2 landing"
```

---

## 明确不做（照抄 spec §八，免得实现者临场扩范围）

- **不动 `injection-cache.mjs` 生产者**，不新增 `'all'` 缓存键。
- **不写 `S-SCOPE-03` 的 runner**，不碰 paper 仓库，不刷 `reference/ccmem` 快照。
- **不在 `admin/diagnose.mjs` 写一行**（归 W0）。
- **不做每站点独立开关** —— 一个布尔覆盖全部，YAGNI。
- **不给 `adjustTrust` 加 scope 校验** —— Task 5 是从源头掐断。
- **不给 `list.mjs` / `retrieval-check.mjs` 加 stderr 警告** —— 它们同样会跨项目（spec §4.4 已记），但加警告不在本轮范围；**别当成 bug 重新发现一次**。
