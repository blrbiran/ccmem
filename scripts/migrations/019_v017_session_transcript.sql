-- ============================================================
-- migrations/019_v017_session_transcript.sql — v0.17 schema
-- (the transcript a session's memories were extracted from)
-- ============================================================
-- Tester #446: a memory has no verifiability dimension. Its provenance lives only
-- inside `audit_log.details` (session_id + transcript_path), and the transcript
-- files are being cleaned by the OS, so nothing can check a memory against what was
-- actually said. This migration puts the one link that the Stop hook already holds
-- (`session_context`) on the row it belongs to, so a future calibration task can ask
-- "what was this session's transcript?" without mining a JSON blob.
--
-- It also unblocks #447: `admin cron run summarize_pending` builds a task payload
-- from `session_context`, and the payload needs exactly this column.
--
-- PRODUCTION NOTE (CLAUDE.md Rule 13): back up the real data root first
-- (runMigration writes <db>.bak.<ms epoch>) and dry-run on a copy. Rollback:
--   1. Stop the daemon, copy the DB aside.
--   2. ALTER TABLE session_context DROP COLUMN transcript_path;
--   3. DELETE FROM schema_migrations WHERE to_version = 19;
--      UPDATE schema_meta SET version = 18;
-- Every statement is additive; no existing row or column is rewritten, and the
-- column is nullable so every pre-existing row stays exactly as it is (NULL).
-- ============================================================

ALTER TABLE session_context ADD COLUMN transcript_path TEXT;

UPDATE schema_meta SET version = 19, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (18, 19, 'v0.17: the transcript a session''s memories came from',
          strftime('%s','now') * 1000, 'ccmem-cli');