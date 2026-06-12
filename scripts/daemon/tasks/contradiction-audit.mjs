import { callClaudeP } from '../claude-p.mjs';
import { contradictionAuditLeaseKey } from '../loop.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { blobToVec, cosineSimilarity } from '../../lib/embedding/cosine.mjs';
import {
  buildContradictionPrompt,
  CONTRADICTION_SCHEMA,
  parseContradictionAuditJson
} from '../../lib/llm-prompts/contradiction-audit.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

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

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function loadScopeMemories(db, scope) {
  if (scope === 'global') {
    return db.prepare(
      `SELECT id, content, embedding, type, trust_score
       FROM memories
       WHERE embedding IS NOT NULL
         AND status = 'active'
         AND decay_status IN ('active', 'probation')
         AND scope = 'global'
       ORDER BY id ASC`
    ).all();
  }

  return db.prepare(
    `SELECT id, content, embedding, type, trust_score
     FROM memories
     WHERE embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND project_key = ?
     ORDER BY id ASC`
  ).all(scope);
}

function candidatePairs(memories, threshold) {
  const pairs = [];

  for (let i = 0; i < memories.length; i += 1) {
    const leftVec = blobToVec(memories[i].embedding);
    for (let j = i + 1; j < memories.length; j += 1) {
      const sim = cosineSimilarity(leftVec, blobToVec(memories[j].embedding));
      if (sim >= threshold) {
        pairs.push({ a: memories[i], b: memories[j], cosine: sim });
      }
    }
  }

  return pairs;
}

function isFreshPair(db, pair, dedupWindowMs) {
  const row = db.prepare(
    `SELECT 1
     FROM contradiction_alerts
     WHERE ((mem_id_a = ? AND mem_id_b = ?) OR (mem_id_a = ? AND mem_id_b = ?))
       AND detected_at > ?
     LIMIT 1`
  ).get(
    pair.a.id,
    pair.b.id,
    pair.b.id,
    pair.a.id,
    Date.now() - dedupWindowMs
  );

  return !row;
}

function applyVerdict(db, scope, batch, verdict, totals, dedupWindowMs) {
  const batchKeys = new Set(batch.flatMap((pair) => [`${pair.a.id}_${pair.b.id}`, `${pair.b.id}_${pair.a.id}`]));

  for (const item of verdict.contradictions ?? []) {
    const key = `${item.id_a}_${item.id_b}`;
    if (!batchKeys.has(key)) {
      continue;
    }

    const pair = batch.find((candidate) => (
      (candidate.a.id === item.id_a && candidate.b.id === item.id_b)
      || (candidate.a.id === item.id_b && candidate.b.id === item.id_a)
    ));
    if (!pair || !isFreshPair(db, pair, dedupWindowMs)) {
      continue;
    }

    const inserted = db.prepare(
      `INSERT INTO contradiction_alerts (
        mem_id_a, mem_id_b, scope, cosine_similarity, evidence, detected_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      item.id_a,
      item.id_b,
      scope,
      pair.cosine,
      JSON.stringify({ llm_reason: item.reason }),
      Date.now()
    );

    writeAudit(db, 'contradiction_detected', item.id_a, {
      alert_id: Number(inserted.lastInsertRowid),
      mem_id_b: item.id_b,
      cosine: pair.cosine,
      llm_reason: item.reason
    });
    totals.contradictions_found += 1;
  }
}

export async function runContradictionAudit(db, task) {
  const startedAt = Date.now();
  const payload = JSON.parse(task?.payload ?? '{}');
  const scheduledFor = Number(task?.scheduled_for);
  const cfg = loadConfig().contradiction?.audit ?? {};
  const threshold = Number(cfg.cosine_threshold ?? 0.7);
  const maxPairsPerBatch = Number(cfg.max_pairs_per_batch ?? 30);
  const dedupWindowMs = Number(cfg.dedup_window_days ?? 30) * 86400000;
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : contradictionAuditLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : startedAt));
  const totals = {
    pairs_scanned: 0,
    contradictions_found: 0,
    llm_calls: 0
  };

  try {
    for (const scope of ['global', ...projectScopes(db)]) {
      const memories = loadScopeMemories(db, scope);
      if (memories.length < 2) {
        continue;
      }

      const pairs = candidatePairs(memories, threshold);
      totals.pairs_scanned += pairs.length;
      const freshPairs = pairs.filter((pair) => isFreshPair(db, pair, dedupWindowMs));
      if (!freshPairs.length) {
        continue;
      }

      for (const batch of chunk(freshPairs, maxPairsPerBatch)) {
        const raw = await callClaudeP(buildContradictionPrompt(batch), {
          taskType: 'contradiction_audit',
          jsonSchema: CONTRADICTION_SCHEMA,
          mockOutput: payload.llm_output
        });
        const verdict = parseContradictionAuditJson(raw);
        totals.llm_calls += 1;
        applyVerdict(db, scope, batch, verdict, totals, dedupWindowMs);
      }
    }

    writeAudit(db, 'contradiction_audit_run', null, {
      pairs_scanned: totals.pairs_scanned,
      contradictions_found: totals.contradictions_found,
      llm_calls: totals.llm_calls,
      duration_ms: Date.now() - startedAt
    });
    markLeaseComplete(db, 'contradiction_audit', leaseKey);
    return totals;
  } catch (error) {
    writeAudit(db, 'contradiction_audit_run', null, {
      pairs_scanned: totals.pairs_scanned,
      contradictions_found: totals.contradictions_found,
      llm_calls: totals.llm_calls,
      duration_ms: Date.now() - startedAt,
      error: String(error?.message ?? error).slice(0, 200)
    });
    throw error;
  }
}
