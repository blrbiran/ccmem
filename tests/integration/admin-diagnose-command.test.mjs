import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-admin-diagnose-'));
const diagnoseCwd = mkdtempSync(path.join(tmpdir(), 'ccmem-diagnose-cwd-'));
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
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { cmdAdminAlias } = await import('../../scripts/lib/admin/alias.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');
const { fallbackProjectKey } = await import('../../scripts/lib/project-key.mjs');
const { handleSessionStart } = await import('../../scripts/handlers/session-start.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');
const { cleanupStaleContextFiles } = await import('../../scripts/lib/context-file.mjs');
const { recordMetric } = await import('../../scripts/lib/metrics.mjs');
const { writeMetricsDailyRollup } = await import('../../scripts/lib/metrics-rollup.mjs');

function resetDiagnoseTables(db) {
  db.prepare(`DELETE FROM daemon_lock`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM cross_scope_alerts`).run();
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM metrics_daily_rollup`).run();
  db.prepare(`DELETE FROM context_write_log`).run();
  db.prepare(`DELETE FROM context_snapshots`).run();
  db.prepare(`DELETE FROM config_kv`).run();
  db.prepare(`DELETE FROM memories`).run();
}

function seedSessionDiagnostics(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO session_context (
      session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at
     ) VALUES
      ('s-1', 'demo/repo', 2, 5, 1200, 9, ?),
      ('s-2', 'demo/other', 1, 2, 300, 4, ?)`
  ).run(now, now - 1000);

  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES
      ('s-1', 2, 'user_prompt_submit', '[1,2]', ?),
      ('s-1', 0, 'session_start', '[3]', ?),
      ('s-2', 1, 'user_prompt_submit', '[4]', ?)`
  ).run(now, now - 100, now - 1000);
}

