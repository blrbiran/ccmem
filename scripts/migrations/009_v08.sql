ALTER TABLE contradiction_alerts RENAME TO contradiction_alerts_old;
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
    acknowledged_action IN ('keep_a', 'keep_b', 'keep_both', 'merged')
  )
);
INSERT INTO contradiction_alerts
SELECT id, mem_id_a, mem_id_b, scope, cosine_similarity, evidence, detected_at, acknowledged_at, acknowledged_action
FROM contradiction_alerts_old;
DROP TABLE contradiction_alerts_old;
CREATE INDEX idx_contra_pending ON contradiction_alerts(detected_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX idx_contra_mem_a ON contradiction_alerts(mem_id_a);
CREATE INDEX idx_contra_mem_b ON contradiction_alerts(mem_id_b);

ALTER TABLE metrics_daily_rollup ADD COLUMN synth_proposed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN synth_accepted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN synth_rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN input_noise_stripped_chars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics_daily_rollup ADD COLUMN quality_gate_rejected INTEGER NOT NULL DEFAULT 0;

UPDATE schema_meta
SET version = 9, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (8, 9, 'v0.8: contradiction_alerts merged action + synthesis quality rollup', strftime('%s', 'now') * 1000, 'ccmem-cli');
