import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot, CCMEM_LAUNCHAGENT_DIR: path.join(dataRoot, 'launch-agents'), CODEX_HOME: codexHome };
delete env.CCMEM_CONFIG_PATH;

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb, ftsDiagnostics } = await import('../../scripts/lib/db.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { codexHookTrust, trustedHookKeys } = await import('../../scripts/lib/install/codex.mjs');

test.after(() => {
  for (const dir of [dataRoot, codexHome, cwd]) rmSync(dir, { recursive: true, force: true });
});

function writeCodexHome({ approve, quoted = false }) {
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
  const header = (key) => (quoted ? `["hooks"."state"."${key}"]` : `[hooks.state."${key}"]`);
  const state = keys.slice(0, approve).map((key) => `${header(key)}\ntrusted_hash = "sha256:test"\n`).join('\n');
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
    assert.equal(fts.trigger_health, 'ready');
    assert.deepEqual(fts.triggers_present, ['memories_ai', 'memories_ad', 'memories_au']);
    assert.deepEqual(fts.legacy_triggers, []);
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

// Tester #464: real Codex 0.170.0 writes every header segment quoted -- `["hooks"."state"."<key>"]` -- and the parser
// matched only the bare `[hooks.state."<key>"]` this file's fixture imagined, so a person who approved all three hooks
// read "0 of 3 approved". The fixture's own shape could never catch it; this row uses the shape Codex writes.
test('trustedHookKeys reads the header shape Codex 0.170 writes: every segment quoted, single or double, spaced or not', () => {
  const real = '[hooks]\n\n["hooks"."state"]\n\n["hooks"."state"."/h/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:a"\n\n'
    + "[ 'hooks' . state . \"/h/hooks.json:stop:0:0\" ]\ntrusted_hash = \"sha256:b\"\n\n"
    + '["hooks".state]\n"/h/hooks.json:user_prompt_submit:0:0" = { trusted_hash = "sha256:c" }\n\n'
    + '["hooks"."other"."not-a-trust-key"]\nx = 1\n';
  // mutation: match only the bare `[hooks.state."k"]` header (the old regex) -> an empty set, red
  assert.deepEqual([...trustedHookKeys(real)].sort(), [
    '/h/hooks.json:session_start:0:0', '/h/hooks.json:stop:0:0', '/h/hooks.json:user_prompt_submit:0:0',
  ]);
  const keys = writeCodexHome({ approve: 3, quoted: true });
  const trust = codexHookTrust({ codexHome });
  assert.equal(trust.approved, 3);
  assert.deepEqual(trust.missing, []);
  assert.equal(keys.length, 3);
});

// Tester #464 (gap): Codex 0.172 also writes the trust path as ONE flat dotted key -- the 15:02 snapshot held
// `"hooks"."state"."<key>"."trusted_hash" = ...` at top level -- and TOML lets the header carry any prefix of that
// path. Each split below returned 0 keys while the header-only parser was in place; every one must read its keys.
test('trustedHookKeys reads flat dotted trust keys at any split between header and key', () => {
  const shapes = {
    // The tester's 15:02 snapshot shape: other tools' keys only (10 in the real file), no ccmem key, top level.
    topLevel: 'model = "gpt-test"\n'
      + '"hooks"."state"."/h/hooks.json:session_start:3:0"."trusted_hash" = "sha256:a"\n'
      + "hooks.state.'/h/hooks.json:stop:1:0'.trusted_hash = \"sha256:b\"\n\n"
      + '[projects."/tmp/p"]\ntrust_level = "trusted"\n',
    underState: '[hooks.state]\n"/h/hooks.json:session_start:3:0".trusted_hash = "sha256:a"\n'
      + '"/h/hooks.json:stop:1:0" . "trusted_hash" = "sha256:b"\n',
    underHooks: '["hooks"]\nstate."/h/hooks.json:session_start:3:0".trusted_hash = "sha256:a"\n'
      + '"state"."/h/hooks.json:stop:1:0"."trusted_hash" = "sha256:b"\n',
  };
  for (const [name, text] of Object.entries(shapes)) {
    // mutation: read keys only from a header (the pre-gap parser) -> an empty set, red
    assert.deepEqual([...trustedHookKeys(text)].sort(), ['/h/hooks.json:session_start:3:0', '/h/hooks.json:stop:1:0'], name);
  }
  // Not a trust key: another field under the key, a key under another table, an array-of-tables entry.
  const decoys = '"hooks"."state"."/h/a:0:0"."enabled" = true\n[hooks.other]\n"/h/b:0:0".trusted_hash = "x"\n'
    + '[[hooks.state]]\n"/h/c:0:0" = { trusted_hash = "y" }\n';
  assert.deepEqual([...trustedHookKeys(decoys)], []);

  // The two snapshots the tester compared must read differently: ccmem's keys absent (15:02) -> 0 of 3,
  // present in the same flat shape -> 3 of 3.
  const keys = writeCodexHome({ approve: 0 });
  const flat = (key) => `"hooks"."state"."${key}"."trusted_hash" = "sha256:test"\n`;
  writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-test"\n${flat('/h/hooks.json:session_start:3:0')}`);
  assert.equal(codexHookTrust({ codexHome }).approved, 0);
  writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-test"\n${keys.map(flat).join('')}`);
  const trust = codexHookTrust({ codexHome });
  assert.equal(trust.approved, 3);
  assert.deepEqual(trust.missing, []);
});

test('admin diagnose prints the runtime and the Codex trust state', () => {
  writeCodexHome({ approve: 2 });
  const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
  // mutation (drop the runtime line) -> red.
  assert.match(out, /^Runtime {2}: node v\d+\.\d+\.\d+ \| sqlite \d+\.\d+\.\d+ \| fts5 ready$/m);
  // mutation (print "all approved" without comparing counts) -> red.
  assert.match(out, /^Codex {4}: hooks installed, 2 of 3 approved — open codex and run \/hooks$/m);
});

// Tester #452: an unapproved (or otherwise skipped) ccmem hook leaves no trace anywhere -- Codex logs nothing and ccmem
// never hears of the session. Diagnose now compares Codex's own rollout files from the last 24 h with the sessions
// ccmem's hooks recorded, so "approved but nothing reaches ccmem" is a number instead of a guess.
test('admin diagnose fails with a redacted legacy FTS trigger health report', () => {
  const db = openDb();
  try {
    db.exec(`CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END`);
  } finally {
    db.close();
  }
  try {
    const result = spawnSync(NODE, [CLI, 'admin', 'diagnose'], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^FTS triggers: repair-needed \(legacy=memories_fts_insert, missing=none, unrecognized=none\)$/m);
    assert.equal(result.stdout.includes('content'), false);
  } finally {
    const cleanup = openDb();
    try { cleanup.exec('DROP TRIGGER IF EXISTS memories_fts_insert'); } finally { cleanup.close(); }
  }
});

test('admin diagnose counts the last 24 h of Codex sessions that never reached the ccmem hooks (#452)', () => {
  writeCodexHome({ approve: 3, quoted: true });
  const now = new Date();
  const day = path.join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const ids = ['01a20c3c-d332-74c0-9671-f8e51f5648b0', '01a20946-90c5-7c51-b779-5a4c67fb9e08', '01a2089c-5c99-7920-81ce-d62ab4c8070b', '01a20c3c-d332-74c0-9671-f8e51f5648b1'];
  const rolloutRows = [
    { type: 'session_meta', payload: { features: { hooks: false } } }, // an observed hook wins over config
    { type: 'session_meta', payload: { config_overrides: ['features.hooks=false'] } },
    { type: 'response_item', payload: { text: 'example command: -c features.hooks=false' } },
    { type: 'session_meta', payload: { features: { hooks: false } } }
  ];
  ids.forEach((id, i) => writeFileSync(path.join(day, `rollout-2026-11-24T14-2${i}-00-${id}.jsonl`), `${JSON.stringify(rolloutRows[i])}\n`));
  const old = path.join(day, 'rollout-2026-11-20T09-00-00-01a1ffff-0000-7000-8000-000000000000.jsonl');
  writeFileSync(old, '{}\n');
  const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  const db = openDb();
  try {
    db.prepare(`INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent)
      VALUES (?, 'p', 0, 0, 0, 0, ?, 'codex')`).run(ids[0], Date.now());
  } finally {
    db.close();
  }
  try {
    const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
    assert.match(out, /^Codex {4}: hooks installed, all approved$/m);
    // mutation: count every rollout file (drop the 24 h mtime filter) -> 5 sessions, red;
    // mutation: count sessions without the session_context lookup -> 0 or 4 missed, red
    assert.match(out, /^Codex {4}: last 24h 4 sessions, 2 requested hooks off for that run, 1 never reached the ccmem hooks \(check the hook command and whether this session type runs hooks\)$/m);

    // Tester #452 (nit): SessionStart writes no session_context while ccmem is off or in shadow, so the same four
    // sessions must not read as "never reached ... not approved"; the line names the mode instead.
    // mutation: ignore the mode -> a missed count again, red
    for (const mode of ['off', 'shadow']) {
      const modeDb = openDb();
      try { setMode(modeDb, mode); } finally { modeDb.close(); }
      const offOut = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
      assert.doesNotMatch(offOut, /never reached the ccmem hooks/, mode);
      assert.match(offOut, new RegExp(`^Codex {4}: last 24h 4 sessions; not checked against the ccmem hooks while ccmem mode is ${mode} \\(hooks record no session then; ccmem mode active\\)$`, 'm'));
    }
  } finally {
    const modeDb = openDb();
    try { setMode(modeDb, 'active'); } finally { modeDb.close(); }
    rmSync(path.join(codexHome, 'sessions'), { recursive: true, force: true });
  }
});

test('admin diagnose excludes subagent rollouts and recognizes continuation files (#559)', () => {
  writeCodexHome({ approve: 3, quoted: true });
  const now = new Date();
  const day = path.join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const subagents = Array.from({ length: 19 }, (_, index) => `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`);
  const users = [
    '10000000-0000-7000-8000-000000000001',
    '10000000-0000-7000-8000-000000000002',
    '10000000-0000-7000-8000-000000000003'
  ];
  for (const [index, id] of subagents.entries()) {
    const meta = index < 10
      ? { type: 'session_meta', payload: { thread_source: 'guardian_review' } }
      : { type: 'session_meta', payload: { source: { subagent: { name: `review-${index}` } } } };
    writeFileSync(path.join(day, `rollout-2026-11-27T08-00-${String(index).padStart(2, '0')}-${id}.jsonl`), `${JSON.stringify(meta)}\n`);
  }
  const outsideWindowRollout = path.join(day, `rollout-2026-11-27T08-00-00-${subagents[0]}.jsonl`);
  const outsideWindow = (Date.now() - 48 * 3600 * 1000) / 1000;
  utimesSync(outsideWindowRollout, outsideWindow, outsideWindow);
  const incompleteContinuation = path.join(day, `rollout-2026-11-27T08-59-00-${subagents[0]}_20000000-0000-7000-8000-000000000002.jsonl`);
  writeFileSync(incompleteContinuation, '{');
  const future = (Date.now() + 1000) / 1000;
  utimesSync(incompleteContinuation, future, future);
  const conflictingContinuation = path.join(day, `rollout-2026-11-27T09-04-00-${subagents[0]}_20000000-0000-7000-8000-000000000003.jsonl`);
  writeFileSync(conflictingContinuation, '{"type":"session_meta","payload":{"thread_source":"user"}}\n');
  utimesSync(conflictingContinuation, future + 1, future + 1);
  writeFileSync(path.join(day, 'rollout-2026-11-27T09-03-00-20000000-0000-7000-8000-000000000001_dead.jsonl'), '{"type":"session_meta"}\n');
  const userMeta = { type: 'session_meta', payload: { thread_source: 'user' } };
  writeFileSync(path.join(day, `rollout-2026-11-27T09-00-00-${users[0]}.jsonl`), `${JSON.stringify(userMeta)}\n`);
  writeFileSync(path.join(day, `rollout-2026-11-27T09-01-00-${users[1]}_20000000-0000-7000-8000-000000000004.jsonl`), `${JSON.stringify(userMeta)}\n`);
  writeFileSync(path.join(day, `rollout-2026-11-27T09-02-00-${users[2]}.jsonl`),
    '{"type":"session_meta","payload":{"thread_source":"user","features":{"hooks":false}}}\n');
  const unfinishedUserTurn = path.join(day, `rollout-2026-11-27T09-05-00-${users[2]}_20000000-0000-7000-8000-000000000005.jsonl`);
  writeFileSync(unfinishedUserTurn, '{');
  utimesSync(unfinishedUserTurn, future, future);
  const db = openDb();
  try {
    for (const id of users.slice(0, 2)) {
      db.prepare(`INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent)
        VALUES (?, 'p', 0, 0, 0, 0, ?, 'codex')`).run(id, Date.now());
    }
  } finally { db.close(); }
  const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
  assert.match(out, /^Codex {4}: last 24h 22 sessions, 19 subagent sessions excluded, 0 requested hooks off for that run, 1 never reached the ccmem hooks \(check the hook command and whether this session type runs hooks\)$/m);
});

test('admin diagnose says so when the Codex hooks are not installed at all', () => {
  rmSync(path.join(codexHome, 'hooks.json'));
  rmSync(path.join(codexHome, 'config.toml'));
  writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-test"\n');
  const out = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], { cwd, env, encoding: 'utf8' });
  assert.match(out, /^Codex {4}: ccmem hooks are not installed \(ccmem install codex\)$/m);
});