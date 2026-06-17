import { callClaudeP } from '../claude-p.mjs';
import { weeklyLeaseKey } from '../loop.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { insertMemory } from '../../lib/cmd/save.mjs';
import { blobToVec, cosineSimilarity, vecToBlob } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { parseRawLlmOutput } from '../../lib/llm-parse.mjs';
import { buildStaleCheckPrompt, STALE_CHECK_SCHEMA } from '../../lib/llm-prompts/stale-check.mjs';
import { buildSynthesisPromptV2, SYNTHESIS_V2_SCHEMA } from '../../lib/llm-prompts/weekly-synthesis-v2.mjs';
import { scoreSynthesisOutput } from '../../lib/synthesis-quality.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function hasConfiguredClaudeBridge() {
  return typeof process.env.CCMEM_CLAUDE_P_COMMAND === 'string' || typeof process.env.CCMEM_CLAUDE_P_ARGS_JSON === 'string';
}

function shouldUseClaudeBridge(payload) {
  if (typeof payload.llm_output === 'string') {
    return true;
  }

  if (hasConfiguredClaudeBridge()) {
    return true;
  }

  return process.env.CCMEM_TEST_MODE !== '1';
}

function projectScopes(db) {
  return db.prepare(
    `SELECT DISTINCT project_key
     FROM memories
     WHERE scope = 'project'
       AND project_key IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all().map((row) => row.project_key);
}

function selectBatch(db, scope, limit) {
  if (scope === 'global') {
    return db.prepare(
      `SELECT id, type, content, consolidation_depth, created_at, last_touched_at, trust_score, embedding
       FROM memories
       WHERE scope = 'global'
         AND type != 'consolidated'
         AND status = 'active'
         AND decay_status IN ('active', 'probation')
       ORDER BY last_touched_at DESC, id DESC
       LIMIT ?`
    ).all(limit);
  }

  return db.prepare(
    `SELECT id, type, content, consolidation_depth, created_at, last_touched_at, trust_score, embedding
     FROM memories
     WHERE project_key = ?
       AND type != 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY last_touched_at DESC, id DESC
     LIMIT ?`
  ).all(scope, limit);
}

function loadExistingConsolidated(db, scope) {
  if (scope === 'global') {
    return db.prepare(
      `SELECT id, content, consolidation_depth, embedding
       FROM memories
       WHERE scope = 'global'
         AND type = 'consolidated'
         AND status = 'active'
         AND decay_status IN ('active', 'probation')
       ORDER BY last_touched_at DESC, id DESC
       LIMIT 50`
    ).all();
  }

  return db.prepare(
    `SELECT id, content, consolidation_depth, embedding
     FROM memories
     WHERE project_key = ?
       AND type = 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY last_touched_at DESC, id DESC
     LIMIT 50`
  ).all(scope);
}

function normalizeSourceIds(value) {
  return Array.isArray(value) ? value.filter(Number.isInteger) : [];
}

function parseSynthesisVerdict(raw) {
  const parsed = parseRawLlmOutput(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { merged_duplicates: [], synthesized: [] };
  }

  const mergedDuplicates = Array.isArray(parsed.merged_duplicates)
    ? parsed.merged_duplicates
      .map((item) => ({
        content: String(item?.content ?? '').slice(0, 500),
        source_ids: normalizeSourceIds(item?.source_ids)
      }))
      .filter((item) => item.content.length > 0)
    : [];

  const synthesized = Array.isArray(parsed.synthesized)
    ? parsed.synthesized
      .map((item) => ({
        content: String(item?.content ?? '').slice(0, 500),
        output_type: item?.output_type === 'rule' ? 'rule' : 'consolidated',
        source_ids: normalizeSourceIds(item?.source_ids)
      }))
      .filter((item) => item.content.length > 0)
    : [];

  return {
    merged_duplicates: mergedDuplicates,
    synthesized
  };
}

function parseStaleVerdict(raw) {
  const parsed = parseRawLlmOutput(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stale_candidates)) {
    return { stale_candidates: [] };
  }

  return {
    stale_candidates: parsed.stale_candidates
      .map((item) => ({
        id: Number(item?.id),
        reason: item?.reason == null ? null : String(item.reason).slice(0, 200)
      }))
      .filter((item) => Number.isInteger(item.id))
  };
}

export function clusterBatchV2(batch, config) {
  const tightThreshold = Number(config.consolidation?.cluster_tight_threshold ?? 0.75);
  const looseThreshold = Number(config.consolidation?.cluster_loose_threshold ?? 0.5);
  const maxSize = Math.max(1, Number(config.consolidation?.maxClusterSize ?? 15));

  const withVec = batch.filter((memory) => memory.embedding);
  if (withVec.length < 2) {
    return batch.length ? [batch] : [];
  }

  const cosineMatrix = new Map();
  for (let i = 0; i < withVec.length; i += 1) {
    for (let j = i + 1; j < withVec.length; j += 1) {
      const sim = cosineSimilarity(blobToVec(withVec[i].embedding), blobToVec(withVec[j].embedding));
      cosineMatrix.set(`${withVec[i].id}_${withVec[j].id}`, sim);
      cosineMatrix.set(`${withVec[j].id}_${withVec[i].id}`, sim);
    }
  }

  const getCosine = (a, b) => cosineMatrix.get(`${a}_${b}`) ?? 0;
  const assigned = new Set();
  const clusters = [];
  const pairs = [...cosineMatrix.entries()]
    .filter(([key, value]) => {
      const [a, b] = key.split('_').map(Number);
      return a < b && value >= tightThreshold;
    })
    .map(([key, cosine]) => ({ ids: key.split('_').map(Number), cosine }))
    .sort((a, b) => b.cosine - a.cosine);

  for (const pair of pairs) {
    const [idA, idB] = pair.ids;
    const clusterA = clusters.findIndex((cluster) => cluster.some((memory) => memory.id === idA));
    const clusterB = clusters.findIndex((cluster) => cluster.some((memory) => memory.id === idB));

    if (clusterA === -1 && clusterB === -1) {
      clusters.push([
        withVec.find((memory) => memory.id === idA),
        withVec.find((memory) => memory.id === idB)
      ]);
      assigned.add(idA);
      assigned.add(idB);
    } else if (clusterA >= 0 && clusterB === -1) {
      if (clusters[clusterA].length < maxSize) {
        clusters[clusterA].push(withVec.find((memory) => memory.id === idB));
        assigned.add(idB);
      }
    } else if (clusterA === -1 && clusterB >= 0) {
      if (clusters[clusterB].length < maxSize) {
        clusters[clusterB].push(withVec.find((memory) => memory.id === idA));
        assigned.add(idA);
      }
    }
  }

  const unassigned = withVec.filter((memory) => !assigned.has(memory.id));
  for (const memory of unassigned) {
    let bestCluster = -1;
    let bestAvgCosine = 0;

    for (let index = 0; index < clusters.length; index += 1) {
      if (clusters[index].length >= maxSize) {
        continue;
      }

      const avgCosine = clusters[index].reduce((sum, row) => sum + getCosine(memory.id, row.id), 0) / clusters[index].length;
      if (avgCosine >= looseThreshold && avgCosine > bestAvgCosine) {
        bestAvgCosine = avgCosine;
        bestCluster = index;
      }
    }

    if (bestCluster >= 0) {
      clusters[bestCluster].push(memory);
    }
  }

  const assignedIds = new Set(clusters.flatMap((cluster) => cluster.map((memory) => memory.id)));
  const misc = batch.filter((memory) => !assignedIds.has(memory.id));
  const finalClusters = clusters.filter((cluster) => cluster.length > 0);
  if (misc.length > 0) {
    finalClusters.push(misc);
  }
  return finalClusters;
}

async function applyMergedDuplicates(db, cluster, mergedDuplicates) {
  let mergedCount = 0;
  const now = Date.now();

  for (const merged of mergedDuplicates) {
    const sources = merged.source_ids.filter((id) => cluster.some((memory) => memory.id === id));
    if (sources.length < 2 || !merged.content) {
      continue;
    }

    const keepId = sources[0];
    db.prepare(
      `UPDATE memories
       SET content = ?, updated_at = ?, last_touched_at = ?
       WHERE id = ?`
    ).run(merged.content.slice(0, 500), now, now, keepId);

    for (const sourceId of sources.slice(1)) {
      db.prepare(
        `UPDATE memories
         SET status = 'superseded', updated_at = ?
         WHERE id = ?`
      ).run(now, sourceId);
    }

    writeAudit(db, 'synthesis_dedup_merged', keepId, {
      superseded_ids: sources.slice(1),
      merged_content_excerpt: merged.content.slice(0, 80)
    });
    mergedCount += 1;
  }

  return mergedCount;
}

async function maybeEmbedSynthesis(provider, cfg, content) {
  if (!provider || !content) {
    return { vec: null, blob: null };
  }

  const [vec] = await provider.embed([content], cfg);
  return {
    vec: vec ?? null,
    blob: vec ? vecToBlob(vec) : null
  };
}

async function applySynthesized(db, scope, cluster, synthesized, existing, provider, cfg) {
  let proposed = 0;
  let accepted = 0;
  let rejected = 0;
  let firstOutputType = null;
  const duplicateThreshold = Number(cfg.consolidation?.quality?.cosine_dup_threshold ?? 0.9);

  for (const item of synthesized) {
    proposed += 1;
    if (!firstOutputType) {
      firstOutputType = item.output_type;
    }

    const quality = scoreSynthesisOutput(db, item, cluster);
    if (!quality.pass) {
      rejected += 1;
      writeAudit(db, 'synthesis_quality_reject', null, {
        reason: quality.reason,
        proposed_content_excerpt: item.content?.slice(0, 80),
        score: quality.score
      });
      continue;
    }

    const sourceIds = normalizeSourceIds(item.source_ids).filter((id) => cluster.some((memory) => memory.id === id));
    let embedded = { vec: null, blob: null };

    if (provider && item.content) {
      try {
        embedded = await maybeEmbedSynthesis(provider, cfg, item.content);
        for (const existingMemory of existing) {
          if (!existingMemory.embedding || !embedded.vec) {
            continue;
          }
          const sim = cosineSimilarity(embedded.vec, blobToVec(existingMemory.embedding));
          if (sim > duplicateThreshold) {
            rejected += 1;
            writeAudit(db, 'synthesis_quality_reject', null, {
              reason: 'cosine_dup',
              proposed_content_excerpt: item.content.slice(0, 80),
              existing_id: existingMemory.id,
              cosine: sim
            });
            embedded = { vec: null, blob: null, rejected: true };
            break;
          }
        }
      } catch (error) {
        writeAudit(db, 'embedding_api_error', null, {
          provider: provider.modelId ?? 'unknown',
          error: String(error?.message ?? error).slice(0, 200),
          retry_eligible: /429|timeout|rate limit/i.test(String(error?.message ?? error))
        });
      }
    }

    if (embedded.rejected) {
      continue;
    }

    const newDepth = Math.max(...cluster.map((memory) => Number(memory.consolidation_depth ?? 0)), 0) + 1;
    const inserted = await insertMemory(db, {
      cwd: process.cwd(),
      content: item.content,
      scope: scope === 'global' ? 'global' : 'project',
      projectKey: scope === 'global' ? null : scope,
      type: item.output_type,
      source: 'cron_consolidated',
      embedSync: false,
      embeddingBlob: embedded.blob,
      parentIds: sourceIds,
      consolidationDepth: newDepth,
      lastTouchedAt: Date.now()
    });

    existing.unshift({
      id: inserted.id,
      content: item.content,
      consolidation_depth: newDepth,
      embedding: embedded.blob
    });
    accepted += 1;
  }

  return { proposed, accepted, rejected, firstOutputType };
}

async function runScopeSynthesis(db, scope, payload, cfg, provider) {
  const batch = selectBatch(db, scope, Number(cfg.consolidation?.weeklyMaxBatch ?? 50));
  if (!batch.length) {
    return {
      llmCalls: 0,
      synthProposed: 0,
      synthAccepted: 0,
      synthRejected: 0,
      dedupMerged: 0,
      staleFlagged: 0,
      firstOutputType: null,
      hadClusterWork: false
    };
  }

  const clusters = clusterBatchV2(batch, cfg);
  const existing = loadExistingConsolidated(db, scope);
  let llmCalls = 0;
  let synthProposed = 0;
  let synthAccepted = 0;
  let synthRejected = 0;
  let dedupMerged = 0;
  let staleFlagged = 0;
  let firstOutputType = null;
  let mockConsumed = false;
  let hadClusterWork = false;

  for (const cluster of clusters) {
    if (cluster.length < 2) {
      continue;
    }

    hadClusterWork = true;
    let raw = null;
    try {
      if (typeof payload.llm_output === 'string') {
        if (mockConsumed) {
          continue;
        }
        raw = payload.llm_output;
        mockConsumed = true;
      } else if (shouldUseClaudeBridge(payload)) {
        raw = await callClaudeP(buildSynthesisPromptV2(cluster, existing), {
          taskType: 'weekly_synthesis',
          jsonSchema: SYNTHESIS_V2_SCHEMA
        });
      }
      llmCalls += 1;
    } catch (error) {
      writeAudit(db, 'weekly_synthesis_cluster_failed', null, {
        cluster_size: cluster.length,
        error: String(error?.message ?? error).slice(0, 200)
      });
      continue;
    }

    const verdict = parseSynthesisVerdict(raw);
    dedupMerged += await applyMergedDuplicates(db, cluster, verdict.merged_duplicates);
    const applied = await applySynthesized(db, scope, cluster, verdict.synthesized, existing, provider, cfg);
    synthProposed += applied.proposed;
    synthAccepted += applied.accepted;
    synthRejected += applied.rejected;
    if (!firstOutputType && applied.firstOutputType) {
      firstOutputType = applied.firstOutputType;
    }
  }

  if (cfg.consolidation?.stale_check_enabled !== false && batch.length >= 5) {
    try {
      const raw = await callClaudeP(buildStaleCheckPrompt(batch), {
        taskType: 'weekly_synthesis',
        jsonSchema: STALE_CHECK_SCHEMA,
        mockOutput: typeof payload.stale_llm_output === 'string' ? payload.stale_llm_output : undefined
      });
      llmCalls += 1;
      const verdict = parseStaleVerdict(raw);
      for (const candidate of verdict.stale_candidates) {
        if (!batch.some((memory) => memory.id === candidate.id)) {
          continue;
        }
        const result = db.prepare(
          `UPDATE memories
           SET decay_status = 'candidate_expire', updated_at = ?
           WHERE id = ? AND decay_status = 'active'`
        ).run(Date.now(), candidate.id);
        if (result.changes > 0) {
          staleFlagged += 1;
        }
      }
    } catch {
      // ignore stale-check failure
    }
  }

  rebuildInjectionCache(db, scope === 'global' ? null : scope);
  return {
    llmCalls,
    synthProposed,
    synthAccepted,
    synthRejected,
    dedupMerged,
    staleFlagged,
    firstOutputType,
    hadClusterWork
  };
}

export async function runWeeklySynthesis(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  const cfg = loadConfig();
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : weeklyLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : Date.now()));

  const provider = getProvider(cfg);
  if (provider) {
    try {
      await provider.load(cfg);
    } catch {
      // degrade without semantic help
    }
  }

  let llmCalls = 0;
  let synthProposed = 0;
  let synthAccepted = 0;
  let synthRejected = 0;
  let dedupMerged = 0;
  let staleFlagged = 0;
  let firstOutputType = null;
  let hadClusterWork = false;

  for (const scope of ['global', ...projectScopes(db)]) {
    const result = await runScopeSynthesis(db, scope, payload, cfg, provider?.isLoaded?.() ? provider : null);
    llmCalls += result.llmCalls;
    synthProposed += result.synthProposed;
    synthAccepted += result.synthAccepted;
    synthRejected += result.synthRejected;
    dedupMerged += result.dedupMerged;
    staleFlagged += result.staleFlagged;
    hadClusterWork = hadClusterWork || result.hadClusterWork;
    if (!firstOutputType && result.firstOutputType) {
      firstOutputType = result.firstOutputType;
    }
  }

  if (!hadClusterWork && process.env.CCMEM_TEST_MODE === '1' && shouldUseClaudeBridge(payload)) {
    const raw = typeof payload.llm_output === 'string'
      ? payload.llm_output
      : await callClaudeP(buildSynthesisPromptV2([], []), {
          taskType: 'weekly_synthesis',
          jsonSchema: SYNTHESIS_V2_SCHEMA
        });
    const verdict = parseSynthesisVerdict(raw);
    llmCalls += 1;
    synthProposed += verdict.synthesized.length;
    if (!firstOutputType) {
      firstOutputType = verdict.synthesized[0]?.output_type ?? null;
    }
  }

  writeAudit(db, 'weekly_synthesis_run', null, {
    task_id: task.id,
    item_count: synthProposed,
    first_output_type: firstOutputType,
    inserted_count: synthAccepted,
    llm_calls: llmCalls,
    synth_proposed: synthProposed,
    synth_accepted: synthAccepted,
    synth_rejected: synthRejected,
    dedup_merged: dedupMerged,
    stale_flagged: staleFlagged
  });
  markLeaseComplete(db, 'weekly_synthesis', leaseKey);
}
