# Design — gate the embed latency probe on real Claude Code usage

Date: 2026-08-05
Status: approved (human, 2026-08-05), not yet implemented
Predecessor: `docs/superpowers/specs/2026-08-04-finding15-embed-latency-probe-design.md`

## 1. Problem

The Finding 15 probe (merged into `main`, commit title
`feat(daemon): schedule the latency probe on an interval, without a lease`) is enqueued
unconditionally by `scheduleCronTasks` whenever `embedding.latency_probe.enabled === true`.
The daemon runs under launchd 24/7, so once the flag is on the probe sends a real, billable
OpenAI request every `interval_ms` forever — including the ~14.5 hours a day nobody is using
Claude Code.

Two costs, one methodological and one operational:

- **Methodological.** The probe exists to reconstruct the part of the embed-latency distribution
  that `openai_timeout_ms: 800` censors on the hook path. A clock that samples uniformly across
  the whole day measures a different population than the hook does, because real prompts cluster
  into working hours. Samples taken at 04:00 are not evidence about what a prompt at 14:00 would
  have experienced.
- **Operational.** Each probe run inserts one row into `tasks`, and nothing in `scripts/` ever
  deletes from `tasks` (the table has no `(status, scheduled_for)` index either, and `mainLoop`'s
  due-query scans it). At the 5-minute default that is 288 rows/day, forever.

The human's requirement: **the probe should sample only while Claude Code is actually in use.**

## 2. Decision

Add one conjunct to the enqueue condition in `scripts/daemon/loop.mjs` (currently `:177`):

```js
const lastActivityMs = db.prepare(
  `SELECT MAX(updated_at) AS t FROM session_context`
).get()?.t ?? 0;

if (lastActivityMs > lastProbeAtMs && nowMs - lastProbeAtMs >= probeIntervalMs) {
  // enqueue as today
}
```

Read as: **there has been real usage since the last probe, and the rate cap has elapsed.**

**Placement is load-bearing:** the `SELECT` must sit *inside* the existing
`if (probeCfg.enabled === true)` block at `loop.mjs:175`, not above it. Hoisted out, every
install runs one query per loop tick for a feature that is off by default — a cost paid by
people who never turn the probe on.

`interval_ms` therefore changes meaning from "sampling period" to "minimum spacing between two
probes". Its default stays 300000 (5 minutes), chosen by the human on 2026-08-05.

### Why pairing rather than an activity window

Three rhythms were considered:

| Rhythm | Rule | Verdict |
|---|---|---|
| **Pair to prompts + rate cap** | new activity since last probe AND cap elapsed | **chosen** |
| Activity window + clock | keep probing while activity is within the last N minutes | rejected: needs a new `window` config key, and it keeps firing for N minutes after you walk away — which is the behaviour this change exists to remove |
| Only after a hook-side timeout | probe once after each `B-fail` | rejected: samples only slow moments, so the resulting distribution is systematically biased and cannot answer `P(ms ≤ 1300)` — the actual question of this line of work |

## 3. Signal source

`session_context.updated_at` (epoch ms), defined in `scripts/migrations/002_v02.sql:54`.

All three hooks bump it: `scripts/handlers/prompt-submit.mjs:33` on every prompt,
`scripts/handlers/session-start.mjs:40`, `scripts/handlers/stop.mjs:25`.

Two properties make it the right signal:

- **The hook path produces it; the daemon only reads it.** No hook code changes, so probe
  ruling #1 ("daemon-side out-of-band probe, hook path behaviour unchanged") is preserved
  literally rather than by argument.
- **It is cheap.** The table holds one row per session — 242 rows measured 2026-08-05. `MAX` over
  242 rows is negligible even as a full scan, so **no index is added**. Growth is a few rows/day.

`wakeRecently()` (`scripts/daemon/wake.mjs:12`) was evaluated and rejected as the signal: only
`stop.mjs:74` touches the wake file, and its window is a fixed 60s boolean rather than a
monotonic timestamp that can be compared against `lastProbeAtMs`.

## 4. Config surface: no new keys

`enabled` and `interval_ms` keep their names; `interval_ms` gains the new meaning above. No
`window`, no `require_activity`, no way to opt back into 24/7 sampling.

