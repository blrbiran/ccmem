# 抬高 `openai_timeout_ms`（800 → 1200）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `DEFAULT_CONFIG.embedding.openai_timeout_ms` 从 800 抬到 1200，止住 hook 侧 48.5% 的 embed 截尾，同时让 hook 自己产出 800–1200 区间的**无截断**延迟分布。

**Architecture:** 单点常数改动 + 一条编码"为什么"的预算不变式测试 + 一份**在改动之前就冻结提交**的测量预登记。抬超时这个动作本身就是那次测量：每一条从 `B-fail` 变成 `A` 的行都带着真实 `embedMs`，落在完全正确的负载上 —— 那正是探针（偏快 1.7×，见 handoff Ⅺ.5）拿不到的东西。

**Tech Stack:** Node.js（**必须 `/usr/local/bin/node` v24.13.0**，见 handoff Ⅳ.2/Ⅳ.20）、`node:test`、`node:sqlite`、OpenAI SDK。

## Global Constraints

- **不要 push。** 删分支/worktree 先问。**不要把 plist 或配置内容打印/落盘。**
- 跑单个测试文件必须两个变量齐全：`env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test <文件>`（Ⅳ.2）。**裸 `node` 是 nvm v22.13.1，能力不同，用了会得出错误结论。**
- 每个新测试必须**亲眼看着定向变异红**，且**红在被测断言自己命名的行为上**（Ⅴ）。崩溃红、"函数不存在"红都不算。
- **本计划改的是 `DEFAULT_CONFIG`（产品默认值），不是本机 `config.json`。** 已实测确认 `~/.claude/ccmem/config.json` 里 `openai_timeout_ms` 为 `undefined`，不覆盖默认值 ⇒ 改默认值即对本机生效。
- **hook 侧下次调用即生效**（每个 prompt 一个新进程）。**daemon 需要重启才会拿到新默认值**，但 daemon 的两个 embed 调用点（`embed-latency-probe.mjs:53`、`vec-backfill.mjs:74`）**都自己覆盖了 timeout**，所以本改动**不需要重启 daemon**，也不影响探针样本的同源性。

---

## 基线（W2 冻结快照，`08-05 22:21 → 08-09 16:2x`）

改动前必须先把这几个数固定下来，它们是后面唯一的对照：

| 量 | 值 |
|---|---|
| 截尾率 `B-fail / 真实尝试` | **66/136 = 48.5%**，Wilson95 **[40.3%, 56.9%]** |
| 剔除已知跑批窗口 | 59/125 = 47.2% |
| `ms_total` | p50 924 / p90 1024 / **p99 1945** / max **2280** |
| `B-fail` 余项（`ms_total − embedMs`） | p50 161 / p90 263 / **max 1476** |
| `A` 路径成功 `embedMs`（在 800 处截尾） | n=70, p50 673 / p90 800 / max 812 |
| `error: 'timeout'` 行数（全历史 3069 条） | **0** |

取数口径见 handoff **Ⅳ.23** 与 **Ⅺ.2**（`retrieval_path` 分类；`A` 里必须剔掉 `retrieval_embed_ms === 0` 的缓存命中）。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md` | **预登记**：成功判据、中止判据、n、分析口径。**必须先于常数改动提交。** | Create |
| `scripts/lib/hook-safety.mjs` | 新增导出 `LEXICAL_FALLBACK_RESERVE_MS`，让"超时之后还要跑回落"这件事有名字 | Modify（`HOOK_BUDGET_MS` 之后） |
| `tests/unit/v013-hook-timeout-budget.test.mjs` | 预算不变式的既有归属地，新增一条守住"超时 + 回落必须留在 harness 硬限内" | Modify（文件末尾追加） |
| `scripts/lib/config.mjs:18` | `DEFAULT_CONFIG.embedding.openai_timeout_ms` | Modify（800 → 1200） |
| `scripts/lib/embedding/openai.mjs:20` | 注释里写着已作废的 "800 实测到 1683ms" | Modify（更正） |
| `tests/integration/admin-diagnose-command.test.mjs:1121` | **唯一钉死默认值 800 的断言，改动后必红** | Modify |

⚠️ **不要动** `tests/unit/v013-backfill-timeout.test.mjs` —— 它第 35 行用的是**相对**比较（`backfillCfg... > DEFAULT_CONFIG...`），本改动下仍然成立；其余几处 `800` 都是显式传入的 fixture，不读默认值。

---

### Task 1：预登记测量协议（**必须在改常数之前单独提交**）

**Files:**
- Create: `docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md`

**Interfaces:**
- Produces: 后续分析唯一合法的判据来源。Task 4 只许照它读数，不许另立判据。

**为什么单独一个 task 且必须先提交：** handoff 反复栽在事后挪门柱上（Ⅴ"0 计数/异常数字先解释来源"、Ⅹ"前一版把 11/96 整个当成 pid=null 的频率"）。**预登记一旦和结果同轮提交，它就失去了全部约束力。**

- [ ] **Step 1: 写预登记文档**

把下面内容原样写入该文件：

```markdown
# 预登记：`openai_timeout_ms` 800 → 1200

