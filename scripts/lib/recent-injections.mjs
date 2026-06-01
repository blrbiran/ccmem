export function getNextPromptIdx(db, sessionId) {
  const row = db.prepare(
    `SELECT MAX(prompt_idx) AS max_prompt_idx
     FROM recent_injections
     WHERE session_id = ?`
  ).get(sessionId);

  return (row?.max_prompt_idx ?? 0) + 1;
}

export function writeRecentInjection(db, sessionId, promptIdx, injectSource, memIds) {
  db.prepare(
    `INSERT INTO recent_injections (session_id, prompt_idx, inject_source, mem_ids, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, promptIdx, injectSource, JSON.stringify(memIds), Date.now());
}
