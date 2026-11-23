import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-cron-vis-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const env = { ...process.env, CCMEM_TEST_MODE: '1', CCMEM_DATA_ROOT: dataRoot };

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminCron } = await import('../../scripts/lib/admin/cron.mjs');
const { touchWakeFile } = await import('../../scripts/daemon/wake.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function runCli(args) {
  return execFileSync(process.execPath, [CLI, 'admin', '--', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: 'pipe' });
}

// Tester #447 defect 5: an unknown subcommand printed nothing and exited 0 — in a
// script or an agent's tool call that is indistinguishable from "it worked".
test('an unknown admin cron subcommand is rejected with a usage line and exit 64', () => {
  let failed = null;
  try {
    runCli(['cron', 'bogus']);
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'the CLI must not exit 0');
  assert.equal(failed.status, 64);
  assert.match(String(failed.stderr), /unknown admin cron subcommand: bogus/);
  assert.match(String(failed.stderr), /admin cron <list\|run>/);
});

// Tester #447: `--issues`/`--history`/`--task`/`--verbose` are parsed but the help
// block named only `<list|run>`, so nobody could find them.
test('admin cron --help names every flag it accepts', () => {
  const help = runCli(['cron', '--help']);
  for (const flag of ['--issues', '--history', '--task', '--verbose']) {
    assert.match(help, new RegExp(flag.replace('-', '\\-')), `help names ${flag}`);
  }
});

// Tester #447: a manual cron run enqueued the row and never touched the wake file, so
// the daemon (idle tick 300 s) sat on it for minutes. Observed live: enqueued 21:42:43,
// claimed 21:48.
test('a manual cron run wakes the daemon instead of waiting out the idle tick', async () => {
  const db = openDb();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM task_runs').run();
  rmSync(path.join(dataRoot, 'daemon.wake'), { force: true });
  await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
  assert.ok(existsSync(path.join(dataRoot, 'daemon.wake')), 'the wake file is written');
  db.close();
});

// Tester #447: `summarize_pending` is the only job that turns transcripts into
// memories, and it could not be run by hand — so after a backend outage there was no
// supported way to prove extraction works again. It can now be run for one session;
// the payload is built from what the Stop hook recorded.
test('summarize_pending can be run by hand for one session', async () => {
  const db = openDb();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM task_runs').run();
  const sessionId = 's-manual-summarize';
  db.prepare(
    `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent, transcript_path)
     VALUES (?, 'project', 0, 12, 0, 12, ?, 'claude-code', '/tmp/does-not-matter.jsonl')
     ON CONFLICT(session_id) DO UPDATE SET transcript_path = excluded.transcript_path`
  ).run(sessionId, Date.now());
  const result = await cmdAdminCron(db, { verb: 'run', taskType: 'summarize_pending', sessionId });
  assert.equal(result.status, 'queued');
  const row = db.prepare('SELECT payload FROM tasks WHERE id=?').get(result.task_id);
  const payload = JSON.parse(String(row.payload));
  assert.equal(payload.session_id, sessionId);
  assert.equal(payload.transcript_path, '/tmp/does-not-matter.jsonl');
  assert.equal(payload.last_message_seq, 12);
  db.close();
});

// A session with nothing recorded cannot be summarized; saying so beats queueing a
// task that will be skipped as a bad payload.
test('running summarize_pending for an unknown session is refused by name', async () => {
  const db = openDb();
  await assert.rejects(
    cmdAdminCron(db, { verb: 'run', taskType: 'summarize_pending', sessionId: 's-not-recorded' }),
    /no session context for s-not-recorded/
  );
  db.close();
});
