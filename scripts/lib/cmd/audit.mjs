export async function cmdAuditShow(db, { id }) {
  return db.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(id);
}
