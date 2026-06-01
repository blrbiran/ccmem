import { getMode, setMode } from '../mode.mjs';

export async function cmdMode(db, { mode = null } = {}) {
  if (!mode) {
    return { mode: getMode(db) };
  }

  setMode(db, mode);
  return { mode };
}
