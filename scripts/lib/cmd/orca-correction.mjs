import { writeAudit } from '../audit.mjs';
import { loadConfig } from '../config.mjs';
import { resolveProjectKey } from '../project-key.mjs';
import { RETRIEVAL_ONLY_TAG } from '../retrieval-only.mjs';
import { insertMemory } from './save.mjs';

// Orca's closed corrections, keyed by Orca's correction id (spec
// docs/superpowers/specs/2026-10-21-orca-correction-import-design.md).
// Trust 0.8: the person's own ruling, curated like cerebrum_import, below
// user_explicit because the text is Orca's template (spec §7.2).
const ORCA_CORRECTION_TRUST = 0.8;
const ID_PATTERN = /^[^\s\p{Cc}]{1,200}$/u;

export class OrcaCorrectionInputError extends Error {}

export function externalRef(id) {
  return `orca:correction:${id}`;
}

export function parseOrcaCorrectionInput(text, subcommand) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OrcaCorrectionInputError('stdin is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrcaCorrectionInputError('stdin must be one JSON object');
  }
  const allowed = subcommand === 'upsert' ? ['version', 'id', 'content'] : ['version', 'id'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new OrcaCorrectionInputError(`unknown keys: ${unknown.join(', ')}`);
  }
  if (value.version !== 1) {
    throw new OrcaCorrectionInputError('version must be 1');
  }
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    throw new OrcaCorrectionInputError('id must be 1-200 characters without whitespace or control characters');
  }
  if (subcommand === 'upsert') {
    const maxChars = Number(loadConfig().save?.max_chars_per_memory ?? 500);
    if (typeof value.content !== 'string' || value.content.length === 0) {
      throw new OrcaCorrectionInputError('content must be a non-empty string');
    }
    if (Number.isFinite(maxChars) && value.content.length > maxChars) {
      throw new OrcaCorrectionInputError(`content is longer than ${maxChars} characters`);
    }
  }
  return value;
}

// Every row with the ref in this project that is not archived. A row
// quarantined at write still counts, so a re-send never piles up duplicates.
function currentRows(db, projectKey, ref) {
  return db.prepare(
    `SELECT id, content, decay_status
     FROM memories
     WHERE scope = 'project'
       AND project_key = ?
       AND decay_status != 'archived'
       AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END) WHERE value = ?)
     ORDER BY id ASC`
  ).all(projectKey, ref);
}

function archive(db, ids, action, ref) {
  const now = Date.now();
  const stmt = db.prepare(`UPDATE memories SET decay_status = 'archived', updated_at = ? WHERE id = ?`);
  for (const id of ids) {
    stmt.run(now, id);
    writeAudit(db, action, id, { external_ref: ref });
  }
}

async function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function cmdOrcaCorrectionUpsert(db, { cwd, input }) {
  const projectKey = resolveProjectKey(cwd);
  const ref = externalRef(input.id);
  return inTransaction(db, async () => {
    const current = currentRows(db, projectKey, ref);
    if (current.length === 1 && current[0].content === input.content) {
      return { action: 'unchanged', memoryId: current[0].id, externalRef: ref, projectKey, decayStatus: current[0].decay_status };
    }
    archive(db, current.map((row) => row.id), 'orca_correction_superseded', ref);
    const saved = await insertMemory(db, {
      cwd,
      content: input.content,
      scope: 'project',
      type: 'rule',
      source: 'external',
      projectKey,
      tags: ['orca-correction', ref, RETRIEVAL_ONLY_TAG],
      trust: ORCA_CORRECTION_TRUST,
      embedSync: false
    });
    return {
      action: current.length ? 'superseded' : 'inserted',
      memoryId: saved.id,
      externalRef: ref,
      projectKey,
      decayStatus: saved.decay_status
    };
  });
}

export async function cmdOrcaCorrectionWithdraw(db, { cwd, input }) {
  const projectKey = resolveProjectKey(cwd);
  const ref = externalRef(input.id);
  return inTransaction(db, async () => {
    const ids = currentRows(db, projectKey, ref).map((row) => row.id);
    archive(db, ids, 'orca_correction_withdrawn', ref);
    return { action: ids.length ? 'withdrawn' : 'absent', memoryIds: ids, externalRef: ref, projectKey };
  });
}
