ALTER TABLE recent_injections ADD COLUMN scores TEXT;

ALTER TABLE metrics_daily_rollup ADD COLUMN inj_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_empty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_avg_fused REAL;
ALTER TABLE metrics_daily_rollup ADD COLUMN inj_never_30d INTEGER NOT NULL DEFAULT 0;

CREATE TABLE promote_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mem_id INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  similar_in TEXT NOT NULL,
  trigger TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_action TEXT,
  CHECK (
    acknowledged_action IS NULL OR
    acknowledged_action IN ('promote', 'dismiss')
  )
);
CREATE INDEX idx_promote_pending ON promote_candidates(detected_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX idx_promote_mem ON promote_candidates(mem_id);

UPDATE schema_meta
SET version = 11, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (10, 11, 'v0.9: injection scores + promote_candidates + injection rollup', strftime('%s', 'now') * 1000, 'ccmem-cli');
