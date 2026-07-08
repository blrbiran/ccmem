import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');
const require = createRequire(import.meta.url);
const BACKUP_DEDUPE_WINDOW_MS = 60_000;
let cachedFtsSupport;

export function getDataRoot() {
  return process.env.CCMEM_DATA_ROOT ?? path.join(os.homedir(), '.claude', 'ccmem');
}

export function getDbPath() {
  return path.join(getDataRoot(), 'global.db');
}

export function getSchemaVersion(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
  if (!row) {
    return 0;
  }

  return db.prepare('SELECT version FROM schema_meta LIMIT 1').get().version;
}

function listMigrationBackups(dbPath = getDbPath()) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((file) => file.startsWith(`${base}.bak.`))
    .map((file) => ({
      file,
      path: path.join(dir, file),
      ts: Number(file.slice(`${base}.bak.`.length)) || 0
    }))
    .sort((a, b) => b.ts - a.ts);
}

function pruneMigrationBackups(dbPath = getDbPath(), maxKeep = Number(loadConfig().migration_backup?.max_keep ?? 5)) {
  if (!Number.isFinite(maxKeep) || maxKeep < 0) {
    return;
  }

  for (const backup of listMigrationBackups(dbPath).slice(maxKeep)) {
    rmSync(backup.path, { force: true });
  }
}

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

function findReusableMigrationBackup(dbPath = getDbPath(), now = Date.now()) {
  const currentSize = fileSize(dbPath);
  if (!Number.isFinite(currentSize)) {
    return null;
  }

  for (const backup of listMigrationBackups(dbPath)) {
    if ((now - backup.ts) > BACKUP_DEDUPE_WINDOW_MS) {
      break;
    }

    if (fileSize(backup.path) === currentSize) {
      return backup.path;
    }
  }

  return null;
}

function createMigrationBackup(dbPath = getDbPath()) {
  if (!existsSync(dbPath)) {
    return null;
  }

  const reusableBackup = findReusableMigrationBackup(dbPath);
  if (reusableBackup) {
    return reusableBackup;
  }

  const backupPath = `${dbPath}.bak.${Date.now()}`;
  copyFileSync(dbPath, backupPath);
  pruneMigrationBackups(dbPath);
  return backupPath;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1").get(tableName));
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function triggerExists(db, triggerName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1").get(triggerName));
}

function tableSql(db, tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName)?.sql ?? '';
}

function dropTriggerIfExists(db, triggerName) {
  if (triggerExists(db, triggerName)) {
    db.exec(`DROP TRIGGER ${triggerName}`);
  }
}

function migrationRecorded(db, toVersion) {
  return Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE to_version = ? LIMIT 1').get(toVersion));
}

function ftsDisabledByEnv() {
  return process.env.CCMEM_DISABLE_FTS5 === '1';
}

function supportsFts(db) {
  if (ftsDisabledByEnv()) {
    return false;
  }
  if (cachedFtsSupport !== undefined) {
    return cachedFtsSupport;
  }

  try {
    if (tableExists(db, 'ccmem_fts_probe')) {
      db.exec('DROP TABLE ccmem_fts_probe');
    }
    db.exec("CREATE VIRTUAL TABLE ccmem_fts_probe USING fts5(content, tokenize='trigram')");
    db.exec('DROP TABLE ccmem_fts_probe');
    cachedFtsSupport = true;
  } catch {
    try {
      if (tableExists(db, 'ccmem_fts_probe')) {
        db.exec('DROP TABLE ccmem_fts_probe');
      }
    } catch {}
    cachedFtsSupport = false;
  }

  return cachedFtsSupport;
}

export function hasUsableFts(db) {
  return supportsFts(db) && tableExists(db, 'memories_fts');
}

function runInTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function runSqlMigration(db, file) {
  runInTransaction(db, () => {
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  });
}

function runJsMigration(db, file) {
  const migration = require(path.join(MIGRATIONS_DIR, file));
  if (typeof migration !== 'function') {
    throw new Error(`Invalid JS migration: ${file}`);
  }
  migration(db);
}

function runVersionedMigration(db, file) {
  if (file.endsWith('.sql')) {
    runSqlMigration(db, file);
    return;
  }
  if (file.endsWith('.cjs')) {
    runJsMigration(db, file);
    return;
  }
  throw new Error(`Unsupported migration type: ${file}`);
}

function ensureTrigger(db, triggerName, sql) {
  if (!triggerExists(db, triggerName)) {
    db.exec(sql);
  }
}

function rebuildFtsIndex(db) {
  db.exec('DELETE FROM memories_fts');
  db.exec(`
    INSERT INTO memories_fts(rowid, content)
    SELECT id, content FROM memories;
  `);
}

