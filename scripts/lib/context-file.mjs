import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderRetrievedBlock } from './render.mjs';

export const CONTEXT_DIR = '.ccmem';
export const CONTEXT_FILE = 'context.md';
export const CONTEXT_EMPTY_SENTINEL = '<!-- ccmem: no relevant memories -->\n';
const GITIGNORE_WARNED_FILE = '.gitignore_warned';
const MAX_CONTEXT_FILE_BYTES = 8192;

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

function warnGitignoreOnce(cwd) {
  const dir = getContextDir(cwd);
  const warnedPath = path.join(dir, GITIGNORE_WARNED_FILE);
  if (existsSync(warnedPath)) {
    return;
  }

  try {
    const gitignorePath = path.join(cwd, '.gitignore');
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (!gitignore.includes('.ccmem')) {
      process.stderr.write('ccmem: hint — add .ccmem/ to .gitignore to exclude context cache\n');
    }
    writeFileSync(warnedPath, '', 'utf8');
  } catch {}
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
  warnGitignoreOnce(cwd);
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
