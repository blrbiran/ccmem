import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-resurrect-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const CLI = '/Users/biran/code/skills/ccmem/scripts/cli.mjs';

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdResurrect } = await import('../../scripts/lib/cmd/resurrect.mjs');
const { resolveProjectKey } = await import('../../scripts/lib/project-key.mjs');

function resetResurrectTables(db) {
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM contradiction_alerts`).run();
  db.prepare(`DELETE FROM cross_scope_alerts`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedGreyZoneMemories(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO memories (
      scope, project_key, type, content, pinned, source, trust_score,
      status, decay_status, helpful_count, unhelpful_count, last_touched_at, created_at, updated_at, tags
    ) VALUES
      ('project', 'demo/repo', 'fact', 'grey one', 0, 'user_explicit', 0.11, 'active', 'active', 0, 0, ?, ?, ?, '["ops"]'),
      ('project', 'demo/repo', 'rule', 'grey two', 0, 'user_explicit', 0.15, 'active', 'active', 0, 0, ?, ?, ?, '["ops","cli"]'),
      ('project', 'demo/repo', 'fact', 'stable three', 0, 'user_explicit', 0.45, 'active', 'active', 0, 0, ?, ?, ?, '["other"]')`
  ).run(now - 30, now - 30, now - 30, now - 20, now - 20, now - 20, now - 10, now - 10, now - 10);
}

async function seedQuarantinedMemory(db, now = Date.now()) {
  const saved = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Quarantined project note',
    scope: 'project'
  });
  const quarantinedAt = now - (26 * 86400000);

  db.prepare(
    `UPDATE memories
     SET decay_status = 'quarantine', quarantined_at = ?, trust_score = ?
     WHERE id = ?`
  ).run(quarantinedAt, 0.12, saved.id);

  const audit = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'security_quarantine_in', ?, ?)`
  ).run(
    quarantinedAt,
    JSON.stringify([saved.id]),
    JSON.stringify({ reason: 'tier3_auto' })
  );

  db.prepare(
    `INSERT INTO audit_log_targets (audit_id, mem_id)
     VALUES (?, ?)`
  ).run(Number(audit.lastInsertRowid), saved.id);

  return saved.id;
}

async function seedCrossScopeAlert(db, now = Date.now()) {
  const globalMem = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Global safety rule',
    scope: 'global'
  });
  const projectMem = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Project shell alias note',
    scope: 'project'
  });

  db.prepare(`UPDATE memories SET trust_score = ? WHERE id = ?`).run(0.9, globalMem.id);
  db.prepare(`UPDATE memories SET trust_score = ? WHERE id = ?`).run(0.6, projectMem.id);

  const alert = db.prepare(
    `INSERT INTO cross_scope_alerts (
      global_mem_id, project_mem_id, project_key, similarity, evidence, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(globalMem.id, projectMem.id, 'demo/repo', 0.91, 'shared shell command', now - 3600000);

  return {
    alertId: Number(alert.lastInsertRowid),
    globalMemId: globalMem.id,
    projectMemId: projectMem.id
  };
}

async function seedRevalidationFlaggedMemory(db, now = Date.now()) {
  const saved = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Potentially stale SSH note',
    scope: 'project',
    type: 'fact'
  });

  db.prepare(`UPDATE memories SET trust_score = ?, pinned = ? WHERE id = ?`).run(0.72, 1, saved.id);

  const audit = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'revalidation_flagged', ?, ?)`
  ).run(
    now - 3600000,
    JSON.stringify([saved.id]),
    JSON.stringify({ trigger_pattern: 'ssh-key', reason: 'pattern changed meaning' })
  );

  db.prepare(
    `INSERT INTO audit_log_targets (audit_id, mem_id)
     VALUES (?, ?)`
  ).run(Number(audit.lastInsertRowid), saved.id);

  return saved.id;
}

async function seedContradictionAlert(db, now = Date.now()) {
  const memA = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Use 4 spaces for indentation',
    scope: 'project',
    type: 'rule'
  });
  const memB = await cmdSave(db, {
    cwd: '/Users/biran/code/skills/ccmem',
    content: 'Use 2 spaces for indentation',
    scope: 'project',
    type: 'rule'
  });

  const inserted = db.prepare(
    `INSERT INTO contradiction_alerts (
      mem_id_a, mem_id_b, scope, cosine_similarity, evidence, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    memA.id,
    memB.id,
    resolveProjectKey('/Users/biran/code/skills/ccmem'),
    0.88,
    JSON.stringify({ llm_reason: 'indentation guidance conflicts' }),
    now - 1800000
  );

  return {
    alertId: Number(inserted.lastInsertRowid),
    memAId: memA.id,
    memBId: memB.id
  };
}

