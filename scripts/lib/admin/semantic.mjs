import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { getProvider, _resetProviderCache } from '../embedding/provider.mjs';
import { transformersLocal } from '../embedding/transformers-local.mjs';

function setConfigValue(db, key, value) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(key, value, Date.now());
}

function runtimeEnabled(db, cfg) {
  const kv = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.enabled'`).get()?.value ?? null;
  return kv != null ? kv === 'true' : Boolean(cfg.embedding?.enabled);
}

function pendingEmbeddings(db) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
}

function embeddedCount(db) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE embedding IS NOT NULL
       AND status = 'active'
       AND decay_status IN ('active', 'probation')`
  ).get()?.n ?? 0);
}

function semanticState(db, cfg) {
  const enabled = runtimeEnabled(db, cfg);
  const embedded = embeddedCount(db);
  const pending = pendingEmbeddings(db);

  if (!enabled) {
    return {
      status: 'disabled',
      enabled: false,
      loaded: false,
      model: cfg.embedding?.model ?? transformersLocal.modelId,
      dim: transformersLocal.dim,
      embedded,
      pending
    };
  }

  const provider = getProvider(cfg);
  return {
    status: pending > 0 ? 'pending backfill' : embedded > 0 ? 'active' : 'enabled',
    enabled: true,
    loaded: provider?.isLoaded?.() ?? false,
    model: provider?.modelId ?? cfg.embedding?.model ?? transformersLocal.modelId,
    dim: provider?.dim ?? transformersLocal.dim,
    embedded,
    pending
  };
}

export async function cmdAdminSemantic(db, { verb }) {
  const cfg = loadConfig();

  if (verb === 'on') {
    setConfigValue(db, 'embedding.enabled', 'true');
    _resetProviderCache();
    const provider = getProvider(loadConfig());
    await provider.load();
    writeAudit(db, 'semantic_enabled', null, { model: provider.modelId, dim: provider.dim });
    return semanticState(db, loadConfig());
  }

  if (verb === 'off') {
    setConfigValue(db, 'embedding.enabled', 'false');
    _resetProviderCache();
    writeAudit(db, 'semantic_disabled', null, {});
    return semanticState(db, loadConfig());
  }

  if (verb === 'status') {
    return semanticState(db, cfg);
  }

  throw Object.assign(new Error(`unknown semantic verb '${verb}'`), { exitCode: 64 });
}
