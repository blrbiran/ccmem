import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { createMigrationBackup, listMigrationBackups, pruneMigrationBackups, publishMigrationSnapshot } = await import('../../scripts/lib/db.mjs');

function withRoot(run) {
  const previous = process.env.CCMEM_DATA_ROOT;
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-backup-'));
  process.env.CCMEM_DATA_ROOT = root;
  try { return run(root, path.join(root, 'global.db')); }
  finally {
    if (previous === undefined) delete process.env.CCMEM_DATA_ROOT;
    else process.env.CCMEM_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('migration backup contains committed rows still in the source WAL', () => withRoot((_root, dbPath) => {
  const source = new DatabaseSync(dbPath);
  try {
    source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('wal-only');");
    const backup = createMigrationBackup(dbPath);
    const copy = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'wal-only');
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { copy.close(); }
  } finally { source.close(); }
}));

test('an interrupted partial backup is never listed as a reusable generation', () => withRoot((root, dbPath) => {
  writeFileSync(path.join(root, 'global.db.bak.123.partial'), 'incomplete');
  assert.deepEqual(listMigrationBackups(dbPath), []);
}));

test('same-size changed content gets a distinct migration backup', () => withRoot((_root, dbPath) => {
  const source = new DatabaseSync(dbPath);
  try {
    source.exec("PRAGMA journal_mode=DELETE; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('aaaa');");
    const first = createMigrationBackup(dbPath);
    source.exec("UPDATE sample SET value='bbbb'");
    const second = createMigrationBackup(dbPath);
    assert.notEqual(second, first);
    const copy = new DatabaseSync(second, { readOnly: true });
    try { assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'bbbb'); }
    finally { copy.close(); }
  } finally { source.close(); }
}));

test('rotation ignores a corrupt numeric sibling and preserves the newest valid backup', () => withRoot((root, dbPath) => {
  const valid = path.join(root, 'global.db.bak.100');
  const copy = new DatabaseSync(valid);
  copy.exec('CREATE TABLE sample(value TEXT);');
  copy.close();
  const corrupt = path.join(root, 'global.db.bak.200');
  writeFileSync(corrupt, 'incomplete');
  pruneMigrationBackups(dbPath, 1);
  assert.equal(existsSync(valid), true);
  assert.equal(existsSync(corrupt), true);
}));

test('atomic publication retries a concurrent EEXIST without replacing either backup', () => withRoot((root, dbPath) => {
  const snapshot = path.join(root, '.complete-snapshot');
  writeFileSync(snapshot, 'complete snapshot');
  const occupied = `${dbPath}.bak.100`;
  writeFileSync(occupied, 'other backup');
  let calls = 0;
  const link = (source, target) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('concurrent publisher won');
      error.code = 'EEXIST';
      throw error;
    }
    linkSync(source, target);
  };
  const published = publishMigrationSnapshot(snapshot, dbPath, 100, link);
  assert.equal(published, `${dbPath}.bak.101`);
  assert.equal(calls, 2);
  assert.equal(existsSync(occupied), true);
  assert.equal(existsSync(published), true);
}));

test('rotation honors a max_keep above sixteen', () => withRoot((root, dbPath) => {
  for (let i = 1; i <= 21; i += 1) {
    const backup = new DatabaseSync(path.join(root, `global.db.bak.${i}`));
    backup.exec('CREATE TABLE sample(value INTEGER)');
    backup.close();
  }
  pruneMigrationBackups(dbPath, 20);
  assert.equal(listMigrationBackups(dbPath).length, 20);
}));

test('corrupt newest names do not keep older valid backups from rotating', () => withRoot((root, dbPath) => {
  for (let i = 1; i <= 7; i += 1) {
    const backup = new DatabaseSync(path.join(root, `global.db.bak.${i}`));
    backup.exec('CREATE TABLE sample(value INTEGER)');
    backup.close();
  }
  for (let i = 100; i < 116; i += 1) writeFileSync(path.join(root, `global.db.bak.${i}`), 'corrupt');
  pruneMigrationBackups(dbPath, 5);
  assert.deepEqual(listMigrationBackups(dbPath).filter((backup) => backup.ts < 100).map((backup) => backup.ts), [7, 6, 5, 4, 3]);
  assert.equal(listMigrationBackups(dbPath).filter((backup) => backup.ts >= 100).length, 16);
}));
