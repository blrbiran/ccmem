import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `ccmem install omp` writes one file into the human's OMP agent directory:
// extensions/ccmem.ts, which OMP auto-loads at startup. Every test runs against
// a temp CCMEM_OMP_AGENT_DIR and a temp data root: the real ~/.omp is never
// read or written. What these pin: a file that was there is backed up and comes
// back byte for byte, a backup is never itself loaded by OMP, a re-run changes
// nothing, and uninstall leaves no ccmem file behind.
process.env.CCMEM_TEST_MODE = '1';
const scratch = mkdtempSync(path.join(tmpdir(), 'ccmem-install-omp-'));
process.env.CCMEM_OMP_AGENT_DIR = path.join(scratch, 'env-agent-dir-never-used');
process.env.CCMEM_DATA_ROOT = path.join(scratch, 'env-data-root');

const { getOmpAgentDir, installOmp, uninstallOmp, ompLoaderSource } = await import('../../scripts/lib/install/omp.mjs');

const NODE = process.execPath;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const EXEC = '/opt/fake/bin/node';
const REPO = '/opt/fake/ccmem';
const LOADER = [
  '// Written by `ccmem install omp`; `ccmem uninstall omp` removes it.',
  "import { createCcmemExtension } from '/opt/fake/ccmem/integrations/omp/ccmem-extension.ts';",
  "export default createCcmemExtension({ node: '/opt/fake/bin/node', hookScript: '/opt/fake/ccmem/scripts/hook.mjs' });",
  ''
].join('\n');
const FOREIGN = "export default function (pi) { pi.on('session_start', () => {}); }\n";

let caseNo = 0;
function freshDirs() {
  caseNo += 1;
  const base = path.join(scratch, `case-${caseNo}`);
  mkdirSync(base);
  const agentDir = path.join(base, 'agent');
  return { agentDir, dataRoot: path.join(base, 'data'), target: path.join(agentDir, 'extensions', 'ccmem.ts') };
}

function mode(filePath) {
  return statSync(filePath).mode & 0o777;
}

function install(dirs, extra = {}) {
  return installOmp({ agentDir: dirs.agentDir, dataRoot: dirs.dataRoot, repoRoot: REPO, execPath: EXEC, ...extra });
}

function uninstall(dirs) {
  return uninstallOmp({ agentDir: dirs.agentDir, dataRoot: dirs.dataRoot });
}

function writeForeign(dirs, bytes = FOREIGN, fileMode = 0o644) {
  mkdirSync(path.dirname(dirs.target), { recursive: true });
  writeFileSync(dirs.target, bytes);
  chmodSync(dirs.target, fileMode);
}

function extensionDirEntries(dirs) {
  return readdirSync(path.dirname(dirs.target)).sort();
}

const manifestFile = (dirs) => path.join(dirs.dataRoot, 'installs', 'omp.json');

test('fresh install writes the loader 0600 in new 0700 dirs and a re-run is a no-op', () => {
  const dirs = freshDirs();

  const first = install(dirs);
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  assert.equal(readFileSync(dirs.target, 'utf8'), LOADER);
  assert.equal(mode(dirs.target), 0o600);
  assert.equal(mode(dirs.agentDir), 0o700);
  assert.equal(mode(path.dirname(dirs.target)), 0o700);
  assert.match(first.diff, /^\+ import \{ createCcmemExtension \}/m);

  assert.equal(mode(manifestFile(dirs)), 0o600);
  const manifest = JSON.parse(readFileSync(manifestFile(dirs), 'utf8'));
  assert.equal(manifest.target, dirs.target);
  assert.equal(manifest.createdFile, true);
  assert.equal(manifest.backup, null);
  assert.equal(manifest.content, LOADER);
  assert.equal(typeof manifest.installedAt, 'number');

  const second = install(dirs);
  assert.equal(second.changed, false);
  assert.equal(second.diff, '');
  assert.equal(readFileSync(dirs.target, 'utf8'), LOADER);
  assert.deepEqual(extensionDirEntries(dirs), ['ccmem.ts'], 'a no-op re-run leaves no backup or temp file');
});

