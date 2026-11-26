import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { getDataRoot } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');
const require = createRequire(import.meta.url);
const BACKUP_DEDUPE_WINDOW_MS = 60_000;
const FTS_TRIGGER_SQL = {
  memories_ai: 'CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content); END',
  memories_ad: 'CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE rowid = old.id; END',
  memories_au: 'CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN DELETE FROM memories_fts WHERE rowid = old.id; INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content); END'
};
const FTS_TRIGGER_NAMES = Object.keys(FTS_TRIGGER_SQL);
// These are the complete trigger bodies shipped in the early ccmem designs.
const LEGACY_FTS_TRIGGER_SQL = {
  memories_fts_insert: 'CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content); END',
  memories_fts_update: 'CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN UPDATE memories_fts SET content = new.content WHERE rowid = new.id; END',
  memories_fts_delete: 'CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE rowid = old.id; END'
};
const LEGACY_FTS_TRIGGER_NAMES = Object.keys(LEGACY_FTS_TRIGGER_SQL);
let cachedFtsSupport;
let cachedFts5ModulePresent;

// Defined in paths.mjs so config.mjs can share it without importing this
// module (which imports config.mjs). Re-exported here because six modules
// already import getDataRoot from db.mjs.
export { getDataRoot };

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
    .filter((file) => file.startsWith(`${base}.bak.`) && /^\d+$/.test(file.slice(`${base}.bak.`.length)))
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

  const backups = listMigrationBackups(dbPath);
  if (backups.length <= maxKeep) return;
  let kept = 0;
  for (const backup of backups) {
    if (!validMigrationBackup(backup.path)) continue;
    if (kept < maxKeep) kept += 1;
    else rmSync(backup.path, { force: true });
  }
}

function validMigrationBackup(filePath) {
  let db;
  try {
    if (!lstatSync(filePath).isFile()) return false;
    db = new DatabaseSync(filePath, { readOnly: true });
    return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function fileHash(filePath) {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function findReusableMigrationBackup(dbPath = getDbPath(), now = Date.now(), snapshotHash = null) {
  if (snapshotHash === null) return null;
  for (const backup of listMigrationBackups(dbPath)) {
    if ((now - backup.ts) > BACKUP_DEDUPE_WINDOW_MS) {
      break;
    }

    if (validMigrationBackup(backup.path) && fileHash(backup.path) === snapshotHash) {
      return backup.path;
    }
  }

  return null;
}

function publishMigrationSnapshot(snapshotPath, dbPath, initialTs = Date.now(), link = linkSync) {
  for (let offset = 0; offset < 1000; offset += 1) {
    const backupPath = `${dbPath}.bak.${initialTs + offset}`;
    try { link(snapshotPath, backupPath); return backupPath; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('migration-backup-name-exhausted');
}

function createMigrationBackup(dbPath = getDbPath(), sourceDb = null, { prune = true } = {}) {
  if (!existsSync(dbPath)) {
    return null;
  }

  // An interrupted snapshot must not even match a person's global.db.bak.* glob.
  const snapshotPath = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.backup-${randomUUID()}.partial`);
  const db = sourceDb ?? new DatabaseSync(dbPath, { readOnly: true });
  try {
    const oldUmask = process.umask(0o077);
    try { db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`); }
    finally { process.umask(oldUmask); }
    if (!validMigrationBackup(snapshotPath)) throw new Error('migration-backup-invalid');
    const verify = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      if (getSchemaVersion(verify) !== getSchemaVersion(db)) throw new Error('migration-backup-schema-mismatch');
    } finally { verify.close(); }
    const fd = openSync(snapshotPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const snapshotHash = fileHash(snapshotPath);
    const reusableBackup = findReusableMigrationBackup(dbPath, Date.now(), snapshotHash);
    if (reusableBackup) return reusableBackup;
    const backupPath = publishMigrationSnapshot(snapshotPath, dbPath);
    const dir = openSync(path.dirname(dbPath), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    if (prune) pruneMigrationBackups(dbPath);
    return backupPath;
  } finally {
    if (sourceDb === null) db.close();
    rmSync(snapshotPath, { force: true });
  }
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

function normalizedSql(sql) {
  return String(sql ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),;=])\s*/g, '$1').replace(/;$/, '');
}

function matchingFtsTriggers(db, definitions) {
  const lookup = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?");
  return Object.keys(definitions).filter((name) => {
    const trigger = lookup.get(name);
    return trigger?.tbl_name === 'memories' && normalizedSql(trigger.sql) === normalizedSql(definitions[name]);
  });
}

function tableSql(db, tableName) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName)?.sql ?? '';
}

