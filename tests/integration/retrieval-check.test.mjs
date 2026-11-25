import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tester #492: the shipped corpus named numeric ids (memories 1 and 2). Those rows are gone or
// superseded in a real store, so every positive case missed and the benchmark reported 0% forever.
// The corpus now names a content fragment instead, and a fragment that matches no memory is a stale
// corpus — refused loudly instead of being scored.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/cli.mjs');
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-retrieval-check-'));
const workCwd = mkdtempSync(path.join(tmpdir(), 'ccmem-retrieval-check-cwd-'));

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
delete process.env.CCMEM_CONFIG_PATH;

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(workCwd, { recursive: true, force: true });
});

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};
delete env.CCMEM_CONFIG_PATH;

function writeCorpus(name, items) {
  const corpusPath = path.join(dataRoot, name);
  writeFileSync(corpusPath, JSON.stringify(items));
  return corpusPath;
}

function runCheck(corpusPath) {
  return spawnSync(process.execPath, [CLI, 'admin', '--', 'retrieval-check', '--corpus', corpusPath, '--k', '1,3'], {
    cwd: workCwd,
    env,
    encoding: 'utf8'
  });
}

test('a corpus whose expected substring matches no memory fails loudly instead of scoring 0% (#492)', () => {
  const corpusPath = writeCorpus('stale-corpus.json', [
    { prompt: 'auth retry failures', expected_substring: 'auth retry failures', note: 'auth retry handling' }
  ]);

  const result = runCheck(corpusPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_CORPUS_STALE: expected "auth retry failures" matched no memory/);
  assert.doesNotMatch(result.stdout, /recall@/);
});

test('an old ID-based positive case is refused instead of being counted as adversarial', () => {
  const corpusPath = writeCorpus('legacy-corpus.json', [
    { prompt: 'auth retry failures', expected_ids: [1] }
  ]);

  const result = runCheck(corpusPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_CORPUS_FORMAT: replace expected_ids with expected_substring/);
  assert.doesNotMatch(result.stdout, /recall@/);
});

test('a corpus whose expected substring matches a live memory scores above zero, and every run names its path', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: workCwd,
    content: 'pnpm workspace install command',
    scope: 'global',
    type: 'fact'
  });
  db.close();

  const corpusPath = writeCorpus('live-corpus.json', [
    { prompt: 'pnpm workspace install command', expected_substring: 'workspace install command', note: 'workspace tooling' },
    { prompt: 'totally unrelated adversarial query', note: 'adversarial miss' }
  ]);

  const result = runCheck(corpusPath);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /recall@1: 50\.0%/);
  assert.match(result.stdout, /recall@3: 50\.0%/);
  assert.match(result.stdout, /Corpus: 2 items \(1 adversarial\)/);
  assert.match(result.stdout, /^run 1: retrievalPath=B-off gated=0 total=1$/m);
  assert.match(result.stdout, /^run 2: retrievalPath=B-off gated=0 total=0$/m);
});
