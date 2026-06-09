UPDATE schema_meta
SET version = 6, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (5, 6, 'v0.5: self-restart, cron config, and backup hygiene', strftime('%s', 'now') * 1000, 'ccmem-cli');
