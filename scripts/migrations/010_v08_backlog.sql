ALTER TABLE tasks ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;

UPDATE tasks
SET duration_ms = CASE
  WHEN started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at THEN finished_at - started_at
  ELSE 0
END;

UPDATE task_runs
SET duration_ms = CASE
  WHEN started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at THEN completed_at - started_at
  ELSE 0
END;

UPDATE schema_meta
SET version = 10, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (9, 10, 'v0.8 backlog: task/task_run duration_ms fields', strftime('%s', 'now') * 1000, 'ccmem-cli');
