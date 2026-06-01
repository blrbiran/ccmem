import { openDb } from './lib/db.mjs';
import { cmdAuditShow } from './lib/cmd/audit.mjs';
import { cmdList } from './lib/cmd/list.mjs';
import { cmdMode } from './lib/cmd/mode.mjs';
import { cmdSave } from './lib/cmd/save.mjs';

const db = openDb();
const [verb, ...args] = process.argv.slice(2);

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
  }
} finally {
  db.close();
}
