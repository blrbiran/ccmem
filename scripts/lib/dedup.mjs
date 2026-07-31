import { writeAudit } from './audit.mjs';
import { loadConfig } from './config.mjs';
import { blobToVec, cosineSimilarity } from './embedding/cosine.mjs';
import { getProvider } from './embedding/provider.mjs';
import { currentEmbeddingSig } from './embedding/signature.mjs';
import { sanitizeFtsQuery } from './retrieval.mjs';

function trigramSet(text, size = 3) {
  const value = String(text ?? '').toLowerCase().trim();
  if (!value || value.length < size) {
    return new Set();
  }

  const set = new Set();
  for (let i = 0; i <= value.length - size; i += 1) {
    set.add(value.slice(i, i + size));
  }
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

function candidateRows(db, scope, projectKey, limit) {
  if (scope === 'global') {
    return db.prepare(
      `SELECT id, content, embedding, embedding_sig
       FROM memories
       WHERE scope = 'global'
         AND status = 'active'
         AND decay_status IN ('active', 'probation')
       ORDER BY last_touched_at DESC, id DESC
       LIMIT ?`
    ).all(limit);
  }

  return db.prepare(
    `SELECT id, content, embedding, embedding_sig
     FROM memories
     WHERE scope = 'project'
       AND project_key = ?
       AND status = 'active'
       AND decay_status IN ('active', 'probation')
     ORDER BY last_touched_at DESC, id DESC
     LIMIT ?`
  ).all(projectKey, limit);
}

export function dedupCheck(db, { content, scope, projectKey, contentVec = null }, cfgOverride = null) {
  const config = cfgOverride ?? loadConfig();
  if (config?.dedup?.enabled === false) {
    return { skipped: true, reason: 'disabled' };
  }

  const ftsQuery = sanitizeFtsQuery(String(content ?? '').slice(0, 80));
  if (!ftsQuery) {
    return { skipped: false, duplicate: false };
  }

  const candidates = candidateRows(
    db,
    scope === 'global' ? 'global' : 'project',
    projectKey,
    Number(config?.dedup?.fts_candidate_limit ?? 20)
  );
  if (!candidates.length) {
    return { skipped: false, duplicate: false };
  }

  const jaccardThreshold = Number(config?.dedup?.jaccard_threshold ?? 0.3);
  const cosineThreshold = Number(config?.dedup?.cosine_threshold ?? 0.85);
  const trigrams = trigramSet(content, Number(config?.dedup?.trigram_size ?? 3));
  // Same-dimension, different-model vectors compare as plausible-but-wrong
  // cosine scores, not the safe all-zero of a length mismatch — so a
  // candidate embedded under a stale signature must be skipped from the
  // cosine lane entirely (not just scored low), or a real duplicate check
  // can silently pass a near-duplicate through, or worse, silently reject a
  // genuinely new memory as a false duplicate. The trigram/jaccard lane is
  // unaffected and still runs over every candidate regardless of signature.
  const sig = contentVec ? currentEmbeddingSig(getProvider(config), config) : null;
  let bestCandidate = null;
  let bestJaccard = 0;
  let bestCosine = 0;
  let bestScore = 0;

  for (const candidate of candidates) {
    const trigramScore = jaccard(trigrams, trigramSet(candidate.content, Number(config?.dedup?.trigram_size ?? 3)));
    let cosineScore = 0;
    if (contentVec && candidate.embedding && candidate.embedding_sig === sig) {
      cosineScore = cosineSimilarity(contentVec, blobToVec(candidate.embedding));
    }
    const score = Math.max(trigramScore, cosineScore);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
      bestJaccard = trigramScore;
      bestCosine = cosineScore;
    }
  }

  const duplicate = Boolean(bestCandidate)
    && (bestJaccard >= jaccardThreshold || bestCosine >= cosineThreshold);

  if (!duplicate) {
    return { skipped: false, duplicate: false };
  }

  db.prepare(
    `UPDATE memories
     SET updated_at = ?
     WHERE id = ?`
  ).run(Date.now(), bestCandidate.id);
  writeAudit(db, 'summarize_skip_duplicate', bestCandidate.id, {
    jaccard: bestJaccard,
    cosine: bestCosine || null,
    lane: bestCosine >= cosineThreshold ? 'cosine' : 'trigram',
    new_content_excerpt: String(content ?? '').slice(0, 80)
  });

  return {
    skipped: false,
    duplicate: true,
    existingId: bestCandidate.id,
    lane: bestCosine >= cosineThreshold ? 'cosine' : 'trigram'
  };
}
