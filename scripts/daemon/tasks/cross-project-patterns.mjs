import { weeklyLeaseKey } from '../loop.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { blobToVec, cosineSimilarity } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { markLeaseComplete } from '../../lib/task-runs.mjs';

function round3(value) {
  return Math.round(Number(value ?? 0) * 1000) / 1000;
}

function distinctProjectKeys(db, minTrust) {
  return db.prepare(
    `SELECT DISTINCT project_key
     FROM memories
     WHERE scope = 'project'
       AND project_key IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND embedding IS NOT NULL
       AND trust_score >= ?
     ORDER BY project_key ASC`
  ).all(minTrust).map((row) => row.project_key);
}

function loadProjectRows(db, projectKey, minTrust) {
  return db.prepare(
    `SELECT id, project_key, content, trust_score, embedding
     FROM memories
     WHERE scope = 'project'
       AND project_key = ?
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND embedding IS NOT NULL
       AND trust_score >= ?
     ORDER BY id ASC`
  ).all(projectKey, minTrust).map((row) => ({
    ...row,
    vec: blobToVec(row.embedding)
  }));
}

function loadGlobalRows(db) {
  return db.prepare(
    `SELECT id, embedding
     FROM memories
     WHERE scope = 'global'
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND embedding IS NOT NULL`
  ).all().map((row) => ({
    ...row,
    vec: blobToVec(row.embedding)
  }));
}

function deduplicateSimilarList(items, representativeId) {
  const map = new Map();
  for (const item of items) {
    const memId = Number(item?.mem_id);
    const projectKey = String(item?.project_key ?? '');
    if (!Number.isFinite(memId) || !projectKey || memId === representativeId) {
      continue;
    }
    const key = `${projectKey}:${memId}`;
    const current = map.get(key);
    const next = {
      project_key: projectKey,
      mem_id: memId,
      cosine: round3(item?.cosine ?? 0)
    };
    if (!current || next.cosine > current.cosine) {
      map.set(key, next);
    }
  }
  return [...map.values()].sort((a, b) => b.cosine - a.cosine || a.project_key.localeCompare(b.project_key) || a.mem_id - b.mem_id);
}

