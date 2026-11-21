import { resolveProjectKey } from '../project-key.mjs';

// Orca writes one terminal run outcome into ccmem (spec
// docs/superpowers/specs/2026-11-21-run-outcome-writeback-design.md §2). Phase
// 1 records the fact and offers a read-only `list` (§4): it never touches
// trust_score, recent_injections, retrieval or the stable section, and it is
// not a memories row.
const MAX_MEMORY_IDS = 64;
const OUTCOME_COUNTERS = ['succeeded', 'failed', 'exhausted', 'cancelled', 'blocked_waiting_human'];

// Text keys: 1-200 characters, no whitespace or control characters (the same
// shape orca-correction uses for its external id).
const TEXT_KEY_PATTERN = /^[^\s\p{Cc}]{1,200}$/u;
// An outcome is an open string carrying ccloop's own terminal value, stored
// verbatim. Only control characters are refused.
const OUTCOME_PATTERN = /^[^\p{Cc}]{1,200}$/u;

const ALLOWED_KEYS = ['version', 'runId', 'taskId', 'attempt', 'outcome', 'abandoned', 'memoryIds', 'observedAt'];

export class OrcaOutcomeInputError extends Error {}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * `orca-run-outcome-v1`. Exactly these keys: an extra key -- including
 * projectKey, which ccmem derives from cwd -- is refused as bad input.
 */
export function parseOrcaOutcomeInput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OrcaOutcomeInputError('stdin is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrcaOutcomeInputError('stdin must be one JSON object');
  }
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknown.length) {
    throw new OrcaOutcomeInputError(`unknown keys: ${unknown.join(', ')}`);
  }
  if (value.version !== 1) {
    throw new OrcaOutcomeInputError('version must be 1');
  }
  if (typeof value.runId !== 'string' || !TEXT_KEY_PATTERN.test(value.runId)) {
    throw new OrcaOutcomeInputError('runId must be 1-200 characters without whitespace or control characters');
  }
  if (value.taskId !== null && (typeof value.taskId !== 'string' || !TEXT_KEY_PATTERN.test(value.taskId))) {
    throw new OrcaOutcomeInputError('taskId must be null or 1-200 characters without whitespace or control characters');
  }
  if (value.attempt !== null && !isPositiveInt(value.attempt)) {
    throw new OrcaOutcomeInputError('attempt must be null or a positive integer');
  }
  if (typeof value.outcome !== 'string' || !OUTCOME_PATTERN.test(value.outcome)) {
    throw new OrcaOutcomeInputError('outcome must be 1-200 characters without control characters');
  }
  if (typeof value.abandoned !== 'boolean') {
    throw new OrcaOutcomeInputError('abandoned must be a boolean');
  }
  if (!Array.isArray(value.memoryIds) || value.memoryIds.length < 1 || value.memoryIds.length > MAX_MEMORY_IDS) {
    throw new OrcaOutcomeInputError(`memoryIds must be an array of 1-${MAX_MEMORY_IDS} positive integers`);
  }
  if (!value.memoryIds.every(isPositiveInt)) {
    throw new OrcaOutcomeInputError('memoryIds must contain only positive integers');
  }
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) {
    throw new OrcaOutcomeInputError('observedAt must be an integer millisecond timestamp');
  }

  return {
    version: 1,
    runId: value.runId,
    taskId: value.taskId ?? null,
    attempt: value.attempt ?? null,
    outcome: value.outcome,
    abandoned: value.abandoned,
    memoryIds: value.memoryIds,
    observedAt: value.observedAt
  };
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Does a stored row hold exactly this frozen payload? Same body => unchanged. */
function samePayload(row, input) {
  return row.task_id === input.taskId
    && row.attempt === input.attempt
    && row.outcome === input.outcome
    && row.abandoned === (input.abandoned ? 1 : 0)
    && row.memory_ids === JSON.stringify(input.memoryIds)
    && row.observed_at === input.observedAt;
}

export function cmdOrcaOutcomeUpsert(db, { cwd, input }) {
  const projectKey = resolveProjectKey(cwd);
  return inTransaction(db, () => {
    const existing = db.prepare(
      `SELECT task_id, attempt, outcome, abandoned, memory_ids, observed_at
       FROM orca_run_outcomes
       WHERE project_key = ? AND run_id = ?`
    ).get(projectKey, input.runId);

    if (existing) {
      // A run's terminal outcome is immutable: a different body is refused,
      // never written over the first one.
      return { version: 1, state: samePayload(existing, input) ? 'unchanged' : 'refused', projectKey };
    }

    db.prepare(
      `INSERT INTO orca_run_outcomes
         (project_key, run_id, task_id, attempt, outcome, abandoned, memory_ids, observed_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      projectKey,
      input.runId,
      input.taskId,
      input.attempt,
      input.outcome,
      input.abandoned ? 1 : 0,
      JSON.stringify(input.memoryIds),
      input.observedAt,
      Date.now()
    );

    return { version: 1, state: 'recorded', projectKey };
  });
}

function parseStoredIds(text) {
  try {
    const ids = JSON.parse(text);
    return Array.isArray(ids) ? ids.map(Number).filter(isPositiveInt) : [];
  } catch {
    return [];
  }
}

/** `--since` accepts a millisecond epoch or anything Date.parse understands. */
export function parseSinceDate(value) {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) {
    return numeric;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new OrcaOutcomeInputError(`--since is not a date: ${value}`);
  }
  return ms;
}

/**
 * Read-only: the recorded rows plus one per-memory tally. `--since` compares
 * recorded_at (the column the index covers). Nothing here writes.
 */
export function cmdOrcaOutcomeList(db, { project = null, since = null } = {}) {
  const where = [];
  const params = [];
  if (project != null) {
    where.push('project_key = ?');
    params.push(project);
  }
  if (since != null) {
    where.push('recorded_at >= ?');
    params.push(since);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const raw = db.prepare(
    `SELECT project_key, run_id, task_id, attempt, outcome, abandoned, memory_ids, observed_at, recorded_at
     FROM orca_run_outcomes${clause}
     ORDER BY recorded_at ASC, rowid ASC`
  ).all(...params);

  const rows = raw.map((row) => {
    const memoryIds = parseStoredIds(row.memory_ids);
    return {
      projectKey: row.project_key,
      runId: row.run_id,
      taskId: row.task_id,
      attempt: row.attempt,
      outcome: row.outcome,
      abandoned: Boolean(row.abandoned),
      memoryIds,
      observedAt: row.observed_at,
      recordedAt: row.recorded_at
    };
  });

  const memories = new Map();
  for (const row of rows) {
    // One run carries a memory once even if the payload repeated the id.
    for (const memoryId of new Set(row.memoryIds)) {
      const tally = memories.get(memoryId) ?? {
        memoryId,
        carried: 0,
        succeeded: 0,
        failed: 0,
        exhausted: 0,
        cancelled: 0,
        blocked_waiting_human: 0
      };
      tally.carried += 1;
      if (OUTCOME_COUNTERS.includes(row.outcome)) {
        tally[row.outcome] += 1;
      }
      memories.set(memoryId, tally);
    }
  }

  return {
    version: 1,
    rows,
    memories: [...memories.values()].sort((a, b) => a.memoryId - b.memoryId)
  };
}