function reconcileFtsArtifacts(db, { rebuild = false, transactional = true } = {}) {
  const work = () => {
    if (!supportsFts(db)) {
      dropTriggerIfExists(db, 'memories_ai');
      dropTriggerIfExists(db, 'memories_ad');
      dropTriggerIfExists(db, 'memories_au');
      return false;
    }

    const hadTable = tableExists(db, 'memories_fts');
    const missingInsertTrigger = !triggerExists(db, 'memories_ai');
    const missingDeleteTrigger = !triggerExists(db, 'memories_ad');
    const missingUpdateTrigger = !triggerExists(db, 'memories_au');

    if (!hadTable) {
      db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='trigram')");
    }

    ensureTrigger(db, 'memories_ai', `
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    ensureTrigger(db, 'memories_ad', `
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
      END;
    `);
    ensureTrigger(db, 'memories_au', `
      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    if (!hadTable || missingInsertTrigger || missingDeleteTrigger || missingUpdateTrigger || rebuild) {
      rebuildFtsIndex(db);
    }

    return true;
  };

  return transactional ? runInTransaction(db, work) : work();
}

function runV06Migration(db) {
  runInTransaction(db, () => {
    const fromVersion = getSchemaVersion(db);
    const now = Date.now();

    if (!columnExists(db, 'memories', 'embedding')) {
      db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
    }

    db.exec(`
      UPDATE audit_log
      SET ts = ts * 1000
      WHERE ts < 10000000000;
    `);

    if (!columnExists(db, 'metrics_daily_rollup', 'vec_backfill_embedded')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN vec_backfill_embedded INTEGER NOT NULL DEFAULT 0');
    }

    reconcileFtsArtifacts(db, { rebuild: true, transactional: false });

    db.prepare('UPDATE schema_meta SET version = 7, applied_at = ?').run(now);
    if (!migrationRecorded(db, 7)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 7, 'v0.6: embedding BLOB + audit_log ts sec-to-ms + vec_backfill rollup + optional FTS artifacts', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
  });
}

function runV07Migration(db) {
  runInTransaction(db, () => {
    const fromVersion = getSchemaVersion(db);
    const now = Date.now();

    if (!tableExists(db, 'contradiction_alerts')) {
      db.exec(`
        CREATE TABLE contradiction_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mem_id_a INTEGER NOT NULL,
          mem_id_b INTEGER NOT NULL,
          scope TEXT NOT NULL,
          cosine_similarity REAL NOT NULL,
          evidence TEXT,
          detected_at INTEGER NOT NULL,
          acknowledged_at INTEGER,
          acknowledged_action TEXT,
          CHECK (cosine_similarity >= 0.0 AND cosine_similarity <= 1.0),
          CHECK (
            acknowledged_action IS NULL OR
            acknowledged_action IN ('keep_a', 'keep_b', 'keep_both')
          )
        )
      `);
      db.exec(`
        CREATE INDEX idx_contra_pending ON contradiction_alerts(detected_at)
          WHERE acknowledged_at IS NULL
      `);
      db.exec(`CREATE INDEX idx_contra_mem_a ON contradiction_alerts(mem_id_a)`);
      db.exec(`CREATE INDEX idx_contra_mem_b ON contradiction_alerts(mem_id_b)`);
    }

    if (!columnExists(db, 'metrics_daily_rollup', 'contra_detected')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN contra_detected INTEGER NOT NULL DEFAULT 0');
    }

    db.prepare('UPDATE schema_meta SET version = 8, applied_at = ?').run(now);
    if (!migrationRecorded(db, 8)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 8, 'v0.7: contradiction_alerts + contra_detected rollup + meta-synthesis', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
  });
}

function runV08Migration(db) {
  runInTransaction(db, () => {
    const fromVersion = getSchemaVersion(db);
    const now = Date.now();
    const contradictionSql = tableSql(db, 'contradiction_alerts');

    if (!/merged/.test(contradictionSql)) {
      db.exec('ALTER TABLE contradiction_alerts RENAME TO contradiction_alerts_old');
      db.exec(`
        CREATE TABLE contradiction_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mem_id_a INTEGER NOT NULL,
          mem_id_b INTEGER NOT NULL,
          scope TEXT NOT NULL,
          cosine_similarity REAL NOT NULL,
          evidence TEXT,
          detected_at INTEGER NOT NULL,
          acknowledged_at INTEGER,
          acknowledged_action TEXT,
          CHECK (cosine_similarity >= 0.0 AND cosine_similarity <= 1.0),
          CHECK (
            acknowledged_action IS NULL OR
            acknowledged_action IN ('keep_a', 'keep_b', 'keep_both', 'merged')
          )
        )
      `);
      db.exec(`
        INSERT INTO contradiction_alerts
        SELECT id, mem_id_a, mem_id_b, scope, cosine_similarity, evidence, detected_at, acknowledged_at, acknowledged_action
        FROM contradiction_alerts_old
      `);
      db.exec('DROP TABLE contradiction_alerts_old');
      db.exec(`CREATE INDEX idx_contra_pending ON contradiction_alerts(detected_at) WHERE acknowledged_at IS NULL`);
      db.exec(`CREATE INDEX idx_contra_mem_a ON contradiction_alerts(mem_id_a)`);
      db.exec(`CREATE INDEX idx_contra_mem_b ON contradiction_alerts(mem_id_b)`);
    }

    if (!columnExists(db, 'metrics_daily_rollup', 'synth_proposed')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN synth_proposed INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'synth_accepted')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN synth_accepted INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'synth_rejected')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN synth_rejected INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'input_noise_stripped_chars')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN input_noise_stripped_chars INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'quality_gate_rejected')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN quality_gate_rejected INTEGER NOT NULL DEFAULT 0');
    }

    db.prepare('UPDATE schema_meta SET version = 9, applied_at = ?').run(now);
    if (!migrationRecorded(db, 9)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 9, 'v0.8: contradiction_alerts merged action + synthesis quality rollup', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
  });
}

