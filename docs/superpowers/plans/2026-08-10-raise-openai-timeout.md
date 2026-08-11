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
