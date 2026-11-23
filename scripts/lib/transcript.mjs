import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeCodexLine, parseCodexLines } from './transcripts/codex.mjs';
import { normalizeOmpEntry, parseOmpLines, OMP_HEADER_TYPES } from './transcripts/omp.mjs';

// A transcript is read while its agent may still be appending, so a line can be
// half-written. Skip it rather than lose the whole transcript.
function readJsonLines(transcriptPath) {
  const lines = [];
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) {
      continue;
    }
    try {
      lines.push(JSON.parse(line));
    } catch {}
  }
  return lines;
}

function parseLines(lines, transcriptPath, agent) {
  const parsed = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  if (agent === 'codex') {
    if (transcriptPath.endsWith('.zst')) {
      process.stderr.write(`ccmem: skipping compressed Codex rollout ${transcriptPath} (.zst is not read)\n`);
      return [];
    }
    return parseCodexLines(parsed);
  }
  if (agent === 'omp') return parseOmpLines(parsed);
  return parsed;
}

export function parseTranscriptWindow(transcriptPath, agent = 'claude-code', maxBytes = 2 * 1024 * 1024, io = fs) {
  if (!transcriptPath) {
    return { entries: [], startByte: 0, endByte: 0, completeLinesOnly: false, complete: false };
  }
  let fd;
  try {
    fd = io.openSync(transcriptPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { entries: [], startByte: 0, endByte: 0, completeLinesOnly: false, complete: false };
    }
    throw error;
  }
  try {
    const snapshotSize = io.fstatSync(fd).size;
    const requestedLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    const limit = Math.min(2 * 1024 * 1024, requestedLimit);
    const rawStart = Math.max(0, snapshotSize - limit);
    const buffer = Buffer.alloc(Math.min(limit, snapshotSize));
    const bytesRead = buffer.length ? io.readSync(fd, buffer, 0, buffer.length, rawStart) : 0;
    const complete = bytesRead >= buffer.length;
    const endByte = bytesRead < buffer.length ? rawStart + bytesRead : snapshotSize;
    const data = buffer.subarray(0, bytesRead);
    let startByte = rawStart;
    if (rawStart > 0) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) {
        return { entries: [], startByte: endByte, endByte, completeLinesOnly: true, complete: false };
      }
      startByte += newline + 1;
    }
    const completeLinesOnly = rawStart > 0;
    const completeThrough = data.lastIndexOf(0x0a);
    const contentStart = rawStart > 0 ? data.indexOf(0x0a) + 1 : 0;
    const contentEnd = completeLinesOnly
      ? completeThrough + 1
      : (complete && endByte === snapshotSize ? data.length : completeThrough + 1);
    const content = contentEnd <= contentStart ? Buffer.alloc(0) : data.subarray(contentStart, contentEnd);
    return {
      entries: parseLines(content.toString('utf8').split('\n'), transcriptPath, agent),
      startByte,
      endByte,
      completeLinesOnly,
      complete
    };
  } finally {
    io.closeSync(fd);
  }
}

export function parseTranscriptByteRange(transcriptPath, agent = 'claude-code', startByte, endByte, completeLinesOnly = false) {
  if (
    !transcriptPath ||
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < 0 ||
    endByte < startByte
  ) {
    return [];
  }

  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  try {
    const buffer = Buffer.alloc(endByte - startByte);
    const bytesRead = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, startByte) : 0;
    const data = buffer.subarray(0, bytesRead);
    if (completeLinesOnly) {
      const completeThrough = data.lastIndexOf(0x0a);
      const complete = completeThrough < 0 ? Buffer.alloc(0) : data.subarray(0, completeThrough + 1);
      return parseLines(complete.toString('utf8').split('\n'), transcriptPath, agent);
    }
    return parseLines(data.toString('utf8').split('\n'), transcriptPath, agent);
  } finally {
    fs.closeSync(fd);
  }
}

// claude-code: the raw transcript entries, as before. codex / omp: normalized
// entries { type: 'user'|'assistant'|'tool', message: { content: string } }.
export function parseTranscript(transcriptPath, agent = 'claude-code') {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }

  if (agent === 'codex') {
    // Codex compresses older rollouts; ccmem ships no zstd decoder.
    if (transcriptPath.endsWith('.zst')) {
      process.stderr.write(`ccmem: skipping compressed Codex rollout ${transcriptPath} (.zst is not read)\n`);
      return [];
    }
    return parseCodexLines(readJsonLines(transcriptPath));
  }

  if (agent === 'omp') {
    return parseOmpLines(readJsonLines(transcriptPath));
  }

  return readJsonLines(transcriptPath);
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function extractEntryText(entry) {
  return extractContentText(entry?.message?.content);
}

// The Stop hook stores this as last_message_seq, and summarize_pending slices
// parseTranscript(path, agent) with it. For codex / omp it is therefore the
// count of normalized entries the agent's parser returns, not of raw lines.
export function countTranscriptLinesOf(entries) {
  return entries.length;
}

