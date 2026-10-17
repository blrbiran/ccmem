import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Failover asks first (spec §5.5, G5; the human's ruling). A fallback backend
 * may bill per token and shares quota with the human's own Codex/OMP work, so:
 *
 * - an exhausted backend never hands work to another on its own: the task
 *   stays queued (no busy retry), a proposal opens, and nothing else runs;
 * - only `ccmem admin llm approve` moves work, and the switch is audited
 *   with from/to/reason;
 * - once the preferred backend's reset time passes, work goes back to it with
 *   no approval;
 * - with every backend exhausted there is no one to propose and the task
 *   still waits;
 * - the ask surfaces where the human sees it: the session-start context file
 *   and the status output.
 *
 * No real claude/codex/omp is run: llm.commands points at fake binaries that
 * log which backend was called.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-llm-failover-'));
const fakeDir = mkdtempSync(path.join(tmpdir(), 'ccmem-llm-failover-fakes-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CODEX_HOME = path.join(fakeDir, 'codex-home');
process.env.CCMEM_OMP_AGENT_DIR = path.join(fakeDir, 'omp-agent');
delete process.env.CCMEM_CONFIG_PATH;
delete process.env.CCMEM_CLAUDE_P_COMMAND;
delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;

const CALLS = path.join(fakeDir, 'calls.log');
process.env.CCMEM_FAKE_CALLS = CALLS;

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { runTask } = await import('../../scripts/daemon/loop.mjs');
const { resolveActiveBackend } = await import('../../scripts/daemon/backend-state.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');
const { getContextFilePath } = await import('../../scripts/lib/context-file.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
});

// Each fake appends its backend id to CALLS, then behaves per its own
// CCMEM_FAKE_<ID> mode: 'ok' answers, 'limit' reports exhausted quota the
// way that tool does.
const LOG = `
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
`;

function writeFake(id, body) {
  const file = path.join(fakeDir, `fake-${id}`);
  writeFileSync(file, `#!${process.execPath}
${LOG}
fs.appendFileSync(process.env.CCMEM_FAKE_CALLS, '${id}\\n');
const mode = process.env.CCMEM_FAKE_${id.toUpperCase()} ?? 'ok';
${body}
`);
  chmodSync(file, 0o700);
  return file;
}

const FAKE_CLAUDE = writeFake('claude', `
if (mode === 'limit') {
  process.stderr.write('429 rate limit; retry-after: 30m');
  process.exit(29);
}
process.stdout.write('claude answer');
`);

const FAKE_CODEX = writeFake('codex', `
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (mode === 'limit') {
  out({ type: 'error', message: "You've hit your usage limit. Try again at Oct 22nd, 2099 2:13 PM." });
  process.exit(1);
}
out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex answer' } });
fs.writeFileSync(at('-o'), 'codex answer');
`);

const FAKE_OMP = writeFake('omp', `
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'omp answer' }], stopReason: 'stop' } });
`);

const CONFIG_PATH = path.join(dataRoot, 'config.json');
const COMMANDS = { claude: FAKE_CLAUDE, codex: FAKE_CODEX, omp: FAKE_OMP };

function writeConfig(llm = {}) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ llm: { backend: 'claude', commands: COMMANDS, ...llm } }));
}

function reset({ claude = 'ok', codex = 'ok' } = {}) {
  // Each test starts with no exhaustion, proposal or task on record.
  const db = openDb();
  db.exec('DELETE FROM llm_backend_state');
  db.exec('DELETE FROM llm_switch_proposals');
  db.exec("DELETE FROM audit_log WHERE action LIKE 'llm_%'");
  db.exec('DELETE FROM tasks');
  db.close();
  writeConfig();
  rmSync(CALLS, { force: true });
  process.env.CCMEM_FAKE_CLAUDE = claude;
  process.env.CCMEM_FAKE_CODEX = codex;
}

function calls() {
  return existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function withDb(work) {
  const db = openDb();
  try {
    return work(db);
  } finally {
    db.close();
  }
}

async function withDbAsync(work) {
  const db = openDb();
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

function enqueue(db) {
  const now = Date.now();
  const id = Number(db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('security_audit', '{}', ?, ?, 'queued')`
  ).run(now, now).lastInsertRowid);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

const dispatchLlm = async () => {
  await callClaudeP('audit this', { taskType: 'security_audit' });
};

function queuedTasks(db) {
  return db.prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id`).all();
}

function openProposals(db) {
  return db.prepare(
    'SELECT * FROM llm_switch_proposals WHERE approved_at IS NULL AND superseded_at IS NULL'
  ).all();
}

function auditRows(db, action) {
  return db.prepare('SELECT details FROM audit_log WHERE action = ? ORDER BY id').all(action)
    .map((row) => JSON.parse(row.details));
}

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, CCMEM_DATA_ROOT: dataRoot },
    encoding: 'utf8'
  });
}