> 本文件在常数改动**之前**提交。改动后**不得修改本文件**；
> 若判据需要修订，另开一份并说明理由，**不要就地改写**。

## 基线（W2 冻结快照，08-05 22:21 → 08-09 16:2x）
截尾率 66/136 = 48.5%，Wilson95 [40.3%, 56.9%]。

## 主要结局（止血）
**新窗口的截尾率 Wilson95 上界 < 40.3%**（即低于基线区间的下界）。
达成 ⇒ 判定"抬超时确实止住了血"；未达成 ⇒ 判定"效果不足以与基线区分"，**不许改读点估计**。

## 次要结局（取数，这才是本轮真正的产出）
新窗口 `A` 路径 `embedMs` 在 **800–1200 区间**的分布（此前完全不可观测）。
输出 n、min/p50/p90/max，以及 `P(800 < embedMs ≤ 1200)`。
⚠️ 1200 以上仍然截尾，**不许从这份分布外推 1200 以上的任何分位数**。

## 样本量（看数之前定死）
**n ≥ 150 次真实 embed 尝试**（按 W2 速率约 36/天 ⇒ 约 4–5 天）。
n < 150 时**只许报"数据不足"，不许读区间**。
若 n=150 时区间仍横跨 40.3%，**延长到 n ≥ 300 再读，不许在中途宣布结论**。

## 中止判据（任一命中即立刻回退，不等 n 攒够）
1. 出现**任何一条** `hook === 'prompt_submit'` 且 `error !== null` 的行
   （基线：全历史 3069 条全为 null；`Promise.race` 从未开火 —— 见 Ⅳ.24）。
2. 新窗口 `ms_total` 的 **p99 > 3000ms**（基线 1945ms；harness 硬限 5000ms）。
3. 出现任何一次 hook 因失败返回空 `additionalContext`。

> 🔴 **上面三条是预登记原文的忠实抄录，刻意不改。但判据 3 已于 2026-08-10 裁决为"不可操作化、未执行"** ——
> 理由与全文见 Task 5 Step 3 的说明、`…-prereg-addendum.md` 的"补遗 2 → 裁决"、handoff **Ⅺ.14**。
> **本轮实际生效的只有 1 与 2。** 读到这里就停下的人不要以为判据 3 还在跑。

## 分析口径（不许临场发明）
- 分类用 `retrieval_path`；`真实尝试 = (A − 缓存命中) + B-fail`，缓存命中判据 `retrieval_embed_ms === 0`（Ⅳ.23）。
- **分析前先把 `metrics.jsonl` 复制成冻结快照再算**（Finding 15 设计文档 line 15-17 的教训：活文件会在分析过程中被追加，导致差一不一致）。
- **剔除本机跑批窗口**，并在跑批发生时**当场记下起止时间**，不要事后回忆（Ⅰ：边界差 6 秒就把 5.1% 读成 9.2%）。
- 区间一律用 Wilson 95%。