function seedAliveDaemon(db, now = Date.now()) {
  db.prepare(
    `INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
     VALUES (1, ?, ?, ?, ?, 1)`
  ).run(2468, 'diagnose-host', now - 4000, now - 600);
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('daemon_startup_schema_version', '12', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(now - 4000);
}

function seedRollupRow(db, {
  dayKey,
  sessionStartP50 = 40,
  sessionStartP95 = 120,
  promptSubmitP50 = 30,
  promptSubmitP95 = 70,
  stopP50 = 35,
  stopP95 = 90,
  llmCalls = 4,
  llmTotalDurationMs = 8000,
  llmFailures = 0,
  llmDeadLetters = 0,
  secQuarantined = 0,
  secAlertsEmitted = 0,
  revalQuarantined = 0,
  revalFlagged = 0,
  revalScanned = 0,
  tier15Clusters = 0,
  contraDetected = 0,
  memsActive = 5,
  memsProbation = 1,
  memsQuarantine = 0,
  memsArchived = 1,
  writtenAt = Date.now()
} = {}) {
  db.prepare(
    `INSERT INTO metrics_daily_rollup (
      day_key,
      hook_session_start_p50,
      hook_session_start_p95,
      hook_prompt_submit_p50,
      hook_prompt_submit_p95,
      hook_stop_p50,
      hook_stop_p95,
      llm_calls,
      llm_total_duration_ms,
      llm_failures,
      llm_dead_letters,
      sec_quarantined,
      sec_alerts_emitted,
      reval_quarantined,
      reval_flagged,
      reval_scanned,
      tier15_clusters,
      contra_detected,
      mems_active,
      mems_probation,
      mems_quarantine,
      mems_archived,
      written_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dayKey,
    sessionStartP50,
    sessionStartP95,
    promptSubmitP50,
    promptSubmitP95,
    stopP50,
    stopP95,
    llmCalls,
    llmTotalDurationMs,
    llmFailures,
    llmDeadLetters,
    secQuarantined,
    secAlertsEmitted,
    revalQuarantined,
    revalFlagged,
    revalScanned,
    tier15Clusters,
    contraDetected,
    memsActive,
    memsProbation,
    memsQuarantine,
    memsArchived,
    writtenAt
  );
}

async function seedSecurityDiagnostics(db, now = Date.now()) {
  const globalMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Global safety rule',
    scope: 'global',
    type: 'rule'
  });
  const projectMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Project shell alias note',
    scope: 'project',
    type: 'fact'
  });

  db.prepare(
    `UPDATE memories
     SET decay_status = 'quarantine', quarantined_at = ?, trust_score = ?
     WHERE id = ?`
  ).run(now - (26 * 86400000), 0.2, projectMem.id);

  const quarantineAudit = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'security_quarantine_in', ?, ?)`
  ).run(
    now - (26 * 86400000),
    JSON.stringify([projectMem.id]),
    JSON.stringify({ reason: 'tier3_auto' })
  );
  db.prepare(
    `INSERT INTO audit_log_targets (audit_id, mem_id)
     VALUES (?, ?)`
  ).run(Number(quarantineAudit.lastInsertRowid), projectMem.id);

  db.prepare(
    `INSERT INTO cross_scope_alerts (
      global_mem_id, project_mem_id, project_key, similarity, evidence, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(globalMem.id, projectMem.id, 'demo/repo', 0.91, 'shared shell command', now - 3600000);

  db.prepare(
    `INSERT INTO cross_scope_alerts (
      global_mem_id, project_mem_id, project_key, similarity, evidence, detected_at,
      acknowledged_at, acknowledged_action
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    globalMem.id,
    projectMem.id,
    'demo/repo',
    0.88,
    'older duplicate',
    now - 7200000,
    now - 1800000,
    'keep_global'
  );

  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'security_audit_run', NULL, ?)`
  ).run(
    now - 600000,
    JSON.stringify({
      pattern_version: '2026-06-04-v03',
      candidates_scanned: 4,
      quarantined: 1,
      alerts_emitted: 2,
      llm_calls: 1,
      duration_ms: 1234,
      pool_a: 1,
      pool_b: 2,
      pool_c: 1
    })
  );

  return { globalMem, projectMem };
}

test('cmdAdminDiagnose returns db health, daemon status, and fallback project key', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedAliveDaemon(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd });

  assert.equal(result.db.health, 'ok');
  assert.equal(result.db.schema_version, 15);
  assert.equal(result.daemon.startup_schema_version, 12);
  assert.equal(typeof result.daemon.uptime_sec, 'number');
  assert.equal(result.daemon.alive, true);
  assert.equal(result.daemon.pid, 2468);
  assert.equal(result.project_key.value, fallbackProjectKey(diagnoseCwd));
  assert.equal(result.project_key.source, 'fallback');
  assert.equal(result.project_key.cwd, null);
  assert.equal(result.project_key.fallback_value, null);
  assert.equal(result.tier2.available, true);
  assert.equal(result.migrations, null);
  db.close();
});

test('cmdAdminDiagnose returns migration history when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, migrations: true });

  assert.equal(Array.isArray(result.migrations), true);
  assert.equal(result.migrations.length >= 7, true);
  assert.deepEqual(result.migrations[0], {
    from_version: 0,
    to_version: 1,
    description: 'v0.1 initial schema',
    applied_at: result.migrations[0].applied_at,
    applied_by: 'ccmem-cli'
  });
  assert.equal(result.migrations.at(-1).to_version, 15);
  db.close();
});

test('cmdAdminDiagnose returns session diagnostics when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedSessionDiagnostics(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, sessions: true });

  assert.equal(Array.isArray(result.sessions), true);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].session_id, 's-1');
  assert.equal(result.sessions[0].message_count, 5);
  assert.deepEqual(result.sessions[0].recent_injections[0].mem_ids, [1, 2]);
  assert.equal(result.sessions[0].recent_injections[1].inject_source, 'session_start');
  assert.equal(result.sessions[1].session_id, 's-2');
  assert.deepEqual(result.sessions[1].recent_injections[0].mem_ids, [4]);
  db.close();
});

test('cmdAdminDiagnose returns security diagnostics when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const { projectMem } = await seedSecurityDiagnostics(db);

  const result = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, security: true });

  assert.equal(result.security.pattern_version, '2026-06-04-v03');
  assert.equal(typeof result.security.last_run_at, 'number');
  assert.deepEqual(result.security.last_run, {
    candidates_scanned: 4,
    quarantined: 1,
    alerts_emitted: 2,
    llm_calls: 1,
    duration_ms: 1234,
    pool_a: 1,
    pool_b: 2,
    pool_c: 1
  });
  assert.equal(result.security.quarantine_pool.total, 1);
  assert.deepEqual(result.security.quarantine_pool.by_reason, [{ reason: 'tier3_auto', count: 1 }]);
  assert.equal(result.security.quarantine_pool.oldest.id, projectMem.id);
  assert.equal(result.security.alerts.pending, 1);
  assert.equal(result.security.alerts.acknowledged, 1);
  db.close();
});

test('cli admin diagnose prints default diagnostics', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedAliveDaemon(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: db ok schema=15/);
  assert.match(output, /ccmem: daemon alive pid=2468 host=diagnose-host/);
  assert.match(output, /startup_schema=12/);
  assert.match(output, /uptime_sec=\d+/);
  assert.match(output, /ccmem: project_key path:/);
  assert.match(output, /ccmem: tier2 available/);
});

test('cli admin diagnose prints daemon unavailable when lock is absent', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: daemon unavailable/);
  assert.match(output, /ccmem: tier2 unavailable/);
});

test('cli admin diagnose --migrations prints schema migration history', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--migrations'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /migration 0->1 by=ccmem-cli desc=v0\.1 initial schema/);
  assert.match(output, /migration 1->2 by=ccmem-cli desc=v0\.2 schema/);
  assert.match(output, /migration 2->3 by=ccmem-cli desc=v0\.3 schema/);
  assert.match(output, /migration 3->4 by=ccmem-cli desc=v0\.4: metrics_daily_rollup \+ revalidation audit actions/);
  assert.match(output, /migration 4->5 by=ccmem-cli desc=v0\.4 compat schema version alignment/);
  assert.match(output, /migration 5->6 by=ccmem-cli desc=v0\.5: self-restart, cron config, and backup hygiene/);
});

test('cli admin diagnose --restart-history prints daemon self-restart history', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'daemon_self_restart', NULL, ?)`
  ).run(
    1717812000000,
    JSON.stringify({
      from_version: 5,
      to_version: 6,
      daemon_pid: 2468,
      waited_ms: 1200,
      in_flight_task_type: 'summarize_pending',
      in_flight_task_id: 12
    })
  );
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'daemon_self_restart', NULL, ?)`
  ).run(
    1717811990000,
    JSON.stringify({
      from_version: 4,
      to_version: 6,
      daemon_pid: 1357,
      waited_ms: 800,
      in_flight_task_type: 'security_audit',
      in_flight_task_id: 7
    })
  );
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--restart-history'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: restart_history 2/);
  assert.match(output, /restart ts=1717812000000 from=5 to=6 pid=2468 waited_ms=1200 task=summarize_pending#12/);
  assert.match(output, /restart ts=1717811990000 from=4 to=6 pid=1357 waited_ms=800 task=security_audit#7/);
});

test('cli admin diagnose --key prints focused project key diagnostics', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--key'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: project_key path:/);
  assert.match(output, new RegExp(`ccmem: cwd .*${path.basename(diagnoseCwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const projectKey = output.match(/ccmem: project_key (path:[0-9a-f]{16}) source=fallback/)?.[1];
  assert.equal(typeof projectKey, 'string');
  assert.match(output, new RegExp(`ccmem: fallback ${projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('cli admin diagnose --sessions prints active sessions and recent injections', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedSessionDiagnostics(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--sessions'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: sessions 2/);
  assert.match(output, /session s-1 msgs=5 tools=2 duration_ms=1200 last_seq=9/);
  assert.match(output, /inject prompt=2 source=user_prompt_submit mems=1,2/);
  assert.match(output, /inject prompt=0 source=session_start mems=3/);
  assert.match(output, /session s-2 msgs=2 tools=1 duration_ms=300 last_seq=4/);
});

test('cli admin diagnose --sessions reflects hook-produced session diagnostics', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const globalMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Prefer concise answers',
    scope: 'global',
    type: 'rule'
  });
  const projectMem = await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });
  db.close();

  await handleSessionStart({ cwd: diagnoseCwd, session_id: 's-hook' });
  await handlePromptSubmit({
    cwd: diagnoseCwd,
    session_id: 's-hook',
    prompt: 'add a route under app api'
  });

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--sessions'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: sessions 1/);
  assert.match(output, /session s-hook msgs=0 tools=0 duration_ms=0 last_seq=0/);
  assert.match(output, new RegExp(`inject prompt=1 source=user_prompt_submit mems=${projectMem.id}`));
  assert.match(output, new RegExp(`inject prompt=0 source=session_start mems=${globalMem.id},${projectMem.id}`));
});

test('cli admin diagnose --security prints security diagnostics', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  await seedSecurityDiagnostics(db);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--security'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Security audit:/);
  assert.match(output, /pattern version\s+: 2026-06-04-v03/);
  assert.match(output, /last scan stats\s+: 4 candidates \/ 1 quarantined \/ 2 alerts \/ 1 LLM calls \/ 1234ms/);
  assert.match(output, /pool yields\s+: A=1 B=2 C=1/);
  assert.match(output, /Quarantine pool\s+: 1 memories/);
  assert.match(output, /tier3_auto : 1/);
  assert.match(output, /Cross-scope alerts: 1 pending \/ 1 acknowledged/);
});

test('cli admin diagnose --tuning reports insufficient data before 7 rollup days', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  for (let day = 1; day <= 6; day += 1) {
    seedRollupRow(db, { dayKey: `2026-06-0${day}` });
  }
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--tuning'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /ccmem: insufficient data \(have 6 days, need >=7\)/);
});

test('metrics rollup persists v0.12 retrieval path counts', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  rmSync(path.join(dataRoot, 'metrics.jsonl'), { force: true });

  const now = new Date();
  const dayEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayStart = dayEnd - 86400000;
  recordMetric({ hook: 'prompt_submit', ts: dayStart + 1000, ms_total: 10, retrieval_path: 'A', retrieval_fallback: false });
  recordMetric({ hook: 'prompt_submit', ts: dayStart + 2000, ms_total: 11, retrieval_path: 'B-fail', retrieval_fallback: true });
  writeMetricsDailyRollup(db);

  const row = db.prepare(
    `SELECT path_a_count, path_b_fail_count, path_b_off_count, path_b_circuit_count, embed_error_rate
     FROM metrics_daily_rollup
     ORDER BY written_at DESC
     LIMIT 1`
  ).get();
  assert.equal(row.path_a_count, 1);
  assert.equal(row.path_b_fail_count, 1);
  assert.equal(row.path_b_off_count, 0);
  assert.equal(row.path_b_circuit_count, 0);
  assert.equal(row.embed_error_rate, 0.5);
  db.close();
});

test('cli admin diagnose --retrieval shows kv-aware embedding state and open circuit', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES ('embedding.enabled', 'false', ?), ('embedding.active_provider', 'openai', ?), ('embedding.circuit_open_until', ?, ?)`
  ).run(now, now, String(now + 60000), now);
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--retrieval'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Embedding: disabled \(openai\)/);
  assert.match(output, /Circuit: OPEN/);
});

test('cli admin diagnose --embedding-circuit can open report and close circuit state', () => {
  let db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const statusOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--embedding-circuit', 'status'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  assert.match(statusOutput, /Circuit: CLOSED/);

  const openOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--embedding-circuit', 'open'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  assert.match(openOutput, /Circuit: OPEN/);

  db = openDb();
  const openUntil = Number(db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.circuit_open_until'`).get()?.value ?? NaN);
  db.close();
  assert.equal(Number.isFinite(openUntil), true);
  assert.equal(openUntil > Date.now(), true);

  const closeOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--embedding-circuit', 'close'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  assert.match(closeOutput, /Circuit: CLOSED/);

  db = openDb();
  const circuitRow = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.circuit_open_until'`).get();
  db.close();
  assert.equal(circuitRow ?? null, null);
});

test('cli admin retrieval-check prints recall and writes retrieval_check_run audit', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const memA = await cmdSave(db, { cwd: diagnoseCwd, content: 'pnpm workspace install command', scope: 'project', type: 'fact' });
  const memB = await cmdSave(db, { cwd: diagnoseCwd, content: 'auth retry failures use bounded timeout handling', scope: 'project', type: 'fact' });
  const corpusPath = path.join(dataRoot, 'retrieval-corpus.json');
  writeFileSync(corpusPath, JSON.stringify([
    { prompt: 'pnpm workspace install command', expected_ids: [memA.id], note: 'workspace' },
    { prompt: 'auth retry failures', expected_ids: [memB.id], note: 'auth' },
    { prompt: 'totally unrelated adversarial query', expected_ids: [], note: 'adversarial' }
  ]));
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'retrieval-check', '--corpus', corpusPath, '--k', '1,3'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /recall@1:/);
  assert.match(output, /precision@3:/);
  assert.match(output, /Corpus: 3 items \(1 adversarial\)/);

  const auditDb = openDb();
  const audit = auditDb.prepare(`SELECT action, details FROM audit_log WHERE action = 'retrieval_check_run' ORDER BY id DESC LIMIT 1`).get();
  auditDb.close();
  assert.equal(audit.action, 'retrieval_check_run');
  assert.equal(JSON.parse(audit.details).total, 3);

  const retrievalOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--retrieval'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  assert.match(retrievalOutput, /Benchmark: recall@3=/);
});

