import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-cron-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');

const { openDb } = await import('../../scripts/lib/db.mjs');
const { dispatchTask } = await import('../../scripts/daemon/dispatch.mjs');
const { contradictionAuditLeaseKey, dayKey, monthlyMetaLeaseKey, weeklyLeaseKey, runTask } = await import('../../scripts/daemon/loop.mjs');
const { cmdAdminCron } = await import('../../scripts/lib/admin/cron.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');
const { fallbackProjectKey } = await import('../../scripts/lib/project-key.mjs');

function resetCronTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
}

function seedCronFixture(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(9876, 'cron-host', now - 5000, now - 700);

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES
     ('daily_maintenance', '2026-06-01', ?, ?, 'failed', 'manual'),
     ('daily_maintenance', '2026-06-02', ?, ?, 'completed', 'daemon'),
     ('weekly_synthesis', '2026-W23', ?, NULL, 'running', 'daemon')`
  ).run(now - 12000, now - 11000, now - 9000, now - 8000, now - 4000);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('weekly_synthesis', '{}', ?, ?, 'queued')`
  ).run(now - 300, now - 300, now - 200, now - 200, now - 100, now - 100);
}

function seedCronIssuesFixture(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES
     ('daily_maintenance', '2026-06-03', ?, ?, 'failed', 'manual'),
     ('weekly_synthesis', '2026-W23', ?, NULL, 'running', 'daemon')`
  ).run(now - 30000, now - 29000, now - 11 * 60 * 1000);

  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES
     ('summarize_pending', '{}', ?, ?, 'queued'),
     ('summarize_pending', '{}', ?, ?, 'queued')`
  ).run(now - 6 * 60 * 1000, now - 6 * 60 * 1000, now - 7 * 60 * 1000, now - 7 * 60 * 1000);
}

