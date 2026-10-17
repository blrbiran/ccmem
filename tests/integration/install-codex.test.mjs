import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `ccmem install codex` writes the human's own Codex hook config. Every test
// runs against a temp CODEX_HOME and a temp data root: the real ~/.codex is
// never read or written. What these pin is the contract a person relies on:
// foreign hooks survive, a backup of the original bytes exists, config.toml is
// never touched, and uninstall puts back exactly what was there.
process.env.CCMEM_TEST_MODE = '1';
const scratch = mkdtempSync(path.join(tmpdir(), 'ccmem-install-codex-'));
process.env.CODEX_HOME = path.join(scratch, 'env-codex-home-never-used');
process.env.CCMEM_DATA_ROOT = path.join(scratch, 'env-data-root');

const { installCodex, uninstallCodex, findTomlHookDefinitions } = await import('../../scripts/lib/install/codex.mjs');

const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const EXEC = '/opt/fake/bin/node';
const REPO = '/opt/fake/ccmem';
const TRUST_LINE = 'Codex hooks run only after you trust them: open codex and run /hooks to approve the three ccmem hooks.';

let caseNo = 0;
function freshDirs() {
  caseNo += 1;
  const base = path.join(scratch, `case-${caseNo}`);
  mkdirSync(base);
  return { codexHome: path.join(base, 'codex'), dataRoot: path.join(base, 'data'), base };
}

function command(mode) {
  return `${EXEC} --no-warnings --experimental-sqlite ${REPO}/scripts/hook.mjs ${mode} --agent codex`;
}

function ccmemGroup(mode) {
  return { hooks: [{ type: 'command', command: command(mode), timeout: 5 }] };
}

function mode(filePath) {
  return statSync(filePath).mode & 0o777;
}

function install(dirs) {
  return installCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: EXEC });
}

function uninstall(dirs) {
  return uninstallCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot });
}

function backupsIn(dir) {
  return readdirSync(dir).filter((name) => /^hooks\.json\.bak\.\d+$/.test(name));
}

const FOREIGN = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-own-stop-hook', timeout: 7 }] }]
  }
};
// Deliberately not JSON.stringify(_, null, 2) output: restoring must give back
// these exact bytes, not a re-serialization of the same object.
const FOREIGN_BYTES = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/local/bin/my-own-stop-hook","timeout":7}]}]}}';
const CONFIG_TOML = 'model = "gpt-5"\nnotify = ["/usr/local/bin/notify-me"]\n';

function writeConfigToml(dirs, text = CONFIG_TOML) {
  mkdirSync(dirs.codexHome, { recursive: true });
  writeFileSync(path.join(dirs.codexHome, 'config.toml'), text);
}

function readConfigToml(dirs) {
  return readFileSync(path.join(dirs.codexHome, 'config.toml'), 'utf8');
}

test('fresh install creates hooks.json 0600 with the three ccmem hooks and a re-run is a no-op', () => {
  const dirs = freshDirs();
  writeConfigToml(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');

  const first = install(dirs);
  assert.equal(first.changed, true);
  assert.equal(first.backup, null, 'nothing existed, so there is nothing to back up');
  assert.equal(mode(target), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
    hooks: {
      SessionStart: [ccmemGroup('session-start')],
      UserPromptSubmit: [ccmemGroup('prompt-submit')],
      Stop: [ccmemGroup('stop')]
    }
  });
  assert.match(first.diff, /^\+ .*scripts\/hook\.mjs session-start --agent codex/m);

  const manifestPath = path.join(dirs.dataRoot, 'installs', 'codex.json');
  assert.equal(mode(manifestPath), 0o600);
  assert.equal(mode(path.join(dirs.dataRoot, 'installs')), 0o700);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.target, target);
  assert.equal(manifest.createdFile, true);
  assert.equal(manifest.backup, null);
  assert.equal(manifest.entries.length, 3);
  assert.equal(typeof manifest.installedAt, 'number');

  const bytesAfterFirst = readFileSync(target);
  const second = install(dirs);
  assert.equal(second.changed, false);
  assert.equal(second.diff, '');
  assert.deepEqual(readFileSync(target), bytesAfterFirst);
  assert.deepEqual(backupsIn(dirs.codexHome), [], 'a no-op re-run must not leave a backup behind');
  assert.equal(readConfigToml(dirs), CONFIG_TOML);
});

