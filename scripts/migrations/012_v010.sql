UPDATE schema_meta SET version = 12, applied_at = strftime('%s','now') * 1000;
INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (11, 12, 'v0.10: cache-friendly file-based injection', strftime('%s','now') * 1000, 'ccmem-cli');
