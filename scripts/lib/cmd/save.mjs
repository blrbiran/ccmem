import { writeAudit } from '../audit.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { evaluateTier1, evaluateTier2, evaluateTier3 } from '../threat-scan.mjs';
import { maybeRunTier15 } from '../tier15.mjs';
import { getSourceInitialTrust } from '../trust.mjs';
import { inferType } from '../type-heuristic.mjs';
import { loadConfig } from '../config.mjs';

function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => String(tag)))];
}

export async function cmdSave(db, { cwd, content, scope = 'project', type = null }) {
  try {
    maybeRunTier15(db);
  } catch {}

  const gate = evaluateTier1(content);
  if (!gate.ok) {
    throw Object.assign(new Error(`ccmem: rejected save (${gate.reason})`), { exitCode: 64 });
  }

  const cfg = loadConfig();
  const source = 'user_explicit';
  let resolvedType = type ?? inferType(content).type;
  let resolvedScope = scope === 'global' ? 'global' : 'project';
  let projectKey = resolvedScope === 'global' ? null : resolveProjectKey(cwd);
  let trustScore = getSourceInitialTrust(source);
  let decayStatus = 'active';
  let quarantinedAt = null;
  let tags = [];
  const t2 = evaluateTier2(content, source, resolvedType);
  const t3 = cfg.security.tier3.enabled ? evaluateTier3(t2, source) : { action: 'allow' };

  if (t3.action === 'force_demote') {
    resolvedType = 'episode';
    resolvedScope = 'project';
    projectKey = resolveProjectKey(cwd);
    trustScore = Math.min(trustScore, 0.6);
    tags = uniqueTags([...tags, 'dangerous_command']);
  }

  if (t3.action === 'quarantine') {
    decayStatus = 'quarantine';
    quarantinedAt = Date.now();
    trustScore = Math.min(trustScore, 0.3);
    tags = uniqueTags([...tags, 'quarantine_at_write']);
  }

  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO memories (
      scope,
      project_key,
      type,
      content,
      pinned,
      source,
      trust_score,
      tags,
      decay_status,
      quarantined_at,
      last_touched_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    resolvedScope,
    projectKey,
    resolvedType,
    content,
    source,
    trustScore,
    JSON.stringify(tags),
    decayStatus,
    quarantinedAt,
    now,
    now,
    now
  );

  const id = Number(result.lastInsertRowid);
  rebuildInjectionCache(db, projectKey);

  if (decayStatus === 'quarantine') {
    writeAudit(db, 'security_quarantine_in', id, {
      reason: 'tier3_at_write',
      suspicion_score: t2.score,
      evidence: t2.evidence,
      source: 'heuristic',
      pattern_version: cfg.security.scan_patterns_version
    });
  }

  return {
    id,
    scope: resolvedScope,
    type: resolvedType,
    decay_status: decayStatus
  };
}