function runV08BacklogMigration(db) {
  runInTransaction(db, () => {
    const fromVersion = getSchemaVersion(db);
    const now = Date.now();

    if (!columnExists(db, 'tasks', 'duration_ms')) {
      db.exec('ALTER TABLE tasks ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'task_runs', 'duration_ms')) {
      db.exec('ALTER TABLE task_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0');
    }

    db.exec(`
      UPDATE tasks
      SET duration_ms = CASE
        WHEN started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at THEN finished_at - started_at
        ELSE 0
      END
    `);
    db.exec(`
      UPDATE task_runs
      SET duration_ms = CASE
        WHEN started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at THEN completed_at - started_at
        ELSE 0
      END
    `);

    db.prepare('UPDATE schema_meta SET version = 10, applied_at = ?').run(now);
    if (!migrationRecorded(db, 10)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 10, 'v0.8 backlog: task/task_run duration_ms fields', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
  });
}

function runV09Migration(db) {
  runInTransaction(db, () => {
    const fromVersion = getSchemaVersion(db);
    const now = Date.now();

    if (!columnExists(db, 'recent_injections', 'scores')) {
      db.exec('ALTER TABLE recent_injections ADD COLUMN scores TEXT');
    }

    if (!columnExists(db, 'metrics_daily_rollup', 'inj_total')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN inj_total INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'inj_empty')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN inj_empty INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'inj_avg_fused')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN inj_avg_fused REAL');
    }
    if (!columnExists(db, 'metrics_daily_rollup', 'inj_never_30d')) {
      db.exec('ALTER TABLE metrics_daily_rollup ADD COLUMN inj_never_30d INTEGER NOT NULL DEFAULT 0');
    }

    if (!tableExists(db, 'promote_candidates')) {
      db.exec(`
        CREATE TABLE promote_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mem_id INTEGER NOT NULL,
          project_key TEXT NOT NULL,
          similar_in TEXT NOT NULL,
          trigger TEXT NOT NULL,
          detected_at INTEGER NOT NULL,
          acknowledged_at INTEGER,
          acknowledged_action TEXT,
          CHECK (
            acknowledged_action IS NULL OR
            acknowledged_action IN ('promote', 'dismiss')
          )
        )
      `);
      db.exec(`
        CREATE INDEX idx_promote_pending ON promote_candidates(detected_at)
          WHERE acknowledged_at IS NULL
      `);
      db.exec(`CREATE INDEX idx_promote_mem ON promote_candidates(mem_id)`);
    }

    db.prepare('UPDATE schema_meta SET version = 11, applied_at = ?').run(now);
    if (!migrationRecorded(db, 11)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 11, 'v0.9: injection scores + promote_candidates + injection rollup', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
  });
}

function runSpecialMigration(db, toVersion) {
  if (toVersion === 7) {
    runV06Migration(db);
    return true;
  }

  if (toVersion === 8) {
    runV07Migration(db);
    return true;
  }

  if (toVersion === 9) {
    runV08Migration(db);
    return true;
  }

  if (toVersion === 10) {
    runV08BacklogMigration(db);
    return true;
  }

  if (toVersion === 11) {
    runV09Migration(db);
    return true;
  }

  return false;
}

export function runMigration(db) {
  let currentVersion = getSchemaVersion(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') || file.endsWith('.cjs'))
    .sort();
  const pending = files.filter((file) => Number(file.split('_', 1)[0]) > currentVersion);

  if (!pending.length) {
    return;
  }

  if (currentVersion > 0) {
    createMigrationBackup();
  }

  for (const file of pending) {
    const toVersion = Number(file.split('_', 1)[0]);
    if (runSpecialMigration(db, toVersion)) {
      currentVersion = getSchemaVersion(db);
      continue;
    }

    runVersionedMigration(db, file);
    currentVersion = getSchemaVersion(db);
  }
}

export { createMigrationBackup, findReusableMigrationBackup, listMigrationBackups, pruneMigrationBackups };

export function ensureSchema(db) {
  runMigration(db);
  reconcileFtsArtifacts(db);
}

export function openDb() {
  mkdirSync(getDataRoot(), { recursive: true });
  const db = new DatabaseSync(getDbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}
