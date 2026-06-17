import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderRetrievedBlock } from './render.mjs';

export const CONTEXT_DIR = '.ccmem';
export const CONTEXT_FILE = 'context.md';
export const CONTEXT_EMPTY_SENTINEL = '<!-- ccmem: no relevant memories -->\n';
const MAX_CONTEXT_FILE_BYTES = 8192;
const EXCLUDE_RULE = '.ccmem/';
const GITDIR_PREFIX = 'gitdir:';
const GITIGNORE_HINT = 'ccmem: hint — add .ccmem/ to .gitignore to exclude context cache\n';

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

export function getContextFilePath(cwd) {
  return path.join(getContextDir(cwd), CONTEXT_FILE);
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

function truncateRows(rows) {
  const working = [...rows];
  let notices = 0;

  while (working.length > 1) {
    const body = renderRetrievedBlock(working);
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
    const fullContent = `<!-- content-hash: ${hash} -->\n${body}`;
    if (Buffer.byteLength(fullContent, 'utf8') <= MAX_CONTEXT_FILE_BYTES) {
      return { rows: working, fullContent, notices };
    }
    working.pop();
    notices += 1;
  }

  const body = renderRetrievedBlock(working);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  let fullContent = `<!-- content-hash: ${hash} -->\n${body}`;
  while (Buffer.byteLength(fullContent, 'utf8') > MAX_CONTEXT_FILE_BYTES && working[0]?.content?.length) {
    working[0] = { ...working[0], content: working[0].content.slice(0, -1) };
    const nextBody = renderRetrievedBlock(working);
    const nextHash = createHash('sha256').update(nextBody).digest('hex').slice(0, 8);
    fullContent = `<!-- content-hash: ${nextHash} -->\n${nextBody}`;
    notices += 1;
  }

  return { rows: working, fullContent, notices };
}

export function writeContextFile(cwd, rows) {
  const dir = getContextDir(cwd);
  mkdirSync(dir, { recursive: true });

  const filePath = getContextFilePath(cwd);
  const body = renderRetrievedBlock(rows);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const existing = readExistingContext(filePath);
  if (existing && extractContentHash(existing) === hash) {
    return { written: false, bytes: Buffer.byteLength(existing, 'utf8'), skipped: true };
  }

  const truncated = truncateRows(rows);
  if (truncated.notices > 0) {
    process.stderr.write(`ccmem: context.md exceeded ${MAX_CONTEXT_FILE_BYTES}B, trimmed to ${truncated.rows.length} mems\n`);
  }

  writeFileSync(filePath, truncated.fullContent, 'utf8');
  ensureIgnoreRule(cwd);
  return {
    written: true,
    bytes: Buffer.byteLength(truncated.fullContent, 'utf8'),
    skipped: false
  };
}

export function clearContextFile(cwd) {
  const filePath = getContextFilePath(cwd);
  if (existsSync(filePath)) {
    writeFileSync(filePath, CONTEXT_EMPTY_SENTINEL, 'utf8');
  }
  return 0;
}
