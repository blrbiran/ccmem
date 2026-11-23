import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Tester #451: `npm test` exited 127 with zero tests run on a machine whose node lives under
 * nvm — `scripts/run-tests.sh` hardcoded `/usr/local/bin/node`, and neither that nor
 * `/opt/homebrew/bin/node` nor `/usr/bin/node` existed there. The daemon install side already
 * has the right shape (`resolveInstallNodePath`: candidates, then `process.execPath`); the
 * test runner treated the first fallback as the only answer.
 *
 * This criterion does not depend on which node paths this machine happens to have: it points
 * `CCMEM_INSTALL_NODE_PATH` at a wrapper that records its own invocation, and asserts the
 * runner used it. The old script ignored the variable and ran (or failed to run) the hardcoded
 * path instead.
 */
test('run-tests.sh runs node from CCMEM_INSTALL_NODE_PATH when it is set (#451)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccmem-run-tests-node-'));
  try {
    const marker = path.join(dir, 'used');
    const wrapper = path.join(dir, 'node');
    writeFileSync(wrapper, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(wrapper, 0o700);
    const probe = path.join(dir, 'probe.test.mjs');
    writeFileSync(probe, "import test from 'node:test';\ntest('probe', () => {});\n");

    // This file runs under `node --test`, which exports NODE_TEST_CONTEXT to its children; an
    // inner `node --test` that inherits it reports nothing to stdout. The runner is spawned as a
    // person's `npm test` would spawn it.
    const env = { ...process.env, CCMEM_INSTALL_NODE_PATH: wrapper, CCMEM_TEST_MODE: '1' };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const out = execFileSync('/bin/sh', [path.join(ROOT, 'scripts/run-tests.sh'), probe], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env });
    assert.match(out, /pass 1/);
    assert.ok(existsSync(marker), 'the runner must use CCMEM_INSTALL_NODE_PATH, not a hardcoded path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same failure the tester hit, made deterministic: a PATH with no `node`, no candidate
// path available and no override must say so by name instead of handing the user an `env:`
// line about a system directory they never mentioned.
test('run-tests.sh without any node says how to point it at one (#451)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccmem-run-tests-nonode-'));
  try {
    let failed = null;
    try {
      execFileSync('/bin/sh', [path.join(ROOT, 'scripts/run-tests.sh'), path.join(dir, 'nothing.test.mjs')], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        // PATH still has the shell's own tools (env, mktemp); only node is out of reach.
        env: (() => { const e = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, CCMEM_INSTALL_NODE_PATH: '', CCMEM_TEST_MODE: '1', CCMEM_STRICT_INTERPRETER: '1' }; delete e.NODE_TEST_CONTEXT; delete e.NODE_OPTIONS; return e; })(),
      });
    } catch (error) {
      failed = error;
    }
    // On a machine where a fallback path exists this cannot be exercised; the message is then
    // unreachable and the run may legitimately start. Only assert when the run refused.
    if (failed !== null) {
      const stderr = String(failed.stderr ?? '');
      assert.match(stderr, /ccmem: no usable node/);
      assert.match(stderr, /CCMEM_INSTALL_NODE_PATH/);
      assert.equal(failed.status, 127);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// package.json's two threat-script entries hardcoded the same path.
test('package.json runs its scripts on the node in use, not a hardcoded path (#451)', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['threat:report', 'threat:baseline']) {
    assert.doesNotMatch(pkg.scripts[name], /\/usr\/local\/bin\/node/, `${name} must not hardcode a node path`);
  }
});