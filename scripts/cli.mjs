import { cmdAdminAlias } from './lib/admin/alias.mjs';
import { cmdAdminCron } from './lib/admin/cron.mjs';
import { cmdAdminDaemon } from './lib/admin/daemon.mjs';
import { cmdAdminDiagnose } from './lib/admin/diagnose.mjs';
import { cmdRetrievalCheck } from './lib/admin/retrieval-check.mjs';
import { cmdAdminSemantic } from './lib/admin/semantic.mjs';
import { openDb } from './lib/db.mjs';
import { readFileSync } from 'node:fs';
import { cmdAuditShow } from './lib/cmd/audit.mjs';
import { cmdExport } from './lib/cmd/export.mjs';
import { cmdImport } from './lib/cmd/import.mjs';
import { cmdList } from './lib/cmd/list.mjs';
import { cmdMode } from './lib/cmd/mode.mjs';
import { cmdPromote } from './lib/cmd/promote.mjs';
import { cmdResurrect } from './lib/cmd/resurrect.mjs';
import { cmdSave } from './lib/cmd/save.mjs';
import { cmdShow } from './lib/cmd/show.mjs';
import { cmdStats } from './lib/cmd/stats.mjs';
import { resolveProjectKey } from './lib/project-key.mjs';

let db = null;
const [verb, ...rawArgs] = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

function getDb() {
  if (!db) {
    db = openDb();
  }

  return db;
}

function printHelp() {
  process.stdout.write(
    'Usage: ccmem <command> [options]\n\n' +
    'Commands:\n' +
    '  save <content> [--global]\n' +
    '  list [query] [--limit N] [--quarantined] [--never-injected] [--days N] [--score]\n' +
    '  show <id>\n' +
    '  export --json [--scope global|project]\n' +
    '  import <file>\n' +
    '  mode [active|shadow|off]\n' +
    '  audit show <id>\n' +
    '  admin daemon <status|start|stop|restart|install|uninstall>\n' +
    '  admin cron <list|run>\n' +
    '  admin semantic <on|off|status> [--provider <transformers-local|openai|jina>]\n' +
    '  admin retrieval-check [--corpus <path>] [--k 1,3,5]\n' +
    '  admin diagnose [--retrieval] [--embedding-circuit <open|close|status>] [--migrations|--key|--sessions|--security|--tuning|--metrics|--synthesis|--restart-history|--injections|--context-history] [--session ID] [--hash HASH] [--days N]\n' +
    '  admin alias <old-project-key> <new-project-key>\n' +
    '  stats [--json|--buckets]\n' +
    '  promote <id> [--global]\n' +
    '  resurrect [--quarantined|--alerts|--revalidation|--contradictions|--promote-candidates] [--all]\n'
  );
}

if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'daemon' && args[1] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'diagnose' && args[1] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'alias' && args[1] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'semantic' && args[1] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'list' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'show' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'export' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'import' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'save' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'mode' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'stats' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'resurrect' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'promote' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'audit' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'cron' && args[1] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === '--help') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'audit' && args[0] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'daemon' && args[1] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'cron' && args[1] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'semantic' && args[1] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'alias' && (args[1] == null || args[2] == null)) {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'diagnose' && args[1] === '--') {
  printHelp();
  process.exit(0);
}

if (verb === 'audit' && args[0] === 'show' && args[1] == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'show' && args.find((arg) => !arg.startsWith('--')) == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'promote' && args.find((arg) => !arg.startsWith('--')) == null) {
  printHelp();
  process.exit(0);
}

if (verb === 'save' && args.filter((arg) => !arg.startsWith('--')).length === 0) {
  printHelp();
  process.exit(0);
}

if (verb === 'import' && args.filter((arg) => !arg.startsWith('--')).length === 0) {
  printHelp();
  process.exit(0);
}

if (verb === 'unknown') {
  printHelp();
  process.exit(0);
}

if (verb === 'admin' && args[0] === 'diagnose' && args[1] == null) {
  // handled below with defaults, keep DB lazy until command path.
}

if (verb === 'list' && args[0] == null) {
  // handled below with defaults, keep DB lazy until command path.
}

if (verb === 'stats' && args[0] == null) {
  // handled below with defaults, keep DB lazy until command path.
}

if (verb === 'mode' && args[0] == null) {
  // handled below with defaults, keep DB lazy until command path.
}

if (verb === 'resurrect' && args[0] == null) {
  // handled below with defaults, keep DB lazy until command path.
}

if (verb === 'save' && args[0] != null) {
  // handled below.
}

if (verb === 'admin' && args[0] === 'daemon' && args[1] != null) {
  // handled below.
}

if (verb === 'admin' && args[0] === 'cron' && args[1] != null) {
  // handled below.
}

if (verb === 'audit' && args[0] === 'show' && args[1] != null) {
  // handled below.
}

if (verb === 'show' && args.find((arg) => !arg.startsWith('--')) != null) {
  // handled below.
}

if (verb === 'promote' && args.find((arg) => !arg.startsWith('--')) != null) {
  // handled below.
}

if (verb === 'admin' && args[0] === 'diagnose') {
  // handled below.
}

if (!['save', 'list', 'show', 'export', 'import', 'mode', 'audit', 'admin', 'stats', 'promote', 'resurrect'].includes(verb)) {
  printHelp();
  process.exit(64);
}

const closeDb = () => db?.close();

function getOptionValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] ?? null : null;
}

function positionalArgs(optionFlagsWithValue = []) {
  const skip = new Set();
  for (const flag of optionFlagsWithValue) {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      skip.add(idx + 1);
    }
  }

  return args.filter((arg, idx) => !arg.startsWith('--') && !skip.has(idx));
}

function createStdinLineReader() {
  let lines = null;
  let index = 0;

  return () => {
    if (!lines) {
      lines = readFileSync(0, 'utf8').split(/\r?\n/);
    }

    return (lines[index++] ?? '').trim();
  };
}

function formatAgeDays(ts) {
  if (!ts) {
    return 'unknown';
  }

  const days = Math.max(0, Math.floor((Date.now() - ts) / 86400000));
  return `${days}d ago`;
}

function formatSettingValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return String(value);
  }

  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function formatMinutes(ms) {
  return (Number(ms ?? 0) / 60000).toFixed(1).replace(/\.0$/, '.0');
}