// Runs the task that exhausts claude: one claude call, a queued retry.
async function exhaustClaude(db) {
  const before = Date.now();
  await runTask(db, enqueue(db), dispatchLlm);
  return before;
}

test('exhaustion keeps the task queued and opens a proposal, but switches nothing', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    const before = await exhaustClaude(db);

    const [retry] = queuedTasks(db);
    assert.ok(retry, 'the task must stay queued, not fail for good');
    assert.ok(retry.scheduled_for >= before + 60_000, 'the retry waits at least a minute: no busy loop');
    const [proposal] = openProposals(db);
    assert.equal(proposal?.from_backend, 'claude');
    assert.equal(proposal.to_backend, 'codex', 'the next backend in the default order');
    assert.deepEqual(auditRows(db, 'llm_backend_exhausted').map((row) => [row.backend, row.proposal_to]), [['claude', 'codex']]);

    // The retry comes due while claude is still exhausted and nothing was
    // approved: it must not run codex. (Claude itself is asked again: its 429
    // carries the retry-after its retries follow.)
    await runTask(db, retry, dispatchLlm);
    assert.deepEqual(calls(), ['claude', 'claude'], 'no other backend may run without approval');
    const [again] = queuedTasks(db);
    assert.ok(again && again.scheduled_for - again.enqueued_at >= 60_000, 'still queued, still waiting');
    assert.equal(openProposals(db).length, 1, 'one open question, not one per retry');
  });
});

test('an exhausted codex is not run again before its reset: the task waits without a call', async () => {
  reset({ codex: 'limit' });
  writeConfig({ backend: 'codex' });
  await withDbAsync(async (db) => {
    const before = Date.now();
    await runTask(db, enqueue(db), dispatchLlm);
    const [retry] = queuedTasks(db);
    assert.ok(retry && retry.scheduled_for >= before + 60_000);
    assert.equal(openProposals(db)[0]?.to_backend, 'omp', 'the next backend after codex in the default order');

    await runTask(db, retry, dispatchLlm);
    assert.deepEqual(calls(), ['codex'], 'the exhausted backend is not hammered, and omp is not run unapproved');
    const [again] = queuedTasks(db);
    assert.ok(again && again.scheduled_for - again.enqueued_at >= 60_000, 'no busy loop');
  });
});

test('a claude call that answers clears its exhaustion and the open question', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    await exhaustClaude(db);
  });
  process.env.CCMEM_FAKE_CLAUDE = 'ok';
  assert.equal(await callClaudeP('audit this', { taskType: 'security_audit' }), 'claude answer');
  assert.equal(await callClaudeP('audit this', { taskType: 'security_audit' }), 'claude answer');
  withDb((db) => {
    assert.equal(openProposals(db).length, 0, 'a backend that answers is not proposed away from');
    assert.equal(db.prepare(`SELECT exhausted_until FROM llm_backend_state WHERE backend = 'claude'`).get().exhausted_until, null);
  });
});

test('approve switches the next call to codex and audits from, to and reason', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    await exhaustClaude(db);
  });

  const approved = cli('admin', 'llm', 'approve');
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /approved switch claude -> codex/);

  assert.equal(await callClaudeP('audit this', { taskType: 'security_audit' }), 'codex answer');
  assert.deepEqual(calls(), ['claude', 'codex']);
  withDb((db) => {
    const [switched] = auditRows(db, 'llm_backend_switch');
    assert.equal(switched.from, 'claude');
    assert.equal(switched.to, 'codex');
    assert.match(switched.reason, /^claude quota exhausted until \d{4}-\d\d-\d\dT/);
  });
});

test('after the reset time passes, work goes back to claude with no approval', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    await exhaustClaude(db);
  });
  assert.equal(cli('admin', 'llm', 'approve').status, 0);

  const until = withDb((db) => db.prepare(`SELECT exhausted_until FROM llm_backend_state WHERE backend = 'claude'`).get().exhausted_until);
  withDb((db) => {
    // Injected clock: one moment before the reset still runs on codex.
    assert.equal(resolveActiveBackend(db, { llm: { backend: 'claude' } }, until - 1), 'codex');
    // Real call path: move the recorded reset into the past.
    db.prepare(`UPDATE llm_backend_state SET exhausted_until = ? WHERE backend = 'claude'`).run(Date.now() - 1);
  });

  process.env.CCMEM_FAKE_CLAUDE = 'ok';
  assert.equal(await callClaudeP('audit this', { taskType: 'security_audit' }), 'claude answer');
  assert.deepEqual(calls(), ['claude', 'claude']);
  withDb((db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM llm_switch_proposals WHERE superseded_at IS NULL').get().n, 0,
      'the approval is used up: the next exhaustion asks again');
    assert.deepEqual(auditRows(db, 'llm_backend_switch').map((row) => [row.from, row.to]), [['claude', 'codex'], ['codex', 'claude']]);
  });
});

