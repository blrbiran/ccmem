# SDD ledger — plan: docs/superpowers/plans/2026-10-17-codex-omp-adaptation.md

Controller: Orca session d0843ec0 (Claude Opus 5.5), 2026-10-17. Spec: docs/superpowers/specs/2026-10-17-codex-omp-adaptation-design.md.
Human mandate (2026-10-17): do all tasks this session; resolve issues by controller recommendation, report at end; criteria (test) rewrites approved; no paid runs, no real installs into ~/.codex / ~/.omp, no merge/push.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T0 vs all | T0 fixes test paths every later task's suite runs on | must run first; ok |
| T1 vs T4 | T1 emits buildReadInstruction(sessionId); T4 adds agent param | compatible (default claude-code) |
| T1 vs T9 | T1 writeContextFile(..., {stableRows}); T9 adds proposal notice line | notice must sit inside hashed content; carry to T9 |
| T2 vs T5 vs T8 | all edit summarize-pending.mjs / content-refiner uses callClaudeP | sequential, no conflict |
| T3 vs T4/T9 | T3 adds session_context.agent, llm_backend_state, llm_switch_proposals | consumed later; ok |
| T4 vs T5 | stop payload.agent → parseTranscript(path, agent) | ok |
| T6 vs T7 | T6 creates install/manifest.mjs; T7 reuses | ok |
| T8 vs T9 | T8 reads config.llm.backend; T9 swaps in resolveActiveBackend | ok |
| T8 vs T10 | backend ids + llm.commands | ok |
| T1 self | caps 4096 / 12288 / retrieved 8192 match Global Constraints | ok |
| T2 self | refiner returns object; summarize-pending sole summary caller; other callers? content-refiner only used by summarize-pending | ok |
| T3 self | Step 1 text on "v16 DB copy" is self-contradictory | Ruling below |
| T5 self | fixtures synthetic; real-file check prints counts only | ok |
| T6 self | config.toml never edited; refuses on [hooks] | ok |
| T7 self | .ts test under node 24 type stripping; API must be checked vs installed 18.10.1 | ok |
| T8 self | claude argv unchanged | ok |
| T9 self | retryAfter path in loop.mjs:286-297 keeps tasks queued | ok |
| T10 self | approved rewrite of admin-daemon PATH expectations | ok |
| T12 self | paid steps excluded by mandate | ok |

Ruling: T3 migration test covers a fresh data root plus an upgrade from a v16 DB built by applying migrations up to 016 only if the runner allows a target version; otherwise fresh + idempotent reopen — the plan text is self-contradictory — cost if wrong: an upgrade-only bug escapes (mitigated: 017 is additive ALTER/CREATE only).
Ruling: paid acceptance (T12 step 2) and real installs are not run this session — human's standing per-call approval rule — cost if wrong: acceptance evidence arrives later.

## Baseline
d9d1547: npm test → 760 tests / 695 pass / 65 fail (stale path; Task 0). Output: Orca scratchpad ccmem-baseline.txt.

