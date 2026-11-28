-- ============================================================
-- migrations/022_reversible_synthesis_versions.sql
-- Reversible weekly synthesis versions
-- ============================================================
-- Rollback (only on a copy, with the daemon stopped):
--   BEGIN IMMEDIATE;
--   ALTER TABLE memories DROP COLUMN superseded_by;
--   ALTER TABLE memories DROP COLUMN parent_id;
--   ALTER TABLE memories DROP COLUMN root_id;
--   ALTER TABLE memories DROP COLUMN version;
--   DELETE FROM schema_migrations WHERE to_version = 22;
--   UPDATE schema_meta SET version = 21;
--   COMMIT;
-- Or restore the pre-migration global.db.bak.<epoch> with all database
-- clients stopped. Existing memory rows are not otherwise rewritten.

ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN root_id INTEGER;
ALTER TABLE memories ADD COLUMN parent_id INTEGER;
ALTER TABLE memories ADD COLUMN superseded_by INTEGER;

UPDATE schema_meta SET version = 22, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (21, 22, 'Reversible weekly synthesis versions', strftime('%s','now') * 1000, 'ccmem-cli');
