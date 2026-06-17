CREATE TABLE IF NOT EXISTS context_snapshots (
  content_hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS context_write_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_idx INTEGER,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  written INTEGER NOT NULL,
  written_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cwl_session ON context_write_log(session_id, prompt_idx);
CREATE INDEX IF NOT EXISTS idx_cwl_time ON context_write_log(written_at);

UPDATE schema_meta SET version = 13, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
SELECT 12, 13, 'v0.11: context_snapshots + context_write_log for write history', strftime('%s','now') * 1000, 'ccmem-cli'
WHERE NOT EXISTS (
  SELECT 1 FROM schema_migrations WHERE to_version = 13
);