function clusterCandidates(candidates, threshold) {
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < candidates.length; i += 1) {
    if (used.has(candidates[i].id)) {
      continue;
    }
    const cluster = [candidates[i]];
    used.add(candidates[i].id);
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (used.has(candidates[j].id)) {
        continue;
      }
      if (cosineSimilarity(candidates[i].vec, candidates[j].vec) >= threshold) {
        cluster.push(candidates[j]);
        used.add(candidates[j].id);
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

export async function runCrossProjectPatterns(db, task) {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const auditCfg = cfg.cross_project?.audit ?? {};
  const cosineThreshold = Number(auditCfg.cosine_threshold ?? 0.85);
  const minProjects = Number(auditCfg.min_projects ?? 2);
  const minTrust = Number(auditCfg.min_trust ?? 0.5);
  const maxCandidatesPerRun = Number(auditCfg.max_candidates_per_run ?? 5);
  const dedupWindowMs = Number(auditCfg.dedup_window_days ?? 30) * 86400000;
  const maxPairs = Number(auditCfg.max_pairs ?? 500000);
  const payload = JSON.parse(task?.payload ?? '{}');
  const scheduledFor = Number(task?.scheduled_for);
  const leaseKey = typeof payload.lease_key === 'string' && payload.lease_key
    ? payload.lease_key
    : weeklyLeaseKey(new Date(Number.isFinite(scheduledFor) ? scheduledFor : Date.now()));

  const provider = getProvider(cfg);
  if (!provider) {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'no_embedding' });
    markLeaseComplete(db, 'cross_project_patterns', leaseKey);
    return;
  }

  try {
    await provider.load(cfg);
  } catch {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'no_embedding' });
    markLeaseComplete(db, 'cross_project_patterns', leaseKey);
    return;
  }

  if (!provider?.isLoaded?.()) {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'no_embedding' });
    markLeaseComplete(db, 'cross_project_patterns', leaseKey);
    return;
  }

  const projectKeys = distinctProjectKeys(db, minTrust);
  if (projectKeys.length < minProjects) {
    writeAudit(db, 'cross_project_skipped', null, { reason: 'single_project' });
    markLeaseComplete(db, 'cross_project_patterns', leaseKey);
    return;
  }

  const projectRows = new Map(projectKeys.map((projectKey) => [projectKey, loadProjectRows(db, projectKey, minTrust)]));
  const globalRows = loadGlobalRows(db);
  const matches = new Map();
  const rowsById = new Map();
  for (const rows of projectRows.values()) {
    for (const row of rows) {
      rowsById.set(row.id, row);
    }
  }

  let pairsChecked = 0;
  let exhausted = false;
  for (let i = 0; i < projectKeys.length && !exhausted; i += 1) {
    for (let j = i + 1; j < projectKeys.length && !exhausted; j += 1) {
      const rowsA = projectRows.get(projectKeys[i]) ?? [];
      const rowsB = projectRows.get(projectKeys[j]) ?? [];
      for (const rowA of rowsA) {
        for (const rowB of rowsB) {
          if (pairsChecked >= maxPairs) {
            exhausted = true;
            break;
          }
          pairsChecked += 1;
          const similarity = cosineSimilarity(rowA.vec, rowB.vec);
          if (similarity < cosineThreshold) {
            continue;
          }
          const itemA = { project_key: rowB.project_key, mem_id: rowB.id, cosine: round3(similarity) };
          const itemB = { project_key: rowA.project_key, mem_id: rowA.id, cosine: round3(similarity) };
          matches.set(rowA.id, [...(matches.get(rowA.id) ?? []), itemA]);
          matches.set(rowB.id, [...(matches.get(rowB.id) ?? []), itemB]);
        }
        if (exhausted) {
          break;
        }
      }
    }
  }

  const rawCandidates = [];
  for (const [memId, similarList] of matches.entries()) {
    const distinctProjects = new Set(similarList.map((item) => item.project_key));
    if (distinctProjects.size < (minProjects - 1)) {
      continue;
    }
    const row = rowsById.get(memId);
    if (!row) {
      continue;
    }
    rawCandidates.push({
      id: row.id,
      project_key: row.project_key,
      trust: Number(row.trust_score ?? 0),
      vec: row.vec,
      similarList
    });
  }

  let skippedGlobalCovered = 0;
  const filtered = rawCandidates.filter((candidate) => {
    for (const globalRow of globalRows) {
      const similarity = cosineSimilarity(candidate.vec, globalRow.vec);
      if (similarity >= cosineThreshold) {
        skippedGlobalCovered += 1;
        writeAudit(db, 'cross_project_already_global', candidate.id, {
          global_mem_id: globalRow.id,
          cosine: round3(similarity)
        });
        return false;
      }
    }
    return true;
  });

  const clusters = clusterCandidates(filtered, cosineThreshold);
  let candidatesFound = 0;

  for (const cluster of clusters) {
    if (candidatesFound >= maxCandidatesPerRun) {
      break;
    }

    const representative = cluster.reduce((best, current) => (current.trust > best.trust ? current : best), cluster[0]);
    const duplicate = db.prepare(
      `SELECT 1
       FROM promote_candidates
       WHERE mem_id = ?
         AND detected_at > ?
       LIMIT 1`
    ).get(representative.id, Date.now() - dedupWindowMs);
    if (duplicate) {
      continue;
    }

    const similarIn = deduplicateSimilarList(
      cluster.flatMap((item) => (
        item.id === representative.id
          ? item.similarList
          : [{ project_key: item.project_key, mem_id: item.id, cosine: 1.0 }, ...item.similarList]
      )),
      representative.id
    );

    const inserted = db.prepare(
      `INSERT INTO promote_candidates (mem_id, project_key, similar_in, trigger, detected_at)
       VALUES (?, ?, ?, 'cosine_cross_project', ?)`
    ).run(representative.id, representative.project_key, JSON.stringify(similarIn), Date.now());
    const candidateId = Number(inserted.lastInsertRowid);

    writeAudit(db, 'cross_project_detected', representative.id, {
      candidate_id: candidateId,
      similar_in: similarIn,
      trigger: 'cosine_cross_project'
    });
    candidatesFound += 1;
  }

  writeAudit(db, 'cross_project_run', null, {
    projects_scanned: projectKeys.length,
    pairs_checked: pairsChecked,
    candidates_found: candidatesFound,
    clusters_formed: clusters.length,
    skipped_global_covered: skippedGlobalCovered,
    duration_ms: Date.now() - startedAt
  });
  markLeaseComplete(db, 'cross_project_patterns', leaseKey);
}