function seedHealthyCronFixture(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(9876, 'cron-host', now - 5000, now - 700);

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES
     ('daily_maintenance', '2026-06-02', ?, ?, 'completed', 'daemon'),
     ('weekly_synthesis', '2026-W23', ?, ?, 'completed', 'daemon')`
  ).run(now - 9000, now - 8000, now - 7000, now - 6000);
}

test('cmdAdminCron returns latest runs and queued counts', async () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);

  const result = await cmdAdminCron(db, { verb: 'list' });
  const byType = Object.fromEntries(result.items.map((item) => [item.type, item]));

  assert.equal(result.daemon_alive, true);
  assert.equal(byType.daily_maintenance.queued, 0);
  assert.equal(byType.daily_maintenance.last_run.status, 'completed');
  assert.equal(byType.summarize_pending.queued, 2);
  assert.equal(byType.summarize_pending.last_run, null);
  assert.equal(byType.weekly_synthesis.queued, 1);
  assert.equal(byType.weekly_synthesis.last_run.status, 'running');
  db.close();
});

test('cmdAdminCron run enqueues daily maintenance with a manual local-day lease key', async () => {
  const db = openDb();
  resetCronTables(db);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const task = db.prepare(
      `SELECT type, payload, scheduled_for, status
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'daily_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.type, 'daily_maintenance');
    assert.equal(task.type, 'daily_maintenance');
    assert.equal(task.scheduled_for, fixedNowMs);
    assert.equal(task.status, 'queued');
    assert.deepEqual(JSON.parse(task.payload), { lease_key: dayKey(fixedNow) });
    assert.equal(lease.date_key, dayKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'running');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdAdminCron run enqueues weekly synthesis with the anchored manual week lease key', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const task = db.prepare(
      `SELECT type, payload, scheduled_for, status
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.type, 'weekly_synthesis');
    assert.equal(task.type, 'weekly_synthesis');
    assert.equal(task.scheduled_for, fixedNowMs);
    assert.equal(task.status, 'queued');
    assert.deepEqual(JSON.parse(task.payload), { lease_key: weeklyLeaseKey(fixedNow) });
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'running');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdAdminCron run skips a duplicate daily manual lease', async () => {
  const db = openDb();
  resetCronTables(db);
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
    const first = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const second = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const queued = db.prepare(
      `SELECT COUNT(*) AS n
       FROM tasks
       WHERE type = 'daily_maintenance'`
    ).get();
    const leases = db.prepare(
      `SELECT COUNT(*) AS n
       FROM task_runs
       WHERE type = 'daily_maintenance'`
    ).get();

    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'skipped');
    assert.equal(second.task_id, null);
    assert.equal(second.reason, 'lease already claimed');
    assert.equal(queued.n, 1);
    assert.equal(leases.n, 1);
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('manual daily admin cron run completes the claimed lease after dispatch', async () => {
  const db = openDb();
  resetCronTables(db);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, task, dispatchTask);

    const storedTask = db.prepare(
      `SELECT status, finished_at
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'daily_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(storedTask.status, 'completed');
    assert.equal(typeof storedTask.finished_at, 'number');
    assert.equal(lease.date_key, dayKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after dispatch', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, task, dispatchTask);

    const storedTask = db.prepare(
      `SELECT status, finished_at
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(storedTask.status, 'completed');
    assert.equal(typeof storedTask.finished_at, 'number');
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('manual revalidation admin cron run dispatches successfully and records manual audit', async () => {
  const db = openDb();
  resetCronTables(db);

  db.prepare(
    `INSERT INTO memories (
      project_key, scope, type, content, source,
      trust_score, pinned, decay_status,
      created_at, updated_at, last_touched_at
     ) VALUES (?, 'project', 'fact', ?, 'user_explicit', ?, 1, 'active', ?, ?, ?)`
  ).run('demo/repo', 'ssh key rotation note', 0.92, Date.now() - 1000, Date.now() - 1000, Date.now() - 1000);

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'revalidation_audit' });
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, task, dispatchTask);

    const storedTask = db.prepare(
      `SELECT status, finished_at
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const audit = db.prepare(
      `SELECT details
       FROM audit_log
       WHERE action = 'revalidation_audit_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const runs = db.prepare(
      `SELECT COUNT(*) AS n
       FROM task_runs
       WHERE type = 'revalidation_audit'`
    ).get();

    assert.equal(storedTask.status, 'completed');
    assert.equal(typeof storedTask.finished_at, 'number');
    assert.equal(runs.n, 0);
    assert.equal(JSON.parse(task.payload ?? '{}').lease_key ?? null, null);
    assert.equal(JSON.parse(audit.details).trigger, 'manual');
  } finally {
    db.close();
  }
});


test('manual weekly admin cron run completes the claimed lease after a timeout-scheduled retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-timeout-retry.mjs');
  const configPath = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-timeout-retry-config.json');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalConfigPath = process.env.CCMEM_CONFIG_PATH;

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
  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: {
        claude_p_timeout_per_task: {
          weekly_synthesis: 50
        }
      }
    })
  );
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  process.env.CCMEM_CONFIG_PATH = configPath;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly timeout retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );
    if (originalConfigPath === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = originalConfigPath;
    }

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalConfigPath === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = originalConfigPath;
    }
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after an explicit retry-after retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-rate-limit-retry.mjs');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalTimeout = process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

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
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly explicit retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalTimeout === undefined) {
      delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;
    } else {
      process.env.CCMEM_CLAUDE_P_TIMEOUT_MS = originalTimeout;
    }
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after a default rate-limit retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-rate-limit-default-retry.mjs');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalTimeout = process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

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
  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly default retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalTimeout === undefined) {
      delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;
    } else {
      process.env.CCMEM_CLAUDE_P_TIMEOUT_MS = originalTimeout;
    }
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after a too-many-requests retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-too-many-requests-retry.mjs');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalTimeout = process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

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
  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly too many retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalTimeout === undefined) {
      delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;
    } else {
      process.env.CCMEM_CLAUDE_P_TIMEOUT_MS = originalTimeout;
    }
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after a seconds retry-after retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-seconds-retry-after-retry.mjs');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalTimeout = process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

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
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(retryTask.scheduled_for - retryTask.enqueued_at, 2000);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly seconds retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalTimeout === undefined) {
      delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;
    } else {
      process.env.CCMEM_CLAUDE_P_TIMEOUT_MS = originalTimeout;
    }
    db.close();
  }
});

test('manual weekly admin cron run completes the claimed lease after a minutes retry-after retry succeeds', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'admin-cron-weekly-minutes-retry-after-retry.mjs');
  const originalEnable = process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
  const originalCommand = process.env.CCMEM_CLAUDE_P_COMMAND;
  const originalArgs = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  const originalTimeout = process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

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
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");
  process.env.CCMEM_ENABLE_REAL_CLAUDE_P = '1';
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([script]);
  delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;

  try {
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const firstTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);

    await runTask(db, firstTask, dispatchTask);

    const retryTask = db.prepare(
      `SELECT *
       FROM tasks
       WHERE type = 'weekly_synthesis'
         AND status = 'queued'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(retryTask.scheduled_for - retryTask.enqueued_at, 120000);

    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({synthesized:[{content:'Manual weekly minutes retry rule',type:'fact',scope:'project',output_type:'rule'}]}));"
    );
    await runTask(db, retryTask, dispatchTask);

    const tasks = db.prepare(
      `SELECT status, error_excerpt, attempts
       FROM tasks
       WHERE type = 'weekly_synthesis'
       ORDER BY id ASC`
    ).all();
    const lease = db.prepare(
      `SELECT date_key, ran_by, status, completed_at
       FROM task_runs
       WHERE type = 'weekly_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const audit = db.prepare(
      `SELECT action, details
       FROM audit_log
       WHERE action = 'weekly_synthesis_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const details = JSON.parse(audit.details);

    assert.deepEqual(tasks.map((task) => [task.status, task.attempts]), [
      ['failed', 1],
      ['completed', 2]
    ]);
    assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
    assert.equal(tasks[1].error_excerpt, null);
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
    assert.equal(audit.action, 'weekly_synthesis_run');
    assert.equal(details.item_count, 1);
    assert.equal(details.first_output_type, 'rule');
  } finally {
    global.Date = OriginalDate;
    if (originalEnable === undefined) {
      delete process.env.CCMEM_ENABLE_REAL_CLAUDE_P;
    } else {
      process.env.CCMEM_ENABLE_REAL_CLAUDE_P = originalEnable;
    }
    if (originalCommand === undefined) {
      delete process.env.CCMEM_CLAUDE_P_COMMAND;
    } else {
      process.env.CCMEM_CLAUDE_P_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
    } else {
      process.env.CCMEM_CLAUDE_P_ARGS_JSON = originalArgs;
    }
    if (originalTimeout === undefined) {
      delete process.env.CCMEM_CLAUDE_P_TIMEOUT_MS;
    } else {
      process.env.CCMEM_CLAUDE_P_TIMEOUT_MS = originalTimeout;
    }
    db.close();
  }
});

