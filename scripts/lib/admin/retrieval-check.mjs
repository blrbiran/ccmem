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

  // A superseded or archived row cannot satisfy a benchmark expectation.
  const matchSubstring = db.prepare(
    `SELECT id FROM memories
     WHERE status = 'active'
       AND decay_status IN ('active', 'probation')
       AND instr(content, ?) > 0`
  );
  const expected = items.map((item) => {
    if (Object.hasOwn(item, 'expected_ids')) {
      throw new Error('E_CORPUS_FORMAT: replace expected_ids with expected_substring for positive cases');
    }
    const needle = item.expected_substring;
    if (needle === undefined) return null;

    const matches = matchSubstring.all(needle);
    if (!matches.length) {
      throw new Error(`E_CORPUS_STALE: expected "${needle}" matched no memory`);
    }
    return new Set(matches.map((row) => row.id));
  });

  const runs = [];
  for (const [index, item] of items.entries()) {
    const { rows, retrievalPath, gated, total } = await retrieveMemories(
      db, item.prompt, projectKey, config, { relevanceFloor: true }
    );
    const firstHitIndex = rows.findIndex((row) => expected[index]?.has(row.id));
    runs.push({ first_hit_rank: firstHitIndex >= 0 ? firstHitIndex + 1 : null });
    process.stdout.write(`run ${index + 1}: retrievalPath=${retrievalPath ?? 'n/a'} gated=${gated ?? 0} total=${total}\n`);
  }

  const metrics = ks.map((value) => {
    const hits = runs.filter((run) => run.first_hit_rank != null && run.first_hit_rank <= value).length;
    const recall = runs.length ? hits / runs.length : 0;
    const precision = runs.length ? hits / (value * runs.length) : 0;
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
    adversarial: expected.filter((ids) => ids === null).length,
    metrics,
    recall_at_3: recallAt3,
    run_at: runAt,
    corpus_path: corpusPath
  };
}