## 预登记的失败可能
若主要结局未达成而次要结局显示 800–1200 区间里几乎没有质量，
**正确结论是"embed 延迟的质量在 1200 以上，抬到 1200 太保守"**，
而**不是**"抬超时没用"。这两者的区分依赖次要结局，所以次要结局必须照样算出来。
```

- [ ] **Step 2: 提交（此时尚未改任何代码）**

```bash
git add docs/superpowers/plans/2026-08-10-raise-openai-timeout-prereg.md docs/superpowers/plans/2026-08-10-raise-openai-timeout.md
git commit -m "docs(plan): pre-register the timeout-raise measurement before touching the constant"
```

---

### Task 2：把"超时 + 回落必须留在 harness 硬限内"变成一条测试

**Files:**
- Modify: `scripts/lib/hook-safety.mjs`（在 `PROMPT_SUBMIT_BUDGET_MS` 导出之后）
- Modify: `tests/unit/v013-hook-timeout-budget.test.mjs`（文件末尾追加）

**Interfaces:**
- Consumes: `HOOK_BUDGET_MS`、`DEFAULT_CONFIG`
- Produces: `LEXICAL_FALLBACK_RESERVE_MS: number`（从 `scripts/lib/hook-safety.mjs` 导出）

**为什么是对着 harness 的 5000 断言，而不是内部预算的 2000：** 实测全历史 3069 条 `prompt_submit` 的 `error` 全为 `null` —— 那个 2000ms 的 `Promise.race` **一次都没开过火**，因为它只框得住异步工作而 hook 大半是同步的（`hook-safety.mjs:10-17` 自己写着）。**把从不生效的软闸当硬不变式，会写出一条测的不是真实约束的测试**（Rule 9）。

- [ ] **Step 1: 在 `hook-safety.mjs` 里加常数**

在 `export const PROMPT_SUBMIT_BUDGET_MS = HOOK_BUDGET_MS.prompt_submit;` 之后插入：

```javascript
/**
 * How much wall clock must still be available AFTER the embed call gives up.
 * A timed-out embed is not the end of the hook: prompt_submit then runs the
 * whole lexical fallback and writes its context file, and that work is
 * synchronous, so no budget can interrupt it — only the harness kill can.
 *
 * 1500 is the measured max of (ms_total - embedMs) across the B-fail rows of
 * the 2026-08-05..08-09 window (observed max 1476ms, p50 161, p90 263).
 * It is deliberately the MAX and not a quantile: this reserve exists to keep
 * the worst case inside the harness timeout, and the harness kill is not a
 * budget that degrades gracefully — it takes stdout and the metrics row with it.
 */
export const LEXICAL_FALLBACK_RESERVE_MS = 1500;
```

- [ ] **Step 2: 写失败测试**

在 `tests/unit/v013-hook-timeout-budget.test.mjs` 末尾追加（`DEFAULT_CONFIG` 需要新增 import）：

```javascript
import { DEFAULT_CONFIG } from '../../scripts/lib/config.mjs';
import { LEXICAL_FALLBACK_RESERVE_MS } from '../../scripts/lib/hook-safety.mjs';

/**
 * Raising openai_timeout_ms is safe right up until the point where a timed-out
 * embed plus its lexical fallback can outlive the harness's own kill. Past that
 * line the failure mode changes character: instead of degrading to lexical
 * retrieval, the hook is killed before it can write stdout or its metrics row,
 * so the incident is also invisible afterwards. The internal 2000ms budget does
 * NOT protect this — it has never fired in 3069 prompt_submit rows because it
 * cannot interrupt synchronous work. The harness timeout is the only real limit.
 */