test('the written loader imports the real extension and default-exports a factory', async () => {
  const dirs = freshDirs();
  installOmp({ agentDir: dirs.agentDir, dataRoot: dirs.dataRoot, repoRoot: ROOT, execPath: NODE });
  assert.equal(readFileSync(dirs.target, 'utf8'), ompLoaderSource({ repoRoot: ROOT, execPath: NODE }));

  const loaded = await import(pathToFileURL(dirs.target).href);
  assert.equal(typeof loaded.default, 'function', 'OMP takes module.default as the extension factory');
  const events = [];
  loaded.default({ on: (event) => events.push(event), sendMessage: () => {} });
  assert.deepEqual(events.sort(), ['before_agent_start', 'session_start', 'session_stop', 'session_switch']);
});

test('install backs up a different ccmem.ts, replaces it, and keeps its mode', () => {
  const dirs = freshDirs();
  writeForeign(dirs);

  const result = install(dirs);
  assert.equal(result.changed, true);
  assert.equal(readFileSync(dirs.target, 'utf8'), LOADER);
  assert.equal(mode(dirs.target), 0o644, 'an existing file keeps its mode');

  assert.ok(result.backup);
  assert.equal(readFileSync(result.backup, 'utf8'), FOREIGN);
  assert.equal(mode(result.backup), 0o600);
  assert.match(path.basename(result.backup), /^ccmem\.ts\.bak\.\d+$/);
  // OMP auto-loads every `extensions/*.ts` / `*.js`; a backup that ended in
  // either would run as a second extension.
  assert.doesNotMatch(result.backup, /\.(ts|js)$/);
  assert.match(result.diff, /^- export default function \(pi\)/m);
  assert.match(result.diff, /^\+ import \{ createCcmemExtension \}/m);

  const manifest = JSON.parse(readFileSync(manifestFile(dirs), 'utf8'));
  assert.equal(manifest.createdFile, false);
  assert.equal(manifest.backup, result.backup);
});

test('uninstall after a fresh install deletes the loader and the manifest', () => {
  const dirs = freshDirs();
  install(dirs);

  assert.deepEqual(uninstall(dirs), { changed: true, restored: true });
  assert.equal(existsSync(dirs.target), false);
  assert.equal(existsSync(manifestFile(dirs)), false);
  assert.deepEqual(extensionDirEntries(dirs), []);
  assert.deepEqual(uninstall(dirs), { changed: false, restored: false });
});

test('uninstall after a replace restores the original bytes and mode', () => {
  const dirs = freshDirs();
  writeForeign(dirs, FOREIGN, 0o640);
  install(dirs);

  assert.deepEqual(uninstall(dirs), { changed: true, restored: true });
  assert.equal(readFileSync(dirs.target, 'utf8'), FOREIGN);
  assert.equal(mode(dirs.target), 0o640);
  assert.equal(existsSync(manifestFile(dirs)), false);
});

test('uninstall without a manifest leaves an existing ccmem.ts alone', () => {
  const dirs = freshDirs();
  writeForeign(dirs);
  assert.deepEqual(uninstall(dirs), { changed: false, restored: false });
  assert.equal(readFileSync(dirs.target, 'utf8'), FOREIGN);
});

test('uninstall after the human edited the loader saves the edit, then restores', () => {
  const dirs = freshDirs();
  writeForeign(dirs);
  install(dirs);
  const edited = `${LOADER}// my tweak\n`;
  writeFileSync(dirs.target, edited);

  const result = uninstall(dirs);
  assert.equal(result.changed, true);
  assert.equal(result.restored, true);
  assert.equal(readFileSync(result.editedBackup, 'utf8'), edited, 'the human\'s edit is not lost');
  assert.equal(readFileSync(dirs.target, 'utf8'), FOREIGN);
});

test('install refuses when the recorded install differs from what would be written now', () => {
  const dirs = freshDirs();
  install(dirs);
  assert.throws(() => install(dirs, { repoRoot: '/opt/moved/ccmem' }), /ccmem uninstall omp/);
  assert.equal(readFileSync(dirs.target, 'utf8'), LOADER);
});

test('install refuses a ccmem loader it has no record of', () => {
  const dirs = freshDirs();
  writeForeign(dirs, LOADER, 0o600);
  assert.throws(() => install(dirs), /no install record/);
  assert.equal(existsSync(manifestFile(dirs)), false);
  assert.deepEqual(extensionDirEntries(dirs), ['ccmem.ts']);
});

