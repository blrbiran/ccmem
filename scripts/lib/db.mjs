import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');
const BACKUP_DEDUPE_WINDOW_MS = 60_000;

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
    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

export { createMigrationBackup, findReusableMigrationBackup, listMigrationBackups, pruneMigrationBackups };

export function ensureSchema(db) {
  runMigration(db);
}

export function openDb() {
  mkdirSync(getDataRoot(), { recursive: true });
  const db = new DatabaseSync(getDbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}
