import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-cmds-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdList } = await import('../../scripts/lib/cmd/list.mjs');
const { cmdPin } = await import('../../scripts/lib/cmd/pin.mjs');
const { cmdForget } = await import('../../scripts/lib/cmd/forget.mjs');
const { cmdShow } = await import('../../scripts/lib/cmd/show.mjs');

function resetCommandTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedStaleMaintenanceState(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES ('s-old', 0, 'session_start', '[1]', ?)`
  ).run(now - (15 * 86400000));

  db.prepare(
    `INSERT INTO task_runs (type, date_key, started_at, status, ran_by)
     VALUES ('summarize_pending', '2026-01-01', ?, 'completed', 'daemon')`
  ).run(now);
}

function assertPreludeCleanup(db) {
  const stale = db.prepare(`SELECT COUNT(*) AS n FROM recent_injections`).get();
  const oldTasks = db.prepare(`SELECT COUNT(*) AS n FROM task_runs WHERE type = 'summarize_pending'`).get();
  const lease = db.prepare(`SELECT status FROM task_runs WHERE type = 'tier1_5_maintenance'`).get();

  assert.equal(stale.n, 0);
  assert.equal(oldTasks.n, 0);
  assert.equal(lease.status, 'completed');
}

function insertMemory(db, content) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source,
      trust_score, decay_status, helpful_count, unhelpful_count,
      last_touched_at, created_at, updated_at
    ) VALUES ('project', 'demo/repo', 'rule', ?, 0, 'user_explicit', 0.9, 'active', 0, 0, ?, ?, ?)`
  ).run(content, now, now, now);
}

function insertCache(db, memoryId, content) {
  db.prepare(
    `INSERT INTO injection_cache (scope, rendered_text, member_ids, rendered_at)
     VALUES ('project:demo/repo', ?, ?, ?)`
  ).run(`[m${memoryId}] rule | project ${content}`, `[${memoryId}]`, Date.now());
}

function memoryId(result) {
  return Number(result.lastInsertRowid ?? result.id);
}

function loadMemory(db, id) {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
}

function primeMemoryForReadCommand(db, content) {
  const inserted = insertMemory(db, content);
  const id = memoryId(inserted);
  insertCache(db, id, content);
  return id;
}

function clearPreludeLease(db) {
  db.prepare(`DELETE FROM task_runs`).run();
}

function projectCwd() {
  return process.cwd();
}

function saveProjectRule(db, content) {
  return cmdSave(db, {
    cwd: projectCwd(),
    content,
    scope: 'project',
    type: 'rule'
  });
}

function countListed(rows, id) {
  return rows.filter((row) => row.id === id).length;
}

function shownMemoryId(row) {
  return Number(row.id);
}

function forgottenMemoryId(row) {
  return Number(row.id);
}

function pinnedValue(row) {
  return row.pinned;
}

function showMemory(db, id) {
  return cmdShow(db, { id });
}

function listMemories(db) {
  return cmdList(db, { limit: 20 });
}

test('pin, show, forget update records and cache', async () => {
  const db = openDb();
  resetCommandTables(db);
  const saved = await saveProjectRule(db, 'Run pnpm test before commit');

  await cmdPin(db, { id: Number(saved.id), remove: false });
  const shown = await showMemory(db, Number(saved.id));
  assert.equal(pinnedValue(shown), 1);

  const forgotten = await cmdForget(db, { id: Number(saved.id) });
  assert.equal(forgottenMemoryId(forgotten), Number(saved.id));
  db.close();
});

test('cmdPin records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetCommandTables(db);
  const saved = await saveProjectRule(db, 'Pin-side local-day lease');
  clearPreludeLease(db);
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
    const result = await cmdPin(db, { id: Number(saved.id), remove: false });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.pinned, 1);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdPin runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetCommandTables(db);
  const inserted = insertMemory(db, 'Pin-side prelude cleanup');
  seedStaleMaintenanceState(db);

  const result = await cmdPin(db, { id: memoryId(inserted), remove: false });

  assert.equal(result.pinned, 1);
  assertPreludeCleanup(db);
  db.close();
});

test('cmdForget records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetCommandTables(db);
  const saved = await saveProjectRule(db, 'Forget-side local-day lease');
  clearPreludeLease(db);
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
    const forgotten = await cmdForget(db, { id: Number(saved.id) });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(forgottenMemoryId(forgotten), Number(saved.id));
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdForget runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetCommandTables(db);
  const saved = await saveProjectRule(db, 'Forget-side prelude cleanup');
  clearPreludeLease(db);
  seedStaleMaintenanceState(db);

  const forgotten = await cmdForget(db, { id: Number(saved.id) });

  assert.equal(forgottenMemoryId(forgotten), Number(saved.id));
  assertPreludeCleanup(db);
  db.close();
});

test('cmdSave runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetCommandTables(db);
  seedStaleMaintenanceState(db);

  await saveProjectRule(db, 'Keep commits small');

  assertPreludeCleanup(db);
  db.close();
});

test('cmdSave records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetCommandTables(db);
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
    const saved = await saveProjectRule(db, 'Save-side local-day lease');
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(Number(saved.id) > 0, true);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdList runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetCommandTables(db);
  const id = primeMemoryForReadCommand(db, 'Read-side prelude list');
  clearPreludeLease(db);
  seedStaleMaintenanceState(db);

  const rows = await listMemories(db);

  assert.equal(countListed(rows, id), 1);
  assertPreludeCleanup(db);
  db.close();
});

test('cmdList records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetCommandTables(db);
  primeMemoryForReadCommand(db, 'Read-side local-day lease');
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
    const rows = await listMemories(db);
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(rows.length, 1);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cmdShow runs Tier 1.5 prelude cleanup', async () => {
  const db = openDb();
  resetCommandTables(db);
  const id = primeMemoryForReadCommand(db, 'Read-side prelude show');
  clearPreludeLease(db);
  seedStaleMaintenanceState(db);

  const shown = await showMemory(db, id);

  assert.equal(shownMemoryId(shown), id);
  assertPreludeCleanup(db);
  db.close();
});

test('cmdShow records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetCommandTables(db);
  const id = primeMemoryForReadCommand(db, 'Read-side show local-day lease');
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
    const shown = await showMemory(db, id);
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(shownMemoryId(shown), id);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
