function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function cutoffMs(days) {
  const n = Number(days ?? 30);
  const clamped = Number.isFinite(n) ? Math.max(1, Math.min(365, Math.trunc(n))) : 30;
  return Date.now() - (clamped * 86400000);
}

export function getNextPromptIdx(db, sessionId) {
  const row = db.prepare(
    `SELECT MAX(prompt_idx) AS max_prompt_idx
     FROM recent_injections
     WHERE session_id = ?`
  ).get(sessionId);

  return (row?.max_prompt_idx ?? 0) + 1;
}

export function writeRecentInjection(db, sessionId, promptIdx, injectSource, memIds, scores = null) {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, scores, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    promptIdx,
    injectSource,
    JSON.stringify(memIds),
    scores ? JSON.stringify(scores) : null,
    Date.now()
  );
}

export function parseInjectionScores(scores) {
  const parsed = parseJson(scores, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function recentInjectionHistoryForMemory(db, memId, limit = 10) {
  return db.prepare(
    `SELECT ri.created_at, ri.scores
     FROM recent_injections ri, json_each(ri.mem_ids) je
     WHERE CAST(je.value AS INTEGER) = ?
       AND ri.scores IS NOT NULL
     ORDER BY ri.created_at DESC, ri.id DESC
     LIMIT ?`
  ).all(memId, limit).map((row) => {
    const score = parseInjectionScores(row.scores).find((item) => Number(item?.id) === Number(memId)) ?? null;
    return {
      created_at: row.created_at,
      score
    };
  }).filter((row) => row.score);
}

export function countNeverInjected(db, days = 30) {
  const cutoff = cutoffMs(days);
  return Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories m
     WHERE m.status = 'active'
       AND m.decay_status IN ('active', 'probation')
       AND NOT EXISTS (
         SELECT 1
         FROM recent_injections ri, json_each(ri.mem_ids) je
         WHERE CAST(je.value AS INTEGER) = m.id
           AND ri.created_at > ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM memory_feedback f, json_each(f.injected_ids) je
         WHERE CAST(je.value AS INTEGER) = m.id
           AND f.recorded_at > ?
       )`
  ).get(cutoff, cutoff)?.n ?? 0);
}

export function listNeverInjected(db, { days = 30, limit = 20 } = {}) {
  const cutoff = cutoffMs(days);
  return db.prepare(
    `SELECT m.id, m.type, m.scope, m.content, m.trust_score, m.created_at
     FROM memories m
     WHERE m.status = 'active'
       AND m.decay_status IN ('active', 'probation')
       AND NOT EXISTS (
         SELECT 1
         FROM recent_injections ri, json_each(ri.mem_ids) je
         WHERE CAST(je.value AS INTEGER) = m.id
           AND ri.created_at > ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM memory_feedback f, json_each(f.injected_ids) je
         WHERE CAST(je.value AS INTEGER) = m.id
           AND f.recorded_at > ?
       )
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT ?`
  ).all(cutoff, cutoff, limit);
}

export function collectInjectionRows(db, days = 14) {
  const cutoff = cutoffMs(days);
  return db.prepare(
    `SELECT id, mem_ids, scores, created_at
     FROM recent_injections
     WHERE created_at > ?
     ORDER BY created_at DESC, id DESC`
  ).all(cutoff).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    mem_ids: Array.isArray(parseJson(row.mem_ids, [])) ? parseJson(row.mem_ids, []) : [],
    scores: parseInjectionScores(row.scores)
  }));
}