function formatLocalTimestamp(ts) {
  if (!ts) {
    return 'unknown';
  }

  const date = new Date(ts);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function formatDurationSeconds(startedAt, completedAt) {
  if (!startedAt || !completedAt || completedAt < startedAt) {
    return 'unknown';
  }

  return String(Math.round((completedAt - startedAt) / 1000));
}

function printTuning(result) {
  const tuning = result.tuning;

  if (tuning.insufficient) {
    process.stdout.write(`ccmem: insufficient data (have ${tuning.days_available} days, need >=${tuning.min_days})\n`);
    return;
  }

  process.stdout.write(`Tuning suggestions (based on last 30 days, ${tuning.days_available} days of data)\n\n`);

  for (const suggestion of tuning.suggestions) {
    const suffix = suggestion.action === 'keep' ? ' (keep)' : '';
    process.stdout.write(
      `  ${suggestion.key.padEnd(44)} current: ${formatSettingValue(suggestion.current)}  suggest: ${formatSettingValue(suggestion.suggest)}${suffix}\n`
    );
    process.stdout.write(`    rationale: ${suggestion.rationale}\n`);
    process.stdout.write(`    impact:    ${suggestion.impact}\n\n`);
  }

  if (tuning.audit_id != null) {
    process.stdout.write(`(use /ccmem:audit show ${tuning.audit_id} for full signal breakdown)\n`);
  }
}

function printRetrieval(result) {
  const retrieval = result.retrieval;
  process.stdout.write(`Embedding: ${retrieval.embedding_enabled ? 'enabled' : 'disabled'} (${retrieval.embedding_provider})\n`);
  process.stdout.write(`Circuit: ${retrieval.circuit}`);
  if (retrieval.circuit_open_until != null) {
    process.stdout.write(` until ${formatLocalTimestamp(retrieval.circuit_open_until)}`);
  }
  process.stdout.write('\n');
  if (retrieval.benchmark) {
    process.stdout.write(`Benchmark: recall@3=${retrieval.benchmark.recall_at_3 ?? 'n/a'} total=${retrieval.benchmark.total} last run=${formatLocalTimestamp(retrieval.benchmark.run_at ?? retrieval.benchmark.ts)}\n`);
  }
}

function printCircuitStatus(result) {
  process.stdout.write(`Circuit: ${result.embedding_circuit.status}`);
  if (result.embedding_circuit.open_until != null) {
    process.stdout.write(` until ${formatLocalTimestamp(result.embedding_circuit.open_until)}`);
  }
  process.stdout.write('\n');
}

function isCircuitVerb(value) {
  return value === 'open' || value === 'close' || value === 'status';
}

function circuitVerbFromArgv(argv) {
  const idx = argv.indexOf('--embedding-circuit');
  if (idx >= 0 && isCircuitVerb(argv[idx + 1])) {
    return argv[idx + 1];
  }
  return 'status';
}

function printMetrics(result) {
  const metrics = result.metrics;

  if (metrics.no_data) {
    process.stdout.write(`ccmem: no metrics data in last ${metrics.days} days\n`);
    return;
  }

  const hooks = [
    ['SessionStart', metrics.hooks.session_start],
    ['UserPromptSubmit', metrics.hooks.prompt_submit],
    ['Stop', metrics.hooks.stop]
  ];

  process.stdout.write(`Metrics (last ${metrics.days} days)\n\n`);
  process.stdout.write('  Hook latency (ms, p50 / p95)\n');
  for (const [label, hook] of hooks) {
    process.stdout.write(
      `    ${label.padEnd(16)} ${String(hook.p50 ?? '-').padStart(3)} / ${String(hook.p95 ?? '-').padEnd(4)}  (budget: ${hook.budget.p50}/${hook.budget.p95})  ${hook.status}\n`
    );
    if (hook.trend) {
      const delta = hook.trend.delta_ms >= 0 ? `+${hook.trend.delta_ms}` : `${hook.trend.delta_ms}`;
      process.stdout.write(
        `                                                  ${hook.trend.arrow} trend: ${delta}ms vs prior ${hook.trend.compare_days}d\n`
      );
    }
  }

  process.stdout.write('\n  LLM calls\n');
  process.stdout.write(`    total:        ${metrics.llm.total}        (avg ${metrics.llm.avg_per_day}/day)\n`);
  process.stdout.write(`    duration:     ${formatMinutes(metrics.llm.duration_ms)} min total (avg ${metrics.llm.avg_duration_s}s/call)\n`);
  process.stdout.write(
    `    failures:     ${metrics.llm.failures}         (${metrics.llm.total ? ((metrics.llm.failures / metrics.llm.total) * 100).toFixed(1) : '0.0'}%)\n`
  );
  process.stdout.write(`    dead-letters: ${metrics.llm.dead_letters}         ${metrics.llm.dead_letters > 0 ? 'WARN' : 'OK'}\n`);

  process.stdout.write('\n  Pool flow\n');
  process.stdout.write(`    Tier 1.5 clusters quarantined: ${metrics.flow.tier15_clusters}\n`);
  process.stdout.write(`    security_audit quarantined:    ${metrics.flow.security_quarantined}\n`);
  process.stdout.write(
    `    revalidation quarantined:      ${metrics.flow.revalidation_quarantined}   flagged: ${metrics.flow.revalidation_flagged}\n`
  );
  process.stdout.write(
    `    cross-scope alerts emitted:    ${metrics.flow.cross_scope_alerts_emitted}   acknowledged: ${metrics.flow.cross_scope_alerts_acknowledged}\n`
  );
  process.stdout.write(
    `    contradictions detected:       ${metrics.flow.contradictions_detected}\n`
  );

  process.stdout.write('\n  Embedding\n');
  process.stdout.write(`    embedded: ${metrics.embedding.embedded}\n`);
  process.stdout.write(`    pending:  ${metrics.embedding.pending}\n`);
  process.stdout.write(`    rate:     ${Math.round(metrics.embedding.avg_rate_per_day)}/day avg\n`);

  process.stdout.write(`\n  Memory pool (end of ${metrics.memory_pool.day_key})\n`);
  process.stdout.write(
    `    active: ${metrics.memory_pool.active}  probation: ${metrics.memory_pool.probation}  quarantine: ${metrics.memory_pool.quarantine}  archived: ${metrics.memory_pool.archived}\n`
  );
}

try {
  if (verb === 'save') {
    const content = args.filter((arg) => !arg.startsWith('--')).join(' ');
    const scope = args.includes('--global') ? 'global' : 'project';
    const result = await cmdSave(getDb(), { cwd: process.cwd(), content, scope });
    process.stdout.write(`ccmem: saved memory #${result.id} (${result.scope} ${result.type})\n`);
  } else if (verb === 'list') {
    const query = positionalArgs(['--limit', '--days']).join(' ') || null;
    const showScore = args.includes('--score');
    const neverInjected = args.includes('--never-injected');
    const rows = await cmdList(getDb(), {
      cwd: process.cwd(),
      limit: Number(getOptionValue('--limit') ?? 20),
      quarantined: args.includes('--quarantined'),
      neverInjected,
      days: Number(getOptionValue('--days') ?? 30),
      query: neverInjected ? null : query
    });

    if (!rows.length) {
      process.stdout.write(
        args.includes('--quarantined')
          ? 'ccmem: no quarantined memories\n'
          : neverInjected
            ? 'ccmem: no never-injected memories\n'
            : 'ccmem: no memories\n'
      );
    } else if (args.includes('--quarantined')) {
      for (const row of rows) {
        process.stdout.write(
          `[m${row.id}] ${row.type} | ${row.scope} | ${row.source} trust=${Number(row.trust_score ?? 0).toFixed(2)} quarantined=${formatAgeDays(row.quarantined_at)} reason=${row.reason ?? 'unknown'}\n`
        );
      }
    } else {
      for (const row of rows) {
        const scoreSuffix = showScore && row.score
          ? ` | score fused=${Number(row.score.fused ?? 0).toFixed(3)} fts=${Number(row.score.fts ?? 0).toFixed(3)} jaccard=${Number(row.score.jaccard ?? 0).toFixed(3)} semantic=${Number(row.score.semantic ?? 0).toFixed(3)}`
          : '';
        const neverSuffix = neverInjected
          ? ` | trust=${Number(row.trust_score ?? 0).toFixed(2)}`
          : '';
        process.stdout.write(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}${neverSuffix}${scoreSuffix}\n`);
      }
    }
  } else if (verb === 'show') {
    const id = positionalArgs()[0];
    const row = await cmdShow(getDb(), { id });
    if (!row) {
      process.stderr.write('ccmem: memory not found\n');
      process.exitCode = 2;
    } else {
      process.stdout.write(`[m${row.id}] ${row.type} | ${row.scope}${row.project_key ? `:${row.project_key}` : ''}\n`);
      process.stdout.write(`${row.content}\n`);
      process.stdout.write(`trust=${Number(row.trust_score ?? 0).toFixed(2)} status=${row.status} decay=${row.decay_status}\n`);
      if (row.injection_history?.length) {
        process.stdout.write('\nRecent injections (last 14d):\n');
        for (const item of row.injection_history) {
          process.stdout.write(
            `  ${formatAgeDays(item.created_at)}  fts=${Number(item.score?.fts ?? 0).toFixed(3)} jac=${Number(item.score?.jac ?? 0).toFixed(3)} cos=${Number(item.score?.cos ?? 0).toFixed(3)} fused=${Number(item.score?.f ?? 0).toFixed(3)}\n`
          );
        }
        process.stdout.write(`  (${row.injection_history.length} times in 14d)\n`);
      }
    }
  } else if (verb === 'export') {
    const scope = getOptionValue('--scope');
    const payload = cmdExport(getDb(), {
      scope,
      projectKey: scope === 'project' ? resolveProjectKey(process.cwd()) : null
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (verb === 'import') {
    const filePath = args.find((arg) => !arg.startsWith('--'));
    const result = await cmdImport(getDb(), { cwd: process.cwd(), filePath });
    process.stdout.write(`ccmem: imported ${result.imported}, skipped ${result.skipped}\n`);
    if (result.pending_embeddings > 0) {
      process.stderr.write(
        `ccmem: ${result.pending_embeddings} memories imported without embeddings (vec_backfill will process them)\n`
      );
    }
  } else if (verb === 'mode') {
    const result = await cmdMode(getDb(), { mode: args[0] ?? null });
    process.stdout.write(`ccmem: mode=${result.mode}\n`);
  } else if (verb === 'audit' && args[0] === 'show' && args[1]) {
    const row = await cmdAuditShow(getDb(), { id: Number(args[1]) });
    process.stdout.write(`${JSON.stringify(row)}\n`);
  } else if (verb === 'admin' && args[0] === 'daemon' && args[1]) {
    const daemonVerb = args[1];
    const result = await cmdAdminDaemon(getDb(), { verb: daemonVerb });

    if (daemonVerb === 'status') {
      if (!result.alive) {
        process.stdout.write('ccmem: daemon not running\n');
      } else {
        const running = result.running_task ? `${result.running_task.type}#${result.running_task.id}` : 'none';
        const source = result.install_variant === 'container-fallback' ? ' source=container-fallback' : '';
        process.stdout.write(
          `ccmem: daemon alive pid=${result.pid} host=${result.hostname} heartbeat_ms=${result.heartbeat_age_ms} startup_schema=${result.startup_schema_version ?? 'unknown'} uptime_sec=${result.uptime_sec ?? 'unknown'} running=${running}${source}\n`
        );
      }
    } else if (result.status === 'already_running') {
      process.stdout.write(`ccmem: daemon already running pid=${result.pid}\n`);
    } else if (result.status === 'started') {
      process.stdout.write(`ccmem: daemon started pid=${result.pid}\n`);
    } else if (result.status === 'stopped') {
      process.stdout.write(`ccmem: daemon stopped pid=${result.pid}\n`);
    } else if (result.status === 'not_running') {
      process.stdout.write('ccmem: daemon not running\n');
    } else if (result.status === 'restarted') {
      process.stdout.write(`ccmem: daemon restarted pid=${result.pid}\n`);
    } else if (result.status === 'installed') {
      const variant = result.variant ? ` (${result.variant})` : '';
      process.stdout.write(`ccmem: daemon installed${variant} ${result.plist_path}\n`);
    } else if (result.status === 'uninstalled') {
      process.stdout.write(`ccmem: daemon uninstalled ${result.plist_path}\n`);
    } else if (result.status === 'not_installed') {
      process.stdout.write('ccmem: daemon not installed\n');
    } else if (result.status === 'install_failed') {
      process.stderr.write(
        `ccmem: WARNING — failed to register Tier 2 daemon (${result.reason}).\n` +
          'Tier 1 (inject) + Tier 1.5 (SQL maintenance) still work.\n' +
          'Tier 2 (summarize / synthesis / L4) requires the daemon.\n'
      );
      process.exitCode = 1;
    } else if (result.status === 'install_warn') {
      process.stdout.write(`ccmem: daemon installed ${result.plist_path}\n`);
      process.stderr.write(`ccmem: WARNING — ${result.reason}\n`);
    } else if (result.status === 'version_check_failed') {
      process.stderr.write(`ccmem: daemon install blocked (${result.reason})\n`);
      process.exitCode = 1;
    } else if (result.status === 'uninstall_failed') {
      process.stderr.write(`ccmem: daemon uninstall failed (${result.reason})\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`ccmem: daemon ${daemonVerb} failed\n`);
      process.exitCode = 1;
    }
  } else if (verb === 'admin' && args[0] === 'cron' && args[1] === 'list') {
    const historyIdx = args.indexOf('--history');
    const taskIdx = args.indexOf('--task');
    const verbose = args.includes('--verbose');

    if (args.includes('--issues')) {
      const result = await cmdAdminCron(getDb(), { verb: 'list', issues: true });

      if (result.issues.length) {
        process.stdout.write('ccmem: cron issues\n');

        for (const issue of result.issues) {
          if (issue.kind === 'failed') {
            process.stdout.write(`failed ${issue.type} last=${issue.date_key} by=${issue.ran_by}\n`);
          } else if (issue.kind === 'zombie') {
            process.stdout.write(`zombie ${issue.type} last=${issue.date_key} age_ms=${issue.age_ms}\n`);
          } else if (issue.kind === 'overdue') {
            process.stdout.write(`overdue ${issue.type} queued=${issue.queued} oldest_ms=${issue.oldest_age_ms}\n`);
          }
        }
      }
    } else if (historyIdx >= 0 && taskIdx >= 0 && args[taskIdx + 1]) {
      try {
        const result = await cmdAdminCron(getDb(), {
          verb: 'list',
          taskType: args[taskIdx + 1],
          history: args[historyIdx + 1] ?? '10',
          verbose
        });
        process.stdout.write(`ccmem: cron history ${result.type}\n`);

        for (const row of result.history) {
          process.stdout.write(
            `${row.status}@${row.date_key} by=${row.ran_by} at=${formatLocalTimestamp(row.completed_at ?? row.started_at)} duration_s=${formatDurationSeconds(row.started_at, row.completed_at)}\n`
          );
        }
        if (verbose && result.last_audit?.summary) {
          process.stdout.write(`  audit: ${result.last_audit.summary}\n`);
        }
      } catch (error) {
        if (error instanceof Error && /unsupported .*cron task:/.test(error.message)) {
          process.stderr.write(`ccmem: ${error.message}\n`);
          process.exitCode = 64;
        } else {
          throw error;
        }
      }
    } else {
      const result = await cmdAdminCron(getDb(), { verb: 'list', verbose });
      process.stdout.write(`ccmem: daemon ${result.daemon_alive ? 'alive' : 'not running'}\n`);

      for (const item of result.items) {
        const last = item.last_run ? `${item.last_run.status}@${item.last_run.date_key}` : 'none';
        const at = item.last_run ? formatLocalTimestamp(item.last_run.completed_at ?? item.last_run.started_at) : 'unknown';
        const duration = item.last_run ? formatDurationSeconds(item.last_run.started_at, item.last_run.completed_at) : 'unknown';
        process.stdout.write(`${item.type} queued=${item.queued} last=${last} at=${at} duration_s=${duration}\n`);
        if (verbose && item.last_audit?.summary) {
          process.stdout.write(`  audit: ${item.last_audit.summary}\n`);
        }
      }
    }
  } else if (verb === 'admin' && args[0] === 'cron' && args[1] === 'run' && args[2]) {
    try {
      const result = await cmdAdminCron(getDb(), { verb: 'run', taskType: args[2] });
      if (result.status === 'skipped') {
        process.stdout.write(`ccmem: skipped ${result.type} (${result.reason})\n`);
      } else {
        process.stdout.write(`ccmem: enqueued ${result.type} as task#${result.task_id}\n`);
      }
    } catch (error) {
      if (error instanceof Error && /unsupported .*cron task:/.test(error.message)) {
        process.stderr.write(`ccmem: ${error.message}\n`);
        process.exitCode = 64;
      } else {
        throw error;
      }
    }
  } else if (verb === 'admin' && args[0] === 'semantic' && args[1]) {
    const result = await cmdAdminSemantic(getDb(), { verb: args[1], provider: getOptionValue('--provider') });
    process.stdout.write(
      `ccmem: semantic ${result.status} enabled=${result.enabled} loaded=${result.loaded} provider=${result.provider} embedded=${result.embedded} pending=${result.pending} model=${result.model} dim=${result.dim}\n`
    );
  } else if (verb === 'admin' && args[0] === 'retrieval-check') {
    const result = await cmdRetrievalCheck(getDb(), {
      cwd: process.cwd(),
      corpus: getOptionValue('--corpus'),
      k: getOptionValue('--k')
    });
    for (const metric of result.metrics) {
      process.stdout.write(`recall@${metric.k}: ${(metric.recall * 100).toFixed(1)}%\n`);
      process.stdout.write(`precision@${metric.k}: ${(metric.precision * 100).toFixed(1)}%\n`);
    }
    process.stdout.write(`\nCorpus: ${result.total} items (${result.adversarial} adversarial)\n`);
  } else if (verb === 'admin' && args[0] === 'alias' && args[1] && args[2]) {
    const readLine = createStdinLineReader();
    const result = await cmdAdminAlias(getDb(), {
      oldKey: args[1],
      newKey: args[2],
      confirm: ({ oldKey, newKey, count }) => {
        process.stdout.write(
          `Alias: "${oldKey}" → "${newKey}" (${count} memories)\n` +
          'Type ALIAS to confirm: '
        );
        return readLine();
      }
    });

    if (result.status === 'usage' || result.status === 'not_found') {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = result.status === 'usage' ? 64 : 2;
    } else if (result.status === 'cancelled') {
      process.stdout.write('ccmem: cancelled\n');
    } else {
      process.stdout.write(`ccmem: aliased ${result.updated_count} memories from "${result.oldKey}" → "${result.newKey}"\n`);
    }
  } else if (verb === 'admin' && args[0] === 'diagnose') {
    const result = await cmdAdminDiagnose(getDb(), {
      cwd: process.cwd(),
      migrations: args.includes('--migrations'),
      key: args.includes('--key'),
      sessions: args.includes('--sessions'),
      security: args.includes('--security'),
      tuning: args.includes('--tuning'),
      metrics: args.includes('--metrics'),
      retrieval: args.includes('--retrieval'),
      embeddingCircuit: args.includes('--embedding-circuit'),
      embeddingCircuitVerb: circuitVerbFromArgv(args),
      restartHistory: args.includes('--restart-history'),
      synthesis: args.includes('--synthesis'),
      injections: args.includes('--injections'),
      contextHistory: args.includes('--context-history'),
      sessionId: getOptionValue('--session'),
      contentHash: getOptionValue('--hash'),
      days: Number(getOptionValue('--days') ?? (args.includes('--context-history') ? 7 : 14))
    });

    if (args.includes('--key')) {
      process.stdout.write(`ccmem: project_key ${result.project_key.value} source=${result.project_key.source}\n`);
      process.stdout.write(`ccmem: cwd ${result.project_key.cwd}\n`);
      process.stdout.write(`ccmem: fallback ${result.project_key.fallback_value}\n`);
    } else if (args.includes('--sessions')) {
      process.stdout.write(`ccmem: sessions ${result.sessions.length}\n`);

      for (const session of result.sessions) {
        process.stdout.write(
          `session ${session.session_id} msgs=${session.message_count} tools=${session.tool_calls} duration_ms=${session.duration_ms} last_seq=${session.last_seq}\n`
        );

        for (const injection of session.recent_injections) {
          process.stdout.write(
            `  inject prompt=${injection.prompt_idx} source=${injection.inject_source} mems=${injection.mem_ids.join(',')} at=${injection.created_at}\n`
          );
        }
      }
    } else if (args.includes('--security')) {
      const security = result.security;
      process.stdout.write('Security audit:\n');
      process.stdout.write(`  last run         : ${security.last_run_at ?? 'never'}\n`);
      process.stdout.write(`  pattern version  : ${security.pattern_version ?? 'unknown'}\n`);
      if (security.last_run) {
        process.stdout.write(
          `  last scan stats  : ${security.last_run.candidates_scanned} candidates / ${security.last_run.quarantined} quarantined / ${security.last_run.alerts_emitted} alerts / ${security.last_run.llm_calls} LLM calls / ${security.last_run.duration_ms}ms\n`
        );
        process.stdout.write(
          `  pool yields      : A=${security.last_run.pool_a} B=${security.last_run.pool_b} C=${security.last_run.pool_c}\n`
        );
      }
      process.stdout.write(`Quarantine pool   : ${security.quarantine_pool.total} memories\n`);
      for (const row of security.quarantine_pool.by_reason) {
        process.stdout.write(`  ${row.reason} : ${row.count}\n`);
      }
      if (security.quarantine_pool.oldest) {
        process.stdout.write(
          `  oldest quarantined: m${security.quarantine_pool.oldest.id} (${security.quarantine_pool.oldest.age_days} days)\n`
        );
      }
      process.stdout.write(
        `Cross-scope alerts: ${security.alerts.pending} pending / ${security.alerts.acknowledged} acknowledged\n`
      );
    } else if (args.includes('--tuning')) {
      printTuning(result);
    } else if (args.includes('--metrics')) {
      printMetrics(result);
    } else if (args.includes('--retrieval')) {
      printRetrieval(result);
    } else if (args.includes('--embedding-circuit')) {
      printCircuitStatus(result);
    } else if (args.includes('--context-history')) {
      const history = result.context_history;
      if (history.mode === 'hash') {
        if (!history.snapshot) {
          process.stdout.write(`ccmem: no snapshot found for hash ${history.hash}\n`);
        } else {
          process.stdout.write(`Hash: ${history.snapshot.content_hash}\n`);
          process.stdout.write(`First seen: ${formatLocalTimestamp(history.snapshot.first_seen_at)}\n`);
          process.stdout.write(`Hit count: ${history.snapshot.hit_count}\n\n`);
          process.stdout.write('Content:\n');
          process.stdout.write(`${history.snapshot.content}\n`);
        }
      } else if (history.mode === 'session') {
        if (history.total === 0) {
          process.stdout.write(`ccmem: no write history for session ${history.session_id}\n`);
        } else {
          process.stdout.write(`Session: ${history.session_id} (${history.total} writes)\n\n`);
          for (const row of history.writes) {
            process.stdout.write(
              `  prompt ${row.prompt_idx}: ${row.content_hash} ${row.bytes}B ${row.written ? 'written' : 'skipped (hash gate)'} ${formatLocalTimestamp(row.written_at)}\n`
            );
          }
        }
      } else {
        process.stdout.write(`Context write history (last ${history.days} days)\n\n`);
        process.stdout.write(`  Total writes: ${history.total}\n`);
        process.stdout.write(`  Actual writes: ${history.actual_writes}\n`);
        process.stdout.write(`  Hash gate skips: ${history.hash_gate_skips}\n`);
        process.stdout.write(`  Gate efficiency: ${(history.gate_efficiency * 100).toFixed(1)}%\n`);
        if (history.top_hashes.length > 0) {
          process.stdout.write('\n  Top hashes\n');
          for (const row of history.top_hashes) {
            process.stdout.write(
              `    ${row.content_hash}  count=${row.count}  writes=${row.writes}  skips=${row.skips}  bytes=${row.bytes}\n`
            );
          }
        }
      }
    } else if (args.includes('--injections')) {
      const inj = result.injections;
      process.stdout.write(`Injection overview (last ${inj.days} days)\n\n`);
      process.stdout.write('  Volume\n');
      process.stdout.write(`    injections:    ${inj.total} (avg ${(inj.total / inj.days).toFixed(1)}/day)\n`);
      process.stdout.write(`    empty:         ${inj.empty} (${inj.total > 0 ? ((inj.empty / inj.total) * 100).toFixed(1) : '0.0'}%)\n`);
      process.stdout.write(`    distinct mems: ${inj.distinct_mems} / ${inj.active_count} active (${inj.active_count > 0 ? ((inj.distinct_mems / inj.active_count) * 100).toFixed(1) : '0.0'}%)\n`);
      if (inj.total > 0) {
        process.stdout.write('\n  Score distribution (fused, p50 / p95)\n');
        process.stdout.write(`    ${inj.fused_p50.toFixed(2)} / ${inj.fused_p95.toFixed(2)}\n`);
      }
      if (inj.top10.length > 0) {
        process.stdout.write('\n  Top 10 most injected\n');
        for (const row of inj.top10) {
          process.stdout.write(`    m${row.id}  ${row.type}|${row.scope}  ${row.count}x  avg=${row.avgFused.toFixed(2)}  ${String(row.content ?? '').slice(0, 50)}\n`);
        }
      }
      if (inj.low_quality.length > 0) {
        process.stdout.write(`\n  Low-quality injections (fused < ${inj.low_threshold})\n`);
        for (const row of inj.low_quality) {
          process.stdout.write(`    m${row.id}  ${row.type}|${row.scope}  ${row.count}x  avg=${row.avgFused.toFixed(2)}  ${String(row.content ?? '').slice(0, 50)}\n`);
        }
        process.stdout.write('    Run /ccmem:forget mNNN to remove, or wait for adaptive decay.\n');
      }
      process.stdout.write(`\n  Never injected (30d, active): ${inj.never_count} memories\n`);
      if (inj.never_count > 0) {
        process.stdout.write('    Run /ccmem:list --never-injected to see them.\n');
      }
      if (inj.perf) {
        process.stdout.write('\n  Retrieval performance (embedding ON)\n');
        process.stdout.write(`    embed:     p50=${inj.perf.embed.p50}ms  p95=${inj.perf.embed.p95}ms\n`);
        process.stdout.write(`    db read:   p50=${inj.perf.db.p50}ms  p95=${inj.perf.db.p95}ms  pool=${inj.perf.avgPool} mems\n`);
        process.stdout.write(`    cosine:    p50=${inj.perf.cosine.p50}ms  p95=${inj.perf.cosine.p95}ms\n`);
      }
      process.stdout.write('\n  Cache efficiency (v0.10 file-based injection)\n');
      process.stdout.write('    injection mode:         file-based\n');
      process.stdout.write(`    additionalContext empty: ${inj.cache.empty_additional_context}/${inj.cache.total_prompts} (${inj.cache.total_prompts > 0 ? ((inj.cache.empty_additional_context / inj.cache.total_prompts) * 100).toFixed(0) : '0'}%)\n`);
      process.stdout.write(`    context file writes:     ${inj.cache.context_file_writes}/${inj.cache.total_prompts}\n`);
      process.stdout.write(`    total file bytes:        ${(inj.cache.total_file_bytes / 1024).toFixed(1)} KB\n`);
      process.stdout.write(`    cache impact:            ${inj.cache.additional_context_all_empty ? '0% ✅' : 'WARN — some prompts injected additionalContext'}\n`);
    } else if (args.includes('--synthesis')) {
      const syn = result.synthesis;
      process.stdout.write(`Synthesis pipeline (last ${syn.days} days, ${syn.weekly_runs} weekly runs)\n\n`);
      process.stdout.write('  Input quality\n');
      process.stdout.write(`    transcript cleaner:  avg ${Math.round(syn.avg_stripped_pct)}% chars stripped (${syn.cleaner_runs} runs)\n`);
      process.stdout.write(`    quality gate:        ${syn.gate_total} rejected / ${syn.proposed + syn.gate_total} proposed (${(syn.proposed + syn.gate_total) > 0 ? Math.round((syn.gate_total / (syn.proposed + syn.gate_total)) * 100) : 0}% reject rate)\n`);
      if (syn.gate_reasons.length > 0) {
        process.stdout.write(`    reject reasons:      ${syn.gate_reasons.map((row) => `${row.reason}=${row.count}`).join('  ')}\n`);
      }
      process.stdout.write('\n  Weekly synthesis\n');
      process.stdout.write(`    LLM calls:           avg ${Math.round(syn.avg_llm_calls * 10) / 10} / run\n`);
      process.stdout.write(`    proposed:            ${syn.proposed} total (avg ${syn.weekly_runs > 0 ? (syn.proposed / syn.weekly_runs).toFixed(1) : '0.0'} / run)\n`);
      process.stdout.write(`    accepted:            ${syn.accepted} (${syn.proposed > 0 ? Math.round((syn.accepted / syn.proposed) * 100) : 0}% acceptance)\n`);
      process.stdout.write(`    rejected:            ${syn.rejected}\n`);
      process.stdout.write('\n  Output quality\n');
      process.stdout.write(`    consolidated active: ${syn.consolidated_active}\n`);
      process.stdout.write(`    superseded:          ${syn.consolidated_superseded}\n`);
    } else if (args.includes('--restart-history')) {
      process.stdout.write(`ccmem: restart_history ${result.restart_history.length}\n`);
      for (const row of result.restart_history) {
        process.stdout.write(
          `restart ts=${row.ts} from=${row.from_version} to=${row.to_version} pid=${row.daemon_pid ?? 'unknown'} waited_ms=${row.waited_ms} task=${row.in_flight_task_type ?? 'none'}#${row.in_flight_task_id ?? 'none'}\n`
        );
      }
    } else {
      process.stdout.write(`ccmem: db ${result.db.health} schema=${result.db.schema_version} path=${result.db.path}\n`);

      if (result.daemon.alive) {
        process.stdout.write(
          `ccmem: daemon alive pid=${result.daemon.pid} host=${result.daemon.hostname} heartbeat_ms=${result.daemon.heartbeat_age_ms} startup_schema=${result.daemon.startup_schema_version ?? 'unknown'} uptime_sec=${result.daemon.uptime_sec ?? 'unknown'}\n`
        );
      } else {
        process.stdout.write('ccmem: daemon unavailable\n');
      }

      process.stdout.write(`ccmem: project_key ${result.project_key.value} source=${result.project_key.source}\n`);
      process.stdout.write(`ccmem: tier2 ${result.tier2.available ? 'available' : 'unavailable'}\n`);

      if (result.migrations) {
        for (const row of result.migrations) {
          process.stdout.write(
            `migration ${row.from_version}->${row.to_version} by=${row.applied_by} desc=${row.description}\n`
          );
        }
      }
    }
  } else if (verb === 'stats') {
    const result = await cmdStats(getDb(), {
      buckets: args.includes('--buckets')
    });

    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write('Tier 1   : ok injecting / retrieving (always on)\n');
      process.stdout.write(`Tier 1.5 : ok opportunistic maintenance ${result.tier15.ran ? 'ran now' : 'already up to date'}\n`);

      if (result.tier2.alive) {
        process.stdout.write(
          `Tier 2   : ok daemon alive pid=${result.tier2.pid} host=${result.tier2.hostname} heartbeat_ms=${result.tier2.heartbeat_age_ms}\n`
        );
      } else {
        process.stdout.write(
          `Tier 2   : warn daemon not running pending summarize=${result.tier2.pending.summarize_pending} synthesis=${result.tier2.pending.weekly_synthesis} security_audit=${result.tier2.pending.security_audit} vec_backfill=${result.tier2.pending.vec_backfill}\n`
        );
      }

      process.stdout.write(
        `Semantic : ${result.semantic.status} | loaded=${result.semantic.loaded} | embedded=${result.semantic.embedded} | pending=${result.semantic.pending} | model=${result.semantic.model} | dim=${result.semantic.dim}\n`
      );
      process.stdout.write(
        `Memories : ${result.memories.active} active / ${result.memories.probation} probation / ${result.memories.quarantined} quarantine / ${result.memories.archived} archived\n`
      );
      process.stdout.write(`Trust    : avg ${result.trust.avg.toFixed(2)} | grey-zone ${result.trust.grey_zone}\n`);
      if (result.security.quarantined > 0 || result.security.alerts_pending > 0) {
        process.stdout.write(
          `Security : ${result.security.quarantined} quarantined (${result.security.pending_sunset} pending sunset) | ${result.security.alerts_pending} cross-scope alerts pending\n`
        );
      }
      if (result.security.contradictions_pending > 0) {
        process.stdout.write(
          `Contradict: ${result.security.contradictions_pending} contradictions pending — run /ccmem:resurrect --contradictions\n`
        );
      }
      if (result.injection.active_count > 0 && (result.injection.never_injected_30d / result.injection.active_count) > result.injection.alert_ratio) {
        process.stdout.write(
          `Injection: ${result.injection.never_injected_30d} memories never injected in 30d (${Math.round((result.injection.never_injected_30d / result.injection.active_count) * 100)}%) — run /ccmem:admin diagnose --injections\n`
        );
      }
      if (result.promote.pending > 0) {
        process.stdout.write(
          `Promote  : ${result.promote.pending} cross-project patterns detected — run /ccmem:resurrect --promote-candidates\n`
        );
      }
      process.stdout.write(
        `Feedback : helpful ${result.feedback.helpful} / unhelpful ${result.feedback.unhelpful} / unknown ${result.feedback.unknown} (last 14d)\n`
      );
      if (result.synthesis.consolidated_active > 0) {
        process.stdout.write(
          `Synthesis: ${result.synthesis.consolidated_active} consolidated active (${result.synthesis.acceptance_rate}% acceptance rate, last 30d)\n`
        );
      }
      if (!result.tuning.insufficient && result.tuning.suggestion_count > 0) {
        process.stdout.write(
          `Tuning  : ${result.tuning.suggestion_count} suggestions available — run /ccmem:admin diagnose --tuning\n`
        );
      }
    }
  } else if (verb === 'promote') {
    const readLine = createStdinLineReader();
    const id = args.find((arg) => !arg.startsWith('--')) ?? null;
    const global = args.includes('--global');
    const result = await cmdPromote(getDb(), {
      id,
      global,
      confirm: (mem) => {
        if (global) {
          process.stdout.write(
            `Promote to GLOBAL (visible in every project):\n  "${mem.content}"\nType PROMOTE GLOBAL to confirm: `
          );
        } else {
          process.stdout.write(`Promote episode→rule (project):\n  "${mem.content}"\nType PROMOTE to confirm: `);
        }

        return readLine();
      }
    });

    if (result.status === 'not_found') {
      process.stderr.write('ccmem: memory not found\n');
      process.exitCode = 2;
    } else if (result.status === 'blocked') {
      process.stderr.write('ccmem: BLOCKED — cannot promote dangerous/secret memory to global\n');
      process.exitCode = 78;
    } else if (result.status === 'unsupported') {
      process.stderr.write(`ccmem: ${result.reason}\n`);
      process.exitCode = 64;
    } else if (result.status === 'cancelled') {
      process.stdout.write('ccmem: cancelled\n');
    } else {
      process.stdout.write(`ccmem: promoted memory #m${result.id}\n`);
    }
  } else if (verb === 'resurrect') {
    const readLine = createStdinLineReader();
    const result = await cmdResurrect(getDb(), {
      cwd: process.cwd(),
      bottom: getOptionValue('--bottom') ?? 10,
      tag: getOptionValue('--tag'),
      limit: getOptionValue('--limit'),
      quarantined: args.includes('--quarantined'),
      alerts: args.includes('--alerts'),
      revalidation: args.includes('--revalidation'),
      contradictions: args.includes('--contradictions'),
      promoteCandidates: args.includes('--promote-candidates'),
      all: args.includes('--all'),
      merge: async (_row, outcome) => {
        process.stdout.write('  merging via LLM...\n');
        if (!outcome?.merge_possible) {
          if (outcome?.error) {
            process.stderr.write(`ccmem: merge failed (${outcome.error}) — try a/b/B instead\n`);
          } else {
            process.stdout.write(`  LLM says merge not possible: ${outcome?.reason ?? 'unknown'}\n`);
            process.stdout.write('  Falling back to a/b/B/s menu.\n');
          }
          return { action: 'skip' };
        }
        process.stdout.write(`  Merged: "${outcome.merged_content}"\n`);
        process.stdout.write('  Accept? [y/N]: ');
        const confirm = readLine().trim().toLowerCase();
        if (confirm !== 'y') {
          process.stdout.write('  cancelled — alert not acknowledged\n');
          return { action: 'skip' };
        }
        return { action: 'merged' };
      },
      decide: (row) => {
        if (args.includes('--alerts')) {
          process.stdout.write(
            `[alert#${row.id}] similarity=${Number(row.similarity ?? 0).toFixed(2)} detected ${formatAgeDays(row.detected_at)}\n` +
            `  GLOBAL  [m${row.global_mem_id}] ${row.global_type} trust=${Number(row.global_trust_score ?? 0).toFixed(2)} ${row.global_content ?? ''}\n` +
            `  PROJECT [m${row.project_mem_id}] ${row.project_type} trust=${Number(row.project_trust_score ?? 0).toFixed(2)} (${row.project_key}) ${row.project_content ?? ''}\n` +
            `  evidence: ${row.evidence ?? ''}\n` +
            '  [G]keep-global / [P]keep-project / [B]keep-both / [X]forget-both / [s]kip: '
          );
          return readLine();
        }

        if (args.includes('--revalidation')) {
          process.stdout.write(
            `[m${row.id}] ${row.type}|${row.scope} trust=${Number(row.trust_score ?? 0).toFixed(2)}${Number(row.pinned ?? 0) === 1 ? ' ★pinned' : ''}\n` +
            `  flagged ${formatAgeDays(row.flag_ts)} — ${row.trigger_pattern ?? 'unknown pattern'}\n` +
            `  flag reason: ${row.flag_reason ?? 'unknown'}\n` +
            `  content: ${row.content}\n` +
            '  [k]eep / [f]orget / [q]uarantine / [s]kip: '
          );
          return readLine();
        }

        if (args.includes('--contradictions')) {
          const reason = (() => {
            try {
              return JSON.parse(row.evidence ?? '{}')?.llm_reason ?? '';
            } catch {
              return '';
            }
          })();
          process.stdout.write(
            `[alert#${row.id}] cosine=${Number(row.cosine_similarity ?? 0).toFixed(2)} detected ${formatAgeDays(row.detected_at)}\n` +
            `  A [m${row.mem_id_a}] ${row.type_a} trust=${Number(row.trust_a ?? 0).toFixed(2)}\n` +
            `    ${row.content_a ?? ''}\n` +
            `  B [m${row.mem_id_b}] ${row.type_b} trust=${Number(row.trust_b ?? 0).toFixed(2)}\n` +
            `    ${row.content_b ?? ''}\n` +
            `${reason ? `  reason: ${reason}\n` : ''}` +
            '  [a]keep-A / [b]keep-B / [B]keep-both / [m]merge / [s]kip: '
          );
          return readLine();
        }

        if (args.includes('--quarantined')) {
          process.stdout.write(
            `[m${row.id}] ${row.type}|${row.scope} trust=${Number(row.trust_score ?? 0).toFixed(2)} quarantined ${formatAgeDays(row.quarantined_at)}\n` +
            `  reason: ${row.reason ?? 'unknown'}\n` +
            `  ${row.content}\n` +
            '  [k]eep / [f]orget / [s]kip: '
          );
          return readLine();
        }

        if (args.includes('--promote-candidates')) {
          process.stdout.write(
            `[candidate#${row.candidate_id}] detected ${formatAgeDays(row.detected_at)}\n` +
            `  [m${row.mem_id}] ${row.type}|project:${row.project_key} trust=${Number(row.trust_score ?? 0).toFixed(2)}\n` +
            `    ${String(row.content ?? '').slice(0, 100)}\n` +
            `  Similar in ${Array.isArray(row.similar) ? row.similar.length : 0} other project(s):\n`
          );
          for (const similar of (row.similar ?? []).slice(0, 5)) {
            process.stdout.write(
              `    project:${similar.project_key} [m${similar.mem_id}] cosine=${Number(similar.cosine ?? 0).toFixed(3)}\n`
            );
          }
          process.stdout.write('  [p]romote to global / [d]ismiss / [s]kip: ');
          return readLine();
        }

        process.stdout.write(
          `[m${row.id}] ${row.type}|${row.scope} trust=${row.trust_score.toFixed(2)}\n  ${row.content}\n  [k]eep / [f]orget / [s]kip: `
        );
        return readLine();
      }
    });

    if (!result.items.length) {
      if (result.mode === 'quarantined') {
        process.stdout.write('ccmem: no quarantined memories\n');
      } else if (result.mode === 'alerts') {
        process.stdout.write('ccmem: no pending cross-scope alerts\n');
      } else if (result.mode === 'revalidation') {
        process.stdout.write('ccmem: no revalidation flags pending\n');
      } else if (result.mode === 'contradictions') {
        process.stdout.write('ccmem: no contradictions detected\n');
      } else if (result.mode === 'promote_candidates') {
        process.stdout.write('ccmem: no cross-project patterns detected\n');
      } else {
        process.stdout.write('ccmem: no grey-zone memories\n');
      }
    } else if (result.mode === 'alerts') {
      const counts = result.items.reduce((acc, item) => {
        acc[item.action] = (acc[item.action] ?? 0) + 1;
        return acc;
      }, {});
      process.stdout.write(
        `ccmem: alerts keep_global=${counts.keep_global ?? 0} keep_project=${counts.keep_project ?? 0} keep_both=${counts.keep_both ?? 0} forget_both=${counts.forget_both ?? 0} skipped=${counts.skip ?? 0}\n`
      );
    } else if (result.mode === 'revalidation') {
      const counts = result.items.reduce((acc, item) => {
        acc[item.action] = (acc[item.action] ?? 0) + 1;
        return acc;
      }, {});
      process.stdout.write(
        `ccmem: revalidation keep=${counts.keep ?? 0} forget=${counts.forget ?? 0} quarantine=${counts.quarantine ?? 0} skipped=${counts.skip ?? 0}\n`
      );
    } else if (result.mode === 'contradictions') {
      const counts = result.items.reduce((acc, item) => {
        acc[item.action] = (acc[item.action] ?? 0) + 1;
        return acc;
      }, {});
      process.stdout.write(
        `ccmem: contradictions keep_a=${counts.keep_a ?? 0} keep_b=${counts.keep_b ?? 0} keep_both=${counts.keep_both ?? 0} merged=${counts.merged ?? 0} skipped=${counts.skip ?? 0}\n`
      );
    } else if (result.mode === 'promote_candidates') {
      const counts = result.items.reduce((acc, item) => {
        acc[item.action] = (acc[item.action] ?? 0) + 1;
        return acc;
      }, {});
      process.stdout.write(
        `ccmem: promote_candidates promote=${counts.promote ?? 0} dismiss=${counts.dismiss ?? 0} blocked=${counts.blocked ?? 0} skipped=${counts.skip ?? 0}\n`
      );
    } else {
      const kept = result.items.filter((item) => item.action === 'keep').length;
      const forgotten = result.items.filter((item) => item.action === 'forget').length;
      const skipped = result.items.filter((item) => item.action === 'skip').length;
      process.stdout.write(`ccmem: resurrected ${kept}, archived ${forgotten}, skipped ${skipped}\n`);
    }
  }
} finally {
  closeDb();
}
