# Explicit Schema Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep database upgrades and their full backups out of ccmem hooks and ordinary runtime opens.

**Architecture:** `openDb()` initializes an empty database and refuses an older populated schema. `ccmem admin migrate` authorizes a full backup and the existing migration runner. Hooks on an older schema return the appropriate empty response with a diagnostic.

**Tech Stack:** Node.js, `node:sqlite`, `node:test`.

**Spec:** The 2026-11-24 Orca session request to make upgrades explicit after migrations repeatedly exceeded the hook deadline. ccmem `CLAUDE.md` Rule 13 requires a full backup for upgrades.

## Global Constraints

- Run development tests against isolated data roots.
- Keep current-schema and empty-root behavior.
- Preserve existing published backups during the explicit upgrade.

## Review Focus

- Exercise the three hook modes with and without a session ID, because the blacklist check opens the database before dispatch.
- Verify that ordinary CLI opens and `admin migrate --help` leave the old schema and backup set untouched.
- Read the resulting backup as SQLite and verify the old schema and a seeded row.
- Verify a repeated explicit command keeps the same backup set.
- Verify daemon startup refuses an older schema before claiming a lease.

### Task 1 — Upgrade only by explicit request

- [ ] Add an integration test that runs the real hook, CLI and daemon against an isolated schema 19 fixture. Assert valid empty hook output, an actionable diagnostic, schema 19, and no new backups. For `admin migrate`, assert schema 20, one new readable schema 19 snapshot, and preservation of the seeded data and existing backups.
- [ ] Run the integration test against the baseline and observe the implicit upgrade and missing admin verb failures.
- [ ] Add `openDb({ migrate = false } = {})` and `MigrationRequiredError`. Keep legacy migration tests exercising the explicit path when they intend to upgrade an existing fixture. Wire the admin verb before ordinary dispatch and handle the error at hook, CLI and daemon boundaries.
- [ ] Run the targeted test and `npm test` with isolated data roots. Review the complete diff before deploying the verified patch to the checkout used by the installed plugin.

## As built (2026-11-24, Orca session follow-up)

- Incident that motivated it (measured on the real store, read-only): a 1.73 GB store's `VACUUM INTO` took 12.04 s
  against hook limits of 2/5/3 s, so every hook was killed mid-backup, the pending migration never landed, and 226
  orphaned `.global.db.backup-*.partial*` files (131,532,564,480 B) accumulated. They were moved to the macOS Trash
  after `lsof` showed no holder and none had changed within 15 minutes.
- Review round 1 (independent reviewer) and rulings:
  - HIGH 1, a daemon writing between snapshot and migration: fixed. `admin migrate` refuses while a live daemon holds
    the lock (names `ccmem admin daemon stop`). `admin daemon stop` still opens a pending store. For SQL-only
    migrations at version 15 and above, the writer is reserved (`BEGIN IMMEDIATE`) before the snapshot, so the
    snapshot and the migration see the same committed state.
  - HIGH 2, daily maintenance pruning to `migration_backup.max_keep`: Ruling — kept. The upgrade itself deletes
    nothing (it writes its snapshot with `prune:false`), and retention is the user's configured policy.
    Cost if wrong: the oldest of six backups goes at the next daily maintenance; raising `max_keep` keeps it.
  - MEDIUM, journal mode changed before the refusal: fixed. The schema plan is read before `journal_mode = WAL`
    (the criterion uses a DELETE-mode fixture).
  - MEDIUM, concurrent first-time initialisation of an empty root: Ruling — deferred. This predates the change (see
    handoff §2.4 "多进程同时冷启动全新空库"). The explicit path re-reads the version inside its write transaction.
    Cost if wrong: a second process racing a brand-new install reads it as an old store and asks for `admin migrate`.
- Gate: `npm test` 1084/1084 in this worktree. `explicit-migration.test.mjs` 10/10. All 8 original criteria were
  red on the baseline; the 2 review criteria were red before their fixes.
