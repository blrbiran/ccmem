export async function cmdShow(db, { id }) {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
}
