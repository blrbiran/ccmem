import { callClaudeP } from '../claude-p.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { insertMemory } from '../../lib/cmd/save.mjs';
import { buildMonthlyMetaPrompt, MONTHLY_META_SCHEMA } from '../../lib/llm-prompts/monthly-meta-synthesis.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function projectScopes(db) {
  return db.prepare(
    `SELECT DISTINCT project_key
     FROM memories
     WHERE scope = 'project'
       AND project_key IS NOT NULL
       AND type = 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all().map((row) => row.project_key);
}

function loadConsolidated(db, scope) {
  if (scope === 'global') {
    return db.prepare(
      `SELECT id, content, consolidation_depth, trust_score, parent_ids, last_touched_at
       FROM memories
       WHERE type = 'consolidated'
         AND status = 'active'
         AND decay_status IN ('active', 'probation')
         AND scope = 'global'
       ORDER BY consolidation_depth ASC, last_touched_at DESC, id ASC`
    ).all();
  }

  return db.prepare(
    `SELECT id, content, consolidation_depth, trust_score, parent_ids, last_touched_at
     FROM memories
     WHERE type = 'consolidated'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND project_key = ?
     ORDER BY consolidation_depth ASC, last_touched_at DESC, id ASC`
  ).all(scope);
}

async function processScope(db, scope, payload, cfg) {
  const consolidated = loadConsolidated(db, scope);
  const threshold = Number(cfg.consolidation?.monthly?.min_consolidated ?? 30);
  const startedAt = Date.now();

  if (consolidated.length < threshold) {
    writeAudit(db, 'monthly_meta_run', null, {
      scope,
      input_count: consolidated.length,
      output_count: 0,
      superseded_count: 0,
      duration_ms: Date.now() - startedAt,
      skipped: 'below_threshold'
    });
    return;
  }

  const raw = await callClaudeP(buildMonthlyMetaPrompt(consolidated, scope), {
    taskType: 'monthly_meta_synthesis',
    jsonSchema: MONTHLY_META_SCHEMA,
    mockOutput: payload.llm_output
  });
  const out = parseLlmJson(raw);
  let outputCount = 0;
  let supersededCount = 0;

  for (const item of out) {
    const parents = (item.source_ids ?? []).filter((id) => consolidated.some((row) => row.id === id));
    if (!parents.length) {
      continue;
    }

    const parentRows = consolidated.filter((row) => parents.includes(row.id));
    const newDepth = Math.max(...parentRows.map((row) => Number(row.consolidation_depth ?? 0))) + 1;
    const result = await insertMemory(db, {
      cwd: process.cwd(),
      content: String(item.content ?? '').slice(0, 80),
      scope: scope === 'global' ? 'global' : 'project',
      projectKey: scope === 'global' ? null : scope,
      type: 'consolidated',
      source: 'cron_consolidated',
      embedSync: true
    });

    db.prepare(
      `UPDATE memories
       SET consolidation_depth = ?, parent_ids = ?, updated_at = ?
       WHERE id = ?`
    ).run(newDepth, JSON.stringify(parents), Date.now(), result.id);

    for (const parentId of parents) {
      db.prepare(
        `UPDATE memories
         SET status = 'superseded', updated_at = ?
         WHERE id = ?`
      ).run(Date.now(), parentId);
      supersededCount += 1;
    }

    outputCount += 1;
  }

  rebuildInjectionCache(db, scope === 'global' ? null : scope);
  writeAudit(db, 'monthly_meta_run', null, {
    scope,
    input_count: consolidated.length,
    output_count: outputCount,
    superseded_count: supersededCount,
    duration_ms: Date.now() - startedAt
  });
}

export async function runMonthlyMetaSynthesis(db, task) {
  const payload = JSON.parse(task?.payload ?? '{}');
  const cfg = loadConfig();
  const scopes = payload.scope ? [payload.scope] : ['global', ...projectScopes(db)];

  for (const scope of scopes) {
    await processScope(db, scope, payload, cfg);
    if (payload.scope && payload.lease_key) {
      markLeaseComplete(db, 'monthly_meta_synthesis', payload.lease_key);
    }
  }
}
