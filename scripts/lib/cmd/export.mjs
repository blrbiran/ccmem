export function cmdExport(db, { scope = null, projectKey = null } = {}) {
  let sql = `SELECT id, scope, project_key, type, content, pinned, source,
                    trust_score, tags, created_at, updated_at
             FROM memories
             WHERE decay_status IN ('active', 'probation')`;
  const params = [];

  if (scope === 'global') {
    sql += ` AND scope = 'global'`;
  } else if (scope === 'project') {
    sql += ` AND scope = 'project' AND project_key = ?`;
    params.push(projectKey);
  }

  sql += ` ORDER BY id ASC`;
  const memories = db.prepare(sql).all(...params);

  return {
    version: '0.7',
    exported_at: Date.now(),
    memories
  };
}
