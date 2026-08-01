import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../scripts/lib/config.mjs';

/**
 * Finding 12: loadConfig() used to return DEFAULT_CONFIG outright whenever
 * CCMEM_CONFIG_PATH was unset, instead of reading the config file that lives
 * next to the store. That variable has no persistent source — not a shell rc,
 * not launchctl, not Claude settings — so it is present only in shells where
 * someone exported it by hand and absent everywhere else. The result was two
 * populations of processes running two different embedding providers against
 * one store: hooks without the variable embedded queries with MiniLM, produced
 * a signature no stored vector carried, and retrieval degraded to lexical in
 * silence.
 *
 * The fallback must track the data root rather than hardcode a second copy of
 * it, so that moving the store (CCMEM_DATA_ROOT, or a future default other
 * than ~/.claude/ccmem) moves the config with it instead of splitting them.
 */

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function tempRoot(configBody) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ccmem-cfg-'));
  if (configBody !== undefined) {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify(configBody));
  }
  return root;
}

test('no CCMEM_CONFIG_PATH: reads config.json from the data root', () => {
  const root = tempRoot({ embedding: { provider: 'openai', openai_model: 'text-embedding-3-small' } });
  try {
    const cfg = withEnv({ CCMEM_CONFIG_PATH: undefined, CCMEM_DATA_ROOT: root }, () => loadConfig());
    // Without the fallback this is 'transformers-local' from DEFAULT_CONFIG,
    // which is exactly the signature split Finding 12 describes.
    assert.equal(cfg.embedding.provider, 'openai');
    assert.equal(cfg.embedding.openai_model, 'text-embedding-3-small');
    // Merge semantics must match the explicit-path branch: keys the file omits
    // still come from DEFAULT_CONFIG.
    assert.equal(cfg.embedding.backfill_batch_size, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no CCMEM_CONFIG_PATH and no config.json in the data root: DEFAULT_CONFIG', () => {
  const root = tempRoot(undefined);
  try {
    const cfg = withEnv({ CCMEM_CONFIG_PATH: undefined, CCMEM_DATA_ROOT: root }, () => loadConfig());
    assert.equal(cfg.embedding.provider, 'transformers-local');
    assert.equal(cfg.embedding.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CCMEM_CONFIG_PATH still wins over the data-root config.json', () => {
  const root = tempRoot({ embedding: { provider: 'openai' } });
  const explicitRoot = tempRoot({ embedding: { provider: 'jina' } });
  try {
    const cfg = withEnv(
      { CCMEM_CONFIG_PATH: path.join(explicitRoot, 'config.json'), CCMEM_DATA_ROOT: root },
      () => loadConfig()
    );
    assert.equal(cfg.embedding.provider, 'jina');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(explicitRoot, { recursive: true, force: true });
  }
});

test('CCMEM_CONFIG_PATH set but missing: falls through to the data-root config.json', () => {
  const root = tempRoot({ embedding: { provider: 'openai' } });
  try {
    const cfg = withEnv(
      { CCMEM_CONFIG_PATH: path.join(root, 'does-not-exist.json'), CCMEM_DATA_ROOT: root },
      () => loadConfig()
    );
    // A pointed-at-nothing variable must not be more authoritative than the
    // store's own config — it was already ignored before this change, it is
    // still ignored, and now the fallback below it actually resolves.
    assert.equal(cfg.embedding.provider, 'openai');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
