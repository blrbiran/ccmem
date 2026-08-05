# Probe Activity Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embed latency probe sample only while Claude Code is actually being used, instead of on a 24/7 clock.

**Architecture:** Add one conjunct to the probe's enqueue condition in `scripts/daemon/loop.mjs`: the probe fires only if `MAX(session_context.updated_at)` — a column all three hooks already bump — is newer than the last probe. `interval_ms` becomes a rate cap rather than a period. No hook code changes; the daemon only reads a table the hooks already write.

**Tech Stack:** Node 22 (`node:test`, `node:sqlite`), better-sqlite3-style prepared statements, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-probe-activity-gate-design.md` (approved 2026-08-05, includes five review corrections). Read it before Task 1 — it carries the rulings this must not overturn.

## Global Constraints

- **Do not modify any hook.** `scripts/handlers/*` is untouched. Probe ruling #1.
- **Do not change any config default.** `enabled` stays `false`, `interval_ms` stays `300000`. Probe ruling #4.
- **Do not add a config key.** No `window`, no `require_activity`. Spec §4.
- **Do not turn `enabled` on** anywhere, including in the developer's own `config.json`.
- **Do not touch the in-module `enabled` gate** in `scripts/daemon/tasks/embed-latency-probe.mjs:30`. Probe ruling #6; spec §5.
- Every regression test must be **watched red first, and red for the right reason**. A crash red does not count. A test that cannot fail does not count.
- Single-file test runs need both variables: `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <file>`. `npm test -- <file>` does **not** isolate a single file.
- Suite baseline is **532 pass / 0 fail**. Two known flakes: `tests/integration/stop-daemon-flow.test.mjs` and `tests/integration/admin-cron-command.test.mjs`. A red in either is a re-run, not a regression — confirm the filename before concluding anything.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/daemon/loop.mjs` | probe scheduling: rate cap, activity gate, module state | Modify `:106-126` (comment + `lastProbeAtMs` init), `:154-158` (`_resetProbeSchedule`), `:174-184` (enqueue block) |
| `tests/integration/daemon-loop.test.mjs` | probe scheduling behaviour | Modify the four probe tests at `:5744-5816`; add four cases |

No files are created. No other file is touched.

---

## Task 1: Seed the probe clock from daemon start, and give the test seam an explicit clock

**Files:**
- Modify: `scripts/daemon/loop.mjs:106-126`, `scripts/daemon/loop.mjs:154-158`
- Test: `tests/integration/daemon-loop.test.mjs:5744-5816`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `_resetProbeSchedule(startMs = Date.now())` — the test seam now accepts the instant to treat as "daemon start". Task 2's tests call it with an explicit epoch-ms value. Module-level `lastProbeAtMs` is seeded to `Date.now()` at import.

**Why this task exists separately:** the existing probe tests drive `scheduleCronTasks` with a fixed fake clock in 2026-08-04 while `Date.now()` is later. Seeding `lastProbeAtMs` from the real clock makes `nowMs - lastProbeAtMs` negative, so the rate-cap conjunct is never satisfied and every probe test silently stops enqueueing. The seam parameter is therefore forced by the change, not a convenience.

- [ ] **Step 1: Watch the existing probe tests pass, to establish the baseline**

Run:
```bash
cd /Users/biran/code/skills/ccmem
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | tail -20
```
Expected: all tests pass. Record the pass count — you will compare against it in Step 6.

- [ ] **Step 2: Seed `lastProbeAtMs` from daemon start and rewrite the comment that describes it**

In `scripts/daemon/loop.mjs`, replace the final paragraph of the block comment at `:123-124` and the initialiser at `:126`.

Replace:
```js
 * A restart resets this and the probe fires once immediately; that is
 * acceptable.
 */
