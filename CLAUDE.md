# CLAUDE.md

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
**Per-task: 330,000 tokens. Per-session: 450,000 tokens.**

⚠️ *** **单位是【上下文窗口占用】，不是【累计消耗 token】。** *** 这两个量差好几个数量级，
在姊妹仓库里被误读过（按"累计消耗"读，因而错误地宣布会话超支）。
**累计花费是另一个数** —— 只抄工具报出来的，拿不到就说拿不到。

If approaching budget, summarize and start fresh. **Surface the breach. Do not silently overrun.**

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

# Rule 13 — 用户数据（**本仓库独有，最高优先级**）

⚠️ *** **ccmem 是这套工具链里唯一会写【用户全局数据】的组件。** *** 上面 12 条通用规则
一条都没提到这件事，而它才是本仓库最大的风险面。

**数据在哪**（都在仓库之外，`git checkout` 救不回来）：

| 路径 | 是什么 |
|---|---|
| `~/.claude/ccmem/global.db` | **全部记忆**。实测量级：接近一万条、150MB+ |
| `~/.claude/ccmem/*.db-wal` / `*.db-shm` | SQLite 预写日志 —— **删了它就是删数据** |
| `~/.claude/ccmem/config.json` | 运行配置 |
| `~/.claude/ccmem/*.jsonl` | 指标与探针输出 |

## 铁律

1. *** **任何会写 `~/.claude/ccmem/**` 的命令，跑之前先备份。** ***
   `global.db` 旁边已有若干 `.bak.<epoch>` —— **沿用这个命名，不要发明新的**。
2. *** **不许在开发中连生产库做写操作。** *** 要试 schema 迁移、要跑 daemon 任务、要试 `forget`／`prune`，
   一律**先把 db 拷到临时路径**，对副本跑。
3. *** **schema 迁移不可逆。** *** 迁移代码上生产库跑之前，必须：
   (a) 备份 (b) 在副本上跑通 (c) **写明怎么回退**。写不出回退步骤 ⇒ **不要跑，找人**。
4. **daemon 是后台常驻的** —— 改了 `scripts/daemon/**` 之后，**旧进程还在跑旧代码**。
   验证前先 `ccmem admin daemon status`，必要时 restart，**否则你验的是上一版**。
5. **hooks 会在每次会话／每次 prompt 上跑**（`SessionStart` / `UserPromptSubmit` / `Stop`，超时 2–5s）。
   改 `hooks/**` 或 `scripts/handlers/**` 属于**影响每一次交互**的改动：
   **一个未捕获的异常或一次超时，会影响用户的每一个会话，而不只是本仓库。**
6. **删记忆一律走 `forget` / 隔离流程，不许直接 `DELETE`**。
   记忆有 `trust_score`、`decay_status`、`quarantined_at` 等状态机，绕过它会留下不一致的行。

## 证据纪律（与姊妹仓库一致）

- *** **绝不过滤验证性跑**（管道会吞掉退出码）；重定向到文件再整份读回。 ***
- *** **成本、耗时、条数只报工具给出的数。拿不到就说拿不到，不许自估。** ***
- **push 需人单独授权。**