Rationale: CLAUDE.md Rule 2, plus the argument the repo already makes at
`scripts/lib/admin/daemon.mjs:696` — a new config key is a new surface that can diverge from the
code (the shape of Finding 12).

**Disclosed cost:** after this change there is no switch that restores unconditional sampling.
That is deliberate. If a future round needs it, it gets added then.

## 5. Compliance with the six standing probe rulings

| # | Ruling | Effect |
|---|---|---|
| 1 | daemon-side out-of-band probe, hook path unchanged | preserved — the gate reads a table the hooks already write |
| 2 | permanent instrument, configurable rate | preserved — still permanent, now conditional |
| 3 | sample real local memory text | unchanged |
| 4 | default off, enabled explicitly per machine | unchanged |
| 5 | record `prompt_chars` | unchanged |
| 6 | in-module `enabled` gate as well as the enqueue gate | **kept as-is; the activity check goes only at the enqueue site** |

On #6 specifically: that ruling guards a *billing/safety* property — a row already queued when
the operator flips `enabled` back to false would still send a real paid request. Activity is not
a safety property. A queued row executes at most one loop tick later, at which point "was in use
a moment ago" still holds. Adding an activity check inside the task module would buy nothing and
would couple the module to `session_context`, widening the import surface that the probe's
isolation depends on.

## 6. Restart boundary — the one behaviour change beyond the gate

`lastProbeAtMs` is module state initialised to `0`, and `loop.mjs:123-124` documents "a restart
resets this and the probe fires once immediately; that is acceptable."

With the activity gate that stops being acceptable: `MAX(updated_at) > 0` is true whenever any
session has ever existed, so **every daemon restart would emit exactly the kind of
nobody-was-using-it sample this change exists to eliminate.**

Change: initialise `lastProbeAtMs` to the daemon's start time, so after a restart the probe waits
for genuinely new activity.

**Second consequence, disclosed rather than discovered later:** this also suppresses every probe
for the first `interval_ms` after any daemon restart, including a restart in the middle of dense
work — because the rate-cap conjunct `nowMs - lastProbeAtMs >= probeIntervalMs` is now measured
from daemon start rather than from epoch 0. Judged acceptable (5 minutes, and restarts are rare),
but it must be written down: without it, a later reader cannot explain the gap that follows every
restart in the sample file.

**The comment at `loop.mjs:123-124` must be updated in the same commit.** Leaving it is the
failure recorded as Ⅲ.3 in the handoff — editing the sentence that is wrong while leaving its
restatement two lines down.

**Implementation note:** `lastProbeAtMs` has a second initialiser — the test seam
`_resetProbeSchedule()` at `loop.mjs:155-158` sets it back to `0`. Both initialisers must express
the same intent, or a test observes a starting state production never has. Decide explicitly which
value the seam resets to and state the choice in the implementation report; do not leave the two
sites disagreeing by accident.

## 7. Testing

Red-green, and the red must be a targeted mutation red — a crash red does not count.

| Case | Expectation |
|---|---|
| new activity + cap elapsed | one row enqueued |
| **no new activity + cap elapsed** | **nothing enqueued** (core assertion of this change) |
| new activity + cap not elapsed | nothing enqueued |
| after restart, no new activity | nothing enqueued (guards §6) |

**Mutation check:** replace `lastActivityMs > lastProbeAtMs` with `true`. Cases 2 and 4 must go
red on their own named assertions; cases 1 and 3 must stay green.

**Case 4 is conditional on the §6 implementation note.** Its ability to fail depends on what
`_resetProbeSchedule()` resets `lastProbeAtMs` to. If the seam still resets to `0` while
production starts at daemon-start time, a test written through the seam exercises a starting
state production never has, and the assertion can pass without the guard existing — the
vacuous-assertion failure mode of Ⅲ.1. Resolve the seam value first, then write case 4 against it, and
say in the implementation report which value was chosen and why.

**Fixture requirement:** any `session_context` table created by a test fixture must match
`scripts/migrations/002_v02.sql:54-62` exactly, including `updated_at INTEGER NOT NULL`. A fixture
that diverges from the migration produces an assertion that can never fail — the defect recorded
as Ⅲ.1 in the handoff, which cost a fix round on the previous wave.