test('install creates a missing CODEX_HOME as 0700', () => {
  const dirs = freshDirs();
  install(dirs);
  assert.equal(mode(dirs.codexHome), 0o700);
});

test('install keeps foreign hooks.json entries and backs up the original bytes', () => {
  const dirs = freshDirs();
  writeConfigToml(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);
  chmodSync(target, 0o644);

  const result = install(dirs);
  assert.equal(result.changed, true);

  const merged = JSON.parse(readFileSync(target, 'utf8'));
  // The foreign hook stays first: Codex keys trust by group index, so moving it
  // would silently revoke the human's approval of their own hook.
  assert.deepEqual(merged.hooks.Stop, [FOREIGN.hooks.Stop[0], ccmemGroup('stop')]);
  assert.deepEqual(merged.hooks.SessionStart, [ccmemGroup('session-start')]);
  assert.deepEqual(merged.hooks.UserPromptSubmit, [ccmemGroup('prompt-submit')]);
  assert.equal(mode(target), 0o644, 'an existing file keeps its mode');

  assert.ok(result.backup, 'a backup path is returned');
  assert.match(path.basename(result.backup), /^hooks\.json\.bak\.\d+$/);
  assert.equal(readFileSync(result.backup, 'utf8'), FOREIGN_BYTES);
  assert.equal(mode(result.backup), 0o600);
  assert.doesNotMatch(result.diff, /^- .*my-own-stop-hook/m, 'the diff must not show the foreign hook removed');
  assert.match(result.diff, /^\+ .*scripts\/hook\.mjs stop --agent codex/m);
  assert.equal(readConfigToml(dirs), CONFIG_TOML);
});

test('install refuses when config.toml defines hooks, writing nothing', () => {
  const dirs = freshDirs();
  const toml = CONFIG_TOML + '\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo hi"\n';
  writeConfigToml(dirs, toml);

  const result = spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, 'install', 'codex'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: dirs.codexHome, CCMEM_DATA_ROOT: dirs.dataRoot }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config\.toml/);
  assert.match(result.stderr, /\[\[hooks\.SessionStart\]\]/);
  assert.equal(existsSync(path.join(dirs.codexHome, 'hooks.json')), false);
  assert.equal(existsSync(path.join(dirs.dataRoot, 'installs', 'codex.json')), false);
  assert.equal(readConfigToml(dirs), toml);
});

test('install proceeds when config.toml only holds Codex trust state', () => {
  const dirs = freshDirs();
  const toml = CONFIG_TOML + '\n[hooks.state."/x/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';
  writeConfigToml(dirs, toml);
  const result = install(dirs);
  assert.equal(result.changed, true);
  assert.equal(readConfigToml(dirs), toml);
});

test('findTomlHookDefinitions tells hook definitions from trust state', () => {
  const definitions = [
    '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "x" }] }]\n',
    '[[hooks.Stop]]\n',
    '  [[hooks.Stop.hooks]]\n',
    '[hooks.UserPromptSubmit]\n',
    '[hooks."Stop"]\n',
    'hooks.Stop = []\n',
    'hooks = { Stop = [] }\n'
  ];
  for (const text of definitions) {
    assert.ok(findTomlHookDefinitions(text).length > 0, `should be a conflict: ${JSON.stringify(text)}`);
  }

  const notDefinitions = [
    '',
    'model = "gpt-5"\n',
    '[hooks.state."/a/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n',
    '[hooks]\n[hooks.state."k"]\nenabled = false\n',
    '[hooks]\nstate = {}\n',
    '[hooks."state"."k"]\ntrusted_hash = "x"\n',
    '[hooksmith]\nx = 1\n',
    '# [[hooks.Stop]]\n',
    '[profiles.x]\nhooks = 1\n'
  ];
  for (const text of notDefinitions) {
    assert.deepEqual(findTomlHookDefinitions(text), [], `should not be a conflict: ${JSON.stringify(text)}`);
  }
});

