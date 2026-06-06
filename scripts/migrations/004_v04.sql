CREATE TABLE metrics_daily_rollup (
  day_key TEXT PRIMARY KEY,
  hook_session_start_p50 REAL,
  hook_session_start_p95 REAL,
  hook_prompt_submit_p50 REAL,
  hook_prompt_submit_p95 REAL,
  hook_stop_p50 REAL,
  hook_stop_p95 REAL,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  llm_total_duration_ms INTEGER NOT NULL DEFAULT 0,
  llm_failures INTEGER NOT NULL DEFAULT 0,
  llm_dead_letters INTEGER NOT NULL DEFAULT 0,
  sec_quarantined INTEGER NOT NULL DEFAULT 0,
  sec_alerts_emitted INTEGER NOT NULL DEFAULT 0,
  reval_quarantined INTEGER NOT NULL DEFAULT 0,
  reval_flagged INTEGER NOT NULL DEFAULT 0,
  reval_scanned INTEGER NOT NULL DEFAULT 0,
  tier15_clusters INTEGER NOT NULL DEFAULT 0,
  mems_active INTEGER NOT NULL DEFAULT 0,
  mems_probation INTEGER NOT NULL DEFAULT 0,
  mems_quarantine INTEGER NOT NULL DEFAULT 0,
  mems_archived INTEGER NOT NULL DEFAULT 0,
  written_at INTEGER NOT NULL
);

CREATE INDEX idx_rollup_written ON metrics_daily_rollup(written_at);

UPDATE schema_meta
SET version = 4, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (3, 4, 'v0.4: metrics_daily_rollup + revalidation audit actions', strftime('%s', 'now') * 1000, 'ccmem-cli');
