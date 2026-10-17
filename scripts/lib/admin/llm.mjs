import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  approveProposal,
  BACKEND_IDS,
  describeBackendState,
  rejectProposal
} from '../../daemon/backend-state.mjs';
import { loadConfig } from '../config.mjs';
import { backupFile, ensureDir, writeOwnedFile } from '../install/manifest.mjs';
import { getConfigPath } from '../paths.mjs';

// `ccmem admin llm ...`: show and change which backend runs the daemon's LLM
// work, and answer a failover proposal (spec §5.5, G5).

// The file loadConfig reads, so a change lands where it takes effect.
function configFilePath() {
  const userPath = process.env.CCMEM_CONFIG_PATH;
  return userPath && existsSync(userPath) ? userPath : getConfigPath();
}

// Sets llm.<key> in config.json, backing the file up first when it exists.
function writeLlmSetting(key, value) {
  const file = configFilePath();
  let parsed = {};
  let backupPath = null;
  if (existsSync(file)) {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
    backupPath = backupFile(file);
  } else {
    ensureDir(path.dirname(file));
  }
  const llm = parsed.llm && typeof parsed.llm === 'object' ? parsed.llm : {};
  parsed.llm = { ...llm, [key]: value };
  writeOwnedFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return { config_path: file, backup_path: backupPath };
}

function assertBackend(id) {
  if (!BACKEND_IDS.includes(id)) {
    throw new Error(`unknown backend '${id}' (one of ${BACKEND_IDS.join(', ')})`);
  }
}

// One line, shared with `admin daemon status`.
export function formatLlmStatus(state) {
  const exhausted = state.exhausted.length
    ? state.exhausted.map((row) => `${row.backend}@${new Date(row.exhausted_until).toISOString()}`).join(',')
    : 'none';
  const proposal = state.proposal ? `${state.proposal.from_backend}->${state.proposal.to_backend}` : 'none';
  return `ccmem: llm backend=${state.active} preferred=${state.preferred} order=${state.order.join(',')} exhausted=${exhausted} proposal=${proposal}`;
}

export function cmdAdminLlm(db, { verb, value = null } = {}) {
  if (verb === 'status') {
    return { status: 'ok', state: describeBackendState(db, loadConfig()) };
  }

  if (verb === 'use') {
    assertBackend(value);
    return { status: 'set', backend: value, ...writeLlmSetting('backend', value) };
  }

  if (verb === 'order') {
    const order = String(value ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (!order.length || new Set(order).size !== order.length) {
      throw new Error(`order must list distinct backends, e.g. ${BACKEND_IDS.join(',')}`);
    }
    order.forEach(assertBackend);
    return { status: 'set', order, ...writeLlmSetting('backend_order', order) };
  }

  if (verb === 'approve') {
    const proposal = approveProposal(db);
    return proposal ? { status: 'approved', proposal } : { status: 'no_proposal' };
  }

  if (verb === 'reject') {
    const proposal = rejectProposal(db);
    return proposal ? { status: 'rejected', proposal } : { status: 'no_proposal' };
  }

  throw new Error(`unknown admin llm verb '${verb}'`);
}
