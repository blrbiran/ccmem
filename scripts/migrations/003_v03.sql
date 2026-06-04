ALTER TABLE memories ADD COLUMN quarantined_at INTEGER;

CREATE INDEX idx_mem_quarantined ON memories(quarantined_at)
  WHERE quarantined_at IS NOT NULL;

CREATE TABLE cross_scope_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  global_mem_id INTEGER NOT NULL,
  project_mem_id INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  similarity REAL NOT NULL,
  evidence TEXT,
  detected_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_action TEXT,
  CHECK (similarity >= 0.0 AND similarity <= 1.0),
  CHECK (
    acknowledged_action IS NULL OR
    acknowledged_action IN ('keep_global', 'keep_project', 'keep_both', 'forget_both')
  )
);

CREATE INDEX idx_alerts_pending ON cross_scope_alerts(detected_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX idx_alerts_global ON cross_scope_alerts(global_mem_id);
CREATE INDEX idx_alerts_project ON cross_scope_alerts(project_mem_id);

UPDATE schema_meta
SET version = 3, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (2, 3, 'v0.3 schema', strftime('%s', 'now') * 1000, 'ccmem-cli');
