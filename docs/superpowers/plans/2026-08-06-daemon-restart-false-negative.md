# bug-063 — `admin daemon restart` False Negative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `ccmem admin daemon restart` that succeeded must stop printing `daemon restart failed`, and one that genuinely failed must say which phase failed and why.

**Architecture:** Three independent defects stacked into one symptom, fixed in dependency order. (2) `restartDaemon`'s object spread overwrites the status it just set, so every restart failure is mislabelled as its stop/start sub-status — fix the spread order. (3) The CLI has no branch for the statuses that then become reachable — add them. (1) The start wait is 2000ms, shorter than an observed cold start — give `startDaemon` its own `START_WAIT_TIMEOUT_MS = 5000` while leaving the stop wait at 2000. Order matters: fixing (2) is what first lets `restart_failed` reach the CLI, which is what (3) handles.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, better-sqlite3, launchd (faked in tests).

## Global Constraints

- **Human ruling, 2026-08-06: the start wait rises to 5000ms; the stop wait stays 2000ms.** Do not make it configurable — a new config key is itself a new surface that can diverge from the code (standing ruling, `daemon.mjs:696`).
- **No test may touch the real launchd job or the real plist.** `tests/integration/plist-drift.test.mjs` already sets `CCMEM_LAUNCHCTL_BIN` / `CCMEM_LAUNCHCTL_LOG` / `CCMEM_LAUNCHAGENT_DIR` at **module scope** for this reason (a past test hijacked the developer's real daemon registration). Add tests to that file so isolation is inherited, never re-established per-test.
- **Run a single test file with:** `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs` — `npm test -- <file>` does **not** isolate, and unsetting only `CCMEM_CONFIG_PATH` lets config fall back to the real `config.json` (which holds an API key).
- **Every regression test must be watched red before it is made green, and red for the right reason.** A crash red does not count; "function not defined" does not count. The red must land on the assertion that names the behavior.
- **Suite baseline: 535 pass / 0 fail.** Three files are known intermittent flakes — `stop-daemon-flow.test.mjs`, `admin-cron-command.test.mjs`, `admin-daemon-command.test.mjs`. Confirm the filename before calling any red a regression.
- **Never print or persist plist contents** — `renderPlist()` output can contain `ANTHROPIC_*` values from `DAEMON_ENV_PASSTHROUGH`.
- Expected final count: **539 pass / 0 fail** (four new tests — three planned, plus the timeout-branch test added to Task 3 by human ruling on 2026-08-06).

## File Structure

| File | Responsibility in this change |
|---|---|
| `scripts/lib/admin/daemon.mjs` | New `START_WAIT_TIMEOUT_MS` constant; three `waitFor` call sites inside `startDaemon` use it; two `restartDaemon` returns get their spread order corrected. |
| `scripts/cli.mjs` | New `else if` branches for `restart_failed` and the two timeout statuses, before the generic fallback. |
| `tests/integration/plist-drift.test.mjs` | Two new opt-in seams in the module-scope fake `launchctl` (`CCMEM_FAKE_BOOTOUT_FAIL`, `CCMEM_FAKE_START_NEVER`) plus five new tests. |

---

### Task 1: `restartDaemon` must report its own failure status

**Files:**
- Modify: `tests/integration/plist-drift.test.mjs` (fake-launchctl script block, ~`:202-206`; new test appended after T9 at `:442`)
- Modify: `scripts/lib/admin/daemon.mjs:735` and `:742`

**Interfaces:**
- Consumes: `cmdAdminDaemon(db, { verb })` — the only export that reaches `restartDaemon`; `restartDaemon` itself is **not exported**, so drive it through this.
- Produces: a `restart_failed` result object with `{ status: 'restart_failed', phase: 'stop' | 'start', previous_pid, reason?, plist_rewrite? }` that survives to the caller. Task 2 renders exactly these fields.

- [ ] **Step 1: Add the bootout-failure seam to the fake launchctl**

In the `writeFileSync(fakeLaunchctlPath, [...])` array, change the `bootout)` case to add one opt-in line as its first statement. This mirrors the existing `CCMEM_FAKE_BOOTSTRAP_SNAPSHOT` opt-in — default behavior is unchanged for every existing test.

```javascript
  '  bootout)',
  // bug-063 缺陷 2 需要一次"stop 阶段失败"的重启。默认不触发，只有显式设了这个
  // 变量的测试才会走到 —— 与 CCMEM_FAKE_BOOTSTRAP_SNAPSHOT 同一种 opt-in。
  '    if [ -n "$CCMEM_FAKE_BOOTOUT_FAIL" ]; then printf %s\\n "bootout refused by the fake" >&2; exit 1; fi',
  '    rm -f "$STATE"',
  '    sqlite3 "$DB" "DELETE FROM daemon_lock;" >/dev/null 2>&1',
  '    ;;',
```

- [ ] **Step 2: Write the failing test**

Append after T9 (`:442`):

```javascript
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
```

- [ ] **Step 3: Run it and confirm the red is the right red**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: T14 fails on the **first** assertion with `Expected values to be strictly equal: 'stop_failed' !== 'restart_failed'`.

**If it fails any other way, stop and report.** A crash, a `reason` of `undefined`, or a failure on the `phase` assertion instead means the seam is wired wrong, not that the defect is proven.

- [ ] **Step 4: Fix the spread order at both sites**

`scripts/lib/admin/daemon.mjs:735` — spread first, own fields last (matching the already-correct sibling at `:745`):

```javascript
    return { ...stopped, status: 'restart_failed', phase: 'stop', previous_pid: current.pid ?? null };
```

`scripts/lib/admin/daemon.mjs:742`:

```javascript
    return { ...started, status: 'restart_failed', phase: 'start', previous_pid: current.pid ?? null, plist_rewrite: rewrite };
```

- [ ] **Step 5: Confirm green, and confirm the control test stayed green**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: T14 PASS **and** T9 (`a blocked gate still lets the restart finish`, asserts `status === 'restarted'`) still PASS. T9 is the control: it proves the spread reorder did not break the success path, where `...started` legitimately supplies `pid`.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/plist-drift.test.mjs scripts/lib/admin/daemon.mjs
git commit -m "fix(daemon): stop restartDaemon from overwriting its own failure status

bug-063 defect 2. The spread came last at both restart_failed returns, so
stopDaemon's 'stop_failed' / startDaemon's 'start_timeout' overwrote the
status restartDaemon had just set. The sibling return two lines below
already had the spread first; these three lines now agree."
```

---

### Task 2: The CLI must say which phase failed and why

**Files:**
- Modify: `scripts/cli.mjs:631` (insert branches before the generic `else`)
- Modify: `tests/integration/plist-drift.test.mjs` (new test appended after the two existing `CLI reporting:` tests, ~`:559`)

**Interfaces:**
- Consumes: the `restart_failed` shape produced by Task 1 (`status`, `phase`, `previous_pid`, `reason`), and `startDaemon`/`stopDaemon`'s `start_timeout` / `stop_timeout` shapes (`status`, `via`; the launchd variant at `daemon.mjs:630` carries **no pid** — do not print one).
- Produces: nothing consumed by later tasks.

**Why this task exists only after Task 1:** before the spread fix, `restart_failed` never reached `cli.mjs` at all. The generic fallback at `:632` printing `daemon restart failed` is the exact string the operator saw twice on 2026-08-05.

- [ ] **Step 1: Write the failing test**

Append after the `CLI reporting: a successful rewrite adds no extra stderr noise` test:

```javascript
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
```

- [ ] **Step 2: Run it and confirm the red is the right red**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: fails on the `/phase=stop/` assertion — `result.status` is already 1 (the generic fallback sets `process.exitCode = 1`), and stderr reads `ccmem: daemon restart failed`.

**The exit-code assertion passing on the red run is expected and is the point:** the exit code was never the defect. If the test goes red on `result.status` instead, the CLI is crashing — stop and report.

- [ ] **Step 3: Add the branches**

In `scripts/cli.mjs`, insert immediately before the generic `} else {` at `:631`:

```javascript
    } else if (result.status === 'restart_failed') {
      const detail = result.reason ? ` — ${result.reason}` : '';
      process.stderr.write(
        `ccmem: daemon restart failed phase=${result.phase} previous_pid=${result.previous_pid ?? 'unknown'}${detail}\n` +
          'ccmem: this does not prove the daemon is down — run `ccmem admin daemon status` before restarting again\n'
      );
      process.exitCode = 1;
    } else if (result.status === 'start_timeout' || result.status === 'stop_timeout') {
      const phase = result.status === 'start_timeout' ? 'start' : 'stop';
      const via = result.via ? ` via=${result.via}` : '';
      process.stderr.write(
        `ccmem: daemon ${phase} timed out waiting for the daemon to respond${via}\n` +
          'ccmem: a timeout is not a failure — run `ccmem admin daemon status`; a small uptime_sec with plist=in_sync means it worked\n'
      );
      process.exitCode = 1;
```

- [ ] **Step 4: Confirm green, and confirm no existing CLI test regressed**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: all PASS, including the two pre-existing `CLI reporting:` tests. The second of those asserts `result.status === 0` on a successful restart — it is the control proving the new branches did not capture the success path.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/plist-drift.test.mjs scripts/cli.mjs
git commit -m "fix(cli): report the phase and reason behind a failed daemon restart

bug-063 defect 3. restart_failed and the two timeout statuses fell to the
generic '<verb> failed' line, dropping phase, reason and previous_pid. Both
new messages point at \`admin daemon status\`, which is the only check that
tells a real failure apart from a slow start."
```

---

### Task 3: Give the start path its own, longer wait

**Files:**
- Modify: `scripts/lib/admin/daemon.mjs:14` (new constant), `:606`, `:625`, `:635` (three `waitFor` calls inside `startDaemon`)
- Modify: `tests/integration/plist-drift.test.mjs` (fake-launchctl `bootstrap)` case; new test)

**Interfaces:**
- Consumes: `waitFor(check, timeoutMs = WAIT_TIMEOUT_MS)` at `daemon.mjs:441` — already takes an explicit override, so no signature change.
- Produces: nothing consumed by later tasks.

**Scope note — read before editing:** `WAIT_TIMEOUT_MS` is shared by **five** call sites: three in `startDaemon` (`:606` wrapper, `:625` launchd, `:635` spawn) and two in `stopDaemon` (`:650`, `:687`). Only the three inside `startDaemon` change. **If you find a fourth `waitFor` call inside `startDaemon`, or fewer than three, stop and report — do not adjust the count silently.**

- [ ] **Step 1: Add the slow-start seam to the fake launchctl**

**Leave `kickstart)` unchanged** — both seams go in `bootstrap)` instead, and this is not a style preference. `withFakeLaunchctl` deletes the STATE marker before every test in this file, so `kickstart` always exits 1 with "service not loaded" and `startDaemon` always falls through to `bootstrapDaemon`. A seam placed in `kickstart)` is unreachable from every test here: T15 passes vacuously in ~37ms without ever exercising the wait. (Corrected 2026-08-06 after the first implementation attempt hit exactly this and reported BLOCKED.)

Modify the `bootstrap)` case. `: > "$STATE"` must stay first — launchd accepts the job immediately in reality; it is the daemon *process* that is slow to write its lock, which is exactly what the delay models:

```javascript
  '  bootstrap)',
  '    : > "$STATE"',
  '    if [ -n "$CCMEM_FAKE_BOOTSTRAP_SNAPSHOT" ]; then cp "$3" "$CCMEM_FAKE_BOOTSTRAP_SNAPSHOT"; fi',
  // job 被接受了，但锁永远不由 fake 写出来 —— 谁来写、什么时候写，交给测试自己决定。
  '    if [ -n "$CCMEM_FAKE_START_NEVER" ]; then exit 0; fi',
  '    set_lock',
  '    ;;',
```

**There is only one seam, and it is the one above.** Do not add a delayed-write seam to the fake `launchctl`. Two earlier attempts did, and both failed for different reasons — the second one leaked a background subshell that outlived its own test and wrote `daemon_lock` into the *next* test's window, since the lock table is shared across the file's module-scope data root. A slow start is now modelled by a timer the test owns and clears (Step 2), so no process outlives the test that created it. (Human ruling, 2026-08-06, after the third BLOCKED report.)

- [ ] **Step 2: Write the failing test**

```javascript
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
```

`waitFor` polls by `await sleep(WAIT_INTERVAL_MS)`, so the event loop stays free and the timer fires on schedule. On the Step 3 red run the wait gives up at ~2000ms and `clearTimeout` runs before the timer ever fires — which is exactly why this shape cannot contaminate the next test the way the subshell did.

- [ ] **Step 2b: Write the timeout-branch coverage test**

**Why this is here:** Task 2 added a `start_timeout` / `stop_timeout` branch to `scripts/cli.mjs` and the plan never asked for a test for it — a drafting gap in this plan, caught by Task 2's review and ruled on by the human on 2026-08-06: cover it here, where the seam already exists. Unlike every other test in this plan, **this one will be green the moment you write it** — the branch already works. Step 5b is what makes it honest.

`restart` cannot reach this branch: `restartDaemon` rewrites both timeout statuses into `restart_failed`. Only the bare `start` verb surfaces `start_timeout` to the CLI.

```javascript
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
```

- [ ] **Step 3: Run it and confirm the red is the right red**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: T15 fails after roughly 2 seconds with `'restart_failed' !== 'restarted'` (Task 1's fix means the status is now honestly `restart_failed` rather than `start_timeout`).

Expected: the Step 2b timeout test **passes** on this same run. That is not a problem — it is covering a branch that already works. Do not try to make it fail here.

**This red is the bug itself reproduced in a test** — the fake daemon *did* come up, and the code called it a failure. If T15 instead passes on this run, the delay seam is not firing; stop and report rather than weakening the assertion.

- [ ] **Step 4: Add the constant and use it at the three start sites**

`scripts/lib/admin/daemon.mjs:14`, immediately after `WAIT_TIMEOUT_MS`:

```javascript
const WAIT_TIMEOUT_MS = 2000;
// 启动等待与停止等待不同源。restart 是人为动作，没有任何外部截止时间约束它,
// 所以抬高的唯一代价是"真失败时多等 3 秒"；而 2000ms 不够一次冷启动，代价是把
// 一次成功的重启报成失败，并诱使操作者再重启一次。取值与本文件 PLIST_PROBE_TIMEOUT_MS
// 一致，理由也一致（见该常量附近那条注释）。bug-063 缺陷 1。
// 冷启动无法按需复现（当前 uptime 是热的），所以这个数是判断，不是测量出来的 ——
// 真正的安全网是 restart_failed 的可读消息，不是这个数字。
const START_WAIT_TIMEOUT_MS = 5000;
```

At `:606`, `:625`, and `:635`, pass it explicitly — for example the launchd site at `:625`:

```javascript
    const started = await waitFor(() => {
      const next = loadDaemonStatus(db);
      return next.alive ? next : null;
    }, START_WAIT_TIMEOUT_MS);
```

Apply the identical second argument to the wrapper site at `:606` and the spawn site at `:635`. Leave both `stopDaemon` sites (`:650`, `:687`) on the default.

- [ ] **Step 5: Confirm green and confirm the stop wait did not move**

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: T15 PASS (taking ~3s), T14 and both `CLI reporting:` tests still PASS.

Then verify the stop path was untouched:

```bash
grep -n "START_WAIT_TIMEOUT_MS" scripts/lib/admin/daemon.mjs
```

Expected: exactly **four** lines — the declaration plus `:606`, `:625`, `:635`. If a `stopDaemon` line appears, revert it.

- [ ] **Step 5b: Prove the Step 2b test with a targeted mutation red**

A test that was green the moment it was written has proven nothing yet. This repo's standing ruling (#9) is that a red-evidence gap is filled with a **targeted mutation red**, never a cheap one — the red must land on the assertion that names the behavior, with the control tests staying green.

Mutate: in `scripts/cli.mjs`, temporarily change the timeout branch's condition to something unreachable — `} else if (result.status === 'start_timeout__mutant' || result.status === 'stop_timeout') {` — so a real `start_timeout` falls through to the generic fallback.

Run: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/plist-drift.test.mjs`

Expected: the Step 2b test fails on the `/timed out/` assertion (stderr reads `ccmem: daemon start failed`). **The `result.status === 1` assertion must still pass** — the generic fallback also exits 1, which is precisely why exit code alone was never enough to catch this.

Expected: T14, T15, and both pre-existing `CLI reporting:` tests stay **green** under the mutation — they do not touch this branch. A mutation that reds them too is not targeted; investigate before proceeding.

**Then revert the mutation** and re-run to confirm green. Record both the mutated output and the restored output in your report. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/plist-drift.test.mjs scripts/lib/admin/daemon.mjs
git commit -m "fix(daemon): give the start path a 5s wait, leaving stop at 2s

bug-063 defect 1, per the 2026-08-06 human ruling. A cold start after the
previous daemon had run 1.5 days exceeded the shared 2000ms budget, so a
restart that worked was reported as failed. restart is a human action with
no external deadline, so the cost of waiting is three seconds on a genuine
failure; the cost of not waiting is a false failure that invites a second
restart. Matches PLIST_PROBE_TIMEOUT_MS, whose comment already argues this."
```

---

## Final verification (do not skip)

- [ ] Run the full suite: `npm test`
- [ ] Expected: **539 pass / 0 fail** (535 baseline + 4 new).
- [ ] If red: check the filename against the three known flakes (`stop-daemon-flow.test.mjs`, `admin-cron-command.test.mjs`, `admin-daemon-command.test.mjs`) **before** calling it a regression. Re-run the single file in isolation to confirm.
- [ ] Confirm no test wrote to the real `~/Library/LaunchAgents/com.ccmem.daemon.plist`: `ls -l ~/Library/LaunchAgents/com.ccmem.daemon.plist` — mtime must predate this session. **Do not print the file's contents.**
- [ ] Do **not** push. Branch integration is the human's call (see `superpowers:finishing-a-development-branch`).

## Deferred, and flagged rather than silently dropped

- **`start_failed` / `stop_failed` reaching the CLI bare.** A plain `ccmem admin daemon start` or `stop` that fails still falls to the generic `:632` line and drops `reason`. This plan only covers those statuses when they arrive wrapped in `restart_failed`. Adding the two branches is four lines and the same shape, but it needs its own red — left out to keep each task's red honest. Worth folding into the v0.14 list.
- **Whether 5000ms is actually enough.** The only cold-start observation is **censored** — it tells us `>2000ms` and nothing more, and a cold start cannot be reproduced on demand (the current daemon is warm). No number chosen here can be proven sufficient; Task 2's legible message is the safety net, Task 3 only lowers the frequency.
- **A hypothesis, not a claim:** `admin-daemon-command.test.mjs` is one of the three known flakes and it exercises daemon start. A marginal 2000ms wait is a *plausible* cause. This plan does not test that, and the flake should not be described as fixed unless someone measures it.
