import { loadConfig } from '../config.mjs';
import { openDb } from '../db.mjs';
import { jinaEmbedding } from './jina.mjs';
import { openaiEmbedding } from './openai.mjs';
import { transformersLocal } from './transformers-local.mjs';

let cachedProvider = null;
let cachedEnabled = null;
let cachedProviderName = null;

function readConfigKv(key) {
  let db;
  try {
    db = openDb();
    const row = db.prepare(`SELECT value FROM config_kv WHERE key = ?`).get(key);
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function resolveConfig(config = null) {
  return config?.embedding ?? loadConfig().embedding ?? {};
}

function resolveEnabled(fileCfg, config = null) {
  if (typeof config?.embedding?.enabled === 'boolean') {
    return config.embedding.enabled;
  }
  const kvEnabled = readConfigKv('embedding.enabled');
  return kvEnabled != null ? kvEnabled === 'true' : Boolean(fileCfg.enabled);
}

function resolveProviderName(fileCfg, config = null) {
  const explicit = config?.embedding?.provider;
  if (explicit) {
    return explicit;
  }
  const kvProvider = readConfigKv('embedding.active_provider');
  return kvProvider ?? fileCfg.provider ?? 'transformers-local';
}

function providerByName(name) {
  switch (name) {
    case 'transformers-local':
      return transformersLocal;
    case 'openai':
      return openaiEmbedding;
    case 'jina':
      return jinaEmbedding;
    default:
      throw new Error(`Unknown embedding provider: ${name}`);
  }
}

export function getProvider(config = null) {
  const fileCfg = resolveConfig(config);
  const enabled = resolveEnabled(fileCfg, config);
  if (!enabled) {
    cachedEnabled = false;
    cachedProvider = null;
    cachedProviderName = null;
    return null;
  }

  const providerName = resolveProviderName(fileCfg, config);
  if (cachedProvider && cachedEnabled === true && cachedProviderName === providerName) {
    cachedProvider.applyConfig?.(config ?? { embedding: fileCfg });
    return cachedProvider;
  }

  const provider = providerByName(providerName);
  provider.applyConfig?.(config ?? { embedding: fileCfg });
  cachedProvider = provider;
  cachedEnabled = true;
  cachedProviderName = providerName;
  return cachedProvider;
}

export function _resetProviderCache() {
  try {
    cachedProvider?.unload?.();
  } catch {}
  cachedProvider = null;
  cachedEnabled = null;
  cachedProviderName = null;
}
