import test from 'node:test';
import assert from 'node:assert/strict';

const { importOptional } = await import('../../scripts/lib/embedding/optional-import.mjs');

// Finding 7 (dogfood). `provider: "openai"` is a documented first-class option
// with six dedicated config keys, but the `openai` package was declared nowhere
// in package.json. Selecting it crashed with a raw ESM resolver stack trace
// naming scripts/lib/embedding/openai.mjs — no mention of npm, no remedy.
// Removing the ERR_MODULE_NOT_FOUND branch re-exposes the raw error and reddens
// this test.
test('a missing optional dependency yields an actionable error, not an ESM stack trace', async () => {
  await assert.rejects(
    () => importOptional('ccmem-no-such-package-exists', 'openai'),
    (err) => {
      assert.equal(err.code, 'CCMEM_OPTIONAL_DEP_MISSING', 'must not surface the raw ERR_MODULE_NOT_FOUND');
      assert.match(err.message, /npm install ccmem-no-such-package-exists/, 'must name the exact remedy command');
      assert.match(err.message, /provider 'openai'/, 'must name which provider needed it');
      return true;
    }
  );
});

// CONTROL against over-correction: the wrapper must stay transparent on the
// success path. A version that swallowed or reshaped the module would break
// every provider while leaving the test above green.
test('a resolvable module is returned unchanged', async () => {
  const mod = await importOptional('node:path', 'openai');
  assert.equal(typeof mod.join, 'function', 'the imported module must be passed through intact');
});
