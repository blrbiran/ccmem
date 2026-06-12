import { callClaudeP } from '../claude-p.mjs';
import { weeklyLeaseKey } from '../loop.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { insertMemory } from '../../lib/cmd/save.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { blobToVec, cosineSimilarity } from '../../lib/embedding/cosine.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function logAudit(db, action, details = null) {
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, NULL, ?)`
  ).run(Date.now(), action, details ? JSON.stringify(details) : null);
}

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
      `SELECT id, content, consolidation_depth, last_touched_at, trust_score, embedding
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
    `SELECT id, content, consolidation_depth, last_touched_at, trust_score, embedding
     FROM memories
     WHERE project_key = ?
       AND type != 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY last_touched_at DESC, id DESC
     LIMIT ?`
  ).all(scope, limit);
}

export function clusterBatch(batch, config) {
  if (!batch.length) {
    return [];
  }

  const threshold = Number(config.consolidation?.cluster_threshold ?? 0.5);
  const maxClusterSize = Math.max(1, Number(config.consolidation?.maxClusterSize ?? 15));
  const minClusterSize = Math.max(1, Math.floor(Number(config.consolidation?.minBatchSize ?? 5) / 2));
  const clusterOf = new Map();
  const clusters = [];

  for (let i = 0; i < batch.length; i += 1) {
    clusterOf.set(batch[i].id, i);
    clusters.push([batch[i]]);
  }

  for (let i = 0; i < batch.length; i += 1) {
    if (!batch[i].embedding) {
      continue;
    }

    for (let j = i + 1; j < batch.length; j += 1) {
      if (!batch[j].embedding) {
        continue;
      }

      const ci = clusterOf.get(batch[i].id);
      const cj = clusterOf.get(batch[j].id);
      if (ci === cj) {
        continue;
      }

      const sim = cosineSimilarity(blobToVec(batch[i].embedding), blobToVec(batch[j].embedding));
      if (sim < threshold) {
        continue;
      }

      for (const memory of clusters[cj]) {
        clusters[ci].push(memory);
        clusterOf.set(memory.id, ci);
      }
      clusters[cj] = [];
    }
  }

  const misc = [];
  const merged = [];
  for (const cluster of clusters.filter((cluster) => cluster.length > 0)) {
    if (cluster.length < minClusterSize) {
      misc.push(...cluster);
    } else {
      merged.push(cluster);
    }
  }

  if (misc.length) {
    merged.push(misc);
  }

  const split = [];
  for (const cluster of merged) {
    for (let i = 0; i < cluster.length; i += maxClusterSize) {
      split.push(cluster.slice(i, i + maxClusterSize));
    }
  }

  return split;
}

function buildWeeklySynthesisPrompt(cluster) {
  const payload = JSON.stringify(cluster.map((memory) => ({
    id: memory.id,
    content: String(memory.content ?? '').slice(0, 200),
    depth: Number(memory.consolidation_depth ?? 0),
    trust: Number(memory.trust_score ?? 0)
  })));

  return [
    'You are a memory synthesis assistant.',
    'Synthesize durable weekly memories as JSON.',
    'Return an array or an object with a synthesized array.',
    '',
    payload
  ].join('\n');
}

async function applyClusterItems(db, scope, cluster, items) {
  let inserted = 0;

  for (const item of items) {
    const parentIds = (item.source_ids ?? []).filter((id) => cluster.some((memory) => memory.id === id));
    const resolvedParents = parentIds.length ? parentIds : cluster.map((memory) => memory.id);
    const newDepth = Math.max(...cluster.map((memory) => Number(memory.consolidation_depth ?? 0)), 0) + 1;

    const result = await insertMemory(db, {
      cwd: process.cwd(),
      content: String(item.content ?? '').slice(0, 80),
      scope: scope === 'global' ? 'global' : 'project',
      projectKey: scope === 'global' ? null : scope,
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: false
    });

    db.prepare(
      `UPDATE memories
       SET consolidation_depth = ?, parent_ids = ?, updated_at = ?
       WHERE id = ?`
    ).run(newDepth, JSON.stringify(resolvedParents), Date.now(), result.id);
    inserted += 1;
  }

  if (inserted > 0) {
    rebuildInjectionCache(db, scope === 'global' ? null : scope);
  }

  return inserted;
}

async function runScopeSynthesis(db, scope, payload, cfg) {
  const batch = selectBatch(db, scope, Number(cfg.consolidation?.weeklyMaxBatch ?? 50));
  if (!batch.length) {
    return [];
  }

  const clusterResults = [];
  const clusters = clusterBatch(batch, cfg);
  let mockConsumed = false;

  for (const cluster of clusters) {
    let raw = null;
    if (typeof payload.llm_output === 'string') {
      if (mockConsumed) {
        continue;
      }
      raw = payload.llm_output;
      mockConsumed = true;
    } else if (shouldUseClaudeBridge(payload)) {
      raw = await callClaudeP(buildWeeklySynthesisPrompt(cluster), {
        taskType: 'weekly_synthesis'
      });
    }

    const items = raw ? parseLlmJson(raw) : [];
    const inserted = cluster.length ? await applyClusterItems(db, scope, cluster, items) : 0;
    clusterResults.push({ items, inserted });
  }

  return clusterResults;
}

function flattenItems(results) {
  return results.flatMap((result) => result.items);
}

function totalItemCount(results) {
  return flattenItems(results).length;
}

function firstOutputType(results) {
  return flattenItems(results)[0]?.output_type ?? null;
}

function totalInserted(results) {
  return results.reduce((sum, result) => sum + Number(result.inserted ?? 0), 0);
}

export async function runWeeklySynthesis(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  const cfg = loadConfig();
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : weeklyLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : Date.now()));

  let results = [];
  for (const scope of ['global', ...projectScopes(db)]) {
    results.push(...await runScopeSynthesis(db, scope, payload, cfg));
  }

  if (!results.length && shouldUseClaudeBridge(payload)) {
    const raw = typeof payload.llm_output === 'string'
      ? payload.llm_output
      : await callClaudeP(buildWeeklySynthesisPrompt([]), { taskType: 'weekly_synthesis' });
    results = [{ items: raw ? parseLlmJson(raw) : [], inserted: 0 }];
  }

  const details = {
    task_id: task.id,
    item_count: totalItemCount(results),
    first_output_type: firstOutputType(results),
    inserted_count: totalInserted(results),
    llm_calls: results.length
  };

  logAudit(db, 'weekly_synthesis_run', details);
  markLeaseComplete(db, 'weekly_synthesis', leaseKey);
}
