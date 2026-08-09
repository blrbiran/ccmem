import { writeAudit } from './audit.mjs';
import { loadConfig } from './config.mjs';
import { rebuildInjectionCache } from './injection-cache.mjs';
import { evaluateTier2, secretScan, tier1Scan } from './threat-scan.mjs';

function maybeWriteAudit(db, suppressAudit, action, memId, details) {
  if (!suppressAudit) {
    writeAudit(db, action, memId, details);
  }
}

function writeSkipAudit(db, trigger, skipped, patternVersion, startedAt, suppressAudit) {
  maybeWriteAudit(db, suppressAudit, 'revalidation_audit_run', null, {
    trigger,
    skipped,
    scanned: 0,
    quarantined: 0,
    flagged: 0,
    duration_ms: Date.now() - startedAt,
    pattern_version: patternVersion,
    fast_skip: false
  });
}

export function revalidationAuditCore(db, { trigger, suppressAudit = false } = {}) {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const scanVersion = cfg.security?.scan_patterns_version ?? 'unknown';
  const revalidationCfg = cfg.security?.revalidation ?? {};

  if (trigger === 'lazy' && revalidationCfg.lazy_enabled === false) {
    writeSkipAudit(db, 'lazy', 'lazy_disabled', scanVersion, startedAt, suppressAudit);
    return { skipped: 'lazy_disabled', scanned: 0, quarantined: 0, flagged: 0 };
  }

  if (trigger === 'daily' && revalidationCfg.daily_enabled === false) {
    writeSkipAudit(db, 'daily', 'daily_disabled', scanVersion, startedAt, suppressAudit);
    return { skipped: 'daily_disabled', scanned: 0, quarantined: 0, flagged: 0 };
  }

  const pending = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE (last_scanned_patterns_version IS NULL OR last_scanned_patterns_version != ?)
       AND decay_status IN ('active', 'probation')`
  ).get(scanVersion);

  if (Number(pending?.n ?? 0) === 0) {
    maybeWriteAudit(db, suppressAudit, 'revalidation_audit_run', null, {
      trigger,
      scanned: 0,
      quarantined: 0,
      flagged: 0,
      duration_ms: Date.now() - startedAt,
      pattern_version: scanVersion,
      fast_skip: true
    });
    return { scanned: 0, quarantined: 0, flagged: 0, fast_skip: true };
  }

  const batchSize = Number(revalidationCfg.batch_size ?? 100);
  const flagTrustThreshold = Number(revalidationCfg.flag_trust_threshold ?? 0.6);
  const candidates = db.prepare(
    `SELECT id, scope, project_key, type, source, content, trust_score, pinned, decay_status, last_touched_at
     FROM memories
     WHERE (last_scanned_patterns_version IS NULL OR last_scanned_patterns_version != ?)
       AND decay_status IN ('active', 'probation')
     ORDER BY trust_score ASC, last_touched_at DESC, id ASC
     LIMIT ?`
  ).all(scanVersion, batchSize);

  const stampStmt = db.prepare(
    `UPDATE memories
     SET last_scanned_patterns_version = ?, updated_at = ?
     WHERE id = ?`
  );
  const quarantineStmt = db.prepare(
    `UPDATE memories
     SET decay_status = 'quarantine', quarantined_at = ?, updated_at = ?
     WHERE id = ? AND decay_status != 'quarantine'`
  );

  const touchedProjects = new Set();
  let touchedGlobal = false;
  let quarantined = 0;
  let flagged = 0;

  // IMMEDIATE 与这里的 deferred 等价（事务内第一条语句就是写），显式写出来是为了不必再推一遍。
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const memory of candidates) {
      const now = Date.now();
      const tier1 = tier1Scan(memory.content);
      const secrets = memory.scope === 'global' ? secretScan(memory.content) : [];
      const tier2 = evaluateTier2(memory.content, memory.source, memory.type);
      const tier1Hit = tier1.matched;
      const secretHit = secrets.length > 0;
      const tier2Hit = tier2.action === 'force_demote';

      if (tier1Hit || secretHit || tier2Hit) {
        const triggerPattern = tier1Hit
          ? tier1.pattern
          : secretHit
            ? `secret:${secrets[0]}`
            : `tier2:${tier2.evidence?.[0] ?? 'unknown'}`;
        const shouldQuarantine = Number(memory.trust_score ?? 0) < flagTrustThreshold && Number(memory.pinned ?? 0) === 0;

        if (shouldQuarantine) {
          const updated = quarantineStmt.run(now, now, memory.id);
          if (updated.changes > 0) {
            maybeWriteAudit(db, suppressAudit, 'revalidation_quarantine_in', memory.id, {
              trigger_pattern: triggerPattern,
              prev_trust: Number(memory.trust_score ?? 0),
              prev_decay_status: memory.decay_status,
              pattern_version: scanVersion
            });
            if (memory.scope === 'global') {
              touchedGlobal = true;
            } else if (memory.project_key) {
              touchedProjects.add(memory.project_key);
            }
            quarantined += 1;
          }
        } else {
          maybeWriteAudit(db, suppressAudit, 'revalidation_flagged', memory.id, {
            trigger_pattern: triggerPattern,
            reason: Number(memory.pinned ?? 0) === 1 ? 'pinned' : 'high_trust',
            prev_trust: Number(memory.trust_score ?? 0),
            pattern_version: scanVersion
          });
          flagged += 1;
        }
      }

      stampStmt.run(scanVersion, now, memory.id);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (touchedGlobal) {
    rebuildInjectionCache(db, null);
  }
  for (const projectKey of touchedProjects) {
    rebuildInjectionCache(db, projectKey);
  }

  maybeWriteAudit(db, suppressAudit, 'revalidation_audit_run', null, {
    trigger,
    scanned: candidates.length,
    quarantined,
    flagged,
    duration_ms: Date.now() - startedAt,
    pattern_version: scanVersion,
    fast_skip: false
  });

  return {
    scanned: candidates.length,
    quarantined,
    flagged,
    fast_skip: false
  };
}
