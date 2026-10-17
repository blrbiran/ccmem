import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTEXT_EMPTY_SENTINEL,
  MAX_CONTEXT_FILE_BYTES,
  STABLE_SECTION_MAX_BYTES,
  getContextFilePath,
  writeContextFile,
  clearContextFile
} from '../../scripts/lib/context-file.mjs';

function makeRows(contents) {
  return contents.map((content, index) => ({
    id: index + 1,
    type: 'fact',
    scope: 'project',
    content
  }));
}

function captureStderr(work) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = ((chunk, encoding, callback) => {
    chunks.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  });

  try {
    return { result: work(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

test('writeContextFile creates .ccmem/context.md with content hash header', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    const rows = makeRows(['Project remembers API routes under /app/api']);
    const { result } = captureStderr(() => writeContextFile(cwd, rows));
    const filePath = getContextFilePath(cwd);
    const text = readFileSync(filePath, 'utf8');

    assert.equal(existsSync(filePath), true);
    assert.equal(result.written, true);
    assert.equal(result.skipped, false);
    assert.match(text, /^<!-- content-hash: [a-f0-9]{8} -->\n/);
    assert.match(text, /=== ccmem: retrieved for current prompt ===/);
    assert.match(text, /app\/api/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeContextFile hash-gates unchanged content and returns existing file bytes', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    const rows = makeRows(['Stable retrieval content']);
    writeContextFile(cwd, rows);
    const filePath = getContextFilePath(cwd);
    const existing = readFileSync(filePath, 'utf8');

    const { result } = captureStderr(() => writeContextFile(cwd, rows));

    assert.equal(result.written, false);
    assert.equal(result.skipped, true);
    assert.equal(result.bytes, Buffer.byteLength(existing, 'utf8'));
    assert.equal(readFileSync(filePath, 'utf8'), existing);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('clearContextFile writes the no-relevant sentinel only when file already exists', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    clearContextFile(cwd);
    assert.equal(existsSync(getContextFilePath(cwd)), false);

    writeContextFile(cwd, makeRows(['Existing retrieval content']));
    clearContextFile(cwd);
    assert.equal(readFileSync(getContextFilePath(cwd), 'utf8'), CONTEXT_EMPTY_SENTINEL);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeContextFile adds .ccmem/ to .git/info/exclude when repo metadata exists', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(cwd, '.git', 'info', 'exclude'), '# local excludes\n', 'utf8');

    const { stderr } = captureStderr(() => writeContextFile(cwd, makeRows(['First write'])));
    const exclude = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');

    assert.match(exclude, /\.ccmem\//);
    assert.doesNotMatch(stderr, /add \.ccmem\/ to \.gitignore/);
    assert.equal(existsSync(path.join(cwd, '.ccmem', '.gitignore_warned')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeContextFile does not duplicate an existing .ccmem/ exclude rule', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(cwd, '.git', 'info', 'exclude'), '# local excludes\n.ccmem/\n', 'utf8');

    captureStderr(() => writeContextFile(cwd, makeRows(['First write'])));
    captureStderr(() => writeContextFile(cwd, makeRows(['Second write'])));
    const exclude = readFileSync(path.join(cwd, '.git', 'info', 'exclude'), 'utf8');

    assert.equal((exclude.match(/^\.ccmem\/$/gm) ?? []).length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeContextFile warns when .git/info/exclude cannot be updated and .ccmem is still unmanaged', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    writeFileSync(path.join(cwd, '.git'), 'not-a-dir', 'utf8');

    const { stderr } = captureStderr(() => writeContextFile(cwd, makeRows(['First write'])));

    assert.match(stderr, /add \.ccmem\/ to \.gitignore/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeContextFile truncates oversized payloads to 8KB and warns', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    const rows = makeRows(Array.from({ length: 10 }, (_, i) => `row-${i}-${'x'.repeat(1500)}`));
    const { result, stderr } = captureStderr(() => writeContextFile(cwd, rows));
    const filePath = getContextFilePath(cwd);
    const text = readFileSync(filePath, 'utf8');

    assert.equal(result.written, true);
    assert.equal(result.bytes <= 8192, true);
    assert.equal(Buffer.byteLength(text, 'utf8') <= 8192, true);
    assert.match(stderr, /context-unknown\.md exceeded 8192B, trimmed to /);
    assert.match(text, /^<!-- content-hash: [a-f0-9]{8} -->\n/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function makeStableRows(count, size) {
  return Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    scope: i % 2 ? 'project' : 'global',
    pinned: 0,
    content: `stable-${i}-${'s'.repeat(size)}`
  }));
}

// WHY: both caps hold at once — a 4 KB stable section plus a full retrieved
// block must still fit the 12 KB file, and the stable cut drops whole rows
// (a half-rendered rule is worse than a missing one).
test('writeContextFile bounds the stable section and the whole file together', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    const stableRows = makeStableRows(40, 300);
    const rows = makeRows(Array.from({ length: 10 }, (_, i) => `row-${i}-${'x'.repeat(1500)}`));
    const { result, stderr } = captureStderr(() => writeContextFile(cwd, rows, null, null, { stableRows, projectKey: 'k' }));
    const text = readFileSync(getContextFilePath(cwd), 'utf8');
    const body = text.slice(text.indexOf('\n') + 1);
    const stable = body.slice(0, body.indexOf('\n\n=== ccmem: retrieved for current prompt ==='));
    const stableLines = stable.split('\n').filter((line) => line.startsWith('- '));

    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_FILE_BYTES);
    assert.ok(Buffer.byteLength(stable, 'utf8') <= STABLE_SECTION_MAX_BYTES);
    assert.ok(stableLines.length > 0 && stableLines.length < stableRows.length);
    assert.ok(stableLines.every((line) => /^- stable-\d+-s{300}$/.test(line)), 'only whole stable rows land');
    assert.deepEqual(result.stableIds, stableRows.slice(0, stableLines.length).map((row) => row.id));
    assert.match(stderr, new RegExp(`stable section trimmed to ${stableLines.length} of 40 mems`));
    assert.match(text, /=== ccmem: retrieved for current prompt ===\n\n\[m1\] fact/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// WHY: the hash gate must see the stable section too, or a changed stable
// rule set with the same retrieved rows would leave the old file in place.
test('writeContextFile rewrites the file when only the stable section changes', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccmem-context-file-'));

  try {
    const rows = makeRows(['Same retrieved row']);
    captureStderr(() => writeContextFile(cwd, rows, null, null, { stableRows: makeStableRows(1, 10), projectKey: 'k' }));
    const { result } = captureStderr(() => writeContextFile(cwd, rows, null, null, { stableRows: makeStableRows(2, 10), projectKey: 'k' }));

    assert.equal(result.written, true);
    assert.match(readFileSync(getContextFilePath(cwd), 'utf8'), /stable-1-s{10}/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
