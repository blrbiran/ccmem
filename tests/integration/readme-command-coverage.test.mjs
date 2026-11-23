import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/**
 * Tester #436: the README fell behind the code systematically — it named a `--provider` list that
 * left out `ollama`, mentioned neither `orca-outcome` nor `orca-correction` nor `list --json`, and
 * `admin diagnose --config` reported `embedding.remote_host` as unknown because that key was read
 * by the code but never declared. Each check below reads the authority (the CLI's own list, the
 * default config) rather than restating it, so the two cannot drift apart again silently.
 */
test('README names every embedding provider the CLI accepts (#436)', () => {
  const cli = readFileSync(path.join(ROOT, 'scripts/cli.mjs'), 'utf8');
  const listed = /admin semantic <on\|off\|status> \[--provider <([^>]+)>\]/.exec(cli);
  assert.ok(listed, 'the CLI still prints its --provider list');
  for (const provider of listed[1].split('|')) {
    assert.match(README, new RegExp(`--provider [^\\n]*\\b${provider}\\b`), `README names the ${provider} provider`);
  }
});

test('README covers the verbs Orca depends on and the JSON read path (#436)', () => {
  for (const phrase of ['orca-outcome', 'orca-correction', 'list --json']) {
    assert.ok(README.includes(phrase), `README mentions ${phrase}`);
  }
});

test('every embedding key the code reads is declared, so diagnose reports no unknown key (#436)', () => {
  const defaults = JSON.parse(readFileSync(path.join(ROOT, 'config.default.json'), 'utf8')).embedding;
  const sources = ['scripts/lib/embedding/transformers-local.mjs', 'scripts/lib/embedding/ollama.mjs', 'scripts/lib/embedding/openai.mjs'];
  const read = new Set();
  for (const source of sources) {
    const text = readFileSync(path.join(ROOT, source), 'utf8');
    // snake_case only: `cfg.baseUrl` is the module's own variable, not a config key.
    for (const match of text.matchAll(/cfg\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?!\s*[:=]\s*[a-zA-Z_]*\.)/g)) read.add(match[1]);
  }
  // `cfg` is the embedding block in these modules; the keys they read must be declared.
  for (const key of read) {
    assert.ok(Object.hasOwn(defaults, key), `embedding.${key} is read by code but absent from config.default.json`);
  }
});

test('README says how to run the suite, and the runner it names resolves its interpreter (#451)', () => {
  assert.match(README, /npm test/);
  const runner = readFileSync(path.join(ROOT, 'scripts/run-tests.sh'), 'utf8');
  assert.match(runner, /CCMEM_INSTALL_NODE_PATH/, 'the runner takes the interpreter override it documents');
  assert.doesNotMatch(runner, /PATH="\$stub_bin:\$PATH" \/usr\/local\/bin\/node/, 'the runner must not hardcode node');
});
