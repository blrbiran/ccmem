import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-db-'));

const { createMigrationBackup, listMigrationBackups, openDb, getDbPath, getSchemaVersion } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { getMode, setMode } = await import('../../scripts/lib/mode.mjs');

function withEnv(key, value, work) {
  const previous = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return work();
  } finally {
    if (previous == null) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

test('openDb creates DB file and applies the latest schema', () => {
  const db = openDb();
  assert.equal(existsSync(getDbPath()), true);
  assert.equal(getSchemaVersion(db), 12);
  db.close();
});

test('openDb repairs a partially applied v0.6 migration and finishes schema upgrade', () => {
  const db = openDb();
  db.exec('DROP TRIGGER IF EXISTS memories_ai');
  db.prepare('UPDATE schema_meta SET version = 6, applied_at = ?').run(Date.now());
  db.prepare('DELETE FROM schema_migrations WHERE to_version = 7').run();
  db.close();

  const repaired = openDb();
  assert.equal(getSchemaVersion(repaired), 12);
  assert.equal(
    repaired.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_ai'").get().name,
    'memories_ai'
  );
  assert.equal(
    repaired.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE to_version = 7').get().n,
    1
  );
  repaired.close();
});

test('openDb works without FTS5 support', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-db-nofts-'));

  try {
    withEnv('CCMEM_DATA_ROOT', tempRoot, () => {
      withEnv('CCMEM_DISABLE_FTS5', '1', () => {
        const db = openDb();
        assert.equal(getSchemaVersion(db), 12);
        assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories_fts' LIMIT 1").get()), false);
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')").get().n,
          0
        );
        db.close();
      });
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('openDb drops legacy FTS triggers when FTS5 is unavailable so writes still work', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-db-legacy-fts-'));

  try {
    withEnv('CCMEM_DATA_ROOT', tempRoot, () => {
      const db = openDb();
      db.close();
    });

    await withEnv('CCMEM_DATA_ROOT', tempRoot, async () => {
      await withEnv('CCMEM_DISABLE_FTS5', '1', async () => {
        const db = openDb();
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')").get().n,
          0
        );
        await cmdSave(db, { cwd: process.cwd(), content: 'Write succeeds without FTS5', scope: 'project' });
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
        db.close();
      });
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('createMigrationBackup reuses a same-size backup created within the dedupe window', () => {
  const db = openDb();
  db.close();

  const first = createMigrationBackup();
  const second = createMigrationBackup();

  assert.equal(typeof first, 'string');
  assert.equal(second, first);
  assert.equal(listMigrationBackups().length, 1);
});

test('mode defaults to active and can be updated', () => {
  const db = openDb();
  assert.equal(getMode(db), 'active');
  setMode(db, 'shadow');
  assert.equal(getMode(db), 'shadow');
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
