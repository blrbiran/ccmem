import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-explicit-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env, CCMEM_DATA_ROOT: root, CCMEM_TEST_MODE: '1',
    CCMEM_LAUNCHAGENT_DIR: path.join(root, 'no-launchagents'),
    CCMEM_LAUNCHCTL_BIN: path.join(root, 'no-launchctl')
  };
  delete env.CCMEM_CONFIG_PATH;
  delete env.CCMEM_INTERNAL;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embedding: { enabled: false } }));
  const run = (script, args, input) => spawnSync(process.execPath, ['--no-warnings', path.join(scripts, script), ...args], {
    encoding: 'utf8', env, input, timeout: 20_000
  });
  const cli = (...args) => run('cli.mjs', args);
  assert.equal(cli('stats').status, 0, 'initialize an isolated store');
  const db = new DatabaseSync(path.join(root, 'global.db'));
  db.exec(`
    DROP INDEX idx_memories_session_id;
    ALTER TABLE memories DROP COLUMN session_id;
    ALTER TABLE memories DROP COLUMN transcript_path;
    ALTER TABLE tasks DROP COLUMN reclaimed_ms;
    DELETE FROM schema_migrations WHERE to_version IN (20, 21);
    UPDATE schema_meta SET version = 19;
    CREATE TABLE migration_sentinel (value TEXT);
    INSERT INTO migration_sentinel VALUES ('preserve me');
  `);
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();
  const version = (file = 'global.db') => {
    const copy = new DatabaseSync(path.join(root, file), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT value FROM migration_sentinel').get().value, 'preserve me');
      return copy.prepare('SELECT version FROM schema_meta').get().version;
    } finally {
      copy.close();
    }
  };
  const backups = () => readdirSync(root).filter((file) => /^(?:global\.db\.bak\.\d+$|\.global\.db\.backup-)/.test(file));
  const open = () => new DatabaseSync(path.join(root, 'global.db'));
  return { root, run, cli, version, backups, open };
}

for (const [mode, eventName] of [['session-start', 'SessionStart'], ['prompt-submit', 'UserPromptSubmit'], ['stop', null]]) {
  for (const input of [{ session_id: 'old-schema-session' }, {}]) {
    test(`${mode} leaves a populated older store alone (${input.session_id ? 'with' : 'without'} session ID)`, (t) => {
      const { run, version, backups, open } = fixture(t);
      const out = run('hook.mjs', [mode], JSON.stringify(input));
      assert.equal(version(), 19, 'a hook must never upgrade the store');
      assert.deepEqual(backups(), []);
      const db = open();
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      db.close();
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout), eventName ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: '' } } : {});
      assert.match(out.stderr, /ccmem admin migrate/);
    });
  }
}

test('ordinary CLI and daemon startup leave upgrades for the explicit command', (t) => {
  const { run, cli, version, backups } = fixture(t);
  const help = cli('admin', 'migrate', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /admin migrate/);
  for (const result of [cli('stats'), run('daemon/main.mjs', [])]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ccmem admin migrate/);
    assert.equal(version(), 19);
    assert.deepEqual(backups(), []);
  }
});