test('install refuses a path that cannot sit inside the loader\'s quoted strings', () => {
  for (const bad of ["/opt/it's/ccmem", '/opt/back\\slash', '/opt/new\nline']) {
    const dirs = freshDirs();
    assert.throws(() => install(dirs, { repoRoot: bad }), /refusing to install/);
    assert.equal(existsSync(dirs.agentDir), false);
    assert.equal(existsSync(manifestFile(dirs)), false);
  }
});

test('a failed loader write names the backup, and uninstall restores the original', () => {
  const dirs = freshDirs();
  writeForeign(dirs);
  const failingWrite = (file) => {
    writeFileSync(file, 'half-wri');
    throw new Error('disk full');
  };

  assert.throws(() => install(dirs, { writeFile: failingWrite }), (error) => {
    assert.match(error.message, /disk full/);
    assert.match(error.message, /ccmem\.ts\.bak\.\d+/);
    assert.match(error.message, /ccmem uninstall omp/);
    return true;
  });

  const result = uninstall(dirs);
  assert.equal(result.restored, true);
  assert.equal(readFileSync(dirs.target, 'utf8'), FOREIGN);
});

test('getOmpAgentDir follows OMP: profile, then PI_CODING_AGENT_DIR, then ~/.omp/agent; CCMEM_OMP_AGENT_DIR wins', () => {
  const home = os.homedir();
  assert.equal(getOmpAgentDir({}), path.join(home, '.omp', 'agent'));
  assert.equal(getOmpAgentDir({ PI_CODING_AGENT_DIR: '/x/agent' }), '/x/agent');
  assert.equal(getOmpAgentDir({ PI_CONFIG_DIR: '.pi' }), path.join(home, '.pi', 'agent'));
  // A named profile derives its own agent dir and ignores PI_CODING_AGENT_DIR.
  assert.equal(getOmpAgentDir({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: '/x/agent' }), path.join(home, '.omp', 'profiles', 'work', 'agent'));
  assert.equal(getOmpAgentDir({ PI_PROFILE: 'legacy' }), path.join(home, '.omp', 'profiles', 'legacy', 'agent'));
  // An explicitly empty OMP_PROFILE selects the default profile over PI_PROFILE.
  assert.equal(getOmpAgentDir({ OMP_PROFILE: '', PI_PROFILE: 'legacy', PI_CODING_AGENT_DIR: '/x/agent' }), '/x/agent');
  assert.equal(getOmpAgentDir({ CCMEM_OMP_AGENT_DIR: '/c/agent', OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: '/x/agent' }), '/c/agent');
});

test('ccmem install omp writes into PI_CODING_AGENT_DIR when CCMEM_OMP_AGENT_DIR is unset', () => {
  const dirs = freshDirs();
  const env = { ...process.env, PI_CODING_AGENT_DIR: dirs.agentDir, CCMEM_DATA_ROOT: dirs.dataRoot };
  for (const name of ['CCMEM_OMP_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR']) {
    delete env[name];
  }
  const run = (...args) => spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, ...args], { cwd: ROOT, encoding: 'utf8', env });

  const installed = run('install', 'omp');
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes(`OMP agent directory ${dirs.agentDir} `), installed.stdout);
  assert.equal(readFileSync(dirs.target, 'utf8'), ompLoaderSource({ repoRoot: ROOT, execPath: NODE }));

  const removed = run('uninstall', 'omp');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(dirs.target), false);
});

test('ccmem install omp prints the target and diff; uninstall undoes it', () => {
  const dirs = freshDirs();
  const env = { ...process.env, CCMEM_OMP_AGENT_DIR: dirs.agentDir, CCMEM_DATA_ROOT: dirs.dataRoot };
  const run = (...args) => spawnSync(NODE, ['--no-warnings', '--experimental-sqlite', CLI, ...args], { cwd: ROOT, encoding: 'utf8', env });

  const installed = run('install', 'omp');
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, new RegExp(`added the ccmem extension at ${dirs.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(installed.stdout, /^\+ export default createCcmemExtension/m);
  assert.equal(readFileSync(dirs.target, 'utf8'), ompLoaderSource({ repoRoot: ROOT, execPath: NODE }));

  const again = run('install', 'omp');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already installed; nothing changed/);

  const removed = run('uninstall', 'omp');
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed the ccmem extension/);
  assert.equal(existsSync(dirs.target), false);

  const none = run('uninstall', 'omp');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /no ccmem extension to remove/);
});
