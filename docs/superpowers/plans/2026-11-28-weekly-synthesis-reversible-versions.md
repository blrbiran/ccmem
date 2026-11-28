# Reversible Weekly Synthesis Versions Implementation Plan

> **For agentic workers:** This plan is executed directly by the issue #569 owner in the isolated worktree; complete each task in order and keep the issue ledger and handoff untouched.

**Goal:** Preserve weekly synthesis merge inputs unchanged and provide `ccmem revert <id>` to undo a current merged version.

**Architecture:** Add nullable lineage links and a version number to memory rows. Weekly synthesis inserts a new row derived from the selected keep row, then atomically points every source at it and supersedes them. A CLI command reverses one such direct merge in an immediate transaction, audits the action and rebuilds the affected injection cache.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, SQL migrations, `node:test` integration tests.

**Spec:** `docs/superpowers/specs/2026-11-28-weekly-synthesis-reversible-versions.md`

## Global Constraints

- Keep every source `content` byte-identical during merge and revert.
- Existing rows migrate with `version = 1`; lineage links start as `NULL`.
- The merge creates exactly one new memory row; all source rows point to its id.
- Retrieval continues to select `status = 'active'` rows only.
- Revert accepts only a current merge row with at least one direct source, no successor, and `decay_status` in `('active', 'probation')`; changes, audit, and cache rebuild must be atomic or occur only after commit.
- All tests and migration checks use isolated temporary data roots; do not read or write production data or operate the daemon.
- Historical specs, issue ledger, and handoff are not edited in this task.

## Review Focus

- A three-source merge, including mixed existing lineage roots, must choose the earliest root deterministically and point all sources to the inserted version.
- A failed/over-limit/refiner-rejected merge must leave source rows and row count unchanged.
- A merge scoped to one project or the global scope must rebuild only the corresponding cache and preserve metadata from the selected keep row.
- Reverting a non-merge row, archived or candidate-expired merge, missing/partial source links, or a row with a successor must refuse without changing rows or audit.
- A valid revert must restore source statuses (including source decay status), mark the merge row superseded, write one audit row, and restore active retrieval/cache membership.

---

### Task 1: Add lineage schema migration

**Files:**
- Create: `scripts/migrations/022_reversible_synthesis_versions.sql`
- Test: `tests/integration/explicit-migration.test.mjs`

**Interfaces:**
- Produces: schema version 22 with `memories.version INTEGER NOT NULL DEFAULT 1`, `root_id INTEGER`, `parent_id INTEGER`, `superseded_by INTEGER`.

- [ ] **Step 1: Add the migration test**

  Extend the isolated explicit-migration fixture to build a version-21 database, run `admin migrate`, assert schema 22, verify all four columns and their declared default/nullability, and assert an existing memory remains version 1 with null lineage links. Add a test-local SQLite rollback sequence based on the migration comment and assert it restores version 21 and removes only the four new columns.

- [ ] **Step 2: Run the new test and confirm the missing migration fails it**

  Run: `env -u CCMEM_CONFIG_PATH CCMEM_INSTALL_NODE_PATH=/usr/local/bin/node NODE_OPTIONS=--no-warnings sh scripts/run-tests.sh tests/integration/explicit-migration.test.mjs`

  Expected: FAIL because schema 22 and lineage columns are absent.

- [ ] **Step 3: Implement migration 022**

  Add the four columns, update `schema_meta` to 22, record the migration, and include rollback instructions that drop the new columns, delete migration 22's row, and reset the version to 21 in one transaction with the daemon stopped. Keep existing memory values untouched.

- [ ] **Step 4: Run the migration test**

  Run the same command as Step 2.

  Expected: PASS, including isolated rollback assertions.

### Task 2: Preserve weekly merge sources

**Files:**
- Modify: `scripts/daemon/tasks/weekly-synthesis.mjs`
- Test: `tests/integration/weekly-synthesis-no-silent-truncation.test.mjs`

**Interfaces:**
- Consumes: migration 022 columns.
- Produces: one new version row per accepted `merged_duplicates` item; all selected sources are linked to it and superseded in the same transaction.

- [ ] **Step 1: Add a failing three-source merge regression**

  Add a test with three active memories of distinct contents and representative metadata. Run a mocked accepted merge and assert that row count grows by exactly one; original contents and selected-source metadata remain unchanged; every source has `status='superseded'` and `superseded_by` equal to the inserted id; the new row has the merged content, version `max(source.version)+1`, parent equal to the first selected source, and the earliest source root. Assert the active selector returns only the merge row.