test('cmdResurrect keeps and forgets grey-zone memories', async () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);

  const decisions = ['k', 'f'];
  const result = await cmdResurrect(db, {
    bottom: 2,
    decide: () => decisions.shift() ?? 's'
  });

  const rows = db.prepare(
    `SELECT content, trust_score, decay_status
     FROM memories
     WHERE content IN ('grey one', 'grey two')
     ORDER BY content ASC`
  ).all();

  assert.equal(result.tier15.ran, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.action), ['keep', 'forget']);
  assert.equal(rows[0].trust_score, 0.3);
  assert.equal(rows[0].decay_status, 'active');
  assert.equal(rows[1].decay_status, 'archived');
  db.close();
});

test('cmdResurrect filters grey-zone memories by tag', async () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);

  const result = await cmdResurrect(db, {
    tag: 'cli',
    decide: () => 's'
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].content, 'grey two');
  assert.equal(result.items[0].action, 'skip');
  db.close();
});

test('cmdResurrect records the local calendar day lease at early-morning local times', async () => {
  const db = openDb();
  resetResurrectTables(db);
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
    seedGreyZoneMemories(db, fixedNowMs);

    const result = await cmdResurrect(db, {
      bottom: 1,
      decide: () => 's'
    });
    const lease = db.prepare(
      `SELECT date_key, status, completed_at
       FROM task_runs
       WHERE type = 'tier1_5_maintenance'
       ORDER BY id DESC
       LIMIT 1`
    ).get();

    assert.equal(result.tier15.ran, true);
    assert.equal(lease.date_key, '2026-06-08');
    assert.equal(lease.status, 'completed');
    assert.equal(typeof lease.completed_at, 'number');
  } finally {
    global.Date = OriginalDate;
    db.close();
  }
});

test('cli resurrect --quarantined restores quarantined memories', async () => {
  const db = openDb();
  resetResurrectTables(db);
  const memId = await seedQuarantinedMemory(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--quarantined', '--limit', '1'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'k\n'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(
    `SELECT decay_status, quarantined_at, trust_score
     FROM memories
     WHERE id = ?`
  ).get(memId);
  const audit = verifyDb.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'security_quarantine_resurrect'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /reason: tier3_auto/);
  assert.match(output, /ccmem: resurrected 1, archived 0, skipped 0/);
  assert.equal(row.decay_status, 'active');
  assert.equal(row.quarantined_at, null);
  assert.ok(row.trust_score > 0.12);
  assert.equal(JSON.parse(audit.details).user_action, 'keep');
});

test('cli resurrect --alerts acknowledges alerts and keeps the global memory', async () => {
  const db = openDb();
  resetResurrectTables(db);
  const { alertId, projectMemId } = await seedCrossScopeAlert(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--alerts', '--limit', '1'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'g\n'
  });

  const verifyDb = openDb();
  const alert = verifyDb.prepare(
    `SELECT acknowledged_at, acknowledged_action
     FROM cross_scope_alerts
     WHERE id = ?`
  ).get(alertId);
  const projectRow = verifyDb.prepare(
    `SELECT decay_status
     FROM memories
     WHERE id = ?`
  ).get(projectMemId);
  const audit = verifyDb.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'security_alert_acknowledged'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /shared shell command/);
  assert.match(output, /ccmem: alerts keep_global=1 keep_project=0 keep_both=0 forget_both=0 skipped=0/);
  assert.equal(typeof alert.acknowledged_at, 'number');
  assert.equal(alert.acknowledged_action, 'keep_global');
  assert.equal(projectRow.decay_status, 'archived');
  assert.equal(JSON.parse(audit.details).alert_id, alertId);
  assert.equal(JSON.parse(audit.details).action, 'keep_global');
});