test('with every backend exhausted there is no proposal and the task stays queued', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    const later = Date.now() + 3_600_000;
    const seed = db.prepare(
      `INSERT INTO llm_backend_state (backend, exhausted_until, last_error, updated_at) VALUES (?, ?, 'seeded', ?)`
    );
    seed.run('codex', later, Date.now());
    seed.run('omp', later, Date.now());

    const before = await exhaustClaude(db);
    assert.equal(openProposals(db).length, 0, 'nothing to propose');
    assert.deepEqual(auditRows(db, 'llm_backend_exhausted').map((row) => row.proposal_to), [null]);
    const [retry] = queuedTasks(db);
    assert.ok(retry && retry.scheduled_for >= before + 60_000);

    await runTask(db, retry, dispatchLlm);
    assert.deepEqual(calls(), ['claude', 'claude'], 'codex and omp are never run');
    assert.equal(queuedTasks(db).length, 1);
    assert.equal(openProposals(db).length, 0);
  });
});

test('an open proposal leads the session-start context file until it is answered', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    await exhaustClaude(db);
  });
  const until = withDb((db) => db.prepare(`SELECT exhausted_until FROM llm_backend_state WHERE backend = 'claude'`).get().exhausted_until);
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-llm-failover-cwd-'));
  const sessionId = 'failover-session-1';

  await handleSessionStart({ cwd, session_id: sessionId });
  const lines = readFileSync(getContextFilePath(cwd, sessionId), 'utf8').split('\n');
  assert.match(lines[0], /^<!-- content-hash: [a-f0-9]+ -->$/);
  assert.equal(
    lines[1],
    `ccmem: claude quota exhausted until ${new Date(until).toISOString()}; run \`ccmem admin llm approve\` to switch background work to codex.`
  );

  assert.equal(cli('admin', 'llm', 'reject').status, 0);
  await handleSessionStart({ cwd, session_id: sessionId });
  const after = readFileSync(getContextFilePath(cwd, sessionId), 'utf8');
  assert.doesNotMatch(after, /admin llm approve/, 'an answered proposal is no longer asked');
  rmSync(cwd, { recursive: true, force: true });
});

test('status output shows the backend, the exhaustion and the open proposal', async () => {
  reset({ claude: 'limit' });
  await withDbAsync(async (db) => {
    await exhaustClaude(db);
  });

  const llm = cli('admin', 'llm', 'status');
  assert.equal(llm.status, 0, llm.stderr);
  assert.match(llm.stdout, /^ccmem: llm backend=claude preferred=claude order=claude,codex,omp exhausted=claude@\d{4}-.+ proposal=claude->codex$/m);

  const daemon = cli('admin', 'daemon', 'status');
  assert.equal(daemon.status, 0, daemon.stderr);
  assert.match(daemon.stdout, /^ccmem: llm backend=claude .*proposal=claude->codex$/m);
});

test('admin llm use and order back up config.json and keep the rest of it', () => {
  reset();
  const original = readFileSync(CONFIG_PATH, 'utf8');

  const used = cli('admin', 'llm', 'use', 'codex');
  assert.equal(used.status, 0, used.stderr);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(config.llm.backend, 'codex');
  assert.deepEqual(config.llm.commands, COMMANDS, 'other settings survive the write');
  const backups = readdirSync(dataRoot).filter((name) => /^config\.json\.bak\.\d+$/.test(name));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(dataRoot, backups[0]), 'utf8'), original, 'the backup holds the bytes before the change');

  const ordered = cli('admin', 'llm', 'order', 'omp,claude');
  assert.equal(ordered.status, 0, ordered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).llm.backend_order, ['omp', 'claude']);

  const before = readFileSync(CONFIG_PATH, 'utf8');
  const bogus = cli('admin', 'llm', 'use', 'gpt');
  assert.notEqual(bogus.status, 0);
  assert.equal(readFileSync(CONFIG_PATH, 'utf8'), before, 'an unknown backend writes nothing');

  for (const name of readdirSync(dataRoot).filter((n) => n.startsWith('config.json.bak.'))) {
    rmSync(path.join(dataRoot, name));
  }
});