test('a timed-out embed plus its lexical fallback still fits inside the harness kill', () => {
  const hooksJson = JSON.parse(readFileSync(path.join(repoRoot, 'hooks/hooks.json'), 'utf8'));
  const harnessMs = findHookTimeoutMs(hooksJson, 'UserPromptSubmit');
  assert.ok(harnessMs > 0, 'UserPromptSubmit must declare a harness timeout');

  const worstCase = DEFAULT_CONFIG.embedding.openai_timeout_ms + LEXICAL_FALLBACK_RESERVE_MS;
  assert.ok(
    worstCase < harnessMs,
    `an embed that times out at ${DEFAULT_CONFIG.embedding.openai_timeout_ms}ms still owes the `
    + `lexical fallback up to ${LEXICAL_FALLBACK_RESERVE_MS}ms, so the worst case is ${worstCase}ms, `
    + `which must stay under the ${harnessMs}ms harness kill`
  );
});
```

⚠️ **`findHookTimeoutMs` 不是新函数** —— 该文件已经在读 `hooks/hooks.json`（顶部已 import `readFileSync` / `path` / `repoRoot`）。**先读该文件现有的解析辅助函数并复用它**；若现有代码是内联解析的，就把那段内联逻辑照原样用，**不要新造一个同名函数**（Rule 8：先读再写）。

- [ ] **Step 3: 定向变异 —— 看着它红，且红在自己命名的行为上**

临时把 `scripts/lib/config.mjs:18` 改成 `openai_timeout_ms: 3600`，然后：

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v013-hook-timeout-budget.test.mjs
```

Expected: FAIL，消息形如 `...worst case is 5100ms, which must stay under the 5000ms harness kill`。
**必须核对红的是这句话，不是崩溃红、不是 import 失败。** 看到之后**把 3600 改回 800**（此时还没到 Task 3）。

- [ ] **Step 4: 确认改回 800 后为绿**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/unit/v013-hook-timeout-budget.test.mjs
```

Expected: PASS（800 + 1500 = 2300 < 5000）。

- [ ] **Step 5: 提交**

```bash
git add scripts/lib/hook-safety.mjs tests/unit/v013-hook-timeout-budget.test.mjs
git commit -m "test(hook-budget): pin the embed timeout against the harness kill, not the budget that never fires"
```

---

### Task 3：抬常数，并修好被它带红的那一条与那句过时注释

**Files:**
- Modify: `scripts/lib/config.mjs:18`
- Modify: `scripts/lib/embedding/openai.mjs:20`
- Modify: `tests/integration/admin-diagnose-command.test.mjs:1121`

- [ ] **Step 1: 先确认那条钉死断言此刻是绿的（改之前的对照）**

```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" /usr/local/bin/node --test tests/integration/admin-diagnose-command.test.mjs
```

Expected: PASS。**这是正面对照** —— 证明下一步的红确实由常数改动引起。

- [ ] **Step 2: 改常数**

`scripts/lib/config.mjs:18`：

```javascript
    openai_timeout_ms: 1200,
```

- [ ] **Step 3: 跑那个集成测试，看着它红**

Expected: FAIL 在 `assert.match(raw, /"openai_timeout_ms": 800/)`。**这条红是预期的，它证明该断言确实在守着默认值。**

- [ ] **Step 4: 更新该断言**

`tests/integration/admin-diagnose-command.test.mjs:1121`：

```javascript
  assert.match(raw, /"openai_timeout_ms": 1200/);
```

- [ ] **Step 5: 更正 `openai.mjs:20` 那句已作废的注释**

原文写着 `openai_timeout_ms: 800 measured 1683ms of wall clock on the ...`。该句描述的是 `maxRetries: 0` 落地**之前**的状态（Finding 15 设计文档 §附带确认 1 已指出），且 800 也不再是默认值。改为：

```javascript
    // of itself. Historical note: before maxRetries was pinned to 0 (2026-08-02),
    // a nominal 800ms cap was measured at 1683ms of wall clock — one timeout plus
    // one retry. The default moved to 1200ms on 2026-08-10; see
    // docs/superpowers/plans/2026-08-10-raise-openai-timeout.md for the evidence.
