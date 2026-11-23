import * as fs from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { parseCodexLines } from './transcripts/codex.mjs';
import { parseOmpLines } from './transcripts/omp.mjs';

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
    return { entries: [], startByte: 0, endByte: 0 };
  }
  let fd;
  try {
    fd = io.openSync(transcriptPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], startByte: 0, endByte: 0 };
    throw error;
  }
  try {
    const snapshotSize = io.fstatSync(fd).size;
    const requestedLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    const limit = Math.min(2 * 1024 * 1024, requestedLimit);
    const rawStart = Math.max(0, snapshotSize - limit);
    const buffer = Buffer.alloc(Math.min(limit, snapshotSize));
    const bytesRead = buffer.length ? io.readSync(fd, buffer, 0, buffer.length, rawStart) : 0;
    const endByte = bytesRead < buffer.length ? rawStart + bytesRead : snapshotSize;
    const data = buffer.subarray(0, bytesRead);
    let startByte = rawStart;
    if (rawStart > 0) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return { entries: [], startByte: endByte, endByte };
      startByte += newline + 1;
    }
    const completeThrough = data.lastIndexOf(0x0a);
    const contentStart = rawStart > 0 ? data.indexOf(0x0a) + 1 : 0;
    const contentEnd = rawStart === 0 && endByte === snapshotSize ? data.length : completeThrough + 1;
    const complete = contentEnd <= contentStart ? Buffer.alloc(0) : data.subarray(contentStart, contentEnd);
    return {
      entries: parseLines(complete.toString('utf8').split('\n'), transcriptPath, agent),
      startByte,
      endByte
    };
  } finally {
    io.closeSync(fd);
  }
}

export function parseTranscriptByteRange(transcriptPath, agent = 'claude-code', startByte, endByte) {
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
    return parseLines(buffer.subarray(0, bytesRead).toString('utf8').split('\n'), transcriptPath, agent);
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
