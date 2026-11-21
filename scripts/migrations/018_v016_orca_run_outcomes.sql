-- ============================================================
-- migrations/018_v016_orca_run_outcomes.sql — v0.16 schema
-- (Orca run outcomes, phase 1: recorded and listed, never read back)
-- ============================================================
-- Orca writes one terminal outcome per run (spec
-- docs/superpowers/specs/2026-11-21-run-outcome-writeback-design.md §2). This
-- is NOT a memories row: export, retrieval, the stable section and the memory
-- count are untouched (§4). Phase 1 records only; nothing moves trust_score.
--
-- PRODUCTION NOTE (CLAUDE.md Rule 13): before this runs against a real data
-- root, back it up (runMigration writes <db>.bak.<ms epoch>) and dry-run it on
-- a copy. Rollback (downgrade) steps:
--   1. Stop the daemon, copy the DB aside.
--   2. DROP TABLE orca_run_outcomes;
--   3. DELETE FROM schema_migrations WHERE to_version = 18;
--      UPDATE schema_meta SET version = 17;
-- Dropping the table loses the recorded outcomes, which is what the rollback
-- means; no other table or code path references them.
-- Every statement is additive; no existing row or column is rewritten.

CREATE TABLE orca_run_outcomes (
  project_key TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  task_id     TEXT,
  attempt     INTEGER,
  outcome     TEXT NOT NULL,
  abandoned   INTEGER NOT NULL CHECK (abandoned IN (0, 1)),
  memory_ids  TEXT NOT NULL,          -- JSON array of positive integers
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (project_key, run_id)
);

CREATE INDEX idx_orca_run_outcomes_recorded_at
  ON orca_run_outcomes (recorded_at);

UPDATE schema_meta SET version = 18, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (17, 18, 'v0.16: orca run outcomes (recorded only, read-only list)',
          strftime('%s','now') * 1000, 'ccmem-cli');