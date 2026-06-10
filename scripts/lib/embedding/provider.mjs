import { loadConfig } from '../config.mjs';
import { openDb } from '../db.mjs';
import { transformersLocal } from './transformers-local.mjs';

let cachedProvider = null;
let cachedEnabled = null;

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

export function getProvider(config = null) {
  const fileCfg = config?.embedding ?? loadConfig().embedding ?? {};
  const kvEnabled = readConfigKv('embedding.enabled');
  const enabled = kvEnabled != null ? kvEnabled === 'true' : Boolean(fileCfg.enabled);
  if (!enabled) {
    cachedEnabled = false;
    return null;
  }

  if (cachedProvider && cachedEnabled === true) {
    return cachedProvider;
  }

  const providerName = fileCfg.provider ?? 'transformers-local';
  if (providerName !== 'transformers-local') {
    throw new Error(`Unknown embedding provider: ${providerName}`);
  }

  cachedProvider = transformersLocal;
  cachedEnabled = true;
  return cachedProvider;
}

export function _resetProviderCache() {
  try {
    cachedProvider?.unload?.();
  } catch {}
  cachedProvider = null;
  cachedEnabled = null;
}
