import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function logAudit(db, action, details = null) {
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, NULL, ?)`
  ).run(Date.now(), action, details ? JSON.stringify(details) : null);
}

function weekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function runWeeklySynthesis(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  const items = typeof payload.llm_output === 'string' ? parseLlmJson(payload.llm_output) : [];

  logAudit(db, 'weekly_synthesis_stub', {
    task_id: task.id,
    item_count: items.length,
    first_output_type: items[0]?.output_type ?? null
  });

  markLeaseComplete(db, 'weekly_synthesis', weekKey(new Date()));
}
