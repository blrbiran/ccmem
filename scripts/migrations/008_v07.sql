CREATE TABLE contradiction_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mem_id_a INTEGER NOT NULL,
  mem_id_b INTEGER NOT NULL,
  scope TEXT NOT NULL,
  cosine_similarity REAL NOT NULL,
  evidence TEXT,
  detected_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_action TEXT,
  CHECK (cosine_similarity >= 0.0 AND cosine_similarity <= 1.0),
  CHECK (
    acknowledged_action IS NULL OR
    acknowledged_action IN ('keep_a', 'keep_b', 'keep_both')
  )
);

CREATE INDEX idx_contra_pending ON contradiction_alerts(detected_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX idx_contra_mem_a ON contradiction_alerts(mem_id_a);
CREATE INDEX idx_contra_mem_b ON contradiction_alerts(mem_id_b);

ALTER TABLE metrics_daily_rollup ADD COLUMN contra_detected INTEGER NOT NULL DEFAULT 0;

UPDATE schema_meta
SET version = 8, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (7, 8, 'v0.7: contradiction_alerts + contra_detected rollup + meta-synthesis', strftime('%s', 'now') * 1000, 'ccmem-cli');
