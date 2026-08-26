import { DEFAULT_CONFIG } from './config.mjs';

/**
 * Reports which config keys are in effect at a value other than the product
 * default, and which keys ccmem does not recognise at all — BY PATH ONLY.
 *
 * Paths, never values: two of the keys that can legitimately differ from the
 * default are API credentials (embedding.openai_api_key, embedding.jina_api_key),
 * and this repo forbids printing config contents. A denylist of sensitive names
 * was considered and rejected: a list nobody maintains rots, and this codebase
 * has just finished cataloguing eight config keys that rotted exactly that way.
 */

/** JSON documents itself with `_`-prefixed keys; they are not configuration. */
const DOC_KEY_PREFIX = '_';

/** Arrays are leaves here — their contents are a value, not a key namespace. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configKeys(value) {
  return Object.keys(value).filter((key) => !key.startsWith(DOC_KEY_PREFIX));
}

/** Every leaf path under `value`, for a subtree the base knows nothing about. */
function collectLeafPaths(value, prefix, out) {
  if (!isPlainObject(value)) {
    out.push(prefix);
    return;
  }

  const keys = configKeys(value);
  if (keys.length === 0) {
    // An empty object has no leaves but is still something the operator wrote,
    // so the object itself is the reportable path.
    out.push(prefix);
    return;
  }

  for (const key of keys) {
    collectLeafPaths(value[key], `${prefix}.${key}`, out);
  }
}

function walk(cfg, base, prefix, out) {
  for (const key of configKeys(cfg)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const cfgValue = cfg[key];
    const baseHasKey = isPlainObject(base) && Object.prototype.hasOwnProperty.call(base, key);

    if (!baseHasKey) {
      collectLeafPaths(cfgValue, keyPath, out.unknown);
      continue;
    }

    const baseValue = base[key];

    if (isPlainObject(cfgValue) && isPlainObject(baseValue)) {
      walk(cfgValue, baseValue, keyPath, out);
      continue;
    }

    if (isPlainObject(cfgValue) !== isPlainObject(baseValue)) {
      // One side is a subtree and the other is a scalar. mergeConfig resolves
      // this by letting the scalar replace the whole subtree, so the child
      // paths genuinely stop existing — emitting them would be a lie.
      out.nonDefault.push(keyPath);
      continue;
    }

    if (JSON.stringify(cfgValue) !== JSON.stringify(baseValue)) {
      out.nonDefault.push(keyPath);
    }
  }

  // Paths present in `base` but absent from `cfg` are deliberately not walked.
  // mergeConfig builds every merged config from a deep clone of DEFAULT_CONFIG,
  // so in production a base key can only disappear by being overwritten with a
  // scalar — which the branch above already reports at the parent path. The
  // reachable case is a test injecting a partial cfg, and reporting there would
  // force every unit test to carry a full DEFAULT_CONFIG replica.
  // If mergeConfig ever stops cloning the base, this becomes a silent gap.
}

export function collectConfigDeltas(cfg, base = DEFAULT_CONFIG) {
  const out = { nonDefault: [], unknown: [] };

  if (!isPlainObject(cfg)) {
    return out;
  }

  walk(cfg, base, '', out);
  out.nonDefault.sort();
  out.unknown.sort();

  return out;
}