test('cmdAdminCron run rejects summarize_pending because manual payload cannot be constructed', async () => {
  const db = openDb();
  resetCronTables(db);

  await assert.rejects(
    cmdAdminCron(db, { verb: 'run', taskType: 'summarize_pending' }),
    /unsupported manual cron task: summarize_pending/
  );

  const tasks = db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'summarize_pending'`
  ).get();
  const leases = db.prepare(
    `SELECT COUNT(*) AS n
     FROM task_runs
     WHERE type = 'summarize_pending'`
  ).get();

  assert.equal(tasks.n, 0);
  assert.equal(leases.n, 0);
  db.close();
});

test('cmdAdminCron run skips daily maintenance when the day lease already exists from daemon work', async () => {
  const db = openDb();
  resetCronTables(db);
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
    db.prepare(
      `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
       VALUES ('daily_maintenance', ?, ?, ?, 'completed', 'daemon')`
    ).run(dayKey(fixedNow), fixedNowMs - 1000, fixedNowMs - 500);

    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const tasks = db.prepare(
      `SELECT COUNT(*) AS n
       FROM tasks
       WHERE type = 'daily_maintenance'`
    ).get();

    assert.equal(result.status, 'skipped');
    assert.equal(result.task_id, null);
    assert.equal(result.reason, 'lease already claimed');
    assert.equal(tasks.n, 0);
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdAdminCron run skips weekly synthesis when the week lease already exists from daemon work', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
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
    db.prepare(
      `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
       VALUES ('weekly_synthesis', ?, ?, ?, 'completed', 'daemon')`
    ).run(weeklyLeaseKey(fixedNow), fixedNowMs - 1000, fixedNowMs - 500);

    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'weekly_synthesis' });
    const tasks = db.prepare(
      `SELECT COUNT(*) AS n
       FROM tasks
       WHERE type = 'weekly_synthesis'`
    ).get();

    assert.equal(result.status, 'skipped');
    assert.equal(result.task_id, null);
    assert.equal(result.reason, 'lease already claimed');
    assert.equal(tasks.n, 0);
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdAdminCron list returns bounded history for one task type', async () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);

  const result = await cmdAdminCron(db, { verb: 'list', taskType: 'daily_maintenance', history: 1 });

  assert.equal(result.type, 'daily_maintenance');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, 'completed');
  assert.equal(result.history[0].date_key, '2026-06-02');
  db.close();
});

test('cmdAdminCron list --issues returns failed, zombie, and overdue problems', async () => {
  const db = openDb();
  resetCronTables(db);
  seedCronIssuesFixture(db);

  const result = await cmdAdminCron(db, { verb: 'list', issues: true });

  assert.equal(result.issues.length, 3);
  assert.deepEqual(result.issues.map((issue) => issue.kind), ['failed', 'overdue', 'zombie']);
  assert.equal(result.issues[0].type, 'daily_maintenance');
  assert.equal(result.issues[1].type, 'summarize_pending');
  assert.equal(result.issues[2].type, 'weekly_synthesis');
  db.close();
});

test('cli admin cron list --history prints task history lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list', '--history', '2', '--task', 'daily_maintenance'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: cron history daily_maintenance/);
  assert.match(output, /completed@2026-06-02 by=daemon/);
  assert.match(output, /failed@2026-06-01 by=manual/);
});

test('cli admin cron list --history prints security_audit history lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES ('security_audit', '2026-W23', ?, ?, 'completed', 'manual')`
  ).run(now - 2000, now - 1000);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list', '--history', '2', '--task', 'security_audit'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: cron history security_audit/);
  assert.match(output, /completed@2026-W23 by=manual/);
});