function dropCanonicalFtsTriggersWithoutModule(db) {
  if (ftsDisabledByEnv()) return;
  cachedFts5ModulePresent ??= Boolean(db.prepare("SELECT 1 FROM pragma_module_list WHERE name = 'fts5'").get());
  if (cachedFts5ModulePresent || matchingFtsTriggers(db, FTS_TRIGGER_SQL).length === 0) return;

  // An SQLite build without FTS5 cannot write through these triggers or reliably
  // snapshot the virtual table using VACUUM INTO. Keep the index for explicit repair
  // with an FTS5-capable build and allow writes through the historical LIKE fallback.
  runInTransaction(db, () => {
    for (const name of matchingFtsTriggers(db, FTS_TRIGGER_SQL)) dropTriggerIfExists(db, name);
  });
}

function hasLegacyFtsProbe(db) {
  return normalizedSql(tableSql(db, 'ccmem_fts_probe'))
    === "create virtual table ccmem_fts_probe using fts5(content,tokenize='trigram')";
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

function supportsFts(db, { cleanupMainProbe = false } = {}) {
  if (ftsDisabledByEnv()) {
    return false;
  }
  if (cleanupMainProbe && hasLegacyFtsProbe(db)) {
    db.exec('DROP TABLE ccmem_fts_probe');
  }
  if (cachedFtsSupport !== undefined) {
    return cachedFtsSupport;
  }

  try {
    db.exec("CREATE VIRTUAL TABLE temp.ccmem_fts_probe USING fts5(content, tokenize='trigram')");
    db.exec('DROP TABLE temp.ccmem_fts_probe');
    cachedFtsSupport = true;
  } catch {
    try {
      db.exec('DROP TABLE IF EXISTS temp.ccmem_fts_probe');
    } catch {}
    cachedFtsSupport = false;
  }

  return cachedFtsSupport;
}

export function hasUsableFts(db) {
  return supportsFts(db) && tableExists(db, 'memories_fts');
}

/**
 * #415 D: what the retrieval path is actually running on, for `admin diagnose`. The three
 * answers are deliberately separate: a disabled-by-env process, a SQLite without FTS5, and a
 * build that has FTS5 but lost the shadow table all degrade to the LIKE fallback, and only
 * naming the cause tells the reader which one to fix.
 */
export function ftsDiagnostics(db) {
  const disabled = ftsDisabledByEnv();
  const supported = supportsFts(db);
  const table = tableExists(db, 'memories_fts');
  const presentTriggers = FTS_TRIGGER_NAMES.filter((name) => triggerExists(db, name));
  const legacyTriggers = matchingFtsTriggers(db, LEGACY_FTS_TRIGGER_SQL);
  const recognizedTriggers = matchingFtsTriggers(db, FTS_TRIGGER_SQL);
  const nameConflicts = [
    ...presentTriggers.filter((name) => !recognizedTriggers.includes(name)),
    ...LEGACY_FTS_TRIGGER_NAMES.filter((name) => !legacyTriggers.includes(name) && triggerExists(db, name))
  ];
  const missingTriggers = FTS_TRIGGER_NAMES.filter((name) => !presentTriggers.includes(name));
  const needsRepair = legacyTriggers.length || nameConflicts.length
    || (supported ? missingTriggers.length || !table : !disabled && recognizedTriggers.length);
  const triggerHealth = needsRepair ? 'repair-needed' : supported ? 'ready' : 'unsupported';
  return {
    disabled_by_env: disabled,
    supported,
    table_present: table,
    status: disabled ? 'disabled-by-env' : !supported ? 'unsupported' : !table ? 'table-missing' : 'ready',
    trigger_health: triggerHealth,
    triggers_present: presentTriggers,
    legacy_triggers: legacyTriggers,
    trigger_name_conflicts: nameConflicts,
    missing_triggers: missingTriggers
  };
}

/**
 * #415 P3: FTS5 leaves segments and tombstones behind as rows are updated and
 * deleted; `optimize` merges them. The daily maintenance runs this once, and
 * reports the size change so the audit trail can show whether it paid off.
 * The measurement uses `dbstat`, which is optional in some builds: when it is
 * unavailable the optimize still runs and both sizes read 0.
 */
export function optimizeFts(db) {
  if (!tableExists(db, 'memories_fts')) return { optimized: false, bytesBefore: 0, bytesAfter: 0 };
  const size = () => {
    try {
      return Number(db.prepare("SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name LIKE 'memories_fts%'").get()?.n ?? 0);
    } catch {
      return 0;
    }
  };
  const bytesBefore = size();
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')");
  return { optimized: true, bytesBefore, bytesAfter: size() };
}

function runInTransaction(db, work) {
  // IMMEDIATE，不是裸 BEGIN：这里的 work 全是写（migration 与 FTS 对账）。deferred 事务会
  // 先读后写，别的连接一旦在中间提交，SQLite 就判读快照失效、返回 SQLITE_BUSY_SNAPSHOT，
  // 而且不调用 busy handler —— openDb() 设的 busy_timeout 对那一类失败完全无效。
  db.exec('BEGIN IMMEDIATE');
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

// Tester #454: a store built by another ccmem lineage can already hold a column a later migration adds
// (session_context.transcript_path existed at version 3 there), and SQLite has no ADD COLUMN IF NOT EXISTS.
// A statement-level `ALTER TABLE <t> ADD COLUMN <c> ...;` at the start of a line is dropped when <c> is
// already there; everything else in the file runs as written.
function migrationSql(db, file) {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(
    /^ALTER TABLE (\w+) ADD COLUMN (\w+)\b[^;]*;/gm,
    (statement, table, column) => (tableExists(db, table) && columnExists(db, table, column) ? '' : statement)
  );
}

function runSqlMigration(db, file) {
  runInTransaction(db, () => {
    db.exec(migrationSql(db, file));
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

function rebuildFtsIndex(db) {
  if (normalizedSql(tableSql(db, 'memories_fts')) !== "create virtual table memories_fts using fts5(content,tokenize='trigram')") {
    throw new Error('cannot rebuild FTS: memories_fts is not a recognized FTS5 table');
  }
  db.exec('DELETE FROM memories_fts');
  db.exec(`
    INSERT INTO memories_fts(rowid, content)
    SELECT id, content FROM memories;
  `);
}

// 纯读，用来决定要不要进写事务。进去之后 work() 会把同样的判断再做一遍，
// 所以两个进程同时判断"要写"也是安全的。
function ftsReconcileNeeded(db, ftsUsable, rebuild) {
  const hasLegacyTrigger = matchingFtsTriggers(db, LEGACY_FTS_TRIGGER_SQL).length > 0;
  if (!ftsUsable) {
    return hasLegacyTrigger || matchingFtsTriggers(db, FTS_TRIGGER_SQL).length > 0;
  }

  return (
    rebuild ||
    hasLegacyFtsProbe(db) ||
    hasLegacyTrigger ||
    !tableExists(db, 'memories_fts') ||
    FTS_TRIGGER_NAMES.some((name) => !triggerExists(db, name))
  );
}

function reconcileFtsArtifacts(db, { rebuild = false, transactional = true, requireStoppedDaemon = false, backup = false } = {}) {
  const work = () => {
    const legacyTriggers = matchingFtsTriggers(db, LEGACY_FTS_TRIGGER_SQL);
    for (const triggerName of legacyTriggers) dropTriggerIfExists(db, triggerName);

    if (!supportsFts(db, { cleanupMainProbe: true })) {
      for (const triggerName of matchingFtsTriggers(db, FTS_TRIGGER_SQL)) dropTriggerIfExists(db, triggerName);
      return legacyTriggers.length;
    }

    const hadTable = tableExists(db, 'memories_fts');
    const missingTriggers = FTS_TRIGGER_NAMES.filter((name) => !triggerExists(db, name));
    if (!hadTable) {
      db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='trigram')");
    }
    for (const name of missingTriggers) db.exec(FTS_TRIGGER_SQL[name]);

    if (!hadTable || legacyTriggers.length || missingTriggers.length || rebuild) {
      rebuildFtsIndex(db);
    }

    return legacyTriggers.length;
  };

  if (!transactional) {
    return work();
  }

  // Probe only the temp schema before locking. Recheck after reserving the writer,
  // so the backup and repair use the same committed starting state.
  const ftsUsable = supportsFts(db);
  if (!ftsReconcileNeeded(db, ftsUsable, rebuild)) return 0;

  return runInTransaction(db, () => {
    if (!ftsReconcileNeeded(db, ftsUsable, rebuild)) return 0;
    if (requireStoppedDaemon) assertDaemonStopped(db);
    if (backup) createMigrationBackup(getDbPath(), null, { prune: false });
    return work();
  });
}

function runV06Migration(db, populated) {
  return runInTransaction(db, () => {
    if (populated) assertDaemonStopped(db);
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

    const droppedLegacyFtsTriggers = reconcileFtsArtifacts(db, { rebuild: true, transactional: false });

    db.prepare('UPDATE schema_meta SET version = 7, applied_at = ?').run(now);
    if (!migrationRecorded(db, 7)) {
      db.prepare(`
        INSERT INTO schema_migrations (from_version, to_version, description, applied_at, applied_by)
        VALUES (?, 7, 'v0.6: embedding BLOB + audit_log ts sec-to-ms + vec_backfill rollup + optional FTS artifacts', ?, 'ccmem-cli')
      `).run(fromVersion, now);
    }
    return droppedLegacyFtsTriggers;
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

export class MigrationRequiredError extends Error {
  constructor(currentVersion, targetVersion) {
    super(`schema migration required (${currentVersion} → ${targetVersion}); run \`ccmem admin migrate\``);
  }
}

function migrationPlan(db) {
  const version = getSchemaVersion(db);
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /\.(sql|cjs)$/.test(file) && Number(file.split('_', 1)[0]) > version)
    .sort();
  const populated = pending.length > 0 && (version > 0 || Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1"
  ).get()));
  return { version, pending, populated };
}

function assertDaemonStopped(db) {
  if (!tableExists(db, 'daemon_lock')) return;
  const owner = db.prepare('SELECT holder_pid, hostname, heartbeat_at FROM daemon_lock WHERE id = 1').get();
  if (!owner) return;
  if (owner.hostname === os.hostname() && owner.holder_pid > 0) {
    try { process.kill(owner.holder_pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; }
  } else if (Date.now() - owner.heartbeat_at >= 60_000) {
    return;
  }
  throw new Error('stop the running daemon with `ccmem admin daemon stop` before upgrading');
}

export function runMigration(db, { migrate = false, plan = migrationPlan(db) } = {}) {
  const { version, pending, populated } = plan;
  if (!pending.length) return;
  if (populated && !migrate) throw new MigrationRequiredError(version, Number(pending.at(-1).split('_', 1)[0]));

  if (version >= 15 && pending.every((file) => file.endsWith('.sql'))) {
    // Reserve the writer before taking the snapshot through a separate reader.
    // The snapshot and all the pending SQL see the same committed starting state.
    return runInTransaction(db, () => {
      const current = getSchemaVersion(db);
      const remaining = pending.filter((file) => Number(file.split('_', 1)[0]) > current);
      if (!remaining.length) return;
      assertDaemonStopped(db);
      createMigrationBackup(getDbPath(), null, { prune: false });
      for (const file of remaining) db.exec(migrationSql(db, file));
    });
  }

  // Legacy migration handlers own their individual transactions.
  if (populated) {
    assertDaemonStopped(db);
    createMigrationBackup(getDbPath(), db, { prune: false });
  }
  let droppedLegacyFtsTriggers = 0;
  for (const file of pending) {
    const toVersion = Number(file.split('_', 1)[0]);
    if (toVersion === 7) droppedLegacyFtsTriggers = runV06Migration(db, populated);
    else if (!runSpecialMigration(db, toVersion)) runVersionedMigration(db, file);
  }
  return droppedLegacyFtsTriggers;
}

export { createMigrationBackup, findReusableMigrationBackup, listMigrationBackups, pruneMigrationBackups, publishMigrationSnapshot };

export function ensureSchema(db, { migrate = false, plan = migrationPlan(db) } = {}) {
  const dropped = runMigration(db, { migrate, plan }) ?? 0;
  if (!migrate && plan.version > 0) {
    dropCanonicalFtsTriggersWithoutModule(db);
    return dropped;
  }

  const existingStore = plan.version > 0 || plan.populated;
  return dropped + reconcileFtsArtifacts(db, {
    requireStoppedDaemon: migrate && existingStore,
    backup: migrate && existingStore && plan.pending.length === 0
  });
}

// 每个连接撞写锁时最多等这么久。导出是为了让"等这个库放锁"的调用方能按它定预算 ——
// 等待方的预算低于这个数，等的就是一个必然等不到的东西：daemon 删锁行本身可以合法地
// 占满这里的 5000ms，而 stop 曾经只等 2000ms（见 admin/daemon.mjs 的 STOP_WAIT_TIMEOUT_MS）。
export const DB_BUSY_TIMEOUT_MS = 5000;

// Another connection holds the lock: SQLITE_BUSY (5), BUSY_RECOVERY (261) or
// BUSY_SNAPSHOT (517). `errcode` is the only discriminator — node:sqlite sets
// `.code` to ERR_SQLITE_ERROR for every failure, and elapsed time cannot tell
// a busy wait from a slow statement.
const BUSY_ERRCODES = new Set([5, 261, 517]);

export function isDatabaseBusy(error) {
  return BUSY_ERRCODES.has(error?.errcode);
}

export function openDb({ migrate = false, forDaemonStop = false, migrationReport } = {}) {
  mkdirSync(getDataRoot(), { recursive: true });
  const db = new DatabaseSync(getDbPath());
  try {
    // busy_timeout 必须先装：打开/恢复 WAL 要拿排它锁，而 `PRAGMA journal_mode = WAL`
    // 在 busy handler 装上之前执行的话，任何并发开库都会让它 0ms 抛 `database is locked`
    // （实测 errcode 5 与 261 SQLITE_BUSY_RECOVERY），配置好的 5 秒容忍度形同虚设。
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    // An older populated store is refused before the journal-mode write: a refusal must not
    // change the file it refuses (a DELETE-mode store stays DELETE until `admin migrate`).
    const plan = migrationPlan(db);
    if (plan.populated) {
      if (forDaemonStop) return db;
      if (!migrate) throw new MigrationRequiredError(plan.version, Number(plan.pending.at(-1).split('_', 1)[0]));
      assertDaemonStopped(db);
    }
    db.exec('PRAGMA journal_mode = WAL;');
    const droppedLegacyFtsTriggers = ensureSchema(db, { migrate, plan });
    if (migrationReport) migrationReport.droppedLegacyFtsTriggers = droppedLegacyFtsTriggers;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
