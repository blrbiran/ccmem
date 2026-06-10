CREATE TABLE schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT INTO schema_meta (version, applied_at)
VALUES (1, strftime('%s', 'now') * 1000);

CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  applied_by TEXT NOT NULL,
  rollback_sql TEXT,
  CHECK (applied_by IN ('ccmem-cli', 'manual', 'upgrade-script'))
);

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (0, 1, 'v0.1 initial schema', strftime('%s', 'now') * 1000, 'ccmem-cli');

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  project_key TEXT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  trust_score REAL NOT NULL DEFAULT 1.0,
  consolidation_depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  decay_status TEXT NOT NULL DEFAULT 'active',
  half_life_days INTEGER,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  unhelpful_count INTEGER NOT NULL DEFAULT 0,
  parent_ids TEXT,
  trust_summary TEXT,
  last_touched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tags TEXT,
  CHECK (scope IN ('global', 'project')),
  CHECK (type IN ('rule', 'fact', 'episode', 'consolidated')),
  CHECK (source IN ('user_explicit', 'tool_output', 'auto_inferred', 'cron_consolidated', 'cerebrum_import', 'external'))
);

CREATE TABLE injection_cache (
  scope TEXT PRIMARY KEY,
  rendered_text TEXT NOT NULL,
  member_ids TEXT NOT NULL,
  rendered_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  affected_ids TEXT,
  details TEXT
);

CREATE TABLE audit_log_targets (
  audit_id INTEGER NOT NULL,
  mem_id INTEGER NOT NULL,
  PRIMARY KEY (audit_id, mem_id)
);

CREATE TABLE config_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT,
  scheduled_for INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_excerpt TEXT
);

CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  date_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  ran_by TEXT,
  UNIQUE(type, date_key)
);
