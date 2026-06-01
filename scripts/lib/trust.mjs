import { loadConfig } from './config.mjs';

const DEFAULT_SOURCE_INITIAL_TRUST = {
  user_explicit: 0.9,
  cron_consolidated: 0.85,
  cerebrum_import: 0.8,
  tool_output: 0.7,
  auto_inferred: 0.5,
  external: 0.3
};

export function getSourceInitialTrust(source) {
  return loadConfig().trust?.sourceInitial?.[source]
    ?? DEFAULT_SOURCE_INITIAL_TRUST[source]
    ?? 0.5;
}

export function adjustTrust(db, memId, outcome) {
  if (outcome === 'unhelpful') {
    db.prepare(
      `UPDATE memories
       SET trust_score = MAX(0, trust_score - 0.10),
           unhelpful_count = unhelpful_count + 1,
           updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), memId);
    return;
  }

  if (outcome === 'helpful') {
    db.prepare(
      `UPDATE memories
       SET trust_score = MIN(1.0, trust_score + 0.05),
           helpful_count = helpful_count + 1,
           updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), memId);
    return;
  }

  if (outcome === 'helpful_implicit') {
    db.prepare(
      `UPDATE memories
       SET trust_score = MIN(1.0, trust_score + 0.025),
           helpful_count = helpful_count + 1,
           updated_at = ?
       WHERE id = ?`
    ).run(Date.now(), memId);
  }
}
