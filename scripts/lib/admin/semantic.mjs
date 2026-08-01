import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { getProvider, _resetProviderCache } from '../embedding/provider.mjs';
import { currentEmbeddingSig } from '../embedding/signature.mjs';
import { transformersLocal } from '../embedding/transformers-local.mjs';
// Imported, not redefined. A local signature-blind copy reported "pending: 0"
// on a store that was fully embedded but entirely stale after migration 016,
// while `admin diagnose --retrieval` reported thousands of stale vectors on the
// same store — two ccmem commands contradicting each other during exactly the
// incident the embedding signature exists to make legible.
import { pendingEmbeddings } from '../../daemon/tasks/vec-backfill.mjs';

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
  const providerName = activeProviderName(db, cfg);
  // Signature-aware: "pending" means "rows a vec_backfill run would still
  // touch", which includes rows embedded under a superseded provider/model/dim.
  const sigCfg = { ...cfg, embedding: { ...cfg.embedding, enabled: true, provider: providerName } };
  const pending = pendingEmbeddings(db, currentEmbeddingSig(getProvider(sigCfg), sigCfg));

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

    // Settle the provider override BEFORE resolving the provider. resolveProviderName
    // reads config_kv ahead of the config file, so a leftover row here would make
    // getProvider load a DIFFERENT provider than the one named above — and, since the
    // row was written unconditionally, one `semantic on` used to shadow the file's
    // `embedding.provider` permanently with no command able to clear it.
    //
    // No --provider means "enable what the config file declares", so the override is
    // deleted rather than re-pinned. An explicit --provider is a deliberate runtime
    // override and still persists.
    if (requestedProvider) {
      setConfigValue(db, 'embedding.active_provider', requestedProvider);
    } else {
      db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.active_provider'`).run();
    }

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