test('admin migrate publishes a pre-upgrade snapshot and is idempotent', (t) => {
  const { root, cli, version, backups } = fixture(t);
  const existing = Array.from({ length: 5 }, (_, i) => `global.db.bak.${i + 1}`);
  for (const file of existing) copyFileSync(path.join(root, 'global.db'), path.join(root, file));
  const result = cli('admin', 'migrate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(version(), 21);
  const names = backups();
  const added = names.filter((name) => !existing.includes(name));
  for (const name of existing) assert.ok(names.includes(name), `keeps ${name}`);
  assert.equal(added.length, 1);
  assert.match(added[0], /^global\.db\.bak\.\d+$/);
  assert.equal(version(added[0]), 19);
  assert.equal(cli('admin', 'migrate').status, 0);
  assert.deepEqual(backups(), names);
  assert.equal(cli('stats').status, 0);
});

test('admin migrate refuses a store held by a running daemon before taking a backup', (t) => {
  const { cli, version, backups, open } = fixture(t);
  const db = open();
  db.prepare(`INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
    VALUES (1, ?, 'fixture', ?, ?, 1)`).run(process.pid, Date.now(), Date.now());
  db.close();
  const result = cli('admin', 'migrate');
  assert.equal(version(), 19, 'stop the daemon before taking the migration snapshot');
  assert.deepEqual(backups(), []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ccmem admin daemon stop/);
});


test('daemon stop remains available while schema upgrade is pending', (t) => {
  const { cli, version, backups } = fixture(t);
  const result = cli('admin', 'daemon', 'stop');
  assert.match(result.stdout, /not running/i, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(version(), 19);
  assert.deepEqual(backups(), []);
});

// Tester #454: a store built by another ccmem lineage already carried session_context.transcript_path at
// version 18, so 019's plain ADD COLUMN failed with "duplicate column name" and the upgrade could never finish.
test('admin migrate refuses FTS maintenance while the daemon is running before taking a backup', (t) => {
  const { cli, backups, open } = fixture(t);
  assert.equal(cli('admin', 'migrate').status, 0);
  const db = open();
  db.exec(`
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  const now = Date.now();
  db.prepare(`INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
    VALUES (1, 999999, 'fixture', ?, ?, 1)`).run(now, now);
  db.close();

  const before = backups();
  const result = cli('admin', 'migrate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stop the running daemon/);
  assert.deepEqual(backups(), before);
  const unchanged = open();
  try {
    assert.equal(Boolean(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_fts_insert'").get()), true);
  } finally {
    unchanged.close();
  }
});

test('admin migrate completes on a version-18 store that already has a column a later migration adds', (t) => {
  const { cli, version, open } = fixture(t);
  const db = open();
  db.exec(`DELETE FROM schema_migrations WHERE to_version = 19; UPDATE schema_meta SET version = 18;`);
  db.close();
  const result = cli('admin', 'migrate');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(version(), 21);
  const after = open();
  try {
    const columns = (table) => after.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
    assert.equal(columns('session_context').filter((name) => name === 'transcript_path').length, 1);
    assert.ok(columns('memories').includes('session_id'));
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE to_version IN (19, 20)').get().n, 2);
  } finally {
    after.close();
  }
});


test('ordinary opens leave stale FTS artifacts untouched; admin migrate backs up and repairs only known legacy triggers', (t) => {
  const { root, cli, backups, open } = fixture(t);
  assert.equal(cli('admin', 'migrate').status, 0);
  const db = open();
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO memories (scope, type, content, source, last_touched_at, created_at, updated_at)
      VALUES ('global', 'rule', 'fts repair sentinel', 'user_explicit', ?, ?, ?)`).run(now, now, now);
    db.exec(`
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.id;
      END;
      CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN
        UPDATE memories_fts SET content = new.content WHERE rowid = new.id;
      END;
      CREATE TRIGGER custom_memories_trigger AFTER UPDATE OF content ON memories BEGIN SELECT 1; END;
      DELETE FROM memories_fts;
    `);
  } finally {
    db.close();
  }

  const before = backups();
  const regularOpen = cli('stats');
  assert.equal(regularOpen.status, 0, regularOpen.stderr);
  const unchanged = open();
  try {
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_fts_insert'").get() != null, true);
    assert.equal(Boolean(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_ai'").get()), true);
    assert.throws(() => unchanged.exec(`INSERT INTO memories (scope, type, content, source, last_touched_at, created_at, updated_at)
      VALUES ('global', 'rule', 'double-write probe', 'user_explicit', 1, 1, 1)`), { errcode: 19 });
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n, 0);
  } finally {
    unchanged.close();
  }
  assert.deepEqual(backups(), before, 'ordinary opens must not snapshot or repair FTS');

  const repaired = cli('admin', 'migrate');
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /dropped 3 legacy FTS triggers/);
  const saved = cli('save', 'fts repair post-migration write');
  assert.equal(saved.status, 0, saved.stderr);
  const after = open();
  try {
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n, 2);
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n, after.prepare('SELECT COUNT(*) AS n FROM memories').get().n);
    assert.equal(Boolean(after.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('memories_fts_insert', 'memories_fts_update', 'memories_fts_delete') LIMIT 1").get()), false);
    assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='custom_memories_trigger'").get() != null, true);
  } finally {
    after.close();
  }
  const added = backups().filter((name) => !before.includes(name));
  assert.equal(added.length, 1);
  const snapshot = new DatabaseSync(path.join(root, added[0]), { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_fts_insert'").get() != null, true);
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM memories_fts').get().n, 0);
  } finally {
    snapshot.close();
  }
  const stableBackups = backups();
  const repeated = cli('admin', 'migrate');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /dropped 0 legacy FTS triggers/);
  assert.deepEqual(backups(), stableBackups, 'a second maintenance pass makes no new snapshot');
});

test('failed FTS rebuild rolls back trigger deletion and leaves a recoverable snapshot', (t) => {
  const { root, cli, backups, open } = fixture(t);
  assert.equal(cli('admin', 'migrate').status, 0);
  const db = open();
  try {
    db.exec(`
      DROP TABLE memories_fts;
      CREATE TABLE memories_fts (content TEXT);
      INSERT INTO memories_fts VALUES ('custom table payload');
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  } finally {
    db.close();
  }

  const before = backups();
  const result = cli('admin', 'migrate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a recognized FTS5 table/);
  const added = backups().filter((name) => !before.includes(name));
  assert.equal(added.length, 1);
  for (const file of ['global.db', added[0]]) {
    const copy = new DatabaseSync(path.join(root, file), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT content FROM memories_fts').get().content, 'custom table payload');
      assert.equal(Boolean(copy.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_fts_insert'").get()), true);
    } finally {
      copy.close();
    }
  }
});

test('admin migrate preserves a custom trigger that only reuses a legacy FTS name', (t) => {
  const { cli, backups, open } = fixture(t);
  assert.equal(cli('admin', 'migrate').status, 0);
  const db = open();
  db.exec(`CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN SELECT 1; END`);
  db.close();

  const before = backups();
  const diagnosis = cli('admin', 'diagnose');
  assert.equal(diagnosis.status, 1);
  assert.match(diagnosis.stdout, /unrecognized=memories_fts_insert/);
  const maintenance = cli('admin', 'migrate');
  assert.equal(maintenance.status, 0, maintenance.stderr);
  assert.deepEqual(backups(), before);

  const after = open();
  try {
    assert.equal(Boolean(after.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='memories_fts_insert'").get()), true);
  } finally {
    after.close();
  }
});

test('migration 21 relabels old reclaimed age without changing ordinary task duration (#507)', (t) => {
  const { cli, open } = fixture(t);
  const db = open();
  db.exec(`INSERT INTO tasks (type, status, scheduled_for, enqueued_at, started_at, finished_at, duration_ms, error_excerpt)
    VALUES ('summarize_pending', 'failed', 1, 1, 1, 26492400001, 26492400000, 'daemon exited while this task was running'),
           ('summarize_pending', 'success', 1, 1, 1, 2501, 2500, NULL)`);
  db.close();
  const result = cli('admin', 'migrate');
  assert.equal(result.status, 0, result.stderr);
  const migrated = open();
  try {
    const [orphan, normal] = migrated.prepare('SELECT duration_ms, reclaimed_ms FROM tasks ORDER BY id').all();
    assert.equal(orphan.duration_ms, 0, 'the historical reclaim age must leave the runtime column');
    assert.equal(orphan.reclaimed_ms, 26492400000);
    assert.equal(normal.duration_ms, 2500);
    assert.equal(normal.reclaimed_ms, null);
  } finally {
    migrated.close();
  }
});
