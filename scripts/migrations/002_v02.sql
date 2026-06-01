ALTER TABLE memories ADD COLUMN migration_origin TEXT;
ALTER TABLE memories ADD COLUMN last_scanned_patterns_version TEXT;

UPDATE memories
SET migration_origin = 'v0.1_user_explicit'
WHERE migration_origin IS NULL;

UPDATE memories
SET half_life_days = CASE type
  WHEN 'rule' THEN 60
  WHEN 'fact' THEN 30
  WHEN 'episode' THEN 7
  WHEN 'consolidated' THEN 90
END
WHERE half_life_days IS NULL;

CREATE TABLE memory_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  injection_source TEXT NOT NULL,
  injected_ids TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'unknown',
  outcome_locked INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE recent_injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_idx INTEGER NOT NULL,
  inject_source TEXT NOT NULL,
  mem_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, prompt_idx) ON CONFLICT REPLACE
);

CREATE TABLE daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  alive INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ccmem_blacklisted_sessions (
  session_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'cron_llm_child',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE session_context (
  session_id TEXT PRIMARY KEY,
  project_key TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX uniq_tasks_summarize_session_seq
  ON tasks(type, json_extract(payload, '$.session_id'), json_extract(payload, '$.last_message_seq'))
  WHERE type = 'summarize_pending' AND status IN ('queued', 'running');

UPDATE schema_meta
SET version = 2, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (1, 2, 'v0.2 schema', strftime('%s', 'now') * 1000, 'ccmem-cli');
