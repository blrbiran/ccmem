-- Rollback: restore the pre-migration global.db.bak.<epoch> with the daemon stopped,
-- or copy reclaimed_ms back to duration_ms for reclaimed rows with a known age,
-- drop reclaimed_ms, remove migration 21's record and reset schema_meta to 20
-- in one transaction with the previous code deployed.
ALTER TABLE tasks ADD COLUMN reclaimed_ms INTEGER;

UPDATE tasks
SET reclaimed_ms = CASE WHEN started_at IS NOT NULL AND finished_at >= started_at THEN duration_ms END,
    duration_ms = 0
WHERE status = 'failed' AND error_excerpt = 'daemon exited while this task was running';

UPDATE schema_meta SET version = 21, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (20, 21, 'Separate orphan reclaim age from task runtime', strftime('%s', 'now') * 1000, 'ccmem-cli');
