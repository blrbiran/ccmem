import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-flow-'));

const NODE = '/usr/local/bin/node';
const CLI = '/Users/biran/code/skills/ccmem/scripts/cli.mjs';
const HOOK = '/Users/biran/code/skills/ccmem/scripts/hook.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdList } = await import('../../scripts/lib/cmd/list.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');

function resetSaveListTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM cross_scope_alerts`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM ccmem_blacklisted_sessions`).run();
  db.prepare(`DELETE FROM memories`).run();
  db.prepare(`DELETE FROM config_kv WHERE key = 'mode'`).run();
}

async function seedQuarantinedListFixture(db, now = Date.now()) {
  await cmdSave(db, { cwd: '/Users/biran/code/skills/ccmem', content: 'Visible list memory', scope: 'project' });
  const quarantined = await cmdSave(db, { cwd: '/Users/biran/code/skills/ccmem', content: 'Quarantined list memory', scope: 'project' });
  const quarantinedAt = now - (26 * 86400000);

  db.prepare(
    `UPDATE memories
     SET decay_status = 'quarantine', quarantined_at = ?, trust_score = ?
     WHERE id = ?`
  ).run(quarantinedAt, 0.2, quarantined.id);

  const audit = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'security_quarantine_in', ?, ?)`
  ).run(
    quarantinedAt,
    JSON.stringify([quarantined.id]),
    JSON.stringify({ reason: 'tier3_auto' })
  );

  db.prepare(
    `INSERT INTO audit_log_targets (audit_id, mem_id)
     VALUES (?, ?)`
  ).run(Number(audit.lastInsertRowid), quarantined.id);
}

test('save -> list -> session start inject works and records session diagnostics', async () => {
  const db = openDb();
  const saved = await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  const rows = await cmdList(db, { query: null, limit: 10 });
  assert.equal(rows.length, 1);

  const result = await handleSessionStart({ cwd: process.cwd(), session_id: 's-start' });
  const injection = db.prepare(
    `SELECT prompt_idx, inject_source, mem_ids
     FROM recent_injections
     WHERE session_id = 's-start'`
  ).get();
  const session = db.prepare(
    `SELECT session_id, project_key, tool_calls, message_count, last_seq
     FROM session_context
     WHERE session_id = 's-start'`
  ).get();

  assert.match(result.additionalContext, /Prefer concise answers/);
  assert.equal(injection.prompt_idx, 0);
  assert.equal(injection.inject_source, 'session_start');
  assert.deepEqual(JSON.parse(injection.mem_ids), [saved.id]);
  assert.equal(session.session_id, 's-start');
  assert.equal(typeof session.project_key, 'string');
  assert.equal(session.tool_calls, 0);
  assert.equal(session.message_count, 0);
  assert.equal(session.last_seq, 0);
  db.close();
});


test('cmdList excludes quarantined memories by default and returns them with reason when requested', async () => {
  const db = openDb();
  resetSaveListTables(db);
  await seedQuarantinedListFixture(db);

  const visibleRows = await cmdList(db, { limit: 10 });
  const quarantinedRows = await cmdList(db, { limit: 10, quarantined: true });

  assert.equal(visibleRows.some((row) => row.content === 'Visible list memory'), true);
  assert.equal(visibleRows.some((row) => row.content === 'Quarantined list memory'), false);
  assert.equal(quarantinedRows.length, 1);
  assert.equal(quarantinedRows[0].content, 'Quarantined list memory');
  assert.equal(quarantinedRows[0].reason, 'tier3_auto');
  db.close();
});

test('cli list --quarantined prints quarantined memories with reason', async () => {
  const db = openDb();
  resetSaveListTables(db);
  await seedQuarantinedListFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'list', '--quarantined', '--limit', '10'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: {
      ...process.env,
      CCMEM_TEST_MODE: '1',
      CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
    },
    encoding: 'utf8'
  });

  assert.match(output, /^\[m\d+\] fact \| project \| user_explicit trust=0\.20 quarantined=\d+d ago reason=tier3_auto\n$/);
  assert.doesNotMatch(output, /Visible list memory/);
});

test('session-start in off mode stays read-only and returns no injected context', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  setMode(db, 'off');

  const output = spawnSync(
    NODE,
    [HOOK, 'session-start'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-off'
      })
    }
  );

  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-off'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-off'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"SessionStart"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(injection.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('session-start hook exits early under CCMEM_INTERNAL and stays read-only', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  setMode(db, 'active');

  const output = spawnSync(
    NODE,
    [HOOK, 'session-start'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT,
        CCMEM_INTERNAL: '1'
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-internal'
      })
    }
  );

  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-internal'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-internal'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"SessionStart"/);
  assert.doesNotMatch(output.stderr, /ccmem:/);
  assert.equal(injection.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('session-start in shadow mode stays read-only and returns no injected context', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  setMode(db, 'shadow');

  const result = await handleSessionStart({ cwd: process.cwd(), session_id: 's-shadow' });
  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-shadow'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-shadow'`
  ).get();

  assert.equal(result.additionalContext, '');
  assert.equal(injection.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('session-start hook in shadow mode stays read-only and emits diagnostic notice', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  setMode(db, 'shadow');

  const output = spawnSync(
    NODE,
    [HOOK, 'session-start'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-shadow-hook'
      })
    }
  );

  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = 's-shadow-hook'`
  ).get();
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = 's-shadow-hook'`
  ).get();

  assert.equal(output.status, 0);
  assert.match(output.stdout, /"hookEventName":"SessionStart"/);
  assert.match(output.stderr, /ccmem: mode=shadow \(read-only diagnostic — no writes, no inject\)/);
  assert.equal(injection.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('session-start runs mini-prelude cleanup after writing injection', async () => {
  const db = openDb();
  const now = Date.now();
  setMode(db, 'active');
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-old', 0, 'session_start', '[99]', ?)`
  ).run(now - (15 * 86400000));

  const insertRecent = db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-many', ?, 'user_prompt_submit', '[1]', ?)`
  );
  for (let i = 1; i <= 22; i += 1) {
    insertRecent.run(i, now - i);
  }

  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
     VALUES ('summarize_pending', '2026-01-01', ?, 'completed', 'daemon')`
  ).run(now);

  const result = await handleSessionStart({ cwd: process.cwd(), session_id: 's-mini' });
  const stale = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-old'`).get();
  const kept = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections WHERE session_id = 's-many'`).get();
  const oldestKept = db.prepare(
    `SELECT MIN(prompt_idx) AS min_prompt_idx FROM recent_injections WHERE session_id = 's-many'`
  ).get();
  const oldTasks = db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE type = 'summarize_pending'`).get();
  const lease = db.prepare(
    `SELECT status FROM task_runs WHERE type = 'tier1_5_mini_prelude'`
  ).get();
  const sessionInjection = db.prepare(
    `SELECT inject_source FROM recent_injections WHERE session_id = 's-mini' AND prompt_idx = 0`
  ).get();

  assert.match(result.additionalContext, /Prefer concise answers/);
  assert.equal(stale.n, 0);
  assert.equal(kept.n, 20);
  assert.equal(oldestKept.min_prompt_idx, 1);
  assert.equal(oldTasks.n, 0);
  assert.equal(lease.status, 'completed');
  assert.equal(sessionInjection.inject_source, 'session_start');
  db.close();
});

