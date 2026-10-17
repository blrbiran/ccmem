import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { renderRetrievedBlock, renderStableContext } from './render.mjs';

export const CONTEXT_DIR = '.ccmem';
export const CONTEXT_FILE = 'context.md';
export const CONTEXT_EMPTY_SENTINEL = '<!-- ccmem: no relevant memories -->\n';
export const MAX_CONTEXT_FILE_BYTES = 12288;
export const STABLE_SECTION_MAX_BYTES = 4096;
// Project lines reserved inside the stable section before globals fill it.
export const PROJECT_STABLE_SHARE_BYTES = 2048;
// Retrieved rows keep the 8 KB they had before the stable section moved into
// this file, measured the same way as then: hash line + retrieved block.
const RETRIEVED_MAX_BYTES = MAX_CONTEXT_FILE_BYTES - STABLE_SECTION_MAX_BYTES;
const HASH_LINE_BYTES = Buffer.byteLength('<!-- content-hash: 00000000 -->\n', 'utf8');
const EXCLUDE_RULE = '.ccmem/';
const GITDIR_PREFIX = 'gitdir:';
const GITIGNORE_HINT = 'ccmem: hint — add .ccmem/ to .gitignore to exclude context cache\n';
const STALE_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function resolveGitDir(cwd) {
  const gitPath = path.join(cwd, '.git');
  if (!existsSync(gitPath)) {
    return null;
  }

  try {
    if (statSync(gitPath).isDirectory()) {
      return gitPath;
    }

    const raw = readFileSync(gitPath, 'utf8').trim();
    if (!raw.startsWith(GITDIR_PREFIX)) {
      return null;
    }

    const gitDir = raw.slice(GITDIR_PREFIX.length).trim();
    return path.resolve(cwd, gitDir);
  } catch {
    return null;
  }
}

function hasExcludeRule(text) {
  return text.split('\n').some((line) => line.trim() === EXCLUDE_RULE);
}