test('cli admin diagnose --metrics prints rollup summary', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  seedRollupRow(db, {
    dayKey: '2026-06-05',
    sessionStartP50: 45,
    sessionStartP95: 150,
    promptSubmitP50: 35,
    promptSubmitP95: 95,
    stopP50: 40,
    stopP95: 110,
    llmCalls: 6,
    llmTotalDurationMs: 12000,
    llmFailures: 1,
    secQuarantined: 2,
    secAlertsEmitted: 1,
    revalQuarantined: 1,
    revalFlagged: 3,
    tier15Clusters: 2,
    contraDetected: 2,
    memsActive: 8,
    memsProbation: 2,
    memsQuarantine: 1,
    memsArchived: 4
  });
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, 'security_alert_acknowledged', NULL, ?)`
  ).run(Date.parse('2026-06-05T12:00:00Z'), JSON.stringify({ alert_id: 1, action: 'keep_global' }));
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--metrics', '--days', '14'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Metrics \(last 14 days\)/);
  assert.match(output, /Hook latency \(ms, p50 \/ p95\)/);
  assert.match(output, /SessionStart\s+45 \/ 150/);
  assert.match(output, /LLM calls/);
  assert.match(output, /total:\s+6/);
  assert.match(output, /revalidation quarantined:\s+1\s+flagged: 3/);
  assert.match(output, /cross-scope alerts emitted:\s+1\s+acknowledged: 1/);
  assert.match(output, /contradictions detected:\s+2/);
  assert.match(output, /Embedding/);
  assert.match(output, /embedded: 0/);
  assert.match(output, /pending:\s+0/);
  assert.match(output, /rate:\s+0\/day avg/);
  assert.match(output, /Memory pool \(end of 2026-06-05\)/);
  assert.match(output, /active: 8  probation: 2  quarantine: 1  archived: 4/);
});

test('cli admin diagnose --tuning prints actionable suggestions when signals are present', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  for (let day = 1; day <= 7; day += 1) {
    seedRollupRow(db, { dayKey: `2026-06-0${day}` });
  }
  for (let i = 0; i < 10; i += 1) {
    db.prepare(
      `INSERT INTO audit_log (ts, action, affected_ids, details)
       VALUES (?, 'security_audit_run', NULL, ?)`
    ).run(
      Date.now() - ((i % 7) * 86400000),
      JSON.stringify({ pool_a: 0, pool_b: 10, pool_c: 0 })
    );
  }
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--tuning'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Tuning suggestions \(based on last 30 days, 7 days of data\)/);
  assert.match(output, /security\.audit\.pool_b\.clusterMinSize/);
  assert.match(output, /current: 3  suggest: 5/);
  assert.match(output, /\(use \/ccmem:audit show \d+ for full signal breakdown\)/);
});

test('cli admin diagnose --injections prints injection observability summary', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const memA = await cmdSave(db, { cwd: diagnoseCwd, content: 'Injection memory A', scope: 'project', type: 'fact' });
  const memB = await cmdSave(db, { cwd: diagnoseCwd, content: 'Injection memory B', scope: 'project', type: 'fact' });
  const memC = await cmdSave(db, { cwd: diagnoseCwd, content: 'Injection memory C', scope: 'project', type: 'fact' });
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, scores, created_at)
     VALUES
     ('s1', 1, 'user_prompt_submit', ?, ?, ?),
     ('s2', 1, 'user_prompt_submit', '[]', NULL, ?)`
  ).run(
    JSON.stringify([memA.id, memB.id]),
    JSON.stringify([
      { id: memA.id, fts: 0.8, jac: 0.6, cos: 0.9, f: 0.82 },
      { id: memB.id, fts: 0.4, jac: 0.3, cos: 0.2, f: 0.25 }
    ]),
    Date.now(),
    Date.now()
  );
  db.close();

  const output = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--injections', '--days', '14'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(output, /Injection overview \(last 14 days\)/);
  assert.match(output, /Volume/);
  assert.match(output, /Top 10 most injected/);
  assert.match(output, /Low-quality injections/);
  assert.match(output, /Cache efficiency \(v0\.10 file-based injection\)/);
  assert.match(output, /injection mode:\s+file-based/);
  assert.match(output, /Never injected \(30d, active\): 1 memories/);
  assert.match(output, new RegExp(`m${memA.id}`));
  assert.match(output, new RegExp(`m${memB.id}`));
  assert.match(output, /avg=0\.25/);
  assert.doesNotMatch(output, new RegExp(`m${memC.id}.*avg=`));
});