test('cli resurrect prints prompts and applies typed decisions', () => {
  const db = openDb();
  resetResurrectTables(db);
  seedGreyZoneMemories(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--bottom', '2'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'k\nf\n'
  });

  const verifyDb = openDb();
  const rows = verifyDb.prepare(
    `SELECT content, trust_score, decay_status
     FROM memories
     WHERE content IN ('grey one', 'grey two')
     ORDER BY content ASC`
  ).all();
  verifyDb.close();

  assert.match(output, /\[m\d+\] fact\|project trust=0\.11/);
  assert.match(output, /\[k\]eep \/ \[f\]orget \/ \[s\]kip:/);
  assert.match(output, /ccmem: resurrected 1, archived 1, skipped 0/);
  assert.equal(rows[0].trust_score, 0.3);
  assert.equal(rows[1].decay_status, 'archived');
});

test('cli resurrect prints no grey-zone memories when none match', () => {
  const db = openDb();
  resetResurrectTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: ''
  });

  assert.equal(output, 'ccmem: no grey-zone memories\n');
});

test('cli resurrect --revalidation applies keep and quarantine decisions', async () => {
  const db = openDb();
  resetResurrectTables(db);
  const memId = await seedRevalidationFlaggedMemory(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--revalidation', '--limit', '1'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'q\n'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(
    `SELECT decay_status, quarantined_at
     FROM memories
     WHERE id = ?`
  ).get(memId);
  const audit = verifyDb.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'revalidation_resurrect'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /flagged .* — ssh-key/);
  assert.match(output, /\[k\]eep \/ \[f\]orget \/ \[q\]uarantine \/ \[s\]kip:/);
  assert.match(output, /ccmem: revalidation keep=0 forget=0 quarantine=1 skipped=0/);
  assert.equal(row.decay_status, 'quarantine');
  assert.equal(typeof row.quarantined_at, 'number');
  assert.equal(JSON.parse(audit.details).user_action, 'quarantine');
});

test('cli resurrect --revalidation prints no pending flags when empty', () => {
  const db = openDb();
  resetResurrectTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--revalidation'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: ''
  });

  assert.equal(output, 'ccmem: no revalidation flags pending\n');
});

test('cli resurrect --contradictions acknowledges contradictions and keeps memory A', async () => {
  const db = openDb();
  resetResurrectTables(db);
  const { alertId, memBId } = await seedContradictionAlert(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'resurrect', '--contradictions', '--limit', '1'], {
    cwd: '/Users/biran/code/skills/ccmem',
    env,
    encoding: 'utf8',
    input: 'a\n'
  });

  const verifyDb = openDb();
  const alert = verifyDb.prepare(
    `SELECT acknowledged_at, acknowledged_action
     FROM contradiction_alerts
     WHERE id = ?`
  ).get(alertId);
  const memB = verifyDb.prepare(
    `SELECT decay_status
     FROM memories
     WHERE id = ?`
  ).get(memBId);
  const audit = verifyDb.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'contradiction_acknowledged'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
  verifyDb.close();

  assert.match(output, /indentation guidance conflicts/);
  assert.match(output, /ccmem: contradictions keep_a=1 keep_b=0 keep_both=0 skipped=0/);
  assert.equal(typeof alert.acknowledged_at, 'number');
  assert.equal(alert.acknowledged_action, 'keep_a');
  assert.equal(memB.decay_status, 'archived');
  assert.equal(JSON.parse(audit.details).alert_id, alertId);
  assert.equal(JSON.parse(audit.details).action, 'keep_a');
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
