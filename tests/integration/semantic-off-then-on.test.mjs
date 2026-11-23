import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-sem-on-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const configPath = path.join(dataRoot, 'config.json');
writeFileSync(configPath, JSON.stringify({ embedding: { enabled: false, provider: 'transformers-local' } }));
process.env.CCMEM_CONFIG_PATH = configPath;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdAdminSemantic } = await import('../../scripts/lib/admin/semantic.mjs');

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

// Tester #435: `admin semantic off` then `admin semantic on` threw
// `TypeError: Cannot read properties of null (reading 'load')` at semantic.mjs:103.
// `off` leaves `embedding.enabled=false` in config_kv; resolveEnabled reads that row
// FIRST, so the `on` path's getProvider(enabled:true) still answered null, and the
// next line dereferenced it. Turning embeddings back on must work.
test('semantic on after semantic off enables the provider instead of crashing', async () => {
  const db = openDb();
  const off = await cmdAdminSemantic(db, { verb: 'off' });
  assert.equal(off.enabled, false);

  const on = await cmdAdminSemantic(db, { verb: 'on' });
  assert.equal(on.enabled, true);
  assert.equal(on.provider, 'transformers-local');

  const status = await cmdAdminSemantic(db, { verb: 'status' });
  assert.equal(status.enabled, true);
  db.close();
});

// A provider that cannot load must still leave the switch as it found it (the #413
// review rule kept for the new ordering): the kv row is restored, not left saying
// "enabled" over a provider that never loaded.
test('a provider that fails to load leaves embedding.enabled as it was', async () => {
  const db = openDb();
  await cmdAdminSemantic(db, { verb: 'off' });
  await assert.rejects(cmdAdminSemantic(db, { verb: 'on', provider: 'no-such-provider' }));
  const row = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.enabled'`).get();
  assert.equal(row?.value ?? null, 'false');
  db.close();
});
