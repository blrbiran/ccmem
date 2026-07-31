-- ============================================================
-- migrations/016_v013.sql — v0.13 schema (embedding signature)
-- ============================================================

-- Every stored vector records which (provider, model, dim) produced it.
-- NULL means "written by v0.12 or earlier, provenance unknown" -> treated as stale.
ALTER TABLE memories ADD COLUMN embedding_sig TEXT;

CREATE INDEX idx_memories_embedding_sig
  ON memories(embedding_sig) WHERE embedding IS NOT NULL;

UPDATE schema_meta SET version = 16, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
  VALUES (15, 16, 'v0.13: embedding_sig for model/dim versioning',
          strftime('%s','now') * 1000, 'ccmem-cli');
