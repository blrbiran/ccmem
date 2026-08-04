import { runContradictionAudit } from './tasks/contradiction-audit.mjs';
import { runCrossProjectPatterns } from './tasks/cross-project-patterns.mjs';
import { runDailyMaintenance } from './tasks/daily-maintenance.mjs';
import { runEmbedLatencyProbe } from './tasks/embed-latency-probe.mjs';
import { runMonthlyMetaSynthesis } from './tasks/monthly-meta-synthesis.mjs';
import { runRevalidationAudit } from './tasks/revalidation-audit.mjs';
import { runSecurityAudit } from './tasks/security-audit.mjs';
import { runSummarizePending } from './tasks/summarize-pending.mjs';
import { runVecBackfill } from './tasks/vec-backfill.mjs';
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

  if (task.type === 'contradiction_audit') {
    return runContradictionAudit(db, task);
  }

  if (task.type === 'cross_project_patterns') {
    return runCrossProjectPatterns(db, task);
  }

  if (task.type === 'monthly_meta_synthesis') {
    return runMonthlyMetaSynthesis(db, task);
  }

  if (task.type === 'vec_backfill') {
    return runVecBackfill(db, task);
  }

  if (task.type === 'embed_latency_probe') {
    return runEmbedLatencyProbe(db, task);
  }

  throw new Error(`unknown task type: ${task.type}`);
}