/**
 * The same three numbers `computeSessionStatsOf` and `countTranscriptLinesOf`
 * give for the WHOLE transcript, without holding it: one streaming pass over
 * complete lines.
 *
 * Why this exists: the Stop hook now reads only the tail window (2 MiB), but
 * `last_message_seq` and `session_context` still mean "the whole transcript".
 * A daemon that predates the window (or a replay of an old payload) parses the
 * full file and slices it with that number; handing it the window's entry count
 * would make it summarize the transcript's opening turns instead of its end.
 * Keeping the full meaning here makes the window an internal detail of the
 * Stop hook, so an un-restarted daemon behaves exactly as before.
 *
 * claude-code and codex count per line. omp's parser walks parentId from the
 * last entry, so this keeps each line's id/parentId and its per-entry verdict
 * (a few small tuples, never the message text) and resolves the branch at the
 * end. A .zst codex rollout counts zero entries, as parseTranscript does.
 */
export function scanTranscript(transcriptPath, agent = 'claude-code', io = fs) {
  const empty = { entryCount: 0, toolCalls: 0, messageCount: 0 };
  if (!transcriptPath) return empty;
  if (agent === 'codex' && transcriptPath.endsWith('.zst')) {
    process.stderr.write(`ccmem: skipping compressed Codex rollout ${transcriptPath} (.zst is not read)\n`);
    return empty;
  }

  let fd;
  try {
    fd = io.openSync(transcriptPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw error;
  }

  const omp = agent === 'omp' ? { ids: [], parents: [], keep: [] } : null;
  let entryCount = 0;
  let toolCalls = 0;
  const count = (entry) => {
    if (!entry) return;
    entryCount += 1;
    if (entry.type === 'tool') toolCalls += 1;
  };

  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = [];
    for (;;) {
      const bytesRead = io.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      // Split on 0x0A over bytes: a multi-byte UTF-8 character never contains
      // that byte, so a line assembled across chunks decodes whole.
      let from = 0;
      for (let at = chunk.subarray(0, bytesRead).indexOf(0x0a); at >= 0; at = chunk.subarray(from, bytesRead).indexOf(0x0a)) {
        const absolute = from + at;
        const line = Buffer.concat([...pending, chunk.subarray(from, absolute)]).toString('utf8');
        pending = [];
        from = absolute + 1;
        handleLine(line, agent, omp, count);
      }
      if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from, bytesRead)));
    }
    // A transcript is read while its agent may still be appending: an
    // unterminated final record is skipped, exactly as parseTranscript skips it.
    if (pending.length > 0) handleLine(Buffer.concat(pending).toString('utf8'), agent, omp, count);
  } finally {
    io.closeSync(fd);
  }

  if (omp !== null) {
    // activeBranch over the retained tuples (omp.mjs's walk, same rules).
    const byId = new Map();
    omp.ids.forEach((id, index) => { if (!byId.has(id)) byId.set(id, index); });
    const seen = new Set();
    let index = omp.ids.length - 1;
    let kept = 0;
    let keptTools = 0;
    while (index >= 0 && !seen.has(omp.ids[index])) {
      seen.add(omp.ids[index]);
      const kind = omp.keep[index];
      if (kind === 'tool') keptTools += 1;
      if (kind !== null) kept += 1;
      const parent = omp.parents[index];
      index = parent == null ? -1 : (byId.has(parent) ? byId.get(parent) : -1);
    }
    return { entryCount: kept, toolCalls: keptTools, messageCount: kept };
  }
  return { entryCount, toolCalls, messageCount: entryCount };
}

/** One complete line of a streaming scan; the per-agent rule lives in the agent's own module. */
function handleLine(line, agent, omp, count) {
  if (!line) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (agent === 'codex') {
    count(normalizeCodexLine(parsed));
    return;
  }
  if (agent === 'omp') {
    if (!parsed || typeof parsed !== 'object' || OMP_HEADER_TYPES.has(parsed.type)) return;
    const normalized = normalizeOmpEntry(parsed);
    omp.ids.push(parsed.id);
    omp.parents.push(parsed.parentId ?? null);
    omp.keep.push(normalized === null ? null : normalized.type);
    return;
  }
  // claude-code: parseTranscript returns every parsed line, unfiltered.
  count(parsed);
}

export function computeSessionStatsOf(entries) {
  return {
    toolCalls: entries.filter((entry) => entry.type === 'tool').length,
    messageCount: entries.length,
    durationMs: 0
  };
}

export function countTranscriptLines(transcriptPath, agent = 'claude-code') {
  return countTranscriptLinesOf(parseTranscript(transcriptPath, agent));
}

export function computeSessionStats(transcriptPath, agent = 'claude-code') {
  return computeSessionStatsOf(parseTranscript(transcriptPath, agent));
}

export function extractAssistantText(entry) {
  return extractEntryText(entry);
}