```

- [ ] **Step 6: 跑全量套件**

```bash
npm test 2>&1 | tail -20
```

Expected: 全绿。⚠️ **如实报数**：写下 `pass` / `fail` 的实际数字。若有红，**先逐条分类失败模式再归并**（Ⅹ 的教训），并对照 handoff Ⅹ 的已知抖动谱 —— 但**"它在清单上"不是解释**（Ⅲ.3）。

- [ ] **Step 7: 提交**

```bash
git add scripts/lib/config.mjs scripts/lib/embedding/openai.mjs tests/integration/admin-diagnose-command.test.mjs
git commit -m "feat(embedding): raise openai_timeout_ms from 800 to 1200"
```

---

### Task 4：确认新值真的到了 hook 路径上（不要信改完就算数）

**Files:** 无（只读验证）

**为什么需要这一步：** handoff Ⅲ.6 记着一次"配置加了却完全不生效，且静默"。**改完必须看到活的证据。**

- [ ] **Step 1: 记下当前 `metrics.jsonl` 的行数作为分界点**

```bash
wc -l ~/.claude/ccmem/metrics.jsonl
```

写进本计划的执行记录里。**它是"新窗口"的起点。**

- [ ] **Step 2: 正常用几次 Claude Code（不需要构造，日常使用即可），然后确认新行的形态**

```bash
/usr/local/bin/node -e '
const fs=require("fs"),os=require("os");
const R=fs.readFileSync(os.homedir()+"/.claude/ccmem/metrics.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse)
 .filter(r=>r.hook==="prompt_submit").slice(-20);
for(const r of R) console.log(new Date(r.ts).toLocaleString("sv"), r.retrieval_path, "embedMs="+r.retrieval_embed_ms, "err="+r.error);
'
```

**判据（两条都要满足才算通）：**
- 出现**至少一条** `retrieval_path === "A"` 且 `retrieval_embed_ms > 812` 的行 ⇒ **新上限确实生效了**（812 是旧窗口 `A` 路径的实测 max，旧值下不可能超过它）。
- 出现的 `B-fail` 行其 `retrieval_embed_ms` 落在 **1200 附近**而不是 800 附近。

⚠️ **不要从缺失下结论**（Ⅴ）：若一段时间内没有 `A` 超过 812 的行，那可能只是延迟本来就没那么高，**不等于改动没生效**。此时改用第二条判据（`B-fail` 的截尾点）来判。若连 `B-fail` 都还是 800 附近，**才是真的没生效** —— 回去查 Ⅲ.6（配置层级）与 Ⅳ.4。

- [ ] **Step 3: 把分界点与实测样本记进 handoff Ⅺ**，并**不提交**任何结论性的截尾率数字（n 还不够，预登记说了 n<150 只许报"数据不足"）。

---

### Task 5：（**约 4–5 天后**，n ≥ 150 时才执行）按预登记读数

- [ ] **Step 1: 把 `metrics.jsonl` 复制成冻结快照再分析**（活文件会在分析过程中被追加）
- [ ] **Step 2: 严格照 `2026-08-10-raise-openai-timeout-prereg.md` 的口径算**，不新增判据
- [ ] **Step 3: 每天至少看一次中止判据 1 和 2**，不要等到第 5 天才发现要回退

  ⚠️ **本轮实际生效的中止判据只有 1 与 2。判据 3 已于 2026-08-10 裁决为"不可操作化、未执行"** ——
  它钉的 `additional_context_empty` 测的是"走没走文件通道"而不是"上下文是否为空"，照字面读 100% 误命中，
  且三个候选代理在健康基线上以 6.9%–100% 的频率恒常开火，换不出能用的。
  裁决全文见 `2026-08-10-raise-openai-timeout-prereg-addendum.md` 的"补遗 2 → 裁决"与 handoff **Ⅺ.14**。
  **读数报告必须显式写出"判据 3 从未执行"，不得默认它通过了。预登记本体零改动。**
  ⚠️ 判据 2 在 `n < 150` 时只作**离群监视**（看 max），**不算 p99**。
- [ ] **Step 4: 把结果写进 handoff Ⅺ**，成功与否都要写；**若主要结局未达成，按预登记的"失败可能"那段判断是"没用"还是"太保守"**

**回退（任一中止判据命中时）：** `scripts/lib/config.mjs:18` 改回 `800`，撤销 `admin-diagnose-command.test.mjs:1121` 的断言，跑一次全量，提交。**Task 2 的不变式测试保留** —— 它与本次取值无关，是长期护栏。

---

## Self-Review

**1. Spec coverage** —— 你（人类）批准的三件事：抬 800→1200（Task 3）、按 Ⅷ 先出计划（本文档）、预先登记成功/中止判据与 n（Task 1）。**三项都有归属 task。**

**2. Placeholder scan** —— 无 TBD / "适当处理错误" / "类似 Task N"。唯一一处非字面量是 Task 2 的 `findHookTimeoutMs`，**已显式要求先读现有文件复用而不是新造**，并说明了理由。

**3. Type consistency** —— `LEXICAL_FALLBACK_RESERVE_MS` 在 Task 2 Step 1 定义、Step 2 使用，名字一致；`DEFAULT_CONFIG.embedding.openai_timeout_ms` 的路径与 `tests/unit/v013-backfill-timeout.test.mjs:35` 现有用法一致。

## 已知不做的事

- **不抬内部预算 2000ms**（harness 给 5000，空着 3000）。那是独立的设计裁决，捆进来会让本次改动不可归因（Rule 3 surgical）。
- **不动探针**（样本同源约束仍在；探针的修法是改成冷路径取样，属 B 线）。
- **不解决冷启动 ~220ms**（B 线，攻因；本计划是止血 + 取数）。

---

## 🔴 本机跑批窗口记录（Task 5 读数时必须剔除）

预登记的分析口径要求"**剔除本机跑批窗口**，并在跑批发生时**当场记下起止时间**，不要事后回忆"。
这里是被 git 跟踪的那一份 —— `.superpowers/sdd/` 里的 ledger 是 git-ignored 的，`git clean -fdx` 会抹掉它。

**2026-08-11**（执行 W4 daemon 成本计量 + A1/A2 测试路径修复，全部为 `npm test` 全量跑）：

| 起 | 止 | 位置 | 结果 |
|---|---|---|---|
| 21:09:58 | 21:10:15 | worktree `w4-daemon-cost` | 547 pass |
| 21:31:32 | 21:31:49 | worktree `w4-daemon-cost` | 566 pass |
| 21:43:23 | 21:43:40 | worktree `w4-daemon-cost` | 572 pass |
| 22:03:49 | 22:04:06 | worktree `w4-daemon-cost` | 582 pass |
| 22:22:40 | 22:22:57 | worktree `w4-daemon-cost` | 582 pass |
| 22:24:59 | 22:25:15 | `main`（合并后验证） | 582 pass |

🔴 **生效的剔除口径（补遗 3，2026-08-12 裁决）—— 窄义**：
**只剔"全量套件运行期 + 前后各至少 60s 余量"**，即上表六行各自外扩 ≥60s。
留余量的理由不变（Ⅰ 记过：边界差 6 秒就把 5.1% 读成 9.2%），**变的是不再按"会话是否活跃"整段剔。**

> ~~⚠️ **不要只剔这六个 17 秒的窗口。** 按 handoff Ⅰ 的规则，窗口按"**会话是否活跃**"划、~~
> ~~不按"批次是否在跑"划，批次边界一律留至少 60s 收尾余量。~~
> ~~**本会话 2026-08-11 全天活跃，按 Ⅰ 的口径整段属"曝露不明"。**~~
>
> ⬆️ **以上三行已于 2026-08-12 随补遗 3 作废，保留原文以便看见判断是怎么变的。**
> 作废理由：**Ⅰ 的"整天曝露不明"是给探针定的**（探针 5 分钟节流，"会话活跃"对它有区分力）；
> 而 `prompt_submit` **按构造每 prompt 一行 ⇒ 每一行都产生于活跃会话**，整天义对它零区分力，
> **照做等于把全部数据剔光**。另：基线 `59/125` 本身就是按窄义算的（handoff Ⅺ.3，只剔了 11 行），
> 新窗口按窄义才与它同构。全文见 `…-prereg-addendum.md` 补遗 3 与 handoff ⅩⅢ.1。
> ⚠️ **`.superpowers/sdd/2026-08-10-raise-openai-timeout/progress.md` 末尾那份同源表仍带作废前的措辞**
> （它是 git-ignored 的历史 ledger，刻意不回改）—— **以本节为准。**

📌 W4 的成本行写在独立的 `daemon-cost.jsonl`，**不进 `metrics.jsonl`** ——
本轮改动本身不往窗口里加行，污染只来自跑批的机器负载。

### ✅ 窗口全程的批次覆盖完整性（2026-08-12 核查）

上表只有 08-11 的六行，而窗口从 **08-10 01:53:30** 就开了。**核查结论：这不是记录缺失，是那两段真的没跑批。**
证据一律取自**当时留下的记录**（预登记禁止事后回忆），逐条如下：

| 时段 | 结论 | 同期证据 |
|---|---|---|
| 08-10 01:53:30（窗口开）→ 08-10 全天 | **无套件** | 合并后那次 `547/547` 跑在**窗口起点之前**（ledger 里 "Suite re-run ON THE MERGE RESULT" 写在 "MEASUREMENT WINDOW START" 之前，起点正是据此定的）；Task 4 记为 "**no suite run**"；当天两个开放问题记为 "read-only, nothing fixed, **no tests run**" |
| 08-10 09:01 → 08-11 20:02 | **无开发会话** | 该区间 `git log --all` **零提交**（上一条 `c0cf156` 08-10 09:01:23，下一条 `a9e0cdb` 08-11 20:02:11） |
| 08-11 20:02 → 22:25 | **六次，已记录** | 即上表；首次跑批 21:09:58 与其后 21:10:42 的提交吻合 |
| 08-12 00:18–00:28、00:44– | **无套件**（只读分析） | 见下节「每日巡检记录」两次的补充记录 |

⚠️ **这条结论的效力边界，照 Ⅺ.14 的写法明说**：第二行是**从"零提交"推出"没跑批"**，
而"跑了套件但没提交"在原理上可能发生。**它是同期证据里最强的一条，不是直接观测。**
若读数时对某一小段存疑，**正确处置是把该段一并剔除（保守方向），不是回忆当时干了什么。**

---

## 🔴 每日巡检记录（中止判据 1 与 2）

预登记要求窗口期内持续巡检中止判据。`.superpowers/` 是 git-ignored，所以记在这里。

**巡检的边界（每次都照这个做，别扩）**：只算判据 1 与 2，以及解封闸门 `n`。
**刻意不算截尾率、不算 Wilson 区间** —— 那是 Task 5，被 `n ≥ 150` 挡着。
判据 3 **不可操作化、未执行**（人类裁决 2026-08-10，见 `…-prereg-addendum.md` 补遗 2），
**每次巡检都要照写一遍，不得默认它通过**。

| 巡检时刻 | 窗口已开 | 判据 1（`prompt_submit` 且 `error !== null`） | 判据 2（`ms_total`） | 判据 3 | `n`（原始） |
|---|---|---|---|---|---|
| 2026-08-11 23:36 | 45.7 h | **0 命中 ✅** | **0 条 >3000ms**；max **2864ms**、>2000ms 共 3 条 | 未执行 | 114 |
| 2026-08-12 00:45 | 46.9 h | **0 命中 ✅** | **0 条 >3000ms**；max **2864ms**、>2000ms 共 3 条（**与上一次同 3 条，无新增**） | 未执行 | 137 |

**2026-08-11 23:36 那次的补充记录：**

- 文件完整性：`metrics.jsonl` 6809 行、0 解析失败、`ts` 严格单调、**无 `.1` 轮转**。
- ⚠️ 判据 2 的 max 2864ms 距硬判据 3000ms 只差 5%（基线 p99 为 1945ms）。**这不是命中**，
  但**后续每次巡检都要看它有没有成群** —— 单点离群与分布右移是两回事。
- 方法：读的是**活文件**，不是冻结快照。对判据 1/2 这种布尔/离群判定可以接受；
  **Task 5 读数仍必须先复制成冻结快照**（预登记的分析口径，不得放宽）。
- 本次会话（08-11 深夜）**未跑任何全量套件**，只做只读分析。但机器负载仍属会话活跃。

**2026-08-12 00:45 那次的补充记录：**

- ⚠️ **距上一次巡检只有 1.15 小时，不是一个独立的"每日"数据点。** 上一次记在 08-11 23:36，
  本次是新会话开工时按纪律先做的。**08-12 当天应当在稍晚再做一次真正跨日的巡检。**
- **判据 2 的成群检查（本轮巡检的重点）**：>2000ms 的 3 条**逐条与上次相同** ——
  `08-11 09:26:59 / 2112ms`、`08-11 21:16:03 / 2525ms（stop）`、`08-11 22:25:34 / 2864ms`。
  期间文件新增 68 行、窗口内新增 23 次真实尝试，**0 条新的 >2000ms**。
  ⇒ 目前证据支持"2864ms 是单点离群"，**不支持分布右移**。但样本增量小，**结论不牢，下次继续看**。
  📌 口径注记：>2000ms 与 max 是**跨全部 hook 类型**统计的（3 条里有 1 条是 `stop`），
  与上一次巡检的算法一致 —— 预登记判据 2 只写 `ms_total`，未限定 hook。
- 文件完整性：`metrics.jsonl` 6877 行、0 解析失败、`ts` 严格单调 0 处逆序、**无 `.1` 轮转**。
- 窗口内 381 行，其中 `prompt_submit` 186 行。
- 方法同上次：读**活文件**、`ts >= 窗口起点` 过滤，**未算截尾率、未算 Wilson 区间、未打印 `n` 的分项**。
- 本次会话**未跑任何全量套件**（只读分析），因此**未产生新的需剔除的跑批窗口**。
- 🔴 **`n`（原始）已到 137，逼近 150 闸门。** 但闸门要求的是**剔除后**的 `n`（补遗 3），
  且读数必须先复制**冻结快照**。**在剔除后 `n ≥ 150` 之前，仍然只许报"数据不足"。**

### 🔴 巡检撞出的口径问题：`n` 到底数剔除前还是剔除后（✅ **已于 2026-08-12 裁决，见下方"裁决"**）

原始 `n = 114`。按天拆：

```
2026-08-10   n = 48    02:19:44 → 23:42:04
2026-08-11   n = 66    00:12:21 → 23:36:33
合计         n = 114
```

08-11 那 66 条几乎全部落在本会话跑 W4 的那一整天里，而本文档上一节当时写着
**「本会话 2026-08-11 全天活跃，按 Ⅰ 的口径整段属"曝露不明"」**
（📌 **那句已随本节的裁决作废，上一节现已改为窄义并把原文划掉** —— 此处引用的是发现问题时的原状）。

**问题**：预登记把 **`n ≥ 150 次真实 embed 尝试`** 写在「样本量」一节，
把 **「剔除本机跑批窗口」** 写在「分析口径」一节，**两者没有说清 `n` 是剔除前数还是剔除后数**。

而且「剔除跑批窗口」本身还有**窄义**（只剔全量套件运行期 + 60s 余量）与**整天义**
（Ⅰ 为探针定的"会话活跃即曝露不明"）两种读法，两者差别很大。

### ✅ 裁决（2026-08-12，人类采纳）

全文与理由见 **`…-prereg-addendum.md` 补遗 3**（**原预登记仍是零改动**）。结论两句：

> **① `n` 在剔除后的集合上数**（`n` 与截尾率必须同集合）。
> **② 「剔除跑批窗口」取窄义**：全量套件运行期 + 前后各至少 60s 余量；
> **不适用 Ⅰ 为探针定的"整天曝露不明"规则。**

关键理由：`prompt_submit` **按构造每个 prompt 一行 ⇒ 每一行都产生于活跃会话**，
整天义对它零区分力、照做等于剔光；而基线 `59/125` 本身就是按窄义算的（Ⅺ.3，只剔了 11 行）。

🔴 **更正一条本文档 2026-08-11 写错的数**：那一版写「按剔除后读手上最多 48」——
**那是按整天义算的，已随裁决作废**。按生效的窄义，剔除量只是那六个 17 秒窗口（+60s 余量）那一小撮，
**远不止 48**。确切值待读数时一次性算。

📌 **记录纪律（裁决的一部分）**：上表的 `n` **一律按"原始（未剔除）"记并显式标注**，
**不要在巡检阶段边记边剔** —— 窄义剔除依赖精确的批次起止时间（就在本文档上一节那张表里），
放到读数时做一次，免得每天的数依赖当天的记忆。
