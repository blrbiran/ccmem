ALTER TABLE memories ADD COLUMN embedding BLOB;

UPDATE audit_log
SET ts = ts * 1000
WHERE ts < 10000000000;

ALTER TABLE metrics_daily_rollup ADD COLUMN vec_backfill_embedded INTEGER NOT NULL DEFAULT 0;

UPDATE schema_meta
SET version = 7, applied_at = strftime('%s', 'now') * 1000;

INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
VALUES (6, 7, 'v0.6: embedding BLOB + audit_log ts sec-to-ms + vec_backfill rollup + optional FTS artifacts', strftime('%s', 'now') * 1000, 'ccmem-cli');
