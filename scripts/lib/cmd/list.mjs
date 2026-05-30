export async function cmdList(db, { limit = 20 } = {}) {
  return db.prepare(
    `SELECT id, scope, project_key, type, content, pinned
     FROM memories
     ORDER BY pinned DESC, last_touched_at DESC
     LIMIT ?`
  ).all(limit);
}
