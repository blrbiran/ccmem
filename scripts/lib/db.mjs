import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');
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

function runV07Migration(db) {
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

export function runMigration(db) {
  const currentVersion = getSchemaVersion(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
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
    if (toVersion === 7) {
      runV07Migration(db);
      continue;
    }

    runSqlMigration(db, file);
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
