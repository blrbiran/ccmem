import { readFileSync } from 'node:fs';
import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { retrieveMemories } from '../retrieval.mjs';

function defaultCorpusPath() {
  return new URL('../benchmark/corpus.json', import.meta.url).pathname;
}

function parseKList(raw) {
  const values = String(raw ?? '1,3,5')
    .split(',')
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  return values.length ? [...new Set(values)] : [1, 3, 5];
}

export async function cmdRetrievalCheck(db, { corpus = null, k = null, cwd = process.cwd() } = {}) {
  const corpusPath = corpus ?? defaultCorpusPath();
  const items = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const ks = parseKList(k);
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    embedding: {
      ...(baseConfig.embedding ?? {}),
      enabled: false
    }
  };
  const projectKey = resolveProjectKey(cwd);
  const results = [];

  for (const item of items) {
    const { rows } = await retrieveMemories(db, item.prompt, projectKey, config);
    const expected = new Set(Array.isArray(item.expected_ids) ? item.expected_ids.map((id) => Number(id)) : []);
    const retrievedIds = rows.map((row) => Number(row.id));
    const firstHitIndex = retrievedIds.findIndex((id) => expected.has(id));
    results.push({
      first_hit_rank: firstHitIndex >= 0 ? firstHitIndex + 1 : null
    });
  }

  const metrics = ks.map((value) => {
    const hits = results.filter((result) => result.first_hit_rank != null && result.first_hit_rank <= value).length;
    const recall = results.length ? hits / results.length : 0;
    const precision = results.length ? hits / (value * results.length) : 0;
    return { k: value, recall, precision };
  });

  const recallAt3 = metrics.find((metric) => metric.k === 3)?.recall ?? null;
  const runAt = Date.now();
  writeAudit(db, 'retrieval_check_run', null, {
    total: items.length,
    recall_at_3: recallAt3 == null ? null : +recallAt3.toFixed(4),
    run_at: runAt
  });

  return {
    total: items.length,
    adversarial: items.filter((item) => !Array.isArray(item.expected_ids) || item.expected_ids.length === 0).length,
    metrics,
    recall_at_3: recallAt3,
    run_at: runAt,
    corpus_path: corpusPath
  };
}
