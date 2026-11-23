-- ============================================================
-- migrations/020_v018_memory_provenance.sql — v0.18 schema
-- (the session and transcript a memory came from)
-- ============================================================
-- Tester #446: a memory had no verifiability dimension. Its provenance existed only in
-- `audit_log.details` (session_id + transcript_path, 1214 rows with 83.5% of active
-- memories reverse-linked), and the transcript files are being cleaned by the OS — 71%
-- of the paths audit names were already gone. Two nullable columns put the link on the
-- row it belongs to, so a calibration task can ask "what was this session's transcript?"
-- without mining a JSON blob, and a memory whose transcript has vanished says so.
--
-- Existing rows keep NULL: the audit log still holds what is knowable for them, and a
-- backfill is a separate, opt-in step (it would rewrite user data).
--
-- PRODUCTION NOTE (CLAUDE.md Rule 13): back up the real data root first
-- (runMigration writes <db>.bak.<ms epoch>) and dry-run on a copy. Rollback:
--   1. Stop the daemon, copy the DB aside.
--   2. ALTER TABLE memories DROP COLUMN session_id;
--      ALTER TABLE memories DROP COLUMN transcript_path;
--   3. DELETE FROM schema_migrations WHERE to_version = 20;
--      UPDATE schema_meta SET version = 19;
-- Every statement is additive; no existing row or column is rewritten, and both columns
-- are nullable so every pre-existing row stays exactly as it is.
-- ============================================================

ALTER TABLE memories ADD COLUMN session_id TEXT;
ALTER TABLE memories ADD COLUMN transcript_path TEXT;

CREATE INDEX idx_memories_session_id ON memories (session_id) WHERE session_id IS NOT NULL;

UPDATE schema_meta SET version = 20, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (19, 20, 'v0.18: the session and transcript a memory came from',
          strftime('%s','now') * 1000, 'ccmem-cli');