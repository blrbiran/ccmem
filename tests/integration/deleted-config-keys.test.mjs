import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Own data root, set before any import reads it: getConfigPath() is
// $CCMEM_DATA_ROOT/config.json, and this file writes a config.json there.
// CCMEM_CONFIG_PATH would take priority over that path, so it is cleared too.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-deleted-keys-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
delete process.env.CCMEM_CONFIG_PATH;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { DEFAULT_CONFIG, loadConfig } = await import('../../scripts/lib/config.mjs');
const { collectConfigDeltas } = await import('../../scripts/lib/config-delta.mjs');

// The six dead keys deleted by the 2026-10-18 human ruling (handoff §2.3
// item 1; docs/superpowers/specs/2026-08-19-dead-key-disposition.md). Each
// promised a behaviour no code path ever had. Users who copied
// config.default.json into ~/.claude/ccmem/config.json still carry them, so
// deleting a key must leave such a config loadable (the daemon dies loudly on a
// ConfigError; hooks and the daemon both go through loadConfig()) and must make
// diagnose name the leftover so the operator can remove it.
const DELETED = [
  'consolidation.minBatchSize',
  'cron.dead_letter_alert',
  'inject.max_chars',
  'llm.claude_p_timeout_per_task.l4_review',
  'security.cross_scope.similarity_min',
  'security.quarantine.hard_delete_days'
];

function get(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : undefined), obj);
}

test('the deleted dead keys are gone from DEFAULT_CONFIG', () => {
  for (const keyPath of DELETED) {
    assert.equal(get(DEFAULT_CONFIG, keyPath), undefined, `${keyPath} should be deleted`);
  }
});

test('a user config still holding the deleted keys loads, and diagnose lists exactly them as unknown', () => {
  writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
    inject: { max_chars: 4000 },
    llm: { claude_p_timeout_per_task: { l4_review: 90000 } },
    cron: { dead_letter_alert: 5 },
    security: {
      cross_scope: { similarity_min: 0.6 },
      quarantine: { hard_delete_days: 14 }
    },
    consolidation: { minBatchSize: 5 }
  }));

  const cfg = loadConfig();

  // The surviving neighbours still resolve to their defaults: the stale keys
  // merge in as surplus, they do not displace or corrupt their sections.
  assert.equal(cfg.inject.max_per_prompt, DEFAULT_CONFIG.inject.max_per_prompt);
  assert.equal(cfg.security.quarantine.sunset_days, DEFAULT_CONFIG.security.quarantine.sunset_days);
  assert.equal(cfg.security.cross_scope.dedup_window_days, DEFAULT_CONFIG.security.cross_scope.dedup_window_days);
  assert.equal(cfg.cron.daily_at, DEFAULT_CONFIG.cron.daily_at);
  assert.equal(cfg.consolidation.maxClusterSize, DEFAULT_CONFIG.consolidation.maxClusterSize);
  assert.equal(
    cfg.llm.claude_p_timeout_per_task.summarize_pending,
    DEFAULT_CONFIG.llm.claude_p_timeout_per_task.summarize_pending
  );

  assert.deepEqual(collectConfigDeltas(cfg).unknown, DELETED);
});
