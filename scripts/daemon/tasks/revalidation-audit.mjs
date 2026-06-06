import { writeAudit } from '../../lib/audit.mjs';
import { revalidationAuditCore } from '../../lib/revalidation.mjs';

export function runRevalidationAudit(db, _task) {
  try {
    return revalidationAuditCore(db, { trigger: 'manual' });
  } catch (error) {
    writeAudit(db, 'revalidation_manual_error', null, {
      error: String(error?.message ?? error).slice(0, 200)
    });
    throw error;
  }
}
