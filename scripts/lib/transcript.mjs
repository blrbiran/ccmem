import { existsSync, readFileSync } from 'node:fs';

export function parseTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }

  return readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

export function countTranscriptLines(transcriptPath) {
  return parseTranscript(transcriptPath).length;
}

export function computeSessionStats(transcriptPath) {
  const entries = parseTranscript(transcriptPath);
  return {
    toolCalls: entries.filter((entry) => entry.type === 'tool').length,
    messageCount: entries.length,
    durationMs: 0
  };
}

export function extractAssistantText(entry) {
  return extractEntryText(entry);
}
