import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { vecToBlob } from '../embedding/cosine.mjs';
import { getProvider } from '../embedding/provider.mjs';
import { rebuildInjectionCache } from '../injection-cache.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { evaluateTier1, evaluateTier2, evaluateTier3 } from '../threat-scan.mjs';
import { maybeRunTier15 } from '../tier15.mjs';
import { getSourceInitialTrust } from '../trust.mjs';
import { inferType } from '../type-heuristic.mjs';

function uniqueTags(tags) {
  return [...new Set((tags ?? []).map((tag) => String(tag)))];
}

async function buildEmbedding(content, cfg) {
  const provider = getProvider(cfg);
  if (!provider) {
    return null;
  }

  try {
    await provider.load(cfg);
    const [vec] = await provider.embed([content], cfg);
    return vec ? vecToBlob(vec) : null;
  } catch {
    return null;
  }
}

export async function insertMemory(db, {
  cwd,
  content,
  scope = 'project',
  type = null,
  source = 'user_explicit',
  projectKey = null,
  pinned = 0,
  tags = [],
  embedSync = true,
  trust = null,
  consolidationDepth = null,
  parentIds = null,
  lastTouchedAt = null,
  status = 'active',
  decayStatus = null,
  quarantinedAt = null,
  embeddingBlob = undefined,
  summaryMeta = null,
  temporalType = null
}) {
  const cfg = loadConfig();
  const maxChars = Number(cfg.save?.max_chars_per_memory ?? 500);
  if (typeof content === 'string' && Number.isFinite(maxChars) && content.length > maxChars) {
    throw new Error(`Content > ${maxChars} chars`);
  }

  const gate = evaluateTier1(content);
  if (!gate.ok) {
    throw Object.assign(new Error(`ccmem: rejected save (${gate.reason})`), { exitCode: 64 });
  }

  let resolvedType = type ?? inferType(content).type;
  let resolvedScope = scope === 'global' ? 'global' : 'project';
  let resolvedProjectKey = resolvedScope === 'global' ? null : (projectKey ?? resolveProjectKey(cwd));
  let trustScore = trust ?? getSourceInitialTrust(source);
  let resolvedDecayStatus = decayStatus ?? 'active';
  let resolvedQuarantinedAt = quarantinedAt ?? null;
  let resolvedTags = uniqueTags(tags);
  const t2 = evaluateTier2(content, source, resolvedType);
  const t3 = cfg.security.tier3.enabled ? evaluateTier3(t2, source) : { action: 'allow' };

  if (t3.action === 'force_demote') {
    resolvedType = 'episode';
    resolvedScope = 'project';
    resolvedProjectKey = projectKey ?? resolveProjectKey(cwd);
    trustScore = Math.min(Number(trustScore ?? 0.6), 0.6);
    resolvedTags = uniqueTags([...resolvedTags, 'dangerous_command']);
  }

  if (t3.action === 'quarantine') {
    resolvedDecayStatus = 'quarantine';
    resolvedQuarantinedAt = Date.now();
    trustScore = Math.min(Number(trustScore ?? 0.3), 0.3);
    resolvedTags = uniqueTags([...resolvedTags, 'quarantine_at_write']);
  }

  const embedding = embeddingBlob !== undefined
    ? embeddingBlob
    : (resolvedDecayStatus === 'quarantine' || !embedSync ? null : await buildEmbedding(content, cfg));
  const now = Date.now();
  const touchedAt = Number.isFinite(Number(lastTouchedAt)) ? Number(lastTouchedAt) : now;
  const resolvedDepth = Number.isFinite(Number(consolidationDepth)) ? Number(consolidationDepth) : 0;
  const resolvedParentIds = Array.isArray(parentIds) && parentIds.length ? JSON.stringify(parentIds.map((id) => Number(id))) : null;
  const resolvedSummaryMeta = typeof summaryMeta === 'string' && summaryMeta.trim() ? summaryMeta : null;
  const resolvedTemporalType = ['permanent', 'temporary', 'time-bound'].includes(temporalType) ? temporalType : null;
  const result = db.prepare(
    `INSERT INTO memories (
      scope,
      project_key,
      type,
      content,
      temporal_type,
      summary_meta,
      embedding,
      pinned,
      source,
      trust_score,
      consolidation_depth,
      parent_ids,
      status,
      tags,
      decay_status,
      quarantined_at,
      last_touched_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    resolvedScope,
    resolvedProjectKey,
    resolvedType,
    content,
    resolvedTemporalType,
    resolvedSummaryMeta,
    embedding,
    Number(pinned) ? 1 : 0,
    source,
    trustScore,
    resolvedDepth,
    resolvedParentIds,
    status,
    JSON.stringify(resolvedTags),
    resolvedDecayStatus,
    resolvedQuarantinedAt,
    touchedAt,
    now,
    now
  );

  const id = Number(result.lastInsertRowid);
  rebuildInjectionCache(db, resolvedScope === 'global' ? null : resolvedProjectKey);

  if (resolvedDecayStatus === 'quarantine') {
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
    project_key: resolvedProjectKey,
    type: resolvedType,
    decay_status: resolvedDecayStatus,
    embedded: embedding != null,
    source,
    consolidation_depth: resolvedDepth,
    parent_ids: resolvedParentIds
  };
}

export async function cmdSave(db, { cwd, content, scope = 'project', type = null }) {
  try {
    maybeRunTier15(db);
  } catch {}

  return insertMemory(db, {
    cwd,
    content,
    scope,
    type,
    source: 'user_explicit',
    embedSync: true
  });
}