test('cli admin cron list prints compact status lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon alive/);
  assert.match(output, /daily_maintenance queued=0 last=completed@2026-06-02/);
  assert.match(output, /summarize_pending queued=2 last=none/);
  assert.match(output, /weekly_synthesis queued=1 last=running@2026-W23/);
});

test('cli admin cron list --issues prints only unhealthy cron lines', () => {
  const db = openDb();
  resetCronTables(db);
  seedCronIssuesFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list', '--issues'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: cron issues/);
  assert.match(output, /failed daily_maintenance last=2026-06-03 by=manual/);
  assert.match(output, /overdue summarize_pending queued=2 oldest_ms=/);
  assert.match(output, /zombie weekly_synthesis last=2026-W23 age_ms=/);
});

test('cli admin cron list --issues stays silent when cron is healthy', () => {
  const db = openDb();
  resetCronTables(db);
  seedHealthyCronFixture(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list', '--issues'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.equal(output, '');
});

test('cli admin cron list prints not running daemon state', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'list'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon not running/);
});

test('cli admin cron run enqueues supported tasks', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'weekly_synthesis'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const task = verifyDb.prepare(
    `SELECT type, scheduled_for, status, payload
     FROM tasks
     WHERE type = 'weekly_synthesis'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const lease = verifyDb.prepare(
    `SELECT date_key, ran_by, status
     FROM task_runs
     WHERE type = 'weekly_synthesis'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /ccmem: enqueued weekly_synthesis as task#\d+/);
  assert.equal(typeof task.scheduled_for, 'number');
  assert.equal(task.status, 'queued');
  assert.equal(typeof JSON.parse(task.payload).lease_key, 'string');
  assert.equal(lease.ran_by, 'manual');
  assert.equal(lease.status, 'running');
});

test('cli admin cron run rejects summarize_pending as a manual task', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  assert.throws(
    () =>
      execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'summarize_pending'], {
        cwd: '/Users/biran/code/skills/ccmem',
        env,
        encoding: 'utf8'
      }),
    (error) => {
      assert.equal(error.status, 64);
      assert.match(String(error.stderr), /ccmem: unsupported manual cron task: summarize_pending/);
      return true;
    }
  );

  const verifyDb = openDb();
  const tasks = verifyDb.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'summarize_pending'`
  ).get();
  verifyDb.close();

  assert.equal(tasks.n, 0);
});

test('cli admin cron run reports duplicate manual leases as skipped', () => {
  const db = openDb();
  resetCronTables(db);
  db.close();

  const first = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'daily_maintenance'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });
  const second = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'daily_maintenance'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const tasks = verifyDb.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'daily_maintenance'`
  ).get();
  verifyDb.close();

  assert.match(first, /ccmem: enqueued daily_maintenance as task#\d+/);
  assert.match(second, /ccmem: skipped daily_maintenance \(lease already claimed\)/);
  assert.equal(tasks.n, 1);
});