test('cli admin diagnose --context-history prints summary, session rows, and hash content', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.prepare(
    `INSERT INTO context_snapshots (content_hash, content, first_seen_at, hit_count)
     VALUES ('abc12345', '=== ccmem: retrieved for current prompt ===\n\n[m1] fact | project Example', ?, 2)`
  ).run(Date.now() - 5000);
  db.prepare(
    `INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
     VALUES
     ('ctx-session', 1, 'abc12345', 72, 1, ?),
     ('ctx-session', 2, 'abc12345', 72, 0, ?),
     ('ctx-session', 3, 'empty', 0, 1, ?)`
  ).run(Date.now() - 4000, Date.now() - 3000, Date.now() - 2000);
  db.close();

  const summaryOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--context-history'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  const sessionOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--context-history', '--session', 'ctx-session'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  const hashOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--context-history', '--hash', 'abc12345'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(summaryOutput, /Context write history \(last 7 days\)/);
  assert.match(summaryOutput, /Total writes: 3/);
  assert.match(summaryOutput, /Actual writes: 2/);
  assert.match(summaryOutput, /Hash gate skips: 1/);
  assert.match(summaryOutput, /abc12345/);

  assert.match(sessionOutput, /Session: ctx-session \(3 writes\)/);
  assert.match(sessionOutput, /prompt 1: abc12345 72B written/);
  assert.match(sessionOutput, /prompt 2: abc12345 72B skipped \(hash gate\)/);
  assert.match(sessionOutput, /prompt 3: empty 0B written/);

  assert.match(hashOutput, /Hash: abc12345/);
  assert.match(hashOutput, /Hit count: 2/);
  assert.match(hashOutput, /=== ccmem: retrieved for current prompt ===/);
});

