export function getMode(db) {
  const row = db.prepare("SELECT value FROM config_kv WHERE key = 'mode'").get();
  return row?.value ?? 'active';
}

export function setMode(db, mode) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
      VALUES ('mode', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(mode, Date.now());
}
