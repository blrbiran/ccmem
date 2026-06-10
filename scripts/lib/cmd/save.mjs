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
  return [...new Set(tags.map((tag) => String(tag)))];
}

async function buildEmbedding(content, cfg) {
  const provider = getProvider(cfg);
  if (!provider) {
    return null;
  }

  try {
    await provider.load();
    const [vec] = await provider.embed([content]);
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
  embedSync = true
}) {
  const gate = evaluateTier1(content);
  if (!gate.ok) {
    throw Object.assign(new Error(`ccmem: rejected save (${gate.reason})`), { exitCode: 64 });
  }

  const cfg = loadConfig();
  let resolvedType = type ?? inferType(content).type;
  let resolvedScope = scope === 'global' ? 'global' : 'project';
  let resolvedProjectKey = resolvedScope === 'global' ? null : (projectKey ?? resolveProjectKey(cwd));
  let trustScore = getSourceInitialTrust(source);
  let decayStatus = 'active';
  let quarantinedAt = null;
  let resolvedTags = uniqueTags(tags);
  const t2 = evaluateTier2(content, source, resolvedType);
  const t3 = cfg.security.tier3.enabled ? evaluateTier3(t2, source) : { action: 'allow' };

  if (t3.action === 'force_demote') {
    resolvedType = 'episode';
    resolvedScope = 'project';
    resolvedProjectKey = projectKey ?? resolveProjectKey(cwd);
    trustScore = Math.min(trustScore, 0.6);
    resolvedTags = uniqueTags([...resolvedTags, 'dangerous_command']);
  }

  if (t3.action === 'quarantine') {
    decayStatus = 'quarantine';
    quarantinedAt = Date.now();
    trustScore = Math.min(trustScore, 0.3);
    resolvedTags = uniqueTags([...resolvedTags, 'quarantine_at_write']);
  }

  const embedding = decayStatus === 'quarantine' || !embedSync ? null : await buildEmbedding(content, cfg);
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO memories (
      scope,
      project_key,
      type,
      content,
      embedding,
      pinned,
      source,
      trust_score,
      tags,
      decay_status,
      quarantined_at,
      last_touched_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    resolvedScope,
    resolvedProjectKey,
    resolvedType,
    content,
    embedding,
    Number(pinned) ? 1 : 0,
    source,
    trustScore,
    JSON.stringify(resolvedTags),
    decayStatus,
    quarantinedAt,
    now,
    now,
    now
  );

  const id = Number(result.lastInsertRowid);
  rebuildInjectionCache(db, resolvedProjectKey);

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
    project_key: resolvedProjectKey,
    type: resolvedType,
    decay_status: decayStatus,
    embedded: embedding != null,
    source
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