test('cmdAdminDiagnose returns context history diagnostics when requested', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.prepare(
    `INSERT INTO context_snapshots (content_hash, content, first_seen_at, hit_count)
     VALUES ('hash9999', 'snapshot body', ?, 1)`
  ).run(Date.now() - 1000);
  db.prepare(
    `INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
     VALUES ('s-context', 1, 'hash9999', 33, 1, ?)`
  ).run(Date.now() - 500);

  const summary = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, contextHistory: true, days: 7 });
  const bySession = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, contextHistory: true, sessionId: 's-context' });
  const byHash = await cmdAdminDiagnose(db, { cwd: diagnoseCwd, contextHistory: true, contentHash: 'hash9999' });

  assert.equal(summary.context_history.mode, 'summary');
  assert.equal(summary.context_history.total, 1);
  assert.equal(bySession.context_history.mode, 'session');
  assert.equal(bySession.context_history.writes.length, 1);
  assert.equal(byHash.context_history.mode, 'hash');
  assert.equal(byHash.context_history.snapshot.content, 'snapshot body');
  db.close();
});


test('cli admin diagnose --context-history reports empty results cleanly', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  db.close();

  const sessionOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--context-history', '--session', 'missing'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });
  const hashOutput = execFileSync(NODE, [CLI, 'admin', '--', 'diagnose', '--context-history', '--hash', 'deadbeef'], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8'
  });

  assert.match(sessionOutput, /ccmem: no write history for session missing/);
  assert.match(hashOutput, /ccmem: no snapshot found for hash deadbeef/);
});


