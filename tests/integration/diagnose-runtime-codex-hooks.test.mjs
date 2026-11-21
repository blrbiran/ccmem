import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tester #415 D and #416: `admin diagnose` must say what the process is actually running on
 * (Node / SQLite / FTS5, and any silent degradation) and whether the installed Codex hooks
 * have been approved in Codex's own trust record.
 *
 * Rule 17: every path here is a temp data root / temp CODEX_HOME; nothing reads the person's
 * real ~/.codex or ~/.claude/ccmem.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const NODE = process.execPath;

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-diagnose-runtime-'));
const codexHome = mkdtempSync(path.join(tmpdir(), 'ccmem-diagnose-codex-'));
const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-diagnose-cwd-'));

const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot, CODEX_HOME: codexHome };
delete env.CCMEM_CONFIG_PATH;

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb, ftsDiagnostics } = await import('../../scripts/lib/db.mjs');
const { codexHookTrust, trustedHookKeys } = await import('../../scripts/lib/install/codex.mjs');

test.after(() => {
  for (const dir of [dataRoot, codexHome, cwd]) rmSync(dir, { recursive: true, force: true });
});

function writeCodexHome({ approve }) {
  mkdirSync(codexHome, { recursive: true });
  const hook = (mode) => ({
    type: 'command',
    command: `${NODE} --no-warnings --experimental-sqlite ${ROOT}/scripts/hook.mjs ${mode} --agent codex`,
    timeout: 5
  });
  writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [hook('session-start')] }],
      UserPromptSubmit: [{ hooks: [hook('prompt-submit')] }],
      Stop: [{ hooks: [hook('stop')] }]
    }
  }, null, 2));
  const target = path.join(codexHome, 'hooks.json');
  const keys = [
    `${target}:session_start:0:0`,
    `${target}:user_prompt_submit:0:0`,
    `${target}:stop:0:0`
  ];
  const state = keys.slice(0, approve).map((key) => `[hooks.state."${key}"]\ntrusted_hash = "sha256:test"\n`).join('\n');
  writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-test"\n\n[hooks.state]\n\n${state}`);
  return keys;
}

test('ftsDiagnostics names why FTS is or is not usable', () => {
  const db = openDb();
  try {
    const fts = ftsDiagnostics(db);
    // The suite runs on a node build with FTS5 (the handoff pins /usr/local/bin/node for exactly this).
    assert.equal(fts.status, 'ready');
    assert.equal(fts.supported, true);
    assert.equal(fts.table_present, true);
    assert.equal(fts.disabled_by_env, false);
  } finally {
    db.close();
  }
});

test('codexHookTrust counts approved keys against the groups that carry ccmem commands', () => {
  const keys = writeCodexHome({ approve: 1 });
  const trust = codexHookTrust({ codexHome });
  // mutation (report installed as approved) -> approved is 1, not 3, red.
  assert.equal(trust.installed, true);
  assert.equal(trust.total, 3);
  assert.equal(trust.approved, 1);
  assert.deepEqual(trust.missing, keys.slice(1));
  // mutation (parse only the first state table) -> the second key is missing from this set, red.
  const trusted = trustedHookKeys('[hooks.state]\n\n[hooks.state."a:b:0:0"]\ntrusted_hash = "x"\n\n[hooks.state."c:d:0:0"]\ntrusted_hash = "y"\n');
  assert.deepEqual([...trusted].sort(), ['a:b:0:0', 'c:d:0:0']);
});

test('admin diagnose prints the runtime and the Codex trust state', () => {
  writeCodexHome({ approve: 2 });
  const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
  // mutation (drop the runtime line) -> red.
  assert.match(out, /^Runtime {2}: node v\d+\.\d+\.\d+ \| sqlite \d+\.\d+\.\d+ \| fts5 ready$/m);
  // mutation (print "all approved" without comparing counts) -> red.
  assert.match(out, /^Codex {4}: hooks installed, 2 of 3 approved — open codex and run \/hooks$/m);
});

test('admin diagnose says so when the Codex hooks are not installed at all', () => {
  rmSync(path.join(codexHome, 'hooks.json'));
  rmSync(path.join(codexHome, 'config.toml'));
  writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test"\n');
  const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
  assert.match(out, /^Codex {4}: ccmem hooks are not installed \(ccmem install codex\)$/m);
});