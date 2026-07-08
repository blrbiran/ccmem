module.exports = function runV015Repair(db) {
  const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name));
  const now = Date.now();

  db.exec('BEGIN');
  try {
    if (!hasColumn('memories', 'summary_meta')) {
      db.exec('ALTER TABLE memories ADD COLUMN summary_meta TEXT');
    }

    if (!hasTable('query_embedding_cache')) {
      db.exec(`
        CREATE TABLE query_embedding_cache (
          prompt_hash TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          prompt_len INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 1
        )
      `);
      db.exec('CREATE INDEX idx_qec_created ON query_embedding_cache(created_at)');
    }

    const rollupColumns = [
      ['embed_error_rate', 'REAL'],
      ['path_a_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['path_b_fail_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['path_b_off_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['path_b_circuit_count', 'INTEGER NOT NULL DEFAULT 0']
    ];
    for (const [column, sqlType] of rollupColumns) {
      if (!hasColumn('metrics_daily_rollup', column)) {
        db.exec(`ALTER TABLE metrics_daily_rollup ADD COLUMN ${column} ${sqlType}`);
      }
    }

    if (hasColumn('memories', 'temporal_type')) {
      db.prepare("UPDATE memories SET temporal_type = NULL WHERE temporal_type = 'temporary'").run();
    }

    db.prepare('UPDATE schema_meta SET version = 15, applied_at = ?').run(now);
    db.prepare(`
      INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
      SELECT 14, 15, 'v0.12 repair: summary_meta + query_embedding_cache + rollup columns', ?, 'ccmem-cli'
      WHERE NOT EXISTS (
        SELECT 1 FROM schema_migrations WHERE to_version = 15
      )
    `).run(now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
