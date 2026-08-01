import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-semprov-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminSemantic } = await import('../../scripts/lib/admin/semantic.mjs');
const { getProvider, _resetProviderCache } = await import('../../scripts/lib/embedding/provider.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

function readProviderKv(db) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.active_provider'`).get()?.value ?? null;
}

function setProviderKv(db, value) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('embedding.active_provider', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(value, Date.now());
}

// Finding 6 (dogfood). `admin semantic on` used to write `embedding.active_provider`
// into config_kv UNCONDITIONALLY. Because resolveProviderName (provider.mjs:69-79)
// reads config_kv BEFORE the config file, one `semantic on` permanently shadowed
// the file's `embedding.provider`, with no command able to clear it: an operator
// who declared `"provider": "openai"` in config.json and restarted the daemon kept
// getting transformers-local forever, with no signal explaining why.
//
// `semantic on` WITHOUT --provider means "enable whatever the config file declares",
// so it must clear the override rather than re-pin it.
test('semantic on without --provider clears the config_kv provider override', async () => {
  const db = openDb();
  setProviderKv(db, 'jina');
  assert.equal(readProviderKv(db), 'jina', 'precondition: kv override is set');

  await cmdAdminSemantic(db, { verb: 'on' });

  assert.equal(
    readProviderKv(db),
    null,
    'embedding.active_provider must be DELETED so the config file regains authority'
  );

  // The user-facing outcome: the file-declared provider now actually resolves.
  _resetProviderCache();
  const provider = getProvider({ embedding: { enabled: true, provider: 'transformers-local' } });
  assert.equal(provider.modelId, 'Xenova/all-MiniLM-L6-v2', 'file-declared provider must win once the kv row is gone');
});

// CONTROL against over-correction: the fix must not turn into "always delete".
// An explicit --provider is a deliberate runtime override and must still persist.
// This test passes both before and after the fix by design — it exists to catch a
// wrong fix, not to prove the right one.
test('semantic on --provider still writes the explicit override to config_kv', async () => {
  const db = openDb();
  db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.active_provider'`).run();

  await cmdAdminSemantic(db, { verb: 'on', provider: 'transformers-local' });

  assert.equal(
    readProviderKv(db),
    'transformers-local',
    'an explicitly requested provider must be persisted as a runtime override'
  );
});

// The command computed `providerName` from the config file but let getProvider
// resolve the provider independently — and getProvider reads config_kv first.
// With a stale kv row the two disagreed: the command loaded (and reported) one
// provider while recording another.
test('the loaded provider matches the provider the command reports', async () => {
  const db = openDb();
  setProviderKv(db, 'jina');

  const result = await cmdAdminSemantic(db, { verb: 'on' });

  assert.equal(result.provider, 'transformers-local', 'reported provider comes from the config file');
  assert.equal(result.model, 'Xenova/all-MiniLM-L6-v2', 'and the model reported is the one actually loaded');
});
