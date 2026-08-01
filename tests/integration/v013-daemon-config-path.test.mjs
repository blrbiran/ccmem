import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-daemonenv-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { buildDaemonEnv, renderPlist } = await import('../../scripts/lib/admin/daemon.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// Finding 9 (dogfood). buildDaemonEnv does not inherit the caller's environment —
// it REBUILDS one from an allowlist, because launchd-started processes inherit no
// shell at all (commit 31c5831 added the list to *propagate* what the daemon needs).
// CCMEM_CONFIG_PATH was never on that list, so the daemon's loadConfig() always fell
// back to DEFAULT_CONFIG while the CLI and hooks read the operator's config.json.
//
// The two processes therefore derived different embedding signatures from the same
// correct signature function: the daemon wrote every vector as
// `transformers-local:Xenova/all-MiniLM-L6-v2:384` while `semantic status` compared
// against `openai:text-embedding-3-small:1536`. Nothing errored; semantic retrieval
// silently degraded to lexical-only and `pending` could never reach zero.
//
// config_kv used to paper over this (the daemon reads the DB, so the
// `embedding.active_provider` row crossed the process boundary), but the Finding 6
// fix correctly deletes that row so the config FILE regains authority — which leaves
// the daemon with no channel to the file at all unless the path propagates.
test('buildDaemonEnv propagates CCMEM_CONFIG_PATH to the daemon', () => {
  const configPath = path.join(dataRoot, 'config.json');

  const env = withEnv({ CCMEM_CONFIG_PATH: configPath }, () => buildDaemonEnv(process.env));

  assert.equal(
    env.CCMEM_CONFIG_PATH,
    configPath,
    'the daemon must see the same config file as the CLI, or the two derive different embedding signatures'
  );
});

// The launchd branch materialises the same env dict into a plist on disk. A fix that
// only reached the spawn path would leave launchd-installed daemons broken.
test('the launchd plist carries CCMEM_CONFIG_PATH', () => {
  const configPath = path.join(dataRoot, 'config.json');

  const plist = withEnv({ CCMEM_CONFIG_PATH: configPath }, () => renderPlist());

  assert.match(plist, /CCMEM_CONFIG_PATH/, 'plist must declare the key');
  assert.ok(plist.includes(configPath), 'plist must carry the resolved config path');
});

// CONTROL against over-correction: the allowlist must not become "pass everything
// through". renderPlist writes its env dict to ~/Library/LaunchAgents in plaintext,
// so an embedding API key must NOT be propagated — the daemon obtains it by reading
// the config file, which is exactly what CCMEM_CONFIG_PATH is for.
// Passes both before and after the fix by design: it exists to catch a wrong fix.
test('embedding API keys are not propagated into the daemon environment', () => {
  const env = withEnv({ OPENAI_API_KEY: 'sk-test-must-not-propagate' }, () => buildDaemonEnv(process.env));

  assert.equal(env.OPENAI_API_KEY, undefined, 'a secret must not be copied into the launchd plist on disk');
});
