# ccmem v0.13 — Handoff

> For an agent picking up the v0.13 implementation run mid-flight.
> Written 2026-07-31, after Tasks 1, 1b, 2, 3 closed review-clean.

## Read these first, in this order

| Artifact | What it is | Why you need it |
|---|---|---|
| `docs/superpowers/plans/2026-07-31-ccmem-v0.13.md` | The implementation plan — 8 tasks, TDD steps, real test code | Your task source. Self-contained; you do not need the original conversation. |
| `.superpowers/sdd/2026-07-31-ccmem-v0.13/progress.md` | The SDD ledger | **Every human ruling, with its reasoning**, plus all deferred minors. This is the only record of decisions that changed the plan. |
| `docs/ccmem-v0.13-spec.md` | The v0.13 spec | Why this release exists; §0.4 (live-DB evidence) and §0.5 (why the L2.5 fix is deferred) are load-bearing. |
| `git log --oneline` | Commit history | Source of truth for what actually landed. |

Do not reconstruct state from this document alone — it summarises, the four above are authoritative.

## Git state

Branch: **`v0.13-spec`**. Not pushed; the human handles all pushes.

**Do not trust any commit SHA written in this document** — committing this file moves HEAD. Establish the real head with `git log --oneline` and cross-check against the ledger's `Task N: complete (commits …)` lines, which record ranges as they were at the time each task closed.

Working tree was clean at handoff. All commits on the branch have passed a task review; there is no unreviewed work.

## Where the run stopped

Tasks **1, 1b, 2, 3** are complete and review-clean. Task 1b was not in the plan — it is a corrective task created mid-run; its brief lives at `.superpowers/sdd/2026-07-31-ccmem-v0.13/task-1b-brief.md`.

Remaining: **Tasks 4, 5, 6, 7, 8**, then the final whole-branch review.

The run paused because cost reached roughly 2× the original estimate and the remaining tasks need no design judgement — they are a better fit for a fresh session. Nothing is blocked.

## ⚠ Task 4 trap — read before dispatching it

**Re-extract Task 4's brief from the plan.** Task 3's design changes amended the plan after Task 4's section was originally written. `diagnose --feedback` must now read the durable decision stream `l25-probe.jsonl`, falling back to `readMetricsLines(days)` **only** when `metrics.decision_data.enabled === false`. An implementer working from a stale brief will read the wrong file and the task will look correct while collecting nothing.

Also for Task 4: `metrics.mjs` exports `decisionDataSizeBytes(decisionCfg)` specifically so `diagnose --feedback` can surface the archive's size. That file is unbounded by design, and ccmem's design principles require runtime costs to be visible — do not skip it.

## Human rulings you must not silently reverse

All are in the ledger with full reasoning. These are the ones easiest to undo by accident:

1. **The L2.5 probe must read `recent_injections`, never `memory_feedback`.** The latter's `outcome` is rewritten in place by feedback logic that runs *before* the probe, so reading it silently drops every turn where the legacy matcher fired. Guarded by invariants #129/#131.
2. **The probe labels, it does not suppress.** Turns with no new injection still record rows, marked `turn_aligned: false`. Those rows are the **negative control** that tells v0.14 whether any threshold is achievable at all. Discarding them was the original design and was explicitly overruled.
3. **`metrics.decision_data.enabled` controls durability, never existence.** When false, probe rows fall back to `metrics.jsonl`; they are never dropped.
4. **`retention_days: 0` means never auto-delete** — deliberately the inverse of runtime hygiene, because ccmem's own 14-day `recent_injections` retention already destroyed the data needed for this release's central decision.
5. **Cleanup goes in `scripts/lib/tier15.mjs`, not `daily-maintenance.mjs`.** ccmem is daemon-optional; the daemon task will not run for users whose daemon is down.
6. **`DEFAULT_CONFIG` in `scripts/lib/config.mjs` is the authoritative config source.** `config.default.json` is a user-facing reference kept in sync by test. `loadConfig()` never reads it.
7. **v0.13 does not change trust behaviour.** No threshold, no matcher, no archive parameter. The store will keep growing during this release — that is expected, not a regression.

## Process that earned its keep — keep doing it

Four of four tasks needed fix rounds. The failures shared one shape: **working code, passing tests, and a defect visible only as data that is quietly wrong.** Five instances, four of them originating in the spec or plan rather than in implementation. Details are in the ledger.

Two practices caught nearly all of it:

- **A scoped re-review after every fix round.** Not a re-run of the task review — it verdicts each finding ADDRESSED/NOT ADDRESSED against the fix diff only.
- **Every regression test must be watched failing before it is accepted.** Break the behaviour, confirm red, restore, record the evidence. This alone caught three tests that were green and worthless — one asserted against its own inline reimplementation, one used a timestamp that failed under both fixed and broken code, one checked drift in only the harmless direction.

Do not let an implementer's self-review substitute for the task review, and do not accept "tests pass" as evidence a test can fail.

## Suggested skills

- **`superpowers:subagent-driven-development`** — the workflow this run is using. Resume from its ledger section: tasks with a `Task N: complete` line are done; do not re-dispatch them.
- **`superpowers:requesting-code-review`** — its `code-reviewer.md` is the prompt for the final whole-branch review. Dispatch that one on the most capable model and point it at the ledger's deferred-minor and parked lines so it can triage them.
- **`superpowers:verification-before-completion`** — before claiming any task done.
- **`superpowers:finishing-a-development-branch`** — once the final review is clean.

Not needed: `brainstorming` and `writing-plans` are already discharged; the spec and plan exist.

## Deferred items

The ledger's `minor (deferred)` and `parked` lines are the complete list. Hand them to the final whole-branch review for triage rather than fixing them opportunistically — several are intentional trade-offs with recorded rulings, not oversights.

## Notes

- OpenWolf bookkeeping (`.wolf/buglog.json`, `.wolf/memory.md`, `.wolf/anatomy.md`) is gitignored and updated separately. bug-052 (the L2.5 matcher) stays **open** — v0.13 only instruments it; the real fix is v0.14 and depends on the data this release collects.
- The final verification section at the end of the plan lists all 15 appendix-A grep invariants plus a live-DB trust-conservation check (`SUM(trust_score)` must not move). Run them before declaring the branch done.
- No credentials or personal data appear in this run's artifacts.
