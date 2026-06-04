function serializeDetails(details) {
  return details == null ? null : JSON.stringify(details);
}

export function writeAudit(db, action, memId = null, details = null) {
  const normalizedMemId = memId == null ? null : Number(memId);
  const affectedIds = normalizedMemId == null ? null : JSON.stringify([normalizedMemId]);
  const result = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, ?, ?)`
  ).run(Date.now(), action, affectedIds, serializeDetails(details));
  const auditId = Number(result.lastInsertRowid);

  if (normalizedMemId != null) {
    db.prepare(
      `INSERT OR IGNORE INTO audit_log_targets (audit_id, mem_id)
       VALUES (?, ?)`
    ).run(auditId, normalizedMemId);
  }

  return auditId;
}

export function writeAuditMany(db, action, memIds = [], details = null) {
  const normalized = [...new Set(memIds.map((id) => Number(id)).filter(Number.isFinite))];
  const result = db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, ?, ?)`
  ).run(Date.now(), action, normalized.length ? JSON.stringify(normalized) : null, serializeDetails(details));
  const auditId = Number(result.lastInsertRowid);

  if (normalized.length) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO audit_log_targets (audit_id, mem_id)
       VALUES (?, ?)`
    );

    for (const memId of normalized) {
      stmt.run(auditId, memId);
    }
  }

  return auditId;
}