export function ensureContextExcluded(cwd) {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) {
    return false;
  }

  try {
    const infoDir = path.join(gitDir, 'info');
    const excludePath = path.join(infoDir, 'exclude');
    mkdirSync(infoDir, { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (hasExcludeRule(existing)) {
      return true;
    }

    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(excludePath, `${prefix}${EXCLUDE_RULE}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function maybeWarnGitignore(cwd) {
  try {
    const gitignorePath = path.join(cwd, '.gitignore');
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignore.includes(EXCLUDE_RULE)) {
      process.stderr.write(GITIGNORE_HINT);
    }
  } catch {
    process.stderr.write(GITIGNORE_HINT);
  }
}

function ensureIgnoreRule(cwd) {
  const gitPath = path.join(cwd, '.git');
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!existsSync(gitPath) && !existsSync(gitignorePath)) {
    return;
  }

  if (!ensureContextExcluded(cwd)) {
    maybeWarnGitignore(cwd);
  }
}

function getContextDir(cwd) {
  return path.join(cwd, CONTEXT_DIR);
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length >= 8 ? sessionId : 'unknown';
}

// Named from a hash of the whole session id, not its first characters: Codex
// and OMP ids are UUIDv7, whose leading hex digits are a millisecond timestamp
// that changes only about every 65 s, so two sessions started close together
// in one project would share (and overwrite) a prefix-named file. An id too
// short to be real still maps to the one shared `context-unknown.md`.
export function contextFileName(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (normalized === 'unknown') {
    return 'context-unknown.md';
  }
  return `context-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}.md`;
}

export function getContextFilePath(cwd, sessionId = null) {
  return path.join(getContextDir(cwd), contextFileName(sessionId));
}

function readExistingContext(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function extractContentHash(text) {
  return text?.match(/^<!-- content-hash:\s*([a-f0-9]+) -->$/m)?.[1] ?? null;
}

// The file body is a list of sections joined by a blank line; the hash covers
// all of them, so a change to any section rewrites the file and an unchanged
// file is never rewritten (prompt-cache friendly re-reads). A notice (one
// line, e.g. a backend switch waiting for approval) leads the body and counts
// against the whole-file cap only.
function buildHashedContent(stableText, rows, notice = null) {
  const retrieved = rows.length ? renderRetrievedBlock(rows) : '';
  // A notice alone still says there are no memories, in the sentinel's words.
  const empty = notice && !stableText && !retrieved ? CONTEXT_EMPTY_SENTINEL.trimEnd() : '';
  const sections = [notice, stableText, retrieved, empty].filter(Boolean);
  const body = sections.join('\n\n');
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return {
    body,
    hash,
    fullContent: `<!-- content-hash: ${hash} -->\n${body}`
  };
}

function fitsCaps(candidate, rows) {
  const retrievedBytes = rows.length ? HASH_LINE_BYTES + Buffer.byteLength(renderRetrievedBlock(rows), 'utf8') : 0;
  return retrievedBytes <= RETRIEVED_MAX_BYTES
    && Buffer.byteLength(candidate.fullContent, 'utf8') <= MAX_CONTEXT_FILE_BYTES;
}

function truncateRows(rows, stableText, notice) {
  const working = [...rows];
  let notices = 0;

  while (working.length > 1) {
    const candidate = buildHashedContent(stableText, working, notice);
    if (fitsCaps(candidate, working)) {
      return { ...candidate, rows: working, notices };
    }
    working.pop();
    notices += 1;
  }

  while (working[0]?.content?.length) {
    const candidate = buildHashedContent(stableText, working, notice);
    if (fitsCaps(candidate, working)) {
      return { ...candidate, rows: working, notices };
    }
    working[0] = { ...working[0], content: working[0].content.slice(0, -1) };
    notices += 1;
  }

  const fallback = buildHashedContent(stableText, working, notice);
  return { ...fallback, rows: working, notices };
}

function parseMemberIds(memberIds) {
  try {
    const parsed = JSON.parse(memberIds ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Stable rows in the injection cache's ranked order (rankRows: pinned,
// priority, recency), global cache first, then the project scope(s). Returns
// every member; the byte cap and the project/global fill order are applied
// when the section is built (buildStableSection).
export function selectStableRows(db, projectKey, { disableScopeIsolation = false } = {}) {
  const scopeClause = disableScopeIsolation ? '' : "WHERE scope = 'global' OR scope = ?";
  const scopeParams = disableScopeIsolation ? [] : [`project:${projectKey}`];
  const caches = db.prepare(
    `SELECT member_ids
     FROM injection_cache
     ${scopeClause}
     ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, scope`
  ).all(...scopeParams);
  const ids = [...new Set(caches.flatMap((row) => parseMemberIds(row.member_ids)))];
  if (!ids.length) {
    return [];
  }

  const byId = new Map(
    db.prepare(
      `SELECT id, scope, content, pinned
       FROM memories
       WHERE id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(ids)).map((row) => [row.id, row])
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function stableLineBytes(row) {
  return Buffer.byteLength(`- ${row.pinned ? '(pinned) ' : ''}${row.content}\n`, 'utf8');
}

// Whole rows only, within STABLE_SECTION_MAX_BYTES, filled in this order
// (each group keeps the cache's rank order):
//   (a) pinned rows, project before global;
//   (b) project rows while project lines stay within PROJECT_STABLE_SHARE_BYTES;
//   (c) global rows;
//   (d) project rows left over from (b).
// Without (b) a few KB of globals starve every project rule (the global cache
// alone is MBs on real data). A row that does not fit is skipped and the fill
// goes on; a row too big for the section on its own is named on stderr, and
// any cut is reported (spec A4).
function buildStableSection(projectKey, stableRows) {
  const rows = stableRows ?? [];
  const isProject = (row) => row.scope === 'project';
  const pinned = rows.filter((row) => row.pinned);
  const unpinnedProject = rows.filter((row) => !row.pinned && isProject(row));
  const phases = [
    { rows: [...pinned.filter(isProject), ...pinned.filter((row) => !isProject(row))] },
    { rows: unpinnedProject, projectShare: true },
    { rows: rows.filter((row) => !row.pinned && !isProject(row)) },
    { rows: unpinnedProject }
  ];

  const kept = [];
  const keptIds = new Set();
  let projectBytes = 0;
  let text = '';
  for (const phase of phases) {
    for (const row of phase.rows) {
      if (keptIds.has(row.id)) {
        continue;
      }
      const lineBytes = stableLineBytes(row);
      if (phase.projectShare && projectBytes + lineBytes > PROJECT_STABLE_SHARE_BYTES) {
        continue;
      }
      const next = renderStableContext(projectKey, [...kept, row]);
      if (Buffer.byteLength(next, 'utf8') > STABLE_SECTION_MAX_BYTES) {
        continue;
      }
      kept.push(row);
      keptIds.add(row.id);
      if (isProject(row)) {
        projectBytes += lineBytes;
      }
      text = next;
    }
  }

  for (const row of rows) {
    const soloBytes = Buffer.byteLength(renderStableContext(projectKey, [row]), 'utf8');
    if (soloBytes > STABLE_SECTION_MAX_BYTES) {
      process.stderr.write(`ccmem: stable row m${row.id} skipped (${soloBytes}B > ${STABLE_SECTION_MAX_BYTES}B section)\n`);
    }
  }
  if (kept.length < rows.length) {
    process.stderr.write(`ccmem: stable section trimmed to ${kept.length} of ${rows.length} mems\n`);
  }
  // ids in file order (renderStableContext puts [GLOBAL] before [PROJECT]).
  const ids = [...kept.filter((row) => !isProject(row)), ...kept.filter(isProject)].map((row) => row.id);
  return { text, ids };
}

function nextPromptIdx(db, sessionId) {
  const normalized = normalizeSessionId(sessionId);
  const row = db.prepare(
    `SELECT MAX(prompt_idx) AS max_idx
     FROM context_write_log
     WHERE session_id = ?`
  ).get(normalized);
  return Number(row?.max_idx ?? 0) + 1;
}

function recordWriteHistory(db, sessionId, contentHash, content, bytes, written) {
  if (!db) {
    return;
  }

  try {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const now = Date.now();
    const promptIdx = nextPromptIdx(db, normalizedSessionId);

    if (contentHash === 'empty') {
      db.prepare(
        `INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
         VALUES (?, ?, 'empty', 0, ?, ?)`
      ).run(normalizedSessionId, promptIdx, written ? 1 : 0, now);
      return;
    }

    if (written) {
      db.prepare(
        `INSERT OR IGNORE INTO context_snapshots (content_hash, content, first_seen_at, hit_count)
         VALUES (?, ?, ?, 1)`
      ).run(contentHash, content, now);
    } else {
      db.prepare(
        `INSERT INTO context_snapshots (content_hash, content, first_seen_at, hit_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(content_hash) DO UPDATE SET hit_count = hit_count + 1`
      ).run(contentHash, content, now);
    }

    db.prepare(
      `INSERT INTO context_write_log (session_id, prompt_idx, content_hash, bytes, written, written_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(normalizedSessionId, promptIdx, contentHash, bytes, written ? 1 : 0, now);
  } catch (error) {
    process.stderr.write(`ccmem: context history write failed (${error.message})\n`);
  }
}

// stableIds in the result are the stable rows that actually landed in the
// file (after the byte cap), for injection telemetry.
export function writeContextFile(cwd, rows, sessionId = null, db = null, { stableRows = null, projectKey = null, notice = null } = {}) {
  const dir = getContextDir(cwd);
  mkdirSync(dir, { recursive: true });

  const filePath = getContextFilePath(cwd, sessionId);
  const stable = buildStableSection(projectKey, stableRows);
  const truncated = truncateRows(rows, stable.text, notice);
  if (truncated.notices > 0) {
    process.stderr.write(`ccmem: ${contextFileName(sessionId)} exceeded ${RETRIEVED_MAX_BYTES}B, trimmed to ${truncated.rows.length} mems\n`);
  }

  const existing = readExistingContext(filePath);
  if (existing && extractContentHash(existing) === truncated.hash) {
    const bytes = Buffer.byteLength(existing, 'utf8');
    recordWriteHistory(db, sessionId, truncated.hash, truncated.body, bytes, false);
    return { written: false, bytes, skipped: true, stableIds: stable.ids };
  }

  writeFileSync(filePath, truncated.fullContent, 'utf8');
  ensureIgnoreRule(cwd);
  const bytes = Buffer.byteLength(truncated.fullContent, 'utf8');
  recordWriteHistory(db, sessionId, truncated.hash, truncated.body, bytes, true);
  return { written: true, bytes, skipped: false, stableIds: stable.ids };
}

export function clearContextFile(cwd, sessionId = null, db = null) {
  const filePath = getContextFilePath(cwd, sessionId);
  if (existsSync(filePath)) {
    writeFileSync(filePath, CONTEXT_EMPTY_SENTINEL, 'utf8');
  }
  recordWriteHistory(db, sessionId, 'empty', '', 0, true);
  return 0;
}

export function cleanupStaleContextFiles(cwd, currentSessionId = null) {
  const dir = getContextDir(cwd);
  if (!existsSync(dir)) {
    return;
  }

  // Ages out every context-*.md alike, including the 8-character names written
  // before files were named by hash, so a live session's fresh file of either
  // form survives and only the current session's file is always kept.
  const currentFile = contextFileName(currentSessionId);
  const cutoffMs = Date.now() - STALE_CONTEXT_MAX_AGE_MS;

  try {
    for (const file of readdirSync(dir)) {
      const filePath = path.join(dir, file);

      if (file === CONTEXT_FILE) {
        try {
          unlinkSync(filePath);
        } catch {}
        continue;
      }

      if (!file.startsWith('context-') || !file.endsWith('.md') || file === currentFile) {
        continue;
      }

      try {
        if (statSync(filePath).mtimeMs < cutoffMs) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
