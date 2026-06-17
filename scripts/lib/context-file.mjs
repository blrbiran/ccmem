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
import { renderRetrievedBlock } from './render.mjs';

export const CONTEXT_DIR = '.ccmem';
export const CONTEXT_FILE = 'context.md';
export const CONTEXT_EMPTY_SENTINEL = '<!-- ccmem: no relevant memories -->\n';
const MAX_CONTEXT_FILE_BYTES = 8192;
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

export function contextFileName(sessionId) {
  return `context-${normalizeSessionId(sessionId).slice(0, 8)}.md`;
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

function buildHashedContent(rows) {
  const body = renderRetrievedBlock(rows);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return {
    body,
    hash,
    fullContent: `<!-- content-hash: ${hash} -->\n${body}`
  };
}

function truncateRows(rows) {
  const working = [...rows];
  let notices = 0;

  while (working.length > 1) {
    const candidate = buildHashedContent(working);
    if (Buffer.byteLength(candidate.fullContent, 'utf8') <= MAX_CONTEXT_FILE_BYTES) {
      return { ...candidate, rows: working, notices };
    }
    working.pop();
    notices += 1;
  }

  while (working[0]?.content?.length) {
    const candidate = buildHashedContent(working);
    if (Buffer.byteLength(candidate.fullContent, 'utf8') <= MAX_CONTEXT_FILE_BYTES) {
      return { ...candidate, rows: working, notices };
    }
    working[0] = { ...working[0], content: working[0].content.slice(0, -1) };
    notices += 1;
  }

  const fallback = buildHashedContent(working);
  return { ...fallback, rows: working, notices };
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

export function writeContextFile(cwd, rows, sessionId = null, db = null) {
  const dir = getContextDir(cwd);
  mkdirSync(dir, { recursive: true });

  const filePath = getContextFilePath(cwd, sessionId);
  const truncated = truncateRows(rows);
  if (truncated.notices > 0) {
    process.stderr.write(`ccmem: ${contextFileName(sessionId)} exceeded ${MAX_CONTEXT_FILE_BYTES}B, trimmed to ${truncated.rows.length} mems\n`);
  }

  const existing = readExistingContext(filePath);
  if (existing && extractContentHash(existing) === truncated.hash) {
    const bytes = Buffer.byteLength(existing, 'utf8');
    recordWriteHistory(db, sessionId, truncated.hash, truncated.body, bytes, false);
    return { written: false, bytes, skipped: true };
  }

  writeFileSync(filePath, truncated.fullContent, 'utf8');
  ensureIgnoreRule(cwd);
  const bytes = Buffer.byteLength(truncated.fullContent, 'utf8');
  recordWriteHistory(db, sessionId, truncated.hash, truncated.body, bytes, true);
  return { written: true, bytes, skipped: false };
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