test('cli admin cron run reports daemon-held daily leases as skipped', () => {
  const db = openDb();
  resetCronTables(db);
  const now = new Date();
  const nowMs = now.getTime();
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES ('daily_maintenance', ?, ?, ?, 'completed', 'daemon')`
  ).run(dayKey(now), nowMs - 1000, nowMs - 500);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'daily_maintenance'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const tasks = verifyDb.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'daily_maintenance'`
  ).get();
  verifyDb.close();

  assert.match(output, /ccmem: skipped daily_maintenance \(lease already claimed\)/);
  assert.equal(tasks.n, 0);
});

test('cli admin cron run reports daemon-held weekly leases as skipped', () => {
  const db = openDb();
  resetCronTables(db);
  const now = new Date();
  const nowMs = now.getTime();
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, completed_at, status, ran_by)
     VALUES ('weekly_synthesis', ?, ?, ?, 'completed', 'daemon')`
  ).run(weeklyLeaseKey(now), nowMs - 1000, nowMs - 500);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'cron', 'run', 'weekly_synthesis'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8'
  });

  const verifyDb = openDb();
  const tasks = verifyDb.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'weekly_synthesis'`
  ).get();
  verifyDb.close();

  assert.match(output, /ccmem: skipped weekly_synthesis \(lease already claimed\)/);
  assert.equal(tasks.n, 0);
});

