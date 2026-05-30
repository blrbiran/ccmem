import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');

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

export function runMigration(db) {
  const currentVersion = getSchemaVersion(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const fileVersion = Number(file.split('_', 1)[0]);
    if (fileVersion <= currentVersion) {
      continue;
    }

    if (existsSync(getDbPath())) {
      copyFileSync(getDbPath(), `${getDbPath()}.bak.${Date.now()}`);
    }

    db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

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
