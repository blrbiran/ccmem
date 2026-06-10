import { hasUsableFts } from './db.mjs';
import { blobToVec, cosineSimilarity } from './embedding/cosine.mjs';
import { getProvider } from './embedding/provider.mjs';

export function sanitizeFtsQuery(prompt) {
  return String(prompt ?? '')
    .replace(/["':(){}\[\]]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 20)
    .join(' ');
}

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 200);
}

export function extractShortTokens(text, maxTerms = 5) {
  return tokenize(text).slice(0, Math.max(1, Number(maxTerms ?? 5)));
}

export function jaccardSimilarity(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (setA.size + setB.size - intersection);
}

function normalizeRank(rank, allRows) {
  if (allRows.length <= 1) {
    return 1;
  }

  const ranks = allRows.map((row) => Number(row.rank ?? 0));
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  if (max === min) {
    return 1;
  }

  return (max - Number(rank ?? 0)) / (max - min);
}

function loadRowsByIds(db, ids) {
  if (!ids.length) {
    return [];
  }

  return db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at
     FROM memories
     WHERE id IN (${ids.map(() => '?').join(',')})
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).all(...ids);
}

function ftsSearch(db, ftsQuery, projectKey, limit) {
  if (!ftsQuery) {
    return [];
  }

  return db.prepare(
    `SELECT m.id, m.type, m.content, m.scope, m.pinned, m.trust_score,
            m.last_touched_at, bm25(memories_fts) AS rank
     FROM memories_fts
     JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND (m.scope = 'global' OR m.project_key = ?)
       AND m.status = 'active'
       AND m.decay_status IN ('active', 'probation')
     ORDER BY m.pinned DESC, rank ASC
     LIMIT ?`
  ).all(ftsQuery, projectKey, limit);
}

export function likeSearch(db, prompt, projectKey, limit) {
  const tokens = extractShortTokens(prompt, 10);
  if (!tokens.length || limit <= 0) {
    return [];
  }

  const clauses = tokens.map(() => 'LOWER(content) LIKE ?').join(' OR ');
  const values = tokens.map((token) => `%${token}%`);
  return db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at, 0 AS rank
     FROM memories
     WHERE (scope = 'global' OR project_key = ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND (${clauses})
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(projectKey, ...values, limit);
}

function legacySubstringSearch(db, prompt, projectKey, limit) {
  const tokens = sanitizeFtsQuery(String(prompt ?? '').slice(0, 2000))
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return [];
  }

  const candidates = db.prepare(
    `SELECT id, type, content, scope, pinned, last_touched_at
     FROM memories
     WHERE (scope = 'global' OR project_key = ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY pinned DESC, last_touched_at DESC`
  ).all(projectKey);

  return candidates
    .filter((row) => {
      const content = String(row.content ?? '').toLowerCase();
      return tokens.some((token) => content.includes(token));
    })
    .slice(0, limit);
}

export function dedupeMerge(left, right) {
  const merged = [];
  const seen = new Set();
  for (const row of [...left, ...right]) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

function renderRow(row, score = null) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    scope: row.scope,
    ...(score ? { score } : {})
  };
}

export async function retrieveMemories(db, prompt, projectKey, config) {
  const limit = Number(config?.inject?.max_per_prompt ?? 6);
  const promptText = String(prompt ?? '').slice(0, 2000);
  const promptTokenList = tokenize(promptText);
  if (!promptTokenList.length) {
    return { rows: [], queryVec: null };
  }

  const promptTokens = new Set(promptTokenList);
  const ftsQuery = sanitizeFtsQuery(promptText);
  const useFts = hasUsableFts(db);
  const provider = getProvider(config);
  let useEmbedding = false;

  if (provider) {
    try {
      await provider.load();
      useEmbedding = provider.isLoaded();
    } catch {
      useEmbedding = false;
    }
  }

  if (!useEmbedding) {
    return {
      rows: legacySubstringSearch(db, promptText, projectKey, limit).map((row) => renderRow(row)),
      queryVec: null
    };
  }

  const [queryVec] = await provider.embed([promptText]);
  let ftsRows = useFts && ftsQuery ? ftsSearch(db, ftsQuery, projectKey, limit * 3) : [];
  let candidateRows = ftsRows;
  const likeEnabled = config?.retrieval?.like_fallback?.enabled !== false;
  const likeTrigger = Number(config?.retrieval?.like_fallback?.trigger_when_fts_below ?? 3);
  if (likeEnabled && (!useFts || candidateRows.length < likeTrigger)) {
    const likeRows = likeSearch(
      db,
      promptText,
      projectKey,
      useFts ? Math.max((limit * 3) - candidateRows.length, limit) : (limit * 3)
    );
    candidateRows = dedupeMerge(candidateRows, likeRows);
  }

  const allVecs = db.prepare(
    `SELECT id, embedding
     FROM memories
     WHERE embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND (scope = 'global' OR project_key = ?)`
  ).all(projectKey);

  const cosineScores = new Map();
  for (const row of allVecs) {
    cosineScores.set(row.id, cosineSimilarity(queryVec, blobToVec(row.embedding)));
  }

  const candidateIds = new Set(candidateRows.map((row) => row.id));
  for (const [id] of [...cosineScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit * 2)) {
    candidateIds.add(id);
  }

  const candidates = loadRowsByIds(db, [...candidateIds]);
  const weights = config?.retrieval?.weights ?? { fts: 0.4, jaccard: 0.2, semantic: 0.4 };
  const scored = candidates.map((row) => {
    const ftsRow = ftsRows.find((candidate) => candidate.id === row.id);
    const ftsScore = ftsRow ? normalizeRank(ftsRow.rank, ftsRows) : 0;
    const jaccardScore = jaccardSimilarity(promptTokens, new Set(tokenize(row.content)));
    const cosineScore = cosineScores.get(row.id) ?? 0;
    const fused = (weights.fts * ftsScore) + (weights.jaccard * jaccardScore) + (weights.semantic * cosineScore);
    return {
      ...row,
      fused,
      ftsScore,
      jaccardScore,
      cosineScore
    };
  });

  scored.sort((a, b) =>
    (Number(b.pinned ?? 0) - Number(a.pinned ?? 0))
    || (b.fused - a.fused)
    || (Number(b.trust_score ?? 0) - Number(a.trust_score ?? 0))
    || (Number(b.last_touched_at ?? 0) - Number(a.last_touched_at ?? 0))
  );

  return {
    rows: scored.slice(0, limit).map((row) => renderRow(row, {
      fused: row.fused,
      fts: row.ftsScore,
      jaccard: row.jaccardScore,
      semantic: row.cosineScore
    })),
    queryVec
  };
}
