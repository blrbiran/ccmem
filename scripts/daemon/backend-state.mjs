import { writeAudit } from '../lib/audit.mjs';

// Which backend runs the daemon's LLM work, given the human's preference, the
// persisted "exhausted until" state and the switch proposals (spec §5.5).
// Failover never happens on its own: an exhausted backend opens a proposal,
// and only an approved one moves work elsewhere. Going back to the preferred
// backend once its reset time has passed needs no approval.

export const BACKEND_IDS = ['claude', 'codex', 'omp'];
const DEFAULT_ORDER = ['claude', 'codex', 'omp'];
// Used when a backend reports exhaustion without saying when it resets.
const DEFAULT_EXHAUSTION_MS = 3_600_000;
const MIN_RETRY_AFTER_MS = 60_000;

export function preferredBackend(config) {
  return config?.llm?.backend ?? 'claude';
}

export function backendOrder(config) {
  const order = config?.llm?.backend_order;
  return Array.isArray(order) && order.length ? order : DEFAULT_ORDER;
}

export function exhaustedUntil(db, backend, now = Date.now()) {
  const until = db.prepare(
    `SELECT exhausted_until FROM llm_backend_state WHERE backend = ?`
  ).get(backend)?.exhausted_until;
  return until != null && until > now ? until : null;
}

export function openProposal(db) {
  return db.prepare(
    `SELECT *
     FROM llm_switch_proposals
     WHERE approved_at IS NULL AND superseded_at IS NULL
     ORDER BY id DESC
     LIMIT 1`
  ).get() ?? null;
}

function approvedProposals(db) {
  return db.prepare(
    `SELECT *
     FROM llm_switch_proposals
     WHERE approved_at IS NOT NULL AND superseded_at IS NULL
     ORDER BY id DESC`
  ).all();
}

// Read-only: the backend work would run on right now.
function pickActiveBackend(db, config, now) {
  const preferred = preferredBackend(config);
  if (exhaustedUntil(db, preferred, now) == null) {
    return preferred;
  }
  for (const proposal of approvedProposals(db)) {
    if (exhaustedUntil(db, proposal.to_backend, now) == null) {
      return proposal.to_backend;
    }
  }
  // Nothing approved is available: claude-p.mjs fails a codex/omp call fast
  // as exhausted, and lets claude answer with its own retry-after.
  return preferred;
}

export function resolveActiveBackend(db, config, now = Date.now()) {
  const preferred = preferredBackend(config);
  const active = pickActiveBackend(db, config, now);
  if (active === preferred && exhaustedUntil(db, preferred, now) == null) {
    // The preferred backend is back: every proposal is moot, and an approved
    // one being dropped is a switch back, logged like any other.
    const approved = approvedProposals(db)[0];
    db.prepare(
      `UPDATE llm_switch_proposals SET superseded_at = ? WHERE superseded_at IS NULL`
    ).run(now);
    if (approved && approved.to_backend !== preferred) {
      writeAudit(db, 'llm_backend_switch', null, {
        from: approved.to_backend,
        to: preferred,
        reason: `${preferred} reset time passed`
      });
    }
  }
  return active;
}

// For status output; writes nothing.
export function describeBackendState(db, config, now = Date.now()) {
  const exhausted = db.prepare(
    `SELECT backend, exhausted_until, last_error
     FROM llm_backend_state
     WHERE exhausted_until > ?
     ORDER BY backend`
  ).all(now);
  return {
    preferred: preferredBackend(config),
    active: pickActiveBackend(db, config, now),
    order: backendOrder(config),
    exhausted,
    proposal: openProposal(db)
  };
}

// The error an exhausted active backend fails with, without being run. The
// task stays queued until the reset (at least a minute: no busy loop).
export function exhaustedError(backend, until, now = Date.now()) {
  const error = new Error(`llm backend ${backend} quota exhausted until ${new Date(until).toISOString()}`);
  error.exhaustion = { backend, resetAt: until };
  error.retryAfter = Math.max(MIN_RETRY_AFTER_MS, until - now);
  return error;
}

function nextAvailableBackend(db, config, backend, now) {
  const order = backendOrder(config);
  const start = order.indexOf(backend);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step) % order.length];
    if (candidate !== backend && BACKEND_IDS.includes(candidate) && exhaustedUntil(db, candidate, now) == null) {
      return candidate;
    }
  }
  return null;
}

export function recordExhaustion(db, backend, { resetAt = null, error = null, config = {}, now = Date.now() } = {}) {
  const until = resetAt ?? now + DEFAULT_EXHAUSTION_MS;
  const lastError = error == null ? null : String(error).slice(0, 200);
  db.prepare(
    `INSERT INTO llm_backend_state (backend, exhausted_until, last_error, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(backend) DO UPDATE SET
       exhausted_until = excluded.exhausted_until,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).run(backend, until, lastError, now);

  let proposal = openProposal(db);
  if (!proposal) {
    const target = nextAvailableBackend(db, config, backend, now);
    if (target) {
      const reason = `${backend} quota exhausted until ${new Date(until).toISOString()}`;
      const id = Number(db.prepare(
        `INSERT INTO llm_switch_proposals (from_backend, to_backend, reason, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(backend, target, reason, now).lastInsertRowid);
      proposal = db.prepare(`SELECT * FROM llm_switch_proposals WHERE id = ?`).get(id);
    }
  }

  writeAudit(db, 'llm_backend_exhausted', null, {
    backend,
    exhausted_until: until,
    error: lastError,
    proposal_to: proposal?.to_backend ?? null
  });
  return { exhaustedUntil: until, proposal };
}

export function clearExhaustion(db, backend, now = Date.now()) {
  db.prepare(
    `UPDATE llm_backend_state SET exhausted_until = NULL, updated_at = ? WHERE backend = ?`
  ).run(now, backend);
}

export function approveProposal(db, now = Date.now()) {
  const proposal = openProposal(db);
  if (!proposal) {
    return null;
  }
  db.prepare(`UPDATE llm_switch_proposals SET approved_at = ? WHERE id = ?`).run(now, proposal.id);
  writeAudit(db, 'llm_backend_switch', null, {
    from: proposal.from_backend,
    to: proposal.to_backend,
    reason: proposal.reason
  });
  return { ...proposal, approved_at: now };
}

export function rejectProposal(db, now = Date.now()) {
  const proposal = openProposal(db);
  if (!proposal) {
    return null;
  }
  db.prepare(`UPDATE llm_switch_proposals SET superseded_at = ? WHERE id = ?`).run(now, proposal.id);
  return { ...proposal, superseded_at: now };
}

// The line session start puts at the top of the context file while a
// proposal waits for the human; null when none does.
export function proposalNotice(db) {
  const proposal = openProposal(db);
  if (!proposal) {
    return null;
  }
  const until = db.prepare(
    `SELECT exhausted_until FROM llm_backend_state WHERE backend = ?`
  ).get(proposal.from_backend)?.exhausted_until ?? proposal.created_at;
  return `ccmem: ${proposal.from_backend} quota exhausted until ${new Date(until).toISOString()}; run \`ccmem admin llm approve\` to switch background work to ${proposal.to_backend}.`;
}