## Progress
Task 0: dispatched (base 49d09a5, implementer sonnet)
Task 0: implementer DONE_WITH_CONCERNS 16c58c8; npm test 760/758/2 fail, both in daemon-stop-wait-budget.test.mjs; controller reran that file alone 3x → 2/2 pass each (flake-1..3.txt).
Ruling: daemon-stop-wait-budget's 2 full-suite failures are a load flake, not a Task 0 regression — alone 3/3 green, no path involvement — cost if wrong: a real lock-timing bug stays unexamined (recorded for the handoff).
Task 0: minor (deferred): REPO_ROOT duplicates existing ROOT in 9 files; no blank line after definitions.
Task 0: complete (commits 49d09a5..16c58c8, review clean; trailer checked)
Task 1: dispatched (base 16c58c8)
Task 1: implementer DONE_WITH_CONCERNS edfa49f (769/769)
Task 1: review → Needs fixes: Important (plan-mandated) project rules starved by global-first ordering (bench: 12 landed, 0 project).
Ruling: stable section order = pinned rows of both scopes (rank order, project pinned first), then project rows up to a 2048-byte share, then global rows fill the rest, then leftover project rows — spec §5.2 names "project match" as a ranking input and the old path injected project rules; the plan's global-then-project text is overridden — cost if wrong: fewer global rules per session (≤2 KB less).
Ruling: a single row larger than the remaining budget is skipped (continue), not a stop — otherwise one long pinned row empties the section — cost if wrong: none material.
Task 1: minor (deferred): per-prompt full member read (7–19 ms measured, acceptable); trim notice on every prompt; retrieved-trim message says 8192B; parseMemberIds duplicated; shadow mode runs selectStableRows.
Task 1: fix round 1/5 (3 addressed, 0 open — project share, oversized skip, cleanup safety; commits edfa49f..3bb7e56)
Task 1: controller bench (reviewer's scratchpad/bench/bench.mjs, 6,211 rows, at 3bb7e56): select 7–11 ms, write 23–71 ms, landed 12, projectLanded 6.
Task 1: minor (deferred): per-row re-render of kept set in buildStableSection (write 23–71 ms on 6k rows); trim notice every hook call.
Task 1: complete (commits 16c58c8..3bb7e56, review clean after 1 round)
Task 2: dispatched (base 3bb7e56)
Task 2: implementer DONE_WITH_CONCERNS 4f4dda1 (777/777). INCIDENT: one real unmocked `claude -p` call during the implementer's first RED run (old refiner ignored mock); cost unknown (not estimated); must be reported to the human.
Task 2: review → spec gap (plan gap): monthly-meta-synthesis.mjs:68,81 silently cuts LLM output (500 then 80 chars) into memory.
Ruling: fold the monthly-meta fix into Task 2 (skipTruncate + refineContentToLimit, reject-audit on ok:false) — spec A2 "any other caller" — cost if wrong: small scope growth.
Ruling: add suite-wide guard CCMEM_CLAUDE_P_COMMAND=${CCMEM_CLAUDE_P_COMMAND:-/usr/bin/false} in scripts/run-tests.sh, and an exhausted mockOutputs array throws (→ refine_failed) — prevents a repeat of the unmocked real call — cost if wrong: a test relying on PATH claude would fail loudly (desired).
Task 2: minor (deferred): precondition assert reading back own value (no-silent-truncation.test.mjs:392); empty first rewrite not re-asked; {"content":""} unwraps to empty; REFINER_SCHEMA hardcodes 500.
Task 2: fix round 1 commit 2e82f91 (782/782): monthly-meta refine-or-reject (80-char W-3 limit kept, loud); exhausted mocks throw; test guard = PATH stub `claude` in run-tests.sh (env-var default broke 13 tests — it enables the bridge).
Ruling: accept the PATH-stub guard instead of the CCMEM_CLAUDE_P_COMMAND default — the env var has semantics (enables bridge, written into plist) — cost if wrong: a test that spawns an absolute claude path bypasses it.
Ruling: published v0.7 spec acceptance #62 greps for slice(0, 80); it no longer matches — record a correction note in the handoff, do not edit the published spec (Rule 13 append-only).
Ruling: weekly-synthesis.mjs:107,116,247 silent 500-char cuts are also A2 "any other caller" — folded into Task 2 as fix round 2, same refine-or-reject pattern.
Task 2: fix round 1+2/5 (6 addressed incl. 2 extra sites synthesis-quality + resurrect merge, 0 open; commits 4f4dda1..d3d99ba)
Task 2: minor (deferred): mockOutputs restart per item; refiner trims fitting text; parseLlmJson default still slices unless skipTruncate (no caller uses default); truncateAtWordBoundary dead code.
Task 2: complete (commits 3bb7e56..d3d99ba, review clean after 2 rounds)
Task 3: dispatched (base d3d99ba)
Task 3: implementer DONE_WITH_CONCERNS 2ac6076 (796/796)
Task 3: review → Needs fixes: list.mjs not showing origin_agent (spec §5.4); minor hardcoded /usr/local/bin/node in 2 new tests — both sent as fix round 1
Task 3: fix round 1/5 (2 addressed, 0 open; commits 2ac6076..dd1c2e5)
Task 3: minor (deferred): list --query/--quarantined/--never-injected modes don't show origin_agent (plain list + show do).
Task 3: complete (commits d3d99ba..dd1c2e5, review clean after 1 round)
Task 4: dispatched (base dd1c2e5)
Task 4: implementer DONE 61d7edf (806/806). Note: origin_agent on summarized memories assigned to Task 5 dispatch (no plan task names it; spec §5.4).
Task 4: ⚠️ resolved by controller: session_context.agent added by migration 017 (Task 3, 2ac6076, before base dd1c2e5).
Task 4: minor (deferred): --agent=codex form unsupported (installers must use space form); COMPACTION_WORDING duplication; tautological "identical across calls" unit test; upsertSessionContext duplicated.
Task 4: complete (commits dd1c2e5..61d7edf, review clean)
Task 5: dispatched (base 61d7edf)
Task 5: implementer DONE_WITH_CONCERNS ce3e1f7 (817/817; real-file counts: codex 6053 lines, omp 12, 0 unparsable). Agent-neutral summarizer prompt is Task 8's.
Task 5: ⚠️ resolved: session_context.agent and insertMemory originAgent come from Task 3 (2ac6076).
Task 5: minor (deferred): ctx.agent / default fallbacks of originAgent untested; .zst notice repeats ~5x per Stop; OMP leaf = last line even without id; inline claude fixture; CCMEM_MARKERS lives in codex.mjs; OMP seq non-monotonic on rewind (harmless, comment suggested).
Task 5: complete (commits 61d7edf..ce3e1f7, review clean)
Task 6: dispatched (base ce3e1f7)
Task 6: implementer DONE_WITH_CONCERNS d6b65b8 (830/830)
Task 6: review → Needs fixes: Important non-atomic writes + unreported residue; minors 1,2,3,6,7 folded into fix round 1.
Task 6: minor (deferred): missing backup blocks uninstall even when unneeded; uninstall index shift revokes trust of later user hooks (document in Task 11); execPath records whichever node ran the CLI (nvm v22 in a demo); trust records persist after uninstall (same definition re-trusted on reinstall); TOML line scan can misread multi-line arrays.
Task 6: fix round 1/5 (5 addressed, 0 open; commits d6b65b8..0ac880d)
Task 6: minor (deferred, for final review): vacuous temp-leak assertion install-codex.test.mjs:372 (lists codexHome not realpath dir); damaged-file branch wording "likely a failed ccmem write" + user's post-install edits only in damaged backup; restore-write failure doesn't name damagedBackup; rename replaces 0444 file / drops owner,xattrs / dangling symlink → regular file; new uninstall CLI lines unasserted.
Task 6: complete (commits ce3e1f7..0ac880d, review clean after 1 round)
Task 7: dispatched (base 0ac880d)
Task 7: implementer DONE_WITH_CONCERNS c23134c (857/857)
Task 7: review → Needs fixes: Important PI_CODING_AGENT_DIR ignored (spec §5.6); Important no session_switch handler (/new,/resume,fork lose the read instruction); minor timer unref/abort folded in.
Ruling: keep session_stop hook awaited (bounded 5 s, matches Claude/Codex) — cost if wrong: up to node-startup latency per OMP turn end.
Task 7: minor (deferred): Bun check script (scratchpad check.ts) not in repo; SQLite ExperimentalWarning in unit test output; OMP profiles to document in Task 11; read instruction re-sent on resume in a new process.
Task 7: fix round 1/5 (3 addressed, 0 open; commits c23134c..2cf19ed)
Task 7: minor (deferred): unref untested; PI_PROFILE-derived inherited PI_CODING_AGENT_DIR edge not mirrored; install message wording static.
Task 7: complete (commits 0ac880d..2cf19ed, review clean after 1 round)
Task 8: dispatched (base 2cf19ed)
Task 8: implementer DONE_WITH_CONCERNS 08a4edb (879/879)
Task 8: review → Needs fixes: Important codex strict-mode schema incompatibility (4/7 schemas); Important (plan-mandated) per-call mkdtemp cwd for claude would create a new ~/.claude/projects dir per call.
Ruling: claude child keeps inheriting the daemon cwd (no per-call cwd); codex/omp keep per-call workDir — the brief's "cwd = fresh mkdtemp" for every child is overridden for claude — cost if wrong: claude summarizer could see a project CLAUDE.md if the daemon cwd were a repo (it is / under launchd).
Ruling: minors 1 (notify=[]), 3 (shared jsonl helpers), 4 (structured timedOut flag) folded into fix round 1; known gaps for Task 11: codex loads $CODEX_HOME/AGENTS.md; llm.models.codex:null cannot drop -m.
Task 8: fix round 1/5 (5 addressed, 0 open; commits 08a4edb..2af8873)
Task 8: minor (deferred): strictSchema skips oneOf/allOf/$defs; strict-shape test doesn't walk anyOf; maxLength kept on the strength of OpenAI docs (verify in paid run); parseJsonLines shared.
Task 8: complete (commits 2cf19ed..2af8873, review clean after 1 round)
Task 9: dispatched (base 2af8873)
Task 9: implementer DONE_WITH_CONCERNS 938e766 (889/889)
Task 9: review → Needs fixes: Important queued work lost after 3 exhausted attempts (G5); Important proposal notice overwritten by first prompt-submit (§5.5).
Ruling: accept deviation — exhausted claude keeps its own 429 retry-after instead of failing fast (spec says record+queue+ask, not fail fast) — cost if wrong: claude retried at retry-after while waiting for approval (now floored ≥60 s and not attempt-capped).
Ruling: exhaustion retries do not consume RETRY_ATTEMPTS_MAX; notice also in prompt-submit and in session-start additionalContext while a proposal is open (changes only then; acceptable cache cost) — cost if wrong: an exhaustion classified wrongly would retry forever at ≥60 s spacing.
Task 9: minors 3–7 folded into fix round 1 (claude usage-limit classifier, stale-approve guard, notice timestamp, reject audit); minor 8 (extra DB opens) deferred.
Task 9: fix round 1/5 (6 addressed, 0 open; commits 938e766..106d44d); re-review minors: seconds-conversion coverage lost; hasUsableApproval branch untested; withDb-failure fallback can drop exhausted codex/omp task; every short claude 429 opened a proposal (noise).
Ruling: a short claude 429 (retry-after < 300 s, no usage-limit text) is NOT exhaustion — pre-Task-9 retry path restored incl. the 9 original assertions; exhaustion = usage-limit text or retry-after ≥ 300 s — cost if wrong: a real quota exhaustion reported only as a short 429 is retried and capped as before (old behavior).
Task 9: fix round 2 dispatched.
Task 9: fix round 2/5 (3 addressed, 0 open; commits 106d44d..ff53055)
Task 9: minor (deferred): unitless retry-after read as ms (pre-existing); real claude usage-limit channel/exit unverified (paid run); approving does not reschedule already-queued tasks; clock-form reset parsed in local time; long comment line + double blank line in claude.mjs/claude-p.mjs; extra DB opens per call.
Task 9: complete (commits 2af8873..ff53055, review clean after 2 rounds)
Task 10: dispatched (base ff53055)
Task 10: implementer DONE_WITH_CONCERNS 8e7d1ce (905/905; TDD order not followed, mutations substitute)
Task 10: minor (deferred): probe has no timeout (same as claude probe); codex/omp-active-with-claude-absent branch untested; tests rely on default backend_order; status says in_sync with PATH benign_changed after backend switch (document: re-run daemon install after changing llm.backend); incapable optional backend dir still on PATH.
Task 10: complete (commits ff53055..8e7d1ce, review clean)
Task 11: dispatched (base 8e7d1ce)
Task 11: implementer DONE_WITH_CONCERNS 69fb107 (905/905)
Task 11: review → Needs fixes: CLAUDE.md residue row false (missing-target uninstall is silent); manifest/.bak leftovers omitted — fix round 1 sent
Task 11: fix round 1/5 (3 addressed, 0 open; commits 69fb107..4a2f79b). Re-review's unconfirmed "Codex hand-edited .bak" resolved by controller: Task 6 fix round confirmed the edited-file uninstall backs up the edited file (review of 0ac880d, codex.mjs edited-file path).
Task 11: complete (commits 8e7d1ce..4a2f79b, review clean after 1 round)
Task 12: dispatched (base 4a2f79b) — free steps only; paid steps listed for the human
Task 12: implementer DONE_WITH_CONCERNS d39d431 (910/910; e2e 51 ok under bun and node; compare-summarizers refuses without --i-approve-paid-calls). Found real bug: context-<8 chars>.md collides for UUIDv7 ids (Codex: 113 shared prefixes among 590 rollouts, names only).
Ruling: context file name = context-<16 hex of sha256(sessionId)>.md for every agent incl. Claude; stale cleanup covers old and new names — UUIDv7 prefixes collide within ~65 s — cost if wrong: one-time orphaned old-name files until the 24 h cleanup.
Task 12: fix round 1 dispatched (before task review, reviewed together).
Task 12: fix round 1 commit 40ec8a4 (911/911; e2e 51 ok). Finding: CCMEM_CONFIG_PATH is set in launchd env (launchctl getenv) — contradicts a config.mjs comment and CLAUDE.md; report to human, not edited.
Task 12: minor (deferred, for final review): compare-summarizers worker mode (CCMEM_COMPARE_WORKER) bypasses approval gate and data-root guard; e2e temp check trusts os.tmpdir(); shallow llm merge in compare plan; README placeholder context-<session>.md; post-merge transition (live session reads old-name file); driver refusal untested; leftover ccmem-ctx-v7-* temp dir in a test.
Task 12: complete (commits 4a2f79b..40ec8a4, review clean incl. fix round 1)
Final review: dispatched (merge base 68e5357)
Final fix wave: 40ec8a4..357398d (924/924 under temp HOME). Concerns: approve --yes is friction not a lock; weekly per-cluster exhaustion still skipped (weekly_synthesis_cluster_failed).
Final fix wave: re-review → all findings addressed (C1, I1, I2, I3, M2, 2 vacuous tests, README, config comment); commits 40ec8a4..357398d.
Final: parked — exhaustion error without retryAfter would now fail the task permanently (latent; real exhaustion errors carry retryAfter) — Ruling: accept, recorded in handoff — cost if wrong: one over-long memory lost as a failed task instead of an audit row.
Final: parked — repeated short 429/timeout past RETRY_ATTEMPTS_MAX ends as failed task without the *_refine_rejected audit text — Ruling: accept (visible as failed task) — cost if wrong: that memory's text not kept in audit.
Final: parked — direct `node --test` runs bypass the temp-HOME isolation; package.json test routes through run-tests.sh, and test-home-isolation.test.mjs fails loudly on a direct run — Ruling: accept.
Final: open for the human — I4 migration-017 merge procedure (handoff §1.0); stray ~/.omp/agent/extensions/ccmem.ts; paid acceptance (spec §7); Task 2 real-call incident.
Final review: complete (branch 68e5357..357398d).
