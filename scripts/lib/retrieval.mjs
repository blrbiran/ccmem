import { createHash } from 'node:crypto';
import { hasUsableFts } from './db.mjs';
import { blobToVec, cosineSimilarity, vecToBlob } from './embedding/cosine.mjs';
import { getProvider, getProviderWithCircuit, recordEmbedFailure, recordEmbedSuccess } from './embedding/provider.mjs';
import { currentEmbeddingSig } from './embedding/signature.mjs';

export function sanitizeFtsQuery(prompt) {
  return String(prompt ?? '')
    .replace(/["':(){}\[\]]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 20)
    .join(' ');
}

const CJK_RANGE = /[㐀-鿿]/u;
let cachedSegmenter = undefined;

function getSegmenter() {
  if (cachedSegmenter !== undefined) {
    return cachedSegmenter;
  }

  try {
    cachedSegmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
  } catch {
    cachedSegmenter = null;
  }

  return cachedSegmenter;
}

export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase().trim();
  if (!raw) {
    return [];
  }

  const segments = raw.split(/[\s,。、!?;:!?,;：；"'“”‘’【】（）()\[\]{}]+/u);
  const tokens = [];

  for (const seg of segments) {
    if (!seg || seg.length < 2) {
      continue;
    }

    if (CJK_RANGE.test(seg)) {
      const segmenter = getSegmenter();
      if (segmenter) {
        let emitted = 0;
        for (const { segment, isWordLike } of segmenter.segment(seg)) {
          if (isWordLike && segment.length >= 2) {
            tokens.push(segment);
            emitted += 1;
          }
        }
        if (emitted > 0) {
          continue;
        }
      }
    }

    tokens.push(seg);
  }

  return [...new Set(tokens)].slice(0, 200);
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

export function ftsSearch(db, ftsQuery, projectKey, limit, disableScopeIsolation = false) {
  if (!ftsQuery) {
    return [];
  }

  const scopeClause = disableScopeIsolation ? '' : "AND (m.scope = 'global' OR m.project_key = ?)";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  return db.prepare(
    `SELECT m.id, m.type, m.content, m.scope, m.pinned, m.trust_score,
            m.last_touched_at, bm25(memories_fts) AS rank
     FROM memories_fts
     JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
       ${scopeClause}
       AND m.status = 'active'
       AND m.decay_status IN ('active', 'probation')
     ORDER BY m.pinned DESC, rank ASC
     LIMIT ?`
  ).all(ftsQuery, ...scopeParams, limit);
}

export function likeSearch(db, prompt, projectKey, limit, disableScopeIsolation = false) {
  const tokens = extractShortTokens(prompt, 10);
  if (!tokens.length || limit <= 0) {
    return [];
  }

  const clauses = tokens.map(() => 'LOWER(content) LIKE ?').join(' OR ');
  const values = tokens.map((token) => `%${token}%`);
  const scopeClause = disableScopeIsolation ? '' : "(scope = 'global' OR project_key = ?) AND";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  return db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at, 0 AS rank
     FROM memories
     WHERE ${scopeClause}
       status = 'active'
       AND decay_status IN ('active', 'probation')
       AND (${clauses})
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(...scopeParams, ...values, limit);
}

export function legacySubstringSearch(db, prompt, projectKey, limit, disableScopeIsolation = false) {
  const tokens = sanitizeFtsQuery(String(prompt ?? '').slice(0, 2000))
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return [];
  }

  const scopeClause = disableScopeIsolation ? '' : "(scope = 'global' OR project_key = ?) AND";
  const scopeParams = disableScopeIsolation ? [] : [projectKey];

  const candidates = db.prepare(
    `SELECT id, type, content, scope, pinned, trust_score, last_touched_at
     FROM memories
     WHERE ${scopeClause}
       status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY pinned DESC, last_touched_at DESC`
  ).all(...scopeParams);

  return candidates
    .map((row) => {
      const content = String(row.content ?? '').toLowerCase();
      const tokenHits = tokens.reduce((sum, token) => sum + (content.includes(token) ? 1 : 0), 0);
      return { ...row, tokenHits };
    })
    .filter((row) => row.tokenHits > 0)
    .sort((a, b) =>
      (Number(b.pinned ?? 0) - Number(a.pinned ?? 0))
      || (Number(b.tokenHits ?? 0) - Number(a.tokenHits ?? 0))
      || (Number(b.trust_score ?? 0) - Number(a.trust_score ?? 0))
      || (Number(b.last_touched_at ?? 0) - Number(a.last_touched_at ?? 0))
    )
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

function toFloat32Vec(vec) {
  if (!vec) {
    return null;
  }
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

function promptHash(sig, promptText) {
  return createHash('sha256').update(`${sig}\n${promptText}`).digest('hex');
}

function readQueryEmbeddingCache(db, promptText, sig) {
  const hash = promptHash(sig, promptText);
  const row = db.prepare(
    `SELECT embedding
     FROM query_embedding_cache
     WHERE prompt_hash = ? AND model = ?`
  ).get(hash, sig);
  if (!row?.embedding) {
    return null;
  }

  db.prepare(
    `UPDATE query_embedding_cache
     SET hit_count = hit_count + 1
     WHERE prompt_hash = ?`
  ).run(hash);

  return {
    hash,
    queryVec: blobToVec(row.embedding)
  };
}

function writeQueryEmbeddingCache(db, promptText, sig, queryVec) {
  const normalized = toFloat32Vec(queryVec);
  if (!normalized) {
    return;
  }

  db.prepare(
    `INSERT INTO query_embedding_cache (prompt_hash, embedding, model, prompt_len, created_at, hit_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(prompt_hash) DO UPDATE SET
       embedding = excluded.embedding,
       model = excluded.model,
       prompt_len = excluded.prompt_len,
       created_at = excluded.created_at`
  ).run(
    promptHash(sig, promptText),
    vecToBlob(normalized),
    sig,
    promptText.length,
    Date.now()
  );
}

function lexicalRetrieve(db, promptText, promptTokens, projectKey, config, limit, useFts, ftsQuery) {
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

  if (!candidateRows.length) {
    const fallbackRows = legacySubstringSearch(db, promptText, projectKey, limit);
    return {
      rows: fallbackRows.map((row) => renderRow(row, {
        fused: Number(row.tokenHits ?? 0),
        fts: 0,
        jaccard: Number(row.tokenHits ?? 0),
        semantic: 0
      })),
      timing: null
    };
  }

  const weights = config?.retrieval?.weights ?? { fts: 0.4, jaccard: 0.2, semantic: 0.4 };
  const scored = candidateRows.map((row) => {
    const ftsScore = useFts && ftsRows.length
      ? normalizeRank((ftsRows.find((candidate) => candidate.id === row.id)?.rank ?? 0), ftsRows)
      : 0;
    const jaccardScore = jaccardSimilarity(promptTokens, new Set(tokenize(row.content)));
    const fused = (weights.fts * ftsScore) + (weights.jaccard * jaccardScore);
    return {
      ...row,
      fused,
      ftsScore,
      jaccardScore
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
      semantic: 0
    })),
    timing: null
  };
}

export async function retrieveMemories(db, prompt, projectKey, config) {
  const limit = Number(config?.inject?.max_per_prompt ?? 6);
  const promptText = String(prompt ?? '').slice(0, 2000);
  const promptTokenList = tokenize(promptText);
  if (!promptTokenList.length) {
    return { rows: [], queryVec: null, cosineContribution: null, timing: null };
  }

  const promptTokens = new Set(promptTokenList);
  const ftsQuery = sanitizeFtsQuery(promptText);
  const useFts = hasUsableFts(db);
  const baseProvider = getProvider(config);
  // Signature reflects the configured provider's identity (provider:model:dim),
  // resolved from applyConfig() at getProvider() time — independent of the
  // circuit breaker below, which only gates whether we can reach the API right
  // now, not what "current" means. Using the circuit-gated provider here would
  // wrongly fall back to config-only dim guessing (e.g. openai_dim defaults to
  // null in DEFAULT_CONFIG, not the provider's real 1536) whenever the circuit
  // is open — even on a query-cache hit, where no live provider is needed at all.
  const sig = baseProvider ? currentEmbeddingSig(baseProvider, config) : null;
  const cachedQuery = sig ? readQueryEmbeddingCache(db, promptText, sig) : null;
  const { provider, circuit } = getProviderWithCircuit(db, config);
  let useEmbedding = false;
  let queryVec = cachedQuery?.queryVec ?? null;

  if (queryVec) {
    useEmbedding = true;
  } else if (provider) {
    try {
      await provider.load(config);
      useEmbedding = provider.isLoaded();
    } catch {
      useEmbedding = false;
    }
  }

  if (!useEmbedding) {
    const lexical = lexicalRetrieve(db, promptText, promptTokens, projectKey, config, limit, useFts, ftsQuery);
    return {
      rows: lexical.rows,
      queryVec: null,
      cosineContribution: null,
      timing: lexical.timing,
      retrievalPath: circuit === 'open' ? 'B-circuit' : 'B-off'
    };
  }

  let embedMs = 0;
  if (!queryVec) {
    const tEmbed = Date.now();
    try {
      [queryVec] = await provider.embed([promptText], config);
      queryVec = toFloat32Vec(queryVec);
      recordEmbedSuccess(db);
      if (sig && queryVec) {
        writeQueryEmbeddingCache(db, promptText, sig, queryVec);
      }
    } catch (error) {
      embedMs = Date.now() - tEmbed;
      recordEmbedFailure(db, config);
      process.stderr.write(`ccmem: embedding API failed (${error.message}), falling back to lexical retrieval\n`);
      const lexical = lexicalRetrieve(db, promptText, promptTokens, projectKey, config, limit, useFts, ftsQuery);
      return {
        rows: lexical.rows,
        queryVec: null,
        cosineContribution: null,
        retrievalPath: 'B-fail',
        timing: {
          ...(lexical.timing ?? {}),
          embedMs,
          embedError: String(error.message ?? error)
        }
      };
    }
    embedMs = Date.now() - tEmbed;
  }
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

  const tDbRead = Date.now();
  const allVecs = db.prepare(
    `SELECT id, embedding
     FROM memories
     WHERE embedding IS NOT NULL AND embedding_sig = ?
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
       AND (scope = 'global' OR project_key = ?)`
  ).all(sig, projectKey);
  // Same population vec_backfill will actually touch (status/decay_status
  // predicate matches its candidate query verbatim) — otherwise archived,
  // deleted, or quarantined rows inflate this count with vectors that will
  // never be re-embedded, and diagnose's "will be re-embedded" claim is false.
  const staleVecs = db.prepare(
    `SELECT COUNT(*) n FROM memories
     WHERE embedding IS NOT NULL AND (embedding_sig IS NULL OR embedding_sig <> ?)
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get(sig).n;
  const dbReadMs = Date.now() - tDbRead;

  const tCosine = Date.now();
  const cosineScores = new Map();
  for (const row of allVecs) {
    cosineScores.set(row.id, cosineSimilarity(queryVec, blobToVec(row.embedding)));
  }
  const cosineMs = Date.now() - tCosine;

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

  const selected = scored.slice(0, limit);
  const cosineContribution = selected.length
    ? selected.reduce((sum, row) => sum + (row.fused > 0 ? ((row.cosineScore * weights.semantic) / row.fused) : 0), 0) / selected.length
    : null;

  return {
    rows: selected.map((row) => renderRow(row, {
      fused: row.fused,
      fts: row.ftsScore,
      jaccard: row.jaccardScore,
      semantic: row.cosineScore
    })),
    queryVec,
    // The signature queryVec was produced under. Returned alongside it because
    // any consumer that cosines this vector against stored ones must filter by
    // it (see inferPositiveFeedback) — the two are only meaningful as a pair.
    embeddingSig: sig,
    cosineContribution,
    retrievalPath: 'A',
    timing: {
      embedMs,
      dbReadMs,
      cosineMs,
      candidatePool: allVecs.length,
      retrieval_stale_vecs: staleVecs
    }
  };
}