test('cmdAdminCron run enqueues security_audit with the anchored manual week lease key', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 3, 18, 0, 0);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'security_audit' });
    const task = db.prepare(
      `SELECT type, payload, scheduled_for, status
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'security_audit'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.type, 'security_audit');
    assert.equal(task.type, 'security_audit');
    assert.equal(task.scheduled_for, fixedNowMs);
    assert.equal(task.status, 'queued');
    assert.deepEqual(JSON.parse(task.payload), { lease_key: weeklyLeaseKey(fixedNow) });
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'running');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdAdminCron run enqueues cross_project_patterns with the anchored manual week lease key', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 7, 4, 48, 0, 0);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'cross_project_patterns' });
    const task = db.prepare(
      `SELECT type, payload, scheduled_for, status
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'cross_project_patterns'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.type, 'cross_project_patterns');
    assert.equal(task.type, 'cross_project_patterns');
    assert.equal(task.scheduled_for, fixedNowMs);
    assert.equal(task.status, 'queued');
    assert.deepEqual(JSON.parse(task.payload), { lease_key: weeklyLeaseKey(fixedNow, { weekday: 0, hour: 4, minute: 47 }) });
    assert.equal(lease.date_key, weeklyLeaseKey(fixedNow, { weekday: 0, hour: 4, minute: 47 }));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'running');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('manual cross_project_patterns run creates promote candidate for similar memories across projects', async () => {
  const db = openDb();
  resetCronTables(db);
  db.prepare(`DELETE FROM memories`).run();
  db.prepare(`DELETE FROM promote_candidates`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.enabled', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(Date.now());

  const projectACwd = '/tmp/ccmem-cross-project-a';
  const projectBCwd = '/tmp/ccmem-cross-project-b';
  const memA = await insertMemory(db, {
    cwd: projectACwd,
    content: 'Use feature folders for related commands',
    scope: 'project',
    type: 'fact',
    source: 'user_explicit'
  });
  await insertMemory(db, {
    cwd: projectBCwd,
    content: 'Use feature folders for related commands',
    scope: 'project',
    type: 'fact',
    source: 'user_explicit'
  });

  const result = await cmdAdminCron(db, { verb: 'run', taskType: 'cross_project_patterns' });
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);
  await runTask(db, task, dispatchTask);

  const candidate = db.prepare(
    `SELECT mem_id, project_key, trigger, acknowledged_at
     FROM promote_candidates
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'cross_project_run'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const details = JSON.parse(audit.details);

  assert.equal(candidate.mem_id, memA.id);
  assert.equal(candidate.project_key, fallbackProjectKey(projectACwd));
  assert.equal(candidate.trigger, 'cosine_cross_project');
  assert.equal(candidate.acknowledged_at, null);
  assert.equal(details.candidates_found, 1);
  assert.equal(details.projects_scanned >= 2, true);
  db.close();
});

test('cmdAdminCron run enqueues contradiction_audit with the anchored manual week lease key', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 5, 8, 4, 18, 0, 0);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'contradiction_audit' });
    const task = db.prepare(
      `SELECT type, payload, scheduled_for, status
       FROM tasks
       WHERE id = ?`
    ).get(result.task_id);
    const lease = db.prepare(
      `SELECT date_key, ran_by, status
       FROM task_runs
       WHERE type = 'contradiction_audit'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.type, 'contradiction_audit');
    assert.equal(task.type, 'contradiction_audit');
    assert.equal(task.scheduled_for, fixedNowMs);
    assert.equal(task.status, 'queued');
    assert.deepEqual(JSON.parse(task.payload), { lease_key: contradictionAuditLeaseKey(fixedNow) });
    assert.equal(lease.date_key, contradictionAuditLeaseKey(fixedNow));
    assert.equal(lease.ran_by, 'manual');
    assert.equal(lease.status, 'running');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('dispatchTask runs contradiction_audit and records alerts', async () => {
  const db = openDb();
  resetCronTables(db);
  const now = Date.now();
  const first = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, embedding, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
     ) VALUES ('project', 'demo/repo', 'rule', 'Use 4 spaces', ?, 0, 'auto_inferred', 0.5, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  ).run(Buffer.alloc(16, 1), now, now, now);
  const second = db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, embedding, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
     ) VALUES ('project', 'demo/repo', 'rule', 'Use 2 spaces', ?, 0, 'auto_inferred', 0.5, 'active', 'active', 0, 0, ?, ?, ?, '[]')`
  ).run(Buffer.alloc(16, 1), now, now, now);
  const memAId = Number(first.lastInsertRowid);
  const memBId = Number(second.lastInsertRowid);
  const leaseKey = contradictionAuditLeaseKey(new Date());
  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
     VALUES ('contradiction_audit', ?, ?, 'running', 'manual')`
  ).run(leaseKey, now);
  const llmOutput = JSON.stringify({
    contradictions: [{ id_a: memAId, id_b: memBId, reason: 'indentation conflict' }],
    compatible: []
  });
  const taskInsert = db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('contradiction_audit', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({ lease_key: leaseKey, llm_output: llmOutput }), now - 1000, now - 1000);
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(taskInsert.lastInsertRowid));

  await runTask(db, task, dispatchTask);

  const alert = db.prepare(
    `SELECT mem_id_a, mem_id_b, scope
     FROM contradiction_alerts
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'contradiction_audit_run'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  const lease = db.prepare(
    `SELECT status, completed_at
     FROM task_runs
     WHERE type = 'contradiction_audit' AND date_key = ?`
  ).get(leaseKey);

  assert.equal(alert.mem_id_a, memAId);
  assert.equal(alert.mem_id_b, memBId);
  assert.equal(alert.scope, 'demo/repo');
  assert.equal(JSON.parse(audit.details).contradictions_found, 1);
  assert.equal(lease.status, 'completed');
  assert.equal(typeof lease.completed_at, 'number');
  db.close();
});

test('cmdAdminCron run enqueues monthly_meta_synthesis without a lease payload', async () => {
  const db = openDb();
  resetCronTables(db);

  const result = await cmdAdminCron(db, { verb: 'run', taskType: 'monthly_meta_synthesis' });
  const task = db.prepare(
    `SELECT type, payload, status
     FROM tasks
     WHERE id = ?`
  ).get(result.task_id);

  assert.equal(result.type, 'monthly_meta_synthesis');
  assert.equal(task.type, 'monthly_meta_synthesis');
  assert.equal(task.status, 'queued');
  assert.deepEqual(JSON.parse(task.payload), {});
  db.close();
});

test('dispatchTask runs monthly_meta_synthesis and supersedes source consolidated memories', async () => {
  const db = openDb();
  resetCronTables(db);
  const configPath = path.join(dataRoot, 'monthly-meta-config.json');
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  writeFileSync(configPath, JSON.stringify({ consolidation: { monthly: { enabled: true, min_consolidated: 2 } } }));
  process.env.CCMEM_CONFIG_PATH = configPath;

  try {
    const first = await insertMemory(db, {
      cwd: '/Users/biran/code/skills/ccmem',
      content: 'Project patterns converge on strict API boundaries',
      scope: 'project',
      projectKey: 'demo/repo',
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: false
    });
    const second = await insertMemory(db, {
      cwd: '/Users/biran/code/skills/ccmem',
      content: 'Project patterns converge on explicit service contracts',
      scope: 'project',
      projectKey: 'demo/repo',
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: false
    });

    const leaseKey = monthlyMetaLeaseKey(new Date(2026, 6, 1), 'demo/repo');
    db.prepare(
      `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
       VALUES ('monthly_meta_synthesis', ?, ?, 'running', 'manual')`
    ).run(leaseKey, Date.now());

    const llmOutput = JSON.stringify({
      synthesized: [
        { content: 'Project rules converge on explicit interface contracts', source_ids: [first.id, second.id] }
      ]
    });
    const taskInsert = db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('monthly_meta_synthesis', ?, ?, ?, 'queued')`
    ).run(JSON.stringify({ scope: 'demo/repo', lease_key: leaseKey, llm_output: llmOutput }), Date.now(), Date.now());
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(taskInsert.lastInsertRowid));

    await runTask(db, task, dispatchTask);

    const synthesized = db.prepare(
      `SELECT id, type, source, project_key, content, parent_ids, consolidation_depth, status
       FROM memories
       WHERE source = 'cron_consolidated'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const parents = db.prepare(
      `SELECT id, status
       FROM memories
       WHERE id IN (?, ?)
       ORDER BY id ASC`
    ).all(first.id, second.id);
    const audit = db.prepare(
      `SELECT details
       FROM audit_log
       WHERE action = 'monthly_meta_run'
       ORDER BY id DESC
       LIMIT 1`
    ).get();
    const lease = db.prepare(
      `SELECT status, completed_at
       FROM task_runs
       WHERE type = 'monthly_meta_synthesis' AND date_key = ?`
    ).get(leaseKey);

    assert.equal(synthesized.type, 'consolidated');
    assert.equal(synthesized.project_key, 'demo/repo');
    assert.equal(synthesized.content, 'Project rules converge on explicit interface contracts');
    assert.deepEqual(JSON.parse(synthesized.parent_ids), [first.id, second.id]);
    assert.equal(synthesized.consolidation_depth, 1);
    assert.deepEqual(parents.map((row) => row.status), ['superseded', 'superseded']);
    assert.equal(JSON.parse(audit.details).output_count, 1);
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
    db.close();
  }
});

test('daily maintenance on day one enqueues monthly_meta_synthesis when threshold is met', async () => {
  const db = openDb();
  resetCronTables(db);
  const fixedNow = new Date(2026, 6, 1, 2, 17, 0, 0);
  const fixedNowMs = fixedNow.getTime();
  const OriginalDate = global.Date;
  const configPath = path.join(dataRoot, 'monthly-meta-day1-config.json');
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  writeFileSync(configPath, JSON.stringify({ consolidation: { monthly: { enabled: true, min_consolidated: 2 } } }));
  process.env.CCMEM_CONFIG_PATH = configPath;

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
    await insertMemory(db, {
      cwd: '/Users/biran/code/skills/ccmem',
      content: 'First consolidated source',
      scope: 'project',
      projectKey: 'demo/repo',
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: false
    });
    await insertMemory(db, {
      cwd: '/Users/biran/code/skills/ccmem',
      content: 'Second consolidated source',
      scope: 'project',
      projectKey: 'demo/repo',
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: false
    });

    const result = await cmdAdminCron(db, { verb: 'run', taskType: 'daily_maintenance' });
    const dailyTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.task_id);
    await runTask(db, dailyTask, dispatchTask);

    const monthlyTask = db.prepare(
      `SELECT type, payload, status
       FROM tasks
       WHERE type = 'monthly_meta_synthesis'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(monthlyTask.type, 'monthly_meta_synthesis');
    assert.equal(monthlyTask.status, 'queued');
    assert.equal(JSON.parse(monthlyTask.payload).scope, 'demo/repo');
  } finally {
    global.Date = OriginalDate;
    if (previousConfigPath === undefined) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
    db.close();
  }
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
