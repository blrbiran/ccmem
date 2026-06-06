import { cmdAdminCron } from './lib/admin/cron.mjs';
import { cmdAdminDaemon } from './lib/admin/daemon.mjs';
import { cmdAdminDiagnose } from './lib/admin/diagnose.mjs';
import { openDb } from './lib/db.mjs';
import { readFileSync } from 'node:fs';
import { cmdAuditShow } from './lib/cmd/audit.mjs';
import { cmdList } from './lib/cmd/list.mjs';
import { cmdMode } from './lib/cmd/mode.mjs';
import { cmdPromote } from './lib/cmd/promote.mjs';
import { cmdResurrect } from './lib/cmd/resurrect.mjs';
import { cmdSave } from './lib/cmd/save.mjs';
import { cmdStats } from './lib/cmd/stats.mjs';

const db = openDb();
const [verb, ...rawArgs] = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

function getOptionValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] ?? null : null;
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

  process.stdout.write(`\n  Memory pool (end of ${metrics.memory_pool.day_key})\n`);
  process.stdout.write(
    `    active: ${metrics.memory_pool.active}  probation: ${metrics.memory_pool.probation}  quarantine: ${metrics.memory_pool.quarantine}  archived: ${metrics.memory_pool.archived}\n`
  );
}

try {
  if (verb === 'save') {
    const content = args.filter((arg) => !arg.startsWith('--')).join(' ');
    const scope = args.includes('--global') ? 'global' : 'project';
    const result = await cmdSave(db, { cwd: process.cwd(), content, scope });
    process.stdout.write(`ccmem: saved memory #${result.id} (${result.scope} ${result.type})\n`);
  } else if (verb === 'list') {
    const rows = await cmdList(db, {
      limit: Number(getOptionValue('--limit') ?? 20),
      quarantined: args.includes('--quarantined')
    });

    if (!rows.length) {
      process.stdout.write(args.includes('--quarantined') ? 'ccmem: no quarantined memories\n' : 'ccmem: no memories\n');
    } else if (args.includes('--quarantined')) {
      for (const row of rows) {
        process.stdout.write(
          `[m${row.id}] ${row.type} | ${row.scope} | ${row.source} trust=${Number(row.trust_score ?? 0).toFixed(2)} quarantined=${formatAgeDays(row.quarantined_at)} reason=${row.reason ?? 'unknown'}\n`
        );
      }
    } else {
      for (const row of rows) {
        process.stdout.write(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}\n`);
      }
    }
  } else if (verb === 'mode') {
    const result = await cmdMode(db, { mode: args[0] ?? null });
    process.stdout.write(`ccmem: mode=${result.mode}\n`);
  } else if (verb === 'audit' && args[0] === 'show' && args[1]) {
    const row = await cmdAuditShow(db, { id: Number(args[1]) });
    process.stdout.write(`${JSON.stringify(row)}\n`);
  } else if (verb === 'admin' && args[0] === 'daemon' && args[1]) {
    const daemonVerb = args[1];
    const result = await cmdAdminDaemon(db, { verb: daemonVerb });

    if (daemonVerb === 'status') {
      if (!result.alive) {
        process.stdout.write('ccmem: daemon not running\n');
      } else {
        const running = result.running_task ? `${result.running_task.type}#${result.running_task.id}` : 'none';
        process.stdout.write(
          `ccmem: daemon alive pid=${result.pid} host=${result.hostname} heartbeat_ms=${result.heartbeat_age_ms} running=${running}\n`
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
      process.stdout.write(`ccmem: daemon installed ${result.plist_path}\n`);
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

    if (args.includes('--issues')) {
      const result = await cmdAdminCron(db, { verb: 'list', issues: true });

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
        const result = await cmdAdminCron(db, {
          verb: 'list',
          taskType: args[taskIdx + 1],
          history: args[historyIdx + 1] ?? '10'
        });
        process.stdout.write(`ccmem: cron history ${result.type}\n`);

        for (const row of result.history) {
          process.stdout.write(`${row.status}@${row.date_key} by=${row.ran_by}\n`);
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
      const result = await cmdAdminCron(db, { verb: 'list' });
      process.stdout.write(`ccmem: daemon ${result.daemon_alive ? 'alive' : 'not running'}\n`);

      for (const item of result.items) {
        const last = item.last_run ? `${item.last_run.status}@${item.last_run.date_key}` : 'none';
        process.stdout.write(`${item.type} queued=${item.queued} last=${last}\n`);
      }
    }
  } else if (verb === 'admin' && args[0] === 'cron' && args[1] === 'run' && args[2]) {
    try {
      const result = await cmdAdminCron(db, { verb: 'run', taskType: args[2] });
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
  } else if (verb === 'admin' && args[0] === 'diagnose') {
    const result = await cmdAdminDiagnose(db, {
      cwd: process.cwd(),
      migrations: args.includes('--migrations'),
      key: args.includes('--key'),
      sessions: args.includes('--sessions'),
      security: args.includes('--security'),
      tuning: args.includes('--tuning'),
      metrics: args.includes('--metrics'),
      days: Number(getOptionValue('--days') ?? 14)
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
    } else {
      process.stdout.write(`ccmem: db ${result.db.health} schema=${result.db.schema_version} path=${result.db.path}\n`);

      if (result.daemon.alive) {
        process.stdout.write(
          `ccmem: daemon alive pid=${result.daemon.pid} host=${result.daemon.hostname} heartbeat_ms=${result.daemon.heartbeat_age_ms}\n`
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
    const result = await cmdStats(db, {
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
          `Tier 2   : warn daemon not running pending summarize=${result.tier2.pending.summarize_pending} synthesis=${result.tier2.pending.weekly_synthesis} security_audit=${result.tier2.pending.security_audit}\n`
        );
      }

      process.stdout.write(
        `Memories : ${result.memories.active} active / ${result.memories.probation} probation / ${result.memories.quarantined} quarantine / ${result.memories.archived} archived\n`
      );
      process.stdout.write(`Trust    : avg ${result.trust.avg.toFixed(2)} | grey-zone ${result.trust.grey_zone}\n`);
      if (result.security.quarantined > 0 || result.security.alerts_pending > 0) {
        process.stdout.write(
          `Security : ${result.security.quarantined} quarantined (${result.security.pending_sunset} pending sunset) | ${result.security.alerts_pending} cross-scope alerts pending\n`
        );
      }
      process.stdout.write(
        `Feedback : helpful ${result.feedback.helpful} / unhelpful ${result.feedback.unhelpful} / unknown ${result.feedback.unknown} (last 14d)\n`
      );
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
    const result = await cmdPromote(db, {
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
    const result = await cmdResurrect(db, {
      cwd: process.cwd(),
      bottom: getOptionValue('--bottom') ?? 10,
      tag: getOptionValue('--tag'),
      limit: getOptionValue('--limit'),
      quarantined: args.includes('--quarantined'),
      alerts: args.includes('--alerts'),
      revalidation: args.includes('--revalidation'),
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

        if (args.includes('--quarantined')) {
          process.stdout.write(
            `[m${row.id}] ${row.type}|${row.scope} trust=${Number(row.trust_score ?? 0).toFixed(2)} quarantined ${formatAgeDays(row.quarantined_at)}\n` +
            `  reason: ${row.reason ?? 'unknown'}\n` +
            `  ${row.content}\n` +
            '  [k]eep / [f]orget / [s]kip: '
          );
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
    } else {
      const kept = result.items.filter((item) => item.action === 'keep').length;
      const forgotten = result.items.filter((item) => item.action === 'forget').length;
      const skipped = result.items.filter((item) => item.action === 'skip').length;
      process.stdout.write(`ccmem: resurrected ${kept}, archived ${forgotten}, skipped ${skipped}\n`);
    }
  }
} finally {
  db.close();
}
