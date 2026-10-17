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
export function countTranscriptLines(transcriptPath, agent = 'claude-code') {
  return parseTranscript(transcriptPath, agent).length;
}

export function computeSessionStats(transcriptPath, agent = 'claude-code') {
  const entries = parseTranscript(transcriptPath, agent);
  return {
    toolCalls: entries.filter((entry) => entry.type === 'tool').length,
    messageCount: entries.length,
    durationMs: 0
  };
}

export function extractAssistantText(entry) {
  return extractEntryText(entry);
}