## 8. Known limitations (do not silently drop from the implementation report)

- **a.** Not one sample per prompt. During dense work the 5-minute cap drops prompts, so what is
  estimated is *the latency distribution during active periods*, not *the distribution over
  retrievals*. Any conclusion written from this data must say so.
- **b.** **One trailing probe follows every period of use.** Once you stop, the last activity
  timestamp still exceeds `lastProbeAtMs`, so the gate fires once more as soon as the rate cap
  elapses — up to `interval_ms` after you walked away. This is a general property of the rule, not
  an artefact of any one hook; `stop.mjs:25` bumping `updated_at` at session end merely makes it
  most visible there. Judged acceptable (it is still the tail of real usage), but it must be
  recorded, or a later reader cannot explain the sample that always sits just past each session.
- **c.** The probe still embeds random memory text, not the real prompt. Comparability of length
  rests on calibrating `text_chars` against `prompt_chars` after the fact. As of the 2026-08-05
  snapshot only **10** records carry `prompt_chars` (Task 1 of the previous wave landed recently),
  so this calibration is not yet possible and must wait for accumulation.
- **d.** `mainLoop` sleeps 300s when idle (`loop.mjs:388`); `touchWakeFile` is called only by
  `stop.mjs:74` and cannot interrupt an in-flight `setTimeout`. **The first sample of a work
  session can therefore lag the first prompt by up to 5 minutes.** Once a stop hook has fired,
  `wakeRecently()` is true and ticks drop to 30s, so later samples are prompt.

## 9. Expected volume

Derived from a frozen copy of `metrics.jsonl` taken 2026-08-05 (5943 records), counting
`hook == "prompt_submit"` per local day over 2026-07-25 … 2026-08-04.

**The right estimator is the number of distinct `interval_ms`-wide windows containing at least
one prompt**, not the prompt count and not the active-hour count. Under this gate a window with
thirty prompts yields the same single sample as a window with one, so any estimate built from
raw prompt volume overstates the yield.

| | 07-25 | 26 | 27 | 28 | 29 | 30 | 31 | 08-01 | 02 | 03 | 04 | mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prompts | 33 | 79 | 67 | 81 | 52 | 27 | 95 | 122 | 137 | 34 | 63 | 71.8 |
| active hours | 9 | 14 | 6 | 7 | 7 | 4 | 13 | 15 | 14 | 8 | 7 | 9.5 |
| **distinct 5-min windows** | 24 | 59 | 42 | 43 | 25 | 18 | 62 | 73 | 74 | 26 | 39 | **44.1** |
| distinct 15-min windows | 19 | 39 | 20 | 19 | 18 | 9 | 33 | 40 | 39 | 17 | 22 | 25.0 |

At the chosen 5-minute cap: **≈ 44 samples/day ⇒ ~300 samples in about 6.8 days**, at
**≈ 44 `tasks` rows/day** against 288 under unconditional sampling. (A 15-minute cap would give
≈ 25/day, ~12 days.)

Two caveats on the estimator itself:

- The windows here are wall-clock-aligned buckets, whereas the real cap is measured rolling from
  the previous probe. The two agree closely but not exactly; treat 44 as a central estimate, not
  a bound.
- It ignores the trailing probe of §8b and the up-to-5-minute first-sample lag of §8d, which push
  in opposite directions.

This is a measurement of an ongoing process and expires: re-derive it from current data before
building any later conclusion on it.

**Superseded:** an earlier revision of this section estimated ≈ 65–70 samples/day and ~4.5 days
by scaling the prompt rate against active hours. That method double-counts prompts that share a
window; the corrected figures above replace it.

## 10. Out of scope

- Changing `openai_timeout_ms`. That is the next round and needs its own plan; it must re-derive
  the budget arithmetic (`embed_timeout` + fallback max 638 < 2000) against data current at that
  time.
- Adding a `tasks` pruner. Real (the table has no cleanup) but a repo-wide retention decision,
  unchanged by this design; it belongs on the v0.14 list.
- Turning `enabled` on. That remains an explicit human action per ruling #4.
