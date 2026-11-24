import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    DELETE FROM schema_migrations WHERE to_version = 20;
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
  assert.equal(version(), 20);
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
