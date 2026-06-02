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

try {
  if (verb === 'save') {
    const content = args.filter((arg) => !arg.startsWith('--')).join(' ');
    const scope = args.includes('--global') ? 'global' : 'project';
    const result = await cmdSave(db, { cwd: process.cwd(), content, scope });
    process.stdout.write(`ccmem: saved memory #${result.id} (${result.scope} ${result.type})\n`);
  } else if (verb === 'list') {
    const rows = await cmdList(db, {});
    for (const row of rows) {
      process.stdout.write(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}\n`);
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
      const result = await cmdAdminCron(db, {
        verb: 'list',
        taskType: args[taskIdx + 1],
        history: args[historyIdx + 1] ?? '10'
      });
      process.stdout.write(`ccmem: cron history ${result.type}\n`);

      for (const row of result.history) {
        process.stdout.write(`${row.status}@${row.date_key} by=${row.ran_by}\n`);
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
    const result = await cmdAdminCron(db, { verb: 'run', taskType: args[2] });
    if (result.status === 'skipped') {
      process.stdout.write(`ccmem: skipped ${result.type} (${result.reason})\n`);
    } else {
      process.stdout.write(`ccmem: enqueued ${result.type} as task#${result.task_id}\n`);
    }
  } else if (verb === 'admin' && args[0] === 'diagnose') {
    const result = await cmdAdminDiagnose(db, {
      cwd: process.cwd(),
      migrations: args.includes('--migrations'),
      key: args.includes('--key'),
      sessions: args.includes('--sessions')
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
          `Tier 2   : warn daemon not running pending summarize=${result.tier2.pending.summarize_pending} synthesis=${result.tier2.pending.weekly_synthesis}\n`
        );
      }

      process.stdout.write(
        `Memories : ${result.memories.active} active / ${result.memories.probation} probation / ${result.memories.archived} archived\n`
      );
      process.stdout.write(`Trust    : avg ${result.trust.avg.toFixed(2)} | grey-zone ${result.trust.grey_zone}\n`);
      process.stdout.write(
        `Feedback : helpful ${result.feedback.helpful} / unhelpful ${result.feedback.unhelpful} / unknown ${result.feedback.unknown} (last 14d)\n`
      );
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
      bottom: getOptionValue('--bottom') ?? 10,
      tag: getOptionValue('--tag'),
      decide: (row) => {
        process.stdout.write(
          `[m${row.id}] ${row.type}|${row.scope} trust=${row.trust_score.toFixed(2)}\n  ${row.content}\n  [k]eep / [f]orget / [s]kip: `
        );
        return readLine();
      }
    });

    if (!result.items.length) {
      process.stdout.write('ccmem: no grey-zone memories\n');
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
