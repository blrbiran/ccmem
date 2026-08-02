import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * These spawn real processes on purpose. loadConfig() throwing is easy to test
 * in isolation and proves nothing about what an operator sees: Finding 5 was
 * filed as "every hook dies" and measurement showed the hooks degrade fine
 * while the daemon is the one that dies, so the thing worth pinning is the
 * behaviour at the process boundary, not the function's.
 *
 * CCMEM_CONFIG_PATH is removed from the child env deliberately. After
 * Finding 12 an unset variable means "read the store's own config.json", so
 * removing it is what puts the parse on the path every process takes.
 */
function runWithConfig(args, configContent) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccmem-cfg-'));
  if (configContent !== null) {
    writeFileSync(path.join(root, 'config.json'), configContent);
  }

  const env = { ...process.env, CCMEM_DATA_ROOT: root };
  delete env.CCMEM_CONFIG_PATH;

  try {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-sqlite', ...args],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 30000 }
    );
    return { ...result, configPath: path.join(root, 'config.json') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The daemon dies here either way — that is the decided behaviour, since
 * falling back to DEFAULT_CONFIG would put it on transformers-local against a
 * store of openai vectors and rebuild Finding 12. What must not survive is the
 * raw stack: launchd restarts the daemon, so an unreadable trace is written
 * again and again into daemon.err.log with nothing in it naming the file.
 *
 * No valid-config counterpart here: a daemon that starts correctly never
 * exits, so the positive control cannot be a spawnSync.
 */
test('a daemon started on an unparseable config says which file, without a stack', () => {
  const { status, stderr, configPath } = runWithConfig(
    ['scripts/daemon/main.mjs'],
    '{"embedding":{"enabled":false}'
  );

  assert.notEqual(status, 0, 'the daemon must not carry on with a config it could not read');
  assert.ok(
    stderr.includes(configPath),
    `stderr must name the offending file, got: ${stderr.slice(0, 300)}`
  );
  assert.ok(
    !stderr.includes('at JSON.parse'),
    `stderr must not be a raw stack, got: ${stderr.slice(0, 300)}`
  );
});

test('a CLI run on an unparseable config names the file too', () => {
  const { status, stdout, stderr, configPath } = runWithConfig(
    ['scripts/cli.mjs', 'admin', 'semantic', 'status'],
    '{"embedding":{"enabled":false},}'
  );

  assert.notEqual(status, 0);
  assert.ok(
    `${stdout}${stderr}`.includes(configPath),
    `output must name the offending file, got: ${`${stdout}${stderr}`.slice(0, 300)}`
  );
});

/**
 * Valid JSON of the wrong shape used to be the quiet one: a top-level string
 * parsed, merged to nothing, and left the process running on DEFAULT_CONFIG —
 * byte-for-byte identical to having no config file at all, with no error
 * anywhere. That is the Finding 12 shape (a process silently on the wrong
 * provider), so it has to fail as loudly as a syntax error does.
 */
test('a config that is valid JSON but not an object is rejected, not ignored', () => {
  const bad = runWithConfig(['scripts/cli.mjs', 'admin', 'semantic', 'status'], '"just a string"');
  assert.notEqual(bad.status, 0, 'a non-object config must not be silently discarded');
  assert.ok(
    `${bad.stdout}${bad.stderr}`.includes(bad.configPath),
    `output must name the offending file, got: ${`${bad.stdout}${bad.stderr}`.slice(0, 300)}`
  );

  // Positive control: the same command with no config file at all still works,
  // so the failure above is the shape check and not the command being broken.
  const control = runWithConfig(['scripts/cli.mjs', 'admin', 'semantic', 'status'], null);
  assert.equal(control.status, 0, `no-config control must still succeed, got: ${control.stderr.slice(0, 200)}`);
});
