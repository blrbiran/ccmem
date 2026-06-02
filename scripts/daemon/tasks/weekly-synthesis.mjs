import { callClaudeP } from '../claude-p.mjs';
import { weeklyLeaseKey } from '../loop.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function logAudit(db, action, details = null) {
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, NULL, ?)`
  ).run(Date.now(), action, details ? JSON.stringify(details) : null);
}

function buildWeeklySynthesisPrompt() {
  return [
    'You are a memory synthesis assistant.',
    'Synthesize durable weekly memories as JSON.',
    'Return an array or an object with a synthesized array.'
  ].join('\n');
}

function shouldUseClaudeBridge(payload) {
  return typeof payload.llm_output === 'string' || process.env.CCMEM_ENABLE_REAL_CLAUDE_P === '1';
}

export async function runWeeklySynthesis(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  let raw = null;

  if (shouldUseClaudeBridge(payload)) {
    raw = await callClaudeP(buildWeeklySynthesisPrompt(), {
      taskType: 'weekly_synthesis',
      mockOutput: payload.llm_output
    });
  }

  const items = raw ? parseLlmJson(raw) : [];
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : weeklyLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : Date.now()));

  logAudit(db, 'weekly_synthesis_stub', {
    task_id: task.id,
    item_count: items.length,
    first_output_type: items[0]?.output_type ?? null
  });

  markLeaseComplete(db, 'weekly_synthesis', leaseKey);
}