let lastProbeAtMs = 0;
```

With:
```js
 * Seeded from daemon start, NOT from 0. With the activity gate below, a 0 seed
 * would make `MAX(session_context.updated_at) > lastProbeAtMs` true on the
 * strength of any session that has ever existed, so every restart would emit
 * exactly the nobody-was-using-it sample the gate exists to remove.
 *
 * The cost of the seed, stated because it is invisible otherwise: no probe
 * fires in the first interval_ms after any restart, including a restart in the
 * middle of dense work. Five minutes, and restarts are rare.
 */
let lastProbeAtMs = Date.now();
```

Leave the rest of the comment (the lease rationale and the `tasks` growth disclosure) exactly as it is.

- [ ] **Step 3: Give the test seam the same initialiser**

Replace `scripts/daemon/loop.mjs:154-158`:
```js
/** Test seam only. */
export function _resetProbeSchedule() {
  lastProbeAtMs = 0;
  warnedBadProbeInterval = false;
}
```

With:
```js
/**
 * Test seam only. Takes the instant to treat as daemon start, because tests
 * drive scheduleCronTasks from a fixed fake clock: seeding from the real
 * Date.now() would put lastProbeAtMs in their future and make the rate-cap
 * check unsatisfiable. The default mirrors the module initialiser so the two
 * sites cannot drift into describing different starting states.
 */