test('handleSessionStart records the local calendar day mini-prelude lease at early-morning local times', async () => {
  const db = openDb();
  setMode(db, 'active');
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  const fixedNow = new Date(2026, 5, 8, 2, 17, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;

  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNowMs;
    }

    static parse(value) {
      return OriginalDate.parse(value);
    }

    static UTC(...args) {
      return OriginalDate.UTC(...args);
    }
  }

  global.Date = FixedDate;

  try {
    const result = await handleSessionStart({ cwd: process.cwd(), session_id: 's-local-day' });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_mini_prelude'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.match(result.additionalContext, /Prefer concise answers/);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('session-start hook exits early for sessions blacklisted by daemon bridge child ids', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });

  const script = path.join(process.env.CCMEM_DATA_ROOT, 'claude-session-start-blacklist-child.mjs');
  writeFileSync(script, "process.stdout.write(process.env.CLAUDE_CODE_SESSION_ID || '')");

  const childSessionId = (await callClaudeP('hello bridge', {
    command: NODE,
    args: [script]
  })).trim();

  const output = execFileSync(
    NODE,
    [HOOK, 'session-start'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: childSessionId
      })
    }
  );

  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = ?`
  ).get(childSessionId);
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = ?`
  ).get(childSessionId);

  assert.match(childSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(output, /"hookEventName":"SessionStart"/);
  assert.equal(injection.n, 0);
  assert.equal(session.n, 0);
  db.close();
});

test('session-start hook ignores expired blacklisted sessions and proceeds normally', async () => {
  const db = openDb();
  await cmdSave(db, { cwd: process.cwd(), content: 'Prefer concise answers', scope: 'global' });
  setMode(db, 'active');
  const now = Date.now();

  db.prepare(
    `INSERT INTO ccmem_blacklisted_sessions (session_id, reason, created_at, expires_at)
     VALUES (?, 'cron_llm_child', ?, ?)`
  ).run('s-expired', now, now - 1000);

  const output = execFileSync(
    NODE,
    [HOOK, 'session-start'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env: {
        ...process.env,
        CCMEM_TEST_MODE: '1',
        CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
      },
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        session_id: 's-expired'
      })
    }
  );

  const injection = db.prepare(
    `SELECT COUNT(*) AS n
     FROM recent_injections
     WHERE session_id = ?`
  ).get('s-expired');
  const session = db.prepare(
    `SELECT COUNT(*) AS n
     FROM session_context
     WHERE session_id = ?`
  ).get('s-expired');
  const blacklist = db.prepare(
    `SELECT COUNT(*) AS n
     FROM ccmem_blacklisted_sessions
     WHERE session_id = ?`
  ).get('s-expired');

  assert.match(output, /"hookEventName":"SessionStart"/);
  assert.match(output, /Prefer concise answers/);
  assert.equal(injection.n, 1);
  assert.equal(session.n, 1);
  assert.equal(blacklist.n, 1);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