test('prompt-submit lexical fallback survives embedding provider errors and keeps additionalContext empty', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Embedding fallback remembers app api routes',
    scope: 'project',
    type: 'fact'
  });
  db.close();

  const configPath = path.join(dataRoot, 'openai-fallback-config.json');
  const previous = process.env.CCMEM_CONFIG_PATH;
  const previousKey = process.env.OPENAI_API_KEY;
  writeFileSync(configPath, JSON.stringify({
    injection: { file_based: true },
    embedding: {
      enabled: true,
      provider: 'openai',
      openai_api_key: 'test-key',
      openai_timeout_ms: 1,
      openai_base_url: 'http://127.0.0.1:1'
    }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const result = await handlePromptSubmit({
      cwd: diagnoseCwd,
      session_id: 's-embed-fallback',
      prompt: 'where are app api routes'
    });

    assert.equal(result.additionalContext, '');
    assert.equal(existsSync(path.join(diagnoseCwd, '.ccmem', 'context-s-embed-.md')), true);
  } finally {
    if (previous == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previous;
    }
    if (previousKey == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});


test('summarize-pending accepts 500-char outputs under v0.11 parsing rules', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const transcriptPath = path.join(dataRoot, 'summary-v011-transcript.jsonl');
  const configPath = path.join(dataRoot, 'summary-v011-config.json');
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  writeFileSync(configPath, JSON.stringify({
    save: { max_chars_per_memory: 500 },
    summarize: {
      min_transcript_after_clean: 1,
      content_refiner: { enabled: false }
    }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;

  try {
    writeFileSync(
      transcriptPath,
      `{"type":"user","message":{"content":[{"type":"text","text":${JSON.stringify('durable convention '.repeat(20))}}]}}\n` +
      `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n`
    );
    db.prepare(
      `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at)
       VALUES ('s-summary-v011', 'demo/repo', 0, 3, 0, 2, ?)`
    ).run(Date.now());
    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('summarize_pending', ?, ?, ?, 'queued')`
    ).run(JSON.stringify({
      session_id: 's-summary-v011',
      transcript_path: transcriptPath,
      last_message_seq: 2,
      llm_output: JSON.stringify({
        synthesized: [{
          content: 'durable memory '.repeat(40),
          type: 'fact',
          scope: 'project',
          tags: ['summary']
        }]
      })
    }), Date.now(), Date.now());

    const task = db.prepare(`SELECT * FROM tasks WHERE type = 'summarize_pending' ORDER BY id DESC LIMIT 1`).get();
    const { runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
    await runSummarizePending(db, task);
    const saved = db.prepare(`SELECT content FROM memories ORDER BY id DESC LIMIT 1`).get();

    assert.equal(Boolean(saved), true);
    assert.equal(saved.content.length <= 500, true);
  } finally {
    if (previousConfigPath == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
    db.close();
  }
});


test('summarize-pending writes summary_meta into memories', async () => {
  const previousConfigPath = process.env.CCMEM_CONFIG_PATH;
  const configPath = path.join(dataRoot, 'summarize-summary-meta-config.json');
  writeFileSync(configPath, JSON.stringify({
    summarize: {
      min_transcript_after_clean: 1,
      quality_gate: { enabled: false }
    }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;

  const db = openDb();
  resetDiagnoseTables(db);
  try {
  const transcriptPath = path.join(dataRoot, 'summarize-summary-meta.jsonl');
  writeFileSync(
    transcriptPath,
    `{"type":"user","message":{"content":[{"type":"text","text":"investigated auth retry timeout and bounded it"}]}}\n` +
    `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n`
  );
  db.prepare(
    `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at)
     VALUES ('s-summary-meta', 'demo/repo', 0, 3, 0, 2, ?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
     VALUES ('summarize_pending', ?, ?, ?, 'queued')`
  ).run(JSON.stringify({
    session_id: 's-summary-meta',
    transcript_path: transcriptPath,
    last_message_seq: 2,
    llm_output: JSON.stringify({
      synthesized: [{
        content: 'Investigated auth retries and closed the timeout gap',
        type: 'episode',
        scope: 'project',
        tags: ['auth'],
        investigated: 'auth retry timeout',
        learned: 'openai timeout must be bounded',
        completed: 'bounded retry path',
        next_steps: 'dogfood with live endpoint',
        temporal_type: 'permanent'
      }]
    })
  }), Date.now(), Date.now());

  const task = db.prepare(`SELECT * FROM tasks WHERE type = 'summarize_pending' ORDER BY id DESC LIMIT 1`).get();
  const { runSummarizePending } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
  await runSummarizePending(db, task);
  const saved = db.prepare(`SELECT summary_meta, temporal_type FROM memories WHERE summary_meta IS NOT NULL ORDER BY id DESC LIMIT 1`).get();

  assert.equal(Boolean(saved), true);
  assert.equal(saved.temporal_type, 'permanent');
  assert.equal(JSON.parse(saved.summary_meta).learned, 'openai timeout must be bounded');
  } finally {
    db.close();
    if (previousConfigPath == null) {
      delete process.env.CCMEM_CONFIG_PATH;
    } else {
      process.env.CCMEM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test('config default version is 0.11', () => {
  const raw = readFileSync('/Users/biran/code/skills/ccmem/config.default.json', 'utf8');
  assert.match(raw, /"version": "0\.11"/);
});


test('config defaults include context_history and openai timeout settings', () => {
  const raw = readFileSync('/Users/biran/code/skills/ccmem/config.default.json', 'utf8');
  assert.match(raw, /"context_history"/);
  assert.match(raw, /"openai_timeout_ms": 800/);
  assert.match(raw, /"max_chars_per_memory": 500/);
});


test('migration 013 exists', () => {
  assert.equal(existsSync('/Users/biran/code/skills/ccmem/scripts/migrations/013_v011.sql'), true);
});


test('context history schema tables exist after openDb', () => {
  const db = openDb();
  resetDiagnoseTables(db);
  const snap = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_snapshots'").get();
  const log = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_write_log'").get();
  assert.equal(snap.name, 'context_snapshots');
  assert.equal(log.name, 'context_write_log');
  db.close();
});


test('session-start read instruction uses session-scoped context filename builder output', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Session scoped instruction memory',
    scope: 'global',
    type: 'rule'
  });
  db.close();

  const result = await handleSessionStart({ cwd: diagnoseCwd, session_id: 'abcdef12-3456-7890' });
  assert.match(result.additionalContext, /Read `\.ccmem\/context-abcdef12\.md`/);
});


test('cleanup removes legacy context.md but preserves fresh other-session files', () => {
  const dir = path.join(diagnoseCwd, '.ccmem');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const legacy = path.join(dir, 'context.md');
  const stale = path.join(dir, 'context-old1111.md');
  const fresh = path.join(dir, 'context-fresh222.md');
  writeFileSync(legacy, 'legacy', 'utf8');
  writeFileSync(stale, 'stale', 'utf8');
  writeFileSync(fresh, 'fresh', 'utf8');

  const oldSeconds = (Date.now() - (48 * 60 * 60 * 1000)) / 1000;
  utimesSync(stale, oldSeconds, oldSeconds);

  cleanupStaleContextFiles(diagnoseCwd, 'current-session');

  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test('cmdAdminAlias updates project keys, cache, and audit', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Alias project memory one',
    scope: 'project',
    type: 'fact'
  });
  await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Alias project memory two',
    scope: 'project',
    type: 'rule'
  });
  const oldKey = fallbackProjectKey(diagnoseCwd);
  const newKey = 'demo/aliased';

  const result = await cmdAdminAlias(db, {
    oldKey,
    newKey,
    confirm: () => 'ALIAS'
  });

  const updated = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE project_key = ?`
  ).get(newKey);
  const oldCache = db.prepare(
    `SELECT COUNT(*) AS n
     FROM injection_cache
     WHERE scope = ?`
  ).get(`project:${oldKey}`);
  const newCache = db.prepare(
    `SELECT member_ids
     FROM injection_cache
     WHERE scope = ?`
  ).get(`project:${newKey}`);
  const audit = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'alias_applied'
     ORDER BY id DESC
     LIMIT 1`
  ).get();

  assert.equal(result.status, 'applied');
  assert.equal(result.updated_count, 2);
  assert.equal(updated.n, 2);
  assert.equal(oldCache.n, 0);
  assert.deepEqual(JSON.parse(newCache.member_ids).length, 2);
  assert.deepEqual(JSON.parse(audit.details), {
    old_key: oldKey,
    new_key: newKey,
    updated_count: 2
  });
  db.close();
});

test('cli admin alias prints success after confirmation', async () => {
  const db = openDb();
  resetDiagnoseTables(db);
  await cmdSave(db, {
    cwd: diagnoseCwd,
    content: 'Alias CLI memory',
    scope: 'project',
    type: 'fact'
  });
  db.close();

  const oldKey = fallbackProjectKey(diagnoseCwd);
  const newKey = 'demo/aliased-cli';
  const output = execFileSync(NODE, [CLI, 'admin', '--', 'alias', oldKey, newKey], {
    cwd: diagnoseCwd,
    env,
    encoding: 'utf8',
    input: 'ALIAS\n'
  });

  const verifyDb = openDb();
  const row = verifyDb.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE project_key = ?`
  ).get(newKey);
  verifyDb.close();

  assert.match(output, new RegExp(`Alias: "${oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" → "${newKey}"`));
  assert.match(output, /Type ALIAS to confirm:/);
  assert.match(output, /ccmem: aliased 1 memories from "/);
  assert.equal(row.n, 1);
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(diagnoseCwd, { recursive: true, force: true });
});
