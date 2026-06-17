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
const { cmdExport } = await import('../../scripts/lib/cmd/export.mjs');
const { cmdImport } = await import('../../scripts/lib/cmd/import.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdList } = await import('../../scripts/lib/cmd/list.mjs');
const { setMode } = await import('../../scripts/lib/mode.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');
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
  db.prepare(`DELETE FROM config_kv`).run();
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
  assert.match(result.additionalContext, /Read `\.ccmem\/context-unknown\.md` at session start and after each \/compact\./);
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

test('cmdList returns never-injected active memories when requested', async () => {
  const db = openDb();
  resetSaveListTables(db);
  const injected = await cmdSave(db, { cwd: process.cwd(), content: 'Already injected memory', scope: 'project' });
  const never = await cmdSave(db, { cwd: process.cwd(), content: 'Never injected memory', scope: 'project' });

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-used', 1, 'user_prompt_submit', ?, ?)`
  ).run(JSON.stringify([injected.id]), Date.now());

  const rows = await cmdList(db, { neverInjected: true, days: 30, limit: 10 });

  assert.equal(rows.some((row) => row.id === never.id), true);
  assert.equal(rows.some((row) => row.id === injected.id), false);
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

test('cmdExport and cmdImport round-trip memories through external source without sync embeddings', async () => {
  const db = openDb();
  resetSaveListTables(db);
  await cmdSave(db, { cwd: process.cwd(), content: 'Exported global memory', scope: 'global' });
  await cmdSave(db, { cwd: process.cwd(), content: 'Exported project memory', scope: 'project' });

  const exported = cmdExport(db, {});
  const backupPath = path.join(process.env.CCMEM_DATA_ROOT, 'backup.json');
  writeFileSync(backupPath, JSON.stringify(exported, null, 2));

  resetSaveListTables(db);
  const imported = await cmdImport(db, { cwd: process.cwd(), filePath: backupPath });
  const rows = db.prepare(
    `SELECT content, source, embedding
     FROM memories
     ORDER BY id ASC`
  ).all();

  assert.equal(imported.imported, 2);
  assert.equal(imported.skipped, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.content), ['Exported global memory', 'Exported project memory']);
  assert.deepEqual(rows.map((row) => row.source), ['external', 'external']);
  assert.equal(rows.every((row) => row.embedding == null), true);
  db.close();
});

test('cli import reports embedding pending when semantic is enabled', async () => {
  const db = openDb();
  resetSaveListTables(db);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(Date.now());
  const backupPath = path.join(process.env.CCMEM_DATA_ROOT, 'import-pending.json');
  writeFileSync(backupPath, JSON.stringify({
    version: '0.6',
    exported_at: Date.now(),
    memories: [
      { scope: 'global', project_key: null, type: 'fact', content: 'Imported pending embedding', pinned: 0, tags: '[]' }
    ]
  }, null, 2));
  db.close();

  const output = spawnSync(NODE, [CLI, 'import', backupPath], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: {
      ...process.env,
      CCMEM_TEST_MODE: '1',
      CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
    },
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const importedRow = verifyDb.prepare(`SELECT source, embedding FROM memories WHERE content = 'Imported pending embedding'`).get();
  assert.equal(output.status, 0);
  assert.match(output.stdout, /ccmem: imported 1, skipped 0/);
  assert.match(output.stderr, /1 memories imported without embeddings \(vec_backfill will process them\)/);
  assert.equal(importedRow.source, 'external');
  assert.equal(importedRow.embedding, null);
  verifyDb.close();
});

test('cli admin semantic toggles runtime semantic state', () => {
  const db = openDb();
  resetSaveListTables(db);
  db.close();

  const baseEnv = {
    ...process.env,
    CCMEM_TEST_MODE: '1',
    CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
  };

  const onOutput = execFileSync(NODE, [CLI, 'admin', 'semantic', 'on'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: baseEnv,
    encoding: 'utf8'
  });
  const statusOutput = execFileSync(NODE, [CLI, 'admin', 'semantic', 'status'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: baseEnv,
    encoding: 'utf8'
  });
  const offOutput = execFileSync(NODE, [CLI, 'admin', 'semantic', 'off'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: baseEnv,
    encoding: 'utf8'
  });

  assert.match(onOutput, /ccmem: semantic enabled enabled=true loaded=true/);
  assert.match(statusOutput, /ccmem: semantic enabled enabled=true/);
  assert.match(offOutput, /ccmem: semantic disabled enabled=false loaded=false/);
});

test('cli list query --score prints score breakdown when semantic is enabled', async () => {
  const db = openDb();
  resetSaveListTables(db);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(Date.now());
  await cmdSave(db, { cwd: process.cwd(), content: 'Semantic score target memory', scope: 'project' });
  db.close();

  const output = execFileSync(NODE, [CLI, 'list', 'semantic', 'score', '--score', '--limit', '1'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: {
      ...process.env,
      CCMEM_TEST_MODE: '1',
      CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
    },
    encoding: 'utf8'
  });

  assert.match(output, /\[m\d+\] fact \| project Semantic score target memory/);
  assert.match(output, /score fused=/);
  assert.match(output, /fts=/);
  assert.match(output, /jaccard=/);
  assert.match(output, /semantic=/);
});

test('cli show prints recent injection history when scores are present', async () => {
  const db = openDb();
  resetSaveListTables(db);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(Date.now());
  const saved = await cmdSave(db, { cwd: process.cwd(), content: 'Show history memory', scope: 'project' });
  db.close();

  await handlePromptSubmit({
    cwd: process.cwd(),
    session_id: 's-show-history',
    prompt: 'show history memory'
  });

  const output = execFileSync(NODE, [CLI, 'show', `m${saved.id}`], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: {
      ...process.env,
      CCMEM_TEST_MODE: '1',
      CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
    },
    encoding: 'utf8'
  });

  assert.match(output, /Recent injections \(last 14d\):/);
  assert.match(output, /fts=/);
  assert.match(output, /jac=/);
  assert.match(output, /cos=/);
  assert.match(output, /fused=/);
});

test('cli list --never-injected prints only never-injected memories', async () => {
  const db = openDb();
  resetSaveListTables(db);
  const injected = await cmdSave(db, { cwd: process.cwd(), content: 'Injected CLI memory', scope: 'project' });
  const never = await cmdSave(db, { cwd: process.cwd(), content: 'Never injected CLI memory', scope: 'project' });
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-cli-never', 1, 'user_prompt_submit', ?, ?)`
  ).run(JSON.stringify([injected.id]), Date.now());
  db.close();

  const output = execFileSync(NODE, [CLI, 'list', '--never-injected', '--days', '30'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env: {
      ...process.env,
      CCMEM_TEST_MODE: '1',
      CCMEM_DATA_ROOT: process.env.CCMEM_DATA_ROOT
    },
    encoding: 'utf8'
  });

  assert.match(output, new RegExp(`m${never.id}`));
  assert.doesNotMatch(output, new RegExp(`m${injected.id}`));
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
  assert.match(result.additionalContext, /ALWAYS re-read regardless of compressed summary content/);
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
