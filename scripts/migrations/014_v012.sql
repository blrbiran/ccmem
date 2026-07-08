ALTER TABLE memories ADD COLUMN temporal_type TEXT;
ALTER TABLE memories ADD COLUMN summary_meta TEXT;

CREATE TABLE query_embedding_cache (
  prompt_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  prompt_len INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_qec_created ON query_embedding_cache(created_at);

ALTER TABLE metrics_daily_rollup ADD COLUMN embed_error_rate REAL;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_a_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_off_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN path_b_circuit_count INTEGER NOT NULL DEFAULT 0;

UPDATE schema_meta SET version = 14, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
SELECT 13, 14, 'v0.12: temporal_type + summary_meta + query_embedding_cache', strftime('%s','now') * 1000, 'ccmem-cli'
WHERE NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE to_version = 14
);
