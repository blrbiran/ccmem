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

function activeProviderName(db, cfg) {
  return db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.active_provider'`).get()?.value
    ?? cfg.embedding?.provider
    ?? 'transformers-local';
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
  const providerName = activeProviderName(db, cfg);

  if (!enabled) {
    return {
      status: 'disabled',
      enabled: false,
      loaded: false,
      provider: providerName,
      model: cfg.embedding?.model ?? transformersLocal.modelId,
      dim: transformersLocal.dim,
      embedded,
      pending
    };
  }

  const provider = getProvider({ embedding: { ...cfg.embedding, enabled: true, provider: providerName } });
  return {
    status: pending > 0 ? 'pending backfill' : embedded > 0 ? 'active' : 'enabled',
    enabled: true,
    loaded: provider?.isLoaded?.() ?? false,
    provider: providerName,
    model: provider?.modelId ?? cfg.embedding?.model ?? transformersLocal.modelId,
    dim: provider?.dim ?? transformersLocal.dim,
    embedded,
    pending
  };
}

export async function cmdAdminSemantic(db, { verb, provider: requestedProvider = null } = {}) {
  const cfg = loadConfig();

  if (verb === 'on') {
    const providerName = requestedProvider ?? cfg.embedding?.provider ?? 'transformers-local';
    const providerCfg = { embedding: { ...cfg.embedding, enabled: true, provider: providerName } };
    const currentModel = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.active_model'`).get()?.value ?? null;
    _resetProviderCache();
    const provider = getProvider(providerCfg);
    await provider.load(providerCfg);
    const newModel = provider.modelId;

    if (currentModel && currentModel !== newModel) {
      const nullified = db.prepare(`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL`).run().changes;
      writeAudit(db, 'embedding_model_switched', null, {
        from_model: currentModel,
        to_model: newModel,
        nullified_count: nullified
      });
    }

    setConfigValue(db, 'embedding.enabled', 'true');
    setConfigValue(db, 'embedding.active_model', newModel);
    setConfigValue(db, 'embedding.active_provider', providerName);
    writeAudit(db, 'semantic_enabled', null, { model: newModel, dim: provider.dim, provider: providerName });
    return semanticState(db, cfg);
  }

  if (verb === 'off') {
    setConfigValue(db, 'embedding.enabled', 'false');
    _resetProviderCache();
    writeAudit(db, 'semantic_disabled', null, {});
    return semanticState(db, cfg);
  }

  if (verb === 'status') {
    return semanticState(db, cfg);
  }

  throw Object.assign(new Error(`unknown semantic verb '${verb}'`), { exitCode: 64 });
}