- [ ] **Step 2: Run the targeted test and confirm it fails on the current overwrite behavior**

  Run: `env -u CCMEM_CONFIG_PATH CCMEM_INSTALL_NODE_PATH=/usr/local/bin/node NODE_OPTIONS=--no-warnings sh scripts/run-tests.sh tests/integration/weekly-synthesis-no-silent-truncation.test.mjs`

  Expected: FAIL on row-count/source-content assertions before implementation.

- [ ] **Step 3: Implement atomic version insertion**

  Replace the in-place content update with a `BEGIN IMMEDIATE` transaction. Copy the selected keep row's memory metadata into a new row, set merged content and timestamps, assign lineage/version fields, point every selected source at the inserted id and set each source status to `superseded`, then write `synthesis_dedup_merged` with the new id and source ids. Do not use `insertMemory`, which re-runs the user-save path and changes its write semantics. Preserve the existing refiner rejection behavior.

- [ ] **Step 4: Run the targeted weekly synthesis test**

  Run the same command as Step 2.

  Expected: PASS, including existing reject/refiner tests.

### Task 3: Add safe merge revert command

**Files:**
- Create: `scripts/lib/cmd/revert.mjs`
- Modify: `scripts/cli.mjs`, `README.md`, `commands/resurrect.md` only if it currently owns shared command guidance; otherwise add `commands/revert.md` and update the README command list.
- Test: Create `tests/integration/revert-command.test.mjs`

**Interfaces:**
- Produces: `cmdRevert(db, { id })` returning `{ status: 'reverted', id, restoredIds }`, `{ status: 'not_found' }`, or `{ status: 'unsupported', reason }`.

- [ ] **Step 1: Add failing module and CLI tests**

  Cover a valid three-source revert and assert original source statuses/content are restored, the merge row becomes superseded, the audit action is `memory_reverted`, and active retrieval returns the originals. Cover invalid id parsing at CLI boundary, unknown id, non-merge row, archived and candidate-expired merge rows, a source set that is incomplete, and a merge row with an existing successor. For every refused case, snapshot and compare affected memory rows and audit row count before/after.

- [ ] **Step 2: Run the new test and confirm it fails before implementation**

  Run: `env -u CCMEM_CONFIG_PATH CCMEM_INSTALL_NODE_PATH=/usr/local/bin/node NODE_OPTIONS=--no-warnings sh scripts/run-tests.sh tests/integration/revert-command.test.mjs`

  Expected: FAIL because `revert` is not a recognized command.

- [ ] **Step 3: Implement the command**

  Parse the id with `parseMemoryId`. In `cmdRevert`, begin an immediate transaction, require a target with `status='active'`, `decay_status` `active` or `probation`, `parent_id`, and no `superseded_by`, require at least one direct source and verify all linked sources are superseded and point back to this id, mark the target superseded, restore direct sources to `active` without changing decay status, and write one `memory_reverted` audit record naming the reverted id and restored source ids. Roll back on any refusal or write error. After a successful commit, rebuild the affected project/global injection cache. Wire CLI help, early id validation, dispatch, and clear success/not-found/refusal exit behavior consistently with existing memory commands.

- [ ] **Step 4: Run revert and weekly synthesis tests**

  Run: `env -u CCMEM_CONFIG_PATH CCMEM_INSTALL_NODE_PATH=/usr/local/bin/node NODE_OPTIONS=--no-warnings sh scripts/run-tests.sh tests/integration/revert-command.test.mjs tests/integration/weekly-synthesis-no-silent-truncation.test.mjs`

  Expected: PASS, including rejection and no-mutation cases.

### Task 4: Review and verify the issue patch

**Files:**
- Review all changes since `07195ae`.

- [ ] **Step 1: Review the full diff for scope, transaction boundaries, metadata preservation, cache effects, and migration rollback accuracy**

- [ ] **Step 2: Run the issue-specific verification set**

  Run: `env -u CCMEM_CONFIG_PATH CCMEM_INSTALL_NODE_PATH=/usr/local/bin/node NODE_OPTIONS=--no-warnings sh scripts/run-tests.sh tests/integration/explicit-migration.test.mjs tests/integration/weekly-synthesis-no-silent-truncation.test.mjs tests/integration/revert-command.test.mjs`

  Expected: PASS with all issue-specific files reported and no production paths used.

- [ ] **Step 3: Confirm clean final diff scope and report the branch without pushing**

  Run: `rtk git status --short --branch` and `rtk git diff --check`.

  Expected: only issue #569 code, tests, migration, README/command guidance, and the new spec/plan are changed; no issue ledger, handoff, production data, or daemon changes.
