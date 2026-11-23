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

    // Settle the provider override BEFORE resolving the provider. resolveProviderName
    // reads config_kv ahead of the config file, so a leftover row here would make
    // getProvider load a DIFFERENT provider than the one named above — and, since the
    // row was written unconditionally, one `semantic on` used to shadow the file's
    // `embedding.provider` permanently with no command able to clear it.
    //
    // No --provider means "enable what the config file declares", so the override is
    // deleted rather than re-pinned. An explicit --provider is a deliberate runtime
    // override and still persists.
    const priorProvider = db.prepare("SELECT value FROM config_kv WHERE key = 'embedding.active_provider'").get()?.value ?? null;
    if (requestedProvider) {
      setConfigValue(db, 'embedding.active_provider', requestedProvider);
    } else {
      db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.active_provider'`).run();
    }

    _resetProviderCache();
    // Tester #435: resolveEnabled (provider.mjs) reads config_kv BEFORE the config
    // file, so after `semantic off` the row still says false and getProvider answered
    // null even though this call asked for enabled:true — the next line then threw
    // `Cannot read properties of null (reading 'load')`. The row must say true before
    // the provider is resolved, and must go back to what it said if the load fails.
    const priorEnabled = db.prepare("SELECT value FROM config_kv WHERE key = 'embedding.enabled'").get()?.value ?? null;
    setConfigValue(db, 'embedding.enabled', 'true');
    _resetProviderCache();
    let provider;
    try {
      // Resolving is inside the try too: an unknown --provider throws here, and that
      // must leave the switch as it was found, exactly like a provider that fails to load.
      provider = getProvider(providerCfg);
      if (provider === null) throw new Error(`embedding provider ${providerName} did not resolve`);
      await provider.load(providerCfg);
    } catch (error) {
      // Issue #413 review: a provider that cannot load (missing model, daemon down) must
      // not leave the store pinned to it. Restore whatever the file/kv said before.
      if (priorEnabled === null) {
        db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.enabled'`).run();
      } else {
        setConfigValue(db, 'embedding.enabled', priorEnabled);
      }
      if (priorProvider === null) {
        db.prepare(`DELETE FROM config_kv WHERE key = 'embedding.active_provider'`).run();
      } else {
        setConfigValue(db, 'embedding.active_provider', priorProvider);
      }
      _resetProviderCache();
      throw error;
    }
    const newModel = provider.modelId;

    // No model-change detector here. v0.13's embedding signature already handles a
    // changed model correctly and non-destructively: rows whose signature no longer
    // matches are re-embedded by vec_backfill, in batches, without ever discarding a
    // vector before its replacement exists. The detector this replaced compared the
    // loaded model against an `embedding.active_model` row and ran
    // `UPDATE memories SET embedding = NULL` across the whole store on any mismatch —
    // an overlapping second mechanism whose only distinct effect was data loss. It
    // became reachable by accident once the Finding 6 fix cleared `active_provider`
    // but left `active_model` behind, so the two keys resolved from different layers.
    setConfigValue(db, 'embedding.enabled', 'true');
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
    const state = semanticState(db, cfg);
    const provider = getProvider({ embedding: { ...cfg.embedding, enabled: true, provider: state.provider } });
    if (state.enabled && provider?.probe) {
      // Only remote providers with a probe (ollama) talk to the network here.
      // Anthropic/OpenAI/Jina probes would spend money or hit rate limits.
      try {
        const health = await provider.probe({ embedding: { ...cfg.embedding, enabled: true, provider: state.provider } });
        state.reachable = health.ok;
        state.health = health.detail;
        // A status call is allowed to pay one local embed: it is the only way
        // to report the true dimension before the first backfill batch.
        if (!state.dim) {
          await provider.load({ embedding: { ...cfg.embedding, enabled: true, provider: state.provider } });
          state.dim = provider.dim;
          state.model = provider.modelId ?? state.model;
        }
      } catch (error) {
        state.reachable = false;
        state.health = error instanceof Error ? error.message : String(error);
      }
      // semanticState computed `pending` before the provider knew its dimension, so its
      // signature was null and the answer could not be trusted. Recompute with the
      // provider that just answered (issue #413 review).
      if (provider.dim) {
        state.pending = pendingEmbeddings(
          db,
          currentEmbeddingSig(provider, { ...cfg, embedding: { ...cfg.embedding, enabled: true, provider: state.provider } })
        );
        state.embedded = embeddedCount(db);
      }
    }
    return state;
  }

  throw Object.assign(new Error(`unknown semantic verb '${verb}'`), { exitCode: 64 });
}
