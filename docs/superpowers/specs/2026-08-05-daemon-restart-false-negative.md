# bug-063 — `admin daemon restart` reports failure for a restart that worked

Date: 2026-08-05
Status: diagnosed, not fixed. Branch `daemon-restart-false-negative` from `912803a`.
Bug log: `.wolf/buglog.json` entry `bug-063` (git-ignored, main checkout only).

## Observed, twice, on 2026-08-05

- Restart #1: printed `ccmem: daemon restart failed`, exit 1 — yet the daemon was alive on a
  new PID with `plist=in_sync`. Restart #2 two minutes later: exit 0, 0.858s.
- Again this evening: `ccmem admin daemon restart` printed the same failure; `status` showed a
  new PID, `uptime_sec=62`, `plist=in_sync`. The restart had worked.

The operator has no way to tell a real failure from this one, and the natural reaction —
restarting again — is exactly what should not happen if a restart genuinely failed.

## Three defects, stacked

**1. The start wait is too short for a cold start.** `scripts/lib/admin/daemon.mjs:14`,
`WAIT_TIMEOUT_MS = 2000`, is the only budget `startDaemon` gives the launchd path to observe a
heartbeat. A cold start after the previous daemon had run 1.5 days exceeded it; the warm restart
measured 0.858s total. The same file argues at `:695-698` that `PLIST_PROBE_TIMEOUT_MS = 5000`
is right because "restart is a human action, better to wait than to misjudge" — the start wait
contradicts that reasoning at 2.5× shorter.

**2. The failure detail is computed and then thrown away.** `restartDaemon` at `:735` and `:742`
returns `{ status: 'restart_failed', phase, ..., ...stopped }` with the spread **last**, so
`...stopped` / `...started` overwrites `status` with `stop_timeout` / `start_timeout`. The
sibling return at `:745` has the spread first and is correct — these three lines disagree.

**3. The CLI has no branch for either value.** `scripts/cli.mjs:598-631` handles twelve statuses,
none of them the two timeouts, so it falls to the generic `daemon <verb> failed` at `:632` and
drops `phase`, `reason` and `previous_pid`.

## The judgment call this needs

Defects 2 and 3 are unambiguous. **Defect 1 is a decision, not a bug fix:** what should the
start wait be? Options: raise it to match `PLIST_PROBE_TIMEOUT_MS`; make it asymmetric (a longer
wait for start than for stop); or leave the timeout alone and let a correct message
(`start_timeout`, with the phase) make the false negative legible instead of eliminating it.

Do not pick silently — the file's existing comment records a deliberate stance, and this repo's
rule is that a new config key is itself a new surface that can diverge from the code, so
"make it configurable" is not the easy answer it looks like.

## Test constraints — read before writing a single test

- **A test in this repo once ran real `launchctl` and hijacked the machine's daemon
  registration.** Isolation must be a module-level default, not something the next person
  remembers to call. Nothing here may touch the real launchd job or the real daemon.
- Every regression test must be watched red first and red for the right reason. A crash red does
  not count; a test that cannot fail does not count.
- The status-clobber defect is testable purely as a function of `restartDaemon`'s return shape —
  that is the cheapest honest red available, and it should exist before any timeout is touched.
- `npm test -- <file>` does not isolate a single file. Use
  `env -u CCMEM_CONFIG_PATH CCMEM_DATA_ROOT="$(mktemp -d)" node --test <file>`.
- Suite baseline on `912803a`: 535 pass / 0 fail. Three files are known intermittent flakes —
  `stop-daemon-flow.test.mjs`, `admin-cron-command.test.mjs`, and (new, seen 2026-08-05)
  `admin-daemon-command.test.mjs`. Confirm the filename before calling a red a regression.

## Out of scope

The probe work is merged and unrelated. Turning `embedding.latency_probe.enabled` on is the
human's action per standing ruling #4 and does not depend on this fix — the daemon running as of
`912803a` already carries the activity gate.