test('install refuses to overwrite a hooks.json it cannot parse', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, '{ not json');
  assert.throws(() => install(dirs), /hooks\.json/);
  assert.equal(readFileSync(target, 'utf8'), '{ not json');
  assert.equal(existsSync(path.join(dirs.dataRoot, 'installs', 'codex.json')), false);
});

test('install refuses when a recorded install differs from what would be written now', () => {
  const dirs = freshDirs();
  install(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');
  const before = readFileSync(target);
  assert.throws(
    () => installCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: '/other/node' }),
    /uninstall codex/
  );
  assert.deepEqual(readFileSync(target), before);
});

test('uninstall after a fresh install deletes hooks.json and the manifest', () => {
  const dirs = freshDirs();
  writeConfigToml(dirs);
  install(dirs);
  const result = uninstall(dirs);
  assert.deepEqual(result, { changed: true, restored: true });
  assert.equal(existsSync(path.join(dirs.codexHome, 'hooks.json')), false);
  assert.equal(existsSync(path.join(dirs.dataRoot, 'installs', 'codex.json')), false);
  assert.deepEqual(uninstall(dirs), { changed: false, restored: false });
  assert.equal(readConfigToml(dirs), CONFIG_TOML);
});

test('uninstall after a merge restores the original bytes exactly', () => {
  const dirs = freshDirs();
  writeConfigToml(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);
  chmodSync(target, 0o644);
  install(dirs);

  const result = uninstall(dirs);
  assert.deepEqual(result, { changed: true, restored: true });
  assert.equal(readFileSync(target, 'utf8'), FOREIGN_BYTES);
  assert.equal(mode(target), 0o644);
  assert.equal(readConfigToml(dirs), CONFIG_TOML);
});

test('uninstall without a manifest changes nothing', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);
  assert.deepEqual(uninstall(dirs), { changed: false, restored: false });
  assert.equal(readFileSync(target, 'utf8'), FOREIGN_BYTES);
});

test('uninstall keeps hooks the human added after install and removes only ccmem', () => {
  const dirs = freshDirs();
  install(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');
  const edited = JSON.parse(readFileSync(target, 'utf8'));
  const added = { hooks: [{ type: 'command', command: '/usr/local/bin/added-later' }] };
  edited.hooks.Stop.push(added);
  writeFileSync(target, JSON.stringify(edited, null, 2));

  const result = uninstall(dirs);
  assert.equal(result.changed, true);
  assert.equal(result.restored, false);
  assert.equal(result.removed, 3);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { hooks: { Stop: [added] } });
  assert.deepEqual(backupsIn(dirs.codexHome), [path.basename(result.backup)], 'the edited file is backed up before ccmem removes its entries');
});

test('uninstall names the ccmem hooks it could not find because they were changed by hand', () => {
  const dirs = freshDirs();
  install(dirs);
  const target = path.join(dirs.codexHome, 'hooks.json');
  const edited = JSON.parse(readFileSync(target, 'utf8'));
  edited.hooks.Stop[0].hooks[0].timeout = 9;
  writeFileSync(target, JSON.stringify(edited, null, 2));

  const result = uninstall(dirs);
  assert.equal(result.restored, false);
  assert.equal(result.removed, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.missing, ['Stop']);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { hooks: { Stop: edited.hooks.Stop } });
});

test('a failed hooks.json write names the backup, and uninstall restores the original from it', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);

  // Simulates a writer that dies half-way: truncated bytes on disk, then an error.
  const truncatingWriter = (file) => {
    writeFileSync(file, '{"hoo');
    throw new Error('disk full');
  };
  let message = '';
  try {
    installCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: EXEC, writeFile: truncatingWriter });
  } catch (error) {
    message = error.message;
  }
  const [backupName] = backupsIn(dirs.codexHome);
  assert.ok(backupName, 'the backup was written before the failing write');
  assert.ok(message.includes(path.join(dirs.codexHome, backupName)), message);
  assert.match(message, /ccmem uninstall codex/);

  const result = uninstall(dirs);
  assert.equal(result.changed, true);
  assert.equal(result.restored, true);
  assert.equal(readFileSync(target, 'utf8'), FOREIGN_BYTES);
  assert.equal(readFileSync(result.damagedBackup, 'utf8'), '{"hoo', 'the damaged bytes are kept, not discarded');
  assert.equal(existsSync(path.join(dirs.dataRoot, 'installs', 'codex.json')), false);
});

