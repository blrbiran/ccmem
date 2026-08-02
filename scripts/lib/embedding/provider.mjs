import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { openDb } from '../db.mjs';
import { jinaEmbedding } from './jina.mjs';
import { openaiEmbedding } from './openai.mjs';
import { transformersLocal } from './transformers-local.mjs';

let cachedProvider = null;
let cachedEnabled = null;
let cachedProviderName = null;

const CIRCUIT_KEYS = {
  openUntil: 'embedding.circuit_open_until',
  failures: 'embedding.consecutive_failures',
  lastProbe: 'embedding.last_probe_at'
};

function writeConfigKv(db, key, value) {
  db.prepare(
    `INSERT INTO config_kv (key, value, set_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`
  ).run(key, String(value), Date.now());
}

function clearConfigKv(db, key) {
  db.prepare(`DELETE FROM config_kv WHERE key = ?`).run(key);
}

function readConfigKvInt(key) {
  const raw = readConfigKv(key);
  // An absent key is absent, not zero. Both callers below test existence with
  // `== null`, and Number(null) is 0 — a finite number — so without this guard a
  // circuit that had never opened read as one that had.
  if (raw == null) {
    return null;
  }

  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function resolveCircuitConfig(config = null) {
  return config?.embedding?.circuit ?? loadConfig().embedding?.circuit ?? {};
}

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
  const kvEnabled = readConfigKv('embedding.enabled');
  if (kvEnabled != null) {
    return kvEnabled === 'true';
  }
  if (typeof config?.embedding?.enabled === 'boolean') {
    return config.embedding.enabled;
  }
  return Boolean(fileCfg.enabled);
}

function resolveProviderName(fileCfg, config = null) {
  const kvProvider = readConfigKv('embedding.active_provider');
  if (kvProvider) {
    return kvProvider;
  }
  const explicit = config?.embedding?.provider;
  if (explicit) {
    return explicit;
  }
  return fileCfg.provider ?? 'transformers-local';
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

export function getProviderWithCircuit(db, config = null) {
  const provider = getProvider(config);
  if (!provider) {
    return { provider: null, circuit: 'closed' };
  }

  const openUntil = readConfigKvInt(CIRCUIT_KEYS.openUntil);
  if (openUntil == null) {
    return { provider, circuit: 'closed' };
  }

  const now = Date.now();
  if (now < openUntil) {
    return { provider: null, circuit: 'open' };
  }

  const probeInterval = Number(resolveCircuitConfig(config).probe_interval_ms ?? 60000);
  const lastProbe = readConfigKvInt(CIRCUIT_KEYS.lastProbe) ?? 0;
  if ((now - lastProbe) < probeInterval) {
    return { provider: null, circuit: 'open' };
  }

  writeConfigKv(db, CIRCUIT_KEYS.lastProbe, now);
  return { provider, circuit: 'half-open' };
}

export function recordEmbedFailure(db, config = null) {
  const circuitCfg = resolveCircuitConfig(config);
  const threshold = Number(circuitCfg.failure_threshold ?? 3);
  const cooldownMs = Number(circuitCfg.cooldown_ms ?? 300000);
  const openUntil = readConfigKvInt(CIRCUIT_KEYS.openUntil);
  if (openUntil != null) {
    writeConfigKv(db, CIRCUIT_KEYS.openUntil, Date.now() + cooldownMs);
    return;
  }

  const failures = (readConfigKvInt(CIRCUIT_KEYS.failures) ?? 0) + 1;
  writeConfigKv(db, CIRCUIT_KEYS.failures, failures);
  if (failures >= threshold) {
    const until = Date.now() + cooldownMs;
    writeConfigKv(db, CIRCUIT_KEYS.openUntil, until);
    writeAudit(db, 'embedding_circuit_open', null, {
      failures,
      cooldown_ms: cooldownMs,
      open_until: until
    });
  }
}

export function recordEmbedSuccess(db) {
  const wasOpen = readConfigKv(CIRCUIT_KEYS.openUntil);
  clearConfigKv(db, CIRCUIT_KEYS.failures);
  clearConfigKv(db, CIRCUIT_KEYS.openUntil);
  clearConfigKv(db, CIRCUIT_KEYS.lastProbe);
  if (wasOpen != null) {
    writeAudit(db, 'embedding_circuit_close', null, { reason: 'probe_success' });
  }
}

export function _resetProviderCache() {
  try {
    cachedProvider?.unload?.();
  } catch {}
  cachedProvider = null;
  cachedEnabled = null;
  cachedProviderName = null;
}
