import { runDailyMaintenance } from './tasks/daily-maintenance.mjs';
import { runRevalidationAudit } from './tasks/revalidation-audit.mjs';
import { runSecurityAudit } from './tasks/security-audit.mjs';
import { runSummarizePending } from './tasks/summarize-pending.mjs';
import { runWeeklySynthesis } from './tasks/weekly-synthesis.mjs';

export async function dispatchTask(db, task) {
  if (task.type === 'summarize_pending') {
    return runSummarizePending(db, task);
  }

  if (task.type === 'daily_maintenance') {
    return runDailyMaintenance(db, task);
  }

  if (task.type === 'revalidation_audit') {
    return runRevalidationAudit(db, task);
  }

  if (task.type === 'weekly_synthesis') {
    return runWeeklySynthesis(db, task);
  }

  if (task.type === 'security_audit') {
    return runSecurityAudit(db, task);
  }

  throw new Error(`unknown task type: ${task.type}`);
}