test('a writer that fails before touching hooks.json leaves the original bytes in place', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);
  assert.throws(() => installCodex({
    codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: EXEC,
    writeFile: () => { throw new Error('EACCES'); }
  }), /backed up at/);
  assert.equal(readFileSync(target, 'utf8'), FOREIGN_BYTES);
});

test('a failed install record names the backup and leaves hooks.json unchanged', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const target = path.join(dirs.codexHome, 'hooks.json');
  writeFileSync(target, FOREIGN_BYTES);
  writeFileSync(dirs.dataRoot, 'a file where the data root directory should be');

  let message = '';
  try {
    install(dirs);
  } catch (error) {
    message = error.message;
  }
  const [backupName] = backupsIn(dirs.codexHome);
  assert.ok(backupName);
  assert.ok(message.includes(path.join(dirs.codexHome, backupName)), message);
  assert.equal(readFileSync(target, 'utf8'), FOREIGN_BYTES);
});

test('install writes through a symlinked hooks.json, keeping the link and the mode', () => {
  const dirs = freshDirs();
  mkdirSync(dirs.codexHome);
  const real = path.join(dirs.base, 'dotfiles-hooks.json');
  writeFileSync(real, FOREIGN_BYTES);
  chmodSync(real, 0o640);
  const target = path.join(dirs.codexHome, 'hooks.json');
  symlinkSync(real, target);

  install(dirs);
  assert.ok(lstatSync(target).isSymbolicLink(), 'the dotfile link must survive');
  assert.equal(mode(real), 0o640);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop[1], ccmemGroup('stop'));
  assert.deepEqual(readdirSync(dirs.codexHome).filter((name) => name.endsWith('.tmp')), []);
});

test('install refuses a node or repo path that the shell would split', () => {
  const dirs = freshDirs();
  assert.throws(
    () => installCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: '/opt/my node/bin/node' }),
    /shell would split/
  );
  assert.throws(
    () => installCodex({ codexHome: dirs.codexHome, dataRoot: dirs.dataRoot, repoRoot: '/opt/$HOME/ccmem', execPath: EXEC }),
    /shell would split/
  );
  assert.equal(existsSync(dirs.codexHome), false);
});

test('an unreadable install record is named, not a bare JSON error', () => {
  const dirs = freshDirs();
  mkdirSync(path.join(dirs.dataRoot, 'installs'), { recursive: true });
  const manifestFile = path.join(dirs.dataRoot, 'installs', 'codex.json');
  writeFileSync(manifestFile, '{ broken');
  assert.throws(() => uninstall(dirs), (error) => error.message.includes(manifestFile));
});

test('ccmem install codex prints the diff and the trust instruction; uninstall undoes it', () => {
  const dirs = freshDirs();
  writeConfigToml(dirs);
  const env = { ...process.env, CODEX_HOME: dirs.codexHome, CCMEM_DATA_ROOT: dirs.dataRoot };
  const run = (...args) => spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, ...args], { cwd: ROOT, encoding: 'utf8', env });

  const installed = run('install', 'codex');
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes(TRUST_LINE), installed.stdout);
  assert.ok(installed.stdout.includes(`${process.execPath} --no-warnings --experimental-sqlite ${ROOT}/scripts/hook.mjs stop --agent codex`));
  assert.match(installed.stdout, /^\+ /m);
  assert.doesNotMatch(installed.stdout + installed.stderr, /trusted_hash|dangerously-bypass-hook-trust/);

  const removed = run('uninstall', 'codex');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(path.join(dirs.codexHome, 'hooks.json')), false);
  assert.equal(readConfigToml(dirs), CONFIG_TOML);

  const noTarget = run('install');
  assert.equal(noTarget.status, 64);
  const unknownTarget = run('install', 'vim');
  assert.equal(unknownTarget.status, 64);
});
