-- ============================================================
-- migrations/017_v015_agents.sql — v0.15 schema (agent provenance, backend state)
-- ============================================================

-- PRODUCTION NOTE (CLAUDE.md Rule 13): before this runs against a real data
-- root, back it up (runMigration already writes <db>.bak.<ms epoch>), dry-run
-- it on a copy, and keep these rollback steps:
--   1. Stop the daemon, copy the DB aside.
--   2. DROP TABLE llm_switch_proposals;
--      DROP TABLE llm_backend_state;
--   3. ALTER TABLE session_context DROP COLUMN agent;
--      ALTER TABLE memories DROP COLUMN origin_agent;
--      (DROP COLUMN needs SQLite >= 3.35; on older builds restore the .bak file.)
--   4. DELETE FROM schema_migrations WHERE to_version = 17;
--      UPDATE schema_meta SET version = 16;
-- Every statement is additive; no existing row or column is rewritten.

-- Which agent wrote a memory. NULL = written before this migration / unknown.
ALTER TABLE memories ADD COLUMN origin_agent TEXT
  CHECK (origin_agent IN ('claude-code','codex','omp'));

-- Which agent a session came from. NULL = pre-017 session (a Claude Code one).
ALTER TABLE session_context ADD COLUMN agent TEXT;

-- Per-backend exhaustion record used by LLM failover.
CREATE TABLE llm_backend_state (
  backend         TEXT PRIMARY KEY,
  exhausted_until INTEGER,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

-- Backend switches proposed to the human; nothing switches without approved_at.
CREATE TABLE llm_switch_proposals (
  id            INTEGER PRIMARY KEY,
  from_backend  TEXT NOT NULL,
  to_backend    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  superseded_at INTEGER
);

UPDATE schema_meta SET version = 17, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (16, 17, 'v0.15: origin_agent, session agent, llm backend state',
          strftime('%s','now') * 1000, 'ccmem-cli');
