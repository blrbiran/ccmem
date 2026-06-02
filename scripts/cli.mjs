import { cmdAdminCron } from './lib/admin/cron.mjs';
import { cmdAdminDaemon } from './lib/admin/daemon.mjs';
import { cmdAdminDiagnose } from './lib/admin/diagnose.mjs';
import { openDb } from './lib/db.mjs';
import { cmdAuditShow } from './lib/cmd/audit.mjs';
import { cmdList } from './lib/cmd/list.mjs';
import { cmdMode } from './lib/cmd/mode.mjs';
import { cmdSave } from './lib/cmd/save.mjs';
import { cmdStats } from './lib/cmd/stats.mjs';

const db = openDb();
const [verb, ...rawArgs] = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

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
  } else if (verb === 'admin' && args[0] === 'daemon' && args[1] === 'status') {
    const result = await cmdAdminDaemon(db, { verb: 'status' });

    if (!result.alive) {
      process.stdout.write('ccmem: daemon not running\n');
    } else {
      const running = result.running_task ? `${result.running_task.type}#${result.running_task.id}` : 'none';
      process.stdout.write(
        `ccmem: daemon alive pid=${result.pid} host=${result.hostname} heartbeat_ms=${result.heartbeat_age_ms} running=${running}\n`
      );
    }
  } else if (verb === 'admin' && args[0] === 'cron' && args[1] === 'list') {
    const historyIdx = args.indexOf('--history');
    const taskIdx = args.indexOf('--task');

    if (historyIdx >= 0 && taskIdx >= 0 && args[taskIdx + 1]) {
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
    process.stdout.write(`ccmem: enqueued ${result.type} as task#${result.task_id}\n`);
  } else if (verb === 'admin' && args[0] === 'diagnose') {
    const result = await cmdAdminDiagnose(db, {
      cwd: process.cwd(),
      migrations: args.includes('--migrations'),
      key: args.includes('--key')
    });

    if (args.includes('--key')) {
      process.stdout.write(`ccmem: project_key ${result.project_key.value} source=${result.project_key.source}\n`);
      process.stdout.write(`ccmem: cwd ${result.project_key.cwd}\n`);
      process.stdout.write(`ccmem: fallback ${result.project_key.fallback_value}\n`);
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
  }
} finally {
  db.close();
}
