import os from 'node:os';
import path from 'node:path';

/**
 * The one place that decides where ccmem's files live.
 *
 * db.mjs re-exports getDataRoot() for its existing importers; config.mjs needs
 * the same answer but cannot import db.mjs, which already imports config.mjs.
 * Resolving it separately in each would be two sources of truth for one
 * location — and Finding 12 is what that costs: the config file and the store
 * drifted apart, so half the processes ran a different embedding provider
 * against the same database and retrieval degraded to lexical in silence.
 *
 * Moving the default (e.g. to ~/.ccmem) means editing this function only.
 */
export function getDataRoot() {
  return process.env.CCMEM_DATA_ROOT ?? path.join(os.homedir(), '.claude', 'ccmem');
}

/** The config file that belongs to the store at getDataRoot(). */
export function getConfigPath() {
  return path.join(getDataRoot(), 'config.json');
}