export function _resetProbeSchedule(startMs = Date.now()) {
  lastProbeAtMs = startMs;
  warnedBadProbeInterval = false;
}
```

- [ ] **Step 4: Run the probe tests and watch them fail**

Run:
```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | grep -A6 "latency probe\|leaves no rows"
```
Expected: `the probe enqueues once per interval, not once per tick` fails with `2 !== 0` (nothing enqueued, because `lastProbeAtMs` is now in the tests' future). This is the intended red — it is the exact failure this task exists to fix, observed rather than assumed.

If instead it still passes, stop: the initialiser did not take effect and Step 2 needs re-checking.

- [ ] **Step 5: Pass an explicit start time from each probe test**

In `tests/integration/daemon-loop.test.mjs`, each of the four probe tests calls `_resetProbeSchedule();`. Give each one a start instant one hour before its fake clock.

Add this constant immediately above the first probe test (`test('the latency probe is not scheduled while disabled'`, around `:5744`):

```js
// The probe tests drive scheduleCronTasks from a fixed clock at 12:00 on
// 2026-08-04. lastProbeAtMs must sit before that, or the rate-cap check
// compares against an instant in their future and can never be satisfied.
const PROBE_TEST_START_MS = new Date('2026-08-04T11:00:00').getTime();
```

Then in all four tests replace:
```js
  _resetProbeSchedule();
```
with:
```js
  _resetProbeSchedule(PROBE_TEST_START_MS);
```

The four call sites are in these tests:
- `the latency probe is not scheduled while disabled`
- `a truthy-but-not-true enabled value does not turn the probe on`
- `the probe enqueues once per interval, not once per tick`
- `the probe leaves no rows in task_runs`

- [ ] **Step 6: Run the full file and confirm the baseline is restored**

Run:
```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | tail -20
```
Expected: same pass count as Step 1, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add scripts/daemon/loop.mjs tests/integration/daemon-loop.test.mjs
git commit -m "refactor(daemon): seed the probe clock from daemon start, not epoch 0

The activity gate that follows compares MAX(session_context.updated_at)
against lastProbeAtMs. Seeded at 0 that comparison is true on the
strength of any session that has ever existed, so every daemon restart
would emit exactly the nobody-was-using-it sample the gate is meant to
remove.

The test seam takes the start instant explicitly because the probe tests
drive scheduleCronTasks from a fixed clock in the past: seeding them from
the real Date.now() puts lastProbeAtMs in their future and makes the
rate-cap check unsatisfiable, which is what Step 4 watched happen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Gate the enqueue on real Claude Code usage

**Files:**
- Modify: `scripts/daemon/loop.mjs:174-184`
- Test: `tests/integration/daemon-loop.test.mjs` (modify two existing probe tests, add four)

**Interfaces:**
- Consumes: `_resetProbeSchedule(startMs)` from Task 1.
- Produces: no new exports. Behaviour: `scheduleCronTasks` enqueues an `embed_latency_probe` row only when `MAX(session_context.updated_at) > lastProbeAtMs` **and** `nowMs - lastProbeAtMs >= interval_ms`.

**Read first:** spec §2 (the placement requirement), §5 (why the gate does *not* go inside the task module), §7 (the mutation check and the case-4 dependency), §8b (the trailing probe).

- [ ] **Step 1: Write the two failing tests that name the new behaviour**

Add these immediately after `test('the probe leaves no rows in task_runs'` in `tests/integration/daemon-loop.test.mjs`. `resetRuntimeTables(db)` already empties `session_context`, so absence of activity is the default state and must be established positively where it matters.

```js
function recordUsage(db, sessionId, atMs) {
  db.prepare(
    `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at)
     VALUES (?, 'demo/repo', 0, 0, 0, 0, ?)
     ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`
  ).run(sessionId, atMs);
}

test('the probe does not fire when nobody has used Claude Code since the last probe', () => {
  const restoreConfig = setRuntimeConfig('probe-idle', {
    embedding: { latency_probe: { enabled: true, interval_ms: 300000 } }
  });
  const db = openDb();
  resetRuntimeTables(db);
  _resetProbeSchedule(PROBE_TEST_START_MS);

  try {
    // Rate cap elapsed (11:00 -> 12:00) but session_context is empty: no usage.
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
    const n = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
    assert.equal(n, 0, 'an idle machine must not send billable requests: the probe measures what retrieval experiences, and retrieval is not happening');
  } finally {
    restoreConfig();
    db.close();
  }
});

test('the probe fires once for a burst of usage, not once per prompt', () => {
  const restoreConfig = setRuntimeConfig('probe-burst', {
    embedding: { latency_probe: { enabled: true, interval_ms: 300000 } }
  });
  const db = openDb();
  resetRuntimeTables(db);
  _resetProbeSchedule(PROBE_TEST_START_MS);

  try {
    recordUsage(db, 'session-a', new Date('2026-08-04T11:59:00').getTime());
    recordUsage(db, 'session-a', new Date('2026-08-04T11:59:30').getTime());
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));   // usage since last probe + cap elapsed -> enqueue

    scheduleCronTasks(db, new Date('2026-08-04T12:06:00'));   // cap elapsed again, but no usage since 11:59:30 -> no enqueue

    recordUsage(db, 'session-a', new Date('2026-08-04T12:10:00').getTime());
    scheduleCronTasks(db, new Date('2026-08-04T12:11:00'));   // fresh usage + cap elapsed -> enqueue

    const n = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
    assert.equal(n, 2, 'two periods of use produce two samples; the four prompts inside them do not produce four');
  } finally {
    restoreConfig();
    db.close();
  }
});
```

- [ ] **Step 2: Run them and watch them fail for the right reason**

Run:
```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | grep -A8 "nobody has used\|burst of usage"
```
Expected:
- `nobody has used Claude Code` fails on its own assertion with `1 !== 0` — the ungated probe enqueues on an idle machine.
- `burst of usage` fails with `3 !== 2` — the ungated probe enqueues at 12:00, 12:06 and 12:11.

Both reds must name those assertions. A stack trace instead means the fixture is wrong, not the code — fix the fixture before continuing.

- [ ] **Step 3: Add the gate**

In `scripts/daemon/loop.mjs`, inside the existing `if (probeCfg.enabled === true) {` block at `:175` — **not above it**, so installs with the probe off pay no query per tick — replace:

```js
    const probeIntervalMs = resolveProbeIntervalMs(probeCfg.interval_ms);
    if (nowMs - lastProbeAtMs >= probeIntervalMs) {
```

with:

```js
    const probeIntervalMs = resolveProbeIntervalMs(probeCfg.interval_ms);
    // All three hooks bump session_context.updated_at (prompt-submit on every
    // prompt, session-start, stop), so this is the hook path telling the daemon
    // it is worth sampling — without the daemon touching the hook path. One row
    // per session, a few hundred rows, so MAX is a negligible scan and no index
    // is warranted.
    const lastActivityMs = db.prepare(
      `SELECT MAX(updated_at) AS t FROM session_context`
    ).get()?.t ?? 0;
    if (lastActivityMs > lastProbeAtMs && nowMs - lastProbeAtMs >= probeIntervalMs) {
```

- [ ] **Step 4: Run the two new tests and watch them pass**

Run:
```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | grep -A6 "nobody has used\|burst of usage"
```
Expected: both pass.

- [ ] **Step 5: Repair the two existing tests the gate has just made dishonest**

Two of Task 1's tests now describe something that no longer happens, and one of them passes for the wrong reason:

`the probe enqueues once per interval, not once per tick` (`:5780`) now enqueues nothing, because it never records usage. Insert usage before each expected enqueue:

```js
    recordUsage(db, 'session-interval', new Date('2026-08-04T11:59:00').getTime());
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));   // first: enqueue

    // Fresh usage AFTER that probe, so the activity conjunct is true here and
    // only the rate cap can block. Without this the 12:01 tick has both
    // conjuncts false and cannot tell you which one did the work.
    recordUsage(db, 'session-interval', new Date('2026-08-04T12:00:30').getTime());
    scheduleCronTasks(db, new Date('2026-08-04T12:01:00'));   // within interval: no enqueue

    scheduleCronTasks(db, new Date('2026-08-04T12:06:00'));   // cap elapsed, usage at 12:00:30 still unsampled: enqueue
```

This keeps the test's existing `assert.equal(n, 2, 'interval gating, not per-tick enqueueing')` honest and makes it the isolating case for spec §7 case 3 (activity present, cap not elapsed). Note the second `recordUsage` also supplies the usage that the 12:06 enqueue consumes, so no third record is needed.

`the probe leaves no rows in task_runs` (`:5800`) asserts an **absence**. With no usage recorded, nothing is enqueued and the assertion holds trivially — it would keep passing if the probe were deleted outright. Give it a probe to observe:

```js
    recordUsage(db, 'session-no-lease', new Date('2026-08-04T11:59:00').getTime());
    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
    const enqueued = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
    assert.equal(enqueued, 1, 'the no-lease claim is only meaningful about a probe that actually ran');
    const n = db.prepare("SELECT count(*) AS n FROM task_runs WHERE type = 'embed_latency_probe'").get().n;
```

Leave that test's existing `assert.equal(n, 0, ...)` and its long message untouched.

- [ ] **Step 6: Add the restart-boundary test (spec §6)**

Add after the burst test:

```js
test('a daemon restart does not by itself produce a sample', () => {
  const restoreConfig = setRuntimeConfig('probe-restart', {
    embedding: { latency_probe: { enabled: true, interval_ms: 300000 } }
  });
  const db = openDb();
  resetRuntimeTables(db);

  try {
    // Usage from before the restart. A 0-seeded clock would treat this as
    // "activity since the last probe" forever.
    recordUsage(db, 'session-yesterday', new Date('2026-08-03T09:00:00').getTime());

    // The restart: lastProbeAtMs is seeded from this instant, exactly as the
    // module initialiser does at daemon start.
    _resetProbeSchedule(PROBE_TEST_START_MS);

    scheduleCronTasks(db, new Date('2026-08-04T12:00:00'));
    const n = db.prepare("SELECT count(*) AS n FROM tasks WHERE type = 'embed_latency_probe'").get().n;
    assert.equal(n, 0, 'restarting the daemon is not usage; a sample taken then measures nothing retrieval experienced');
  } finally {
    restoreConfig();
    db.close();
  }
});
```

- [ ] **Step 7: Run the whole file green**

Run:
```bash
env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test tests/integration/daemon-loop.test.mjs 2>&1 | tail -20
```
Expected: 0 fail, pass count = Task 1 Step 6's count + 3.

- [ ] **Step 8: Run the mutation check (spec §7) — this is the step that decides whether the tests are real**

Temporarily replace the gate's first conjunct in `scripts/daemon/loop.mjs`:
```js
    if (true && nowMs - lastProbeAtMs >= probeIntervalMs) {
```

Run the file. Expected:
- `the probe does not fire when nobody has used Claude Code since the last probe` — RED on `1 !== 0`
- `a daemon restart does not by itself produce a sample` — RED on `1 !== 0`
- `the probe fires once for a burst of usage, not once per prompt` — RED on `3 !== 2`
- `the latency probe is not scheduled while disabled`, `a truthy-but-not-true enabled value...`, `the probe enqueues once per interval...`, `the probe leaves no rows in task_runs` — all still GREEN

Then **revert the mutation** and re-run to confirm green. Record the observed reds verbatim in the implementation report; if any expected red did not appear, the corresponding test cannot fail and must be rewritten before this task is done.

- [ ] **Step 9: Run the full suite**

Run:
```bash
npm test 2>&1 | tail -25
```
Expected: 535 pass / 0 fail (532 baseline + 3 new). A red in `stop-daemon-flow.test.mjs` or `admin-cron-command.test.mjs` is the known flake — re-run those files alone to confirm before treating it as a regression. Any other red is a regression and blocks the commit.

- [ ] **Step 10: Commit**

```bash
git add scripts/daemon/loop.mjs tests/integration/daemon-loop.test.mjs
git commit -m "feat(daemon): sample embed latency only while Claude Code is in use

The probe fired on a clock the daemon keeps 24/7, so once enabled it
sent a real billable request through the ~14.5 hours a day nobody is
prompting. Those samples also measure the wrong population: the probe
exists to reconstruct the latency distribution that openai_timeout_ms
censors on the hook path, and real prompts cluster into working hours,
so a uniform clock is not evidence about what a prompt would have seen.

Gate the enqueue on MAX(session_context.updated_at) > lastProbeAtMs. All
three hooks already bump that column, so the daemon only reads what the
hook path already writes and the hook path itself is untouched. The read
sits inside the enabled check so installs with the probe off -- the
default -- pay nothing per tick.

interval_ms becomes a rate cap rather than a period: one sample per
period of use, not one per prompt. Measured against a frozen metrics
snapshot this yields ~44 samples/day against 288 unconditional.

Two existing tests were repaired rather than left passing: the interval
test recorded no usage and so enqueued nothing, and the task_runs test
asserts an absence that held trivially once nothing was enqueued -- it
would have kept passing with the probe deleted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Completion criteria

- `npm test` reports 535 pass / 0 fail on the final state (known flakes re-run and confirmed).
- The mutation check in Task 2 Step 8 produced all four expected reds and no unexpected ones, and the observation is written down.
- `scripts/handlers/` is untouched: `git diff --stat main -- scripts/handlers/` is empty.
- No config default changed: `git diff main -- scripts/lib/config.mjs` is empty.
- `enabled` is still `false` in `DEFAULT_CONFIG`, and no developer `config.json` was edited.

## After this plan

Not in scope here, in order:

1. **Turn the probe on.** Human action per ruling #4 — add `embedding.latency_probe.enabled: true` to the store's `config.json`. `loadConfig()` is re-read every tick and deep-merges, so only that one key is needed and no daemon restart is required. Verify within one tick that a row lands in `embed-latency-probe.jsonl` and that the reasons `provider` / `no_api_key` / `no_text` / `load_failed` do not appear.
2. **Run ~7 days** (spec §9: ≈44 samples/day, ~300 samples in ~6.8 days).
3. **Answer the actual question:** `P(ms ≤ 1300) − P(ms ≤ 800)` with a confidence interval, plus the residual `P(ms > 1300)` that stays lost. Validate first that the probe's sub-800ms samples agree with the hook's observed successes — if they disagree, the answer is "undecidable", not an extrapolation.
4. **Then** change `openai_timeout_ms`, in its own round with its own plan, re-deriving the budget arithmetic against data current at that time.
