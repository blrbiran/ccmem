UPDATE schema_meta
SET version = 5, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (4, 5, 'v0.4 compat schema version alignment', strftime('%s', 'now') * 1000, 'ccmem-cli');
