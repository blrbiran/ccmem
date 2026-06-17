import { callClaudeP } from '../daemon/claude-p.mjs';
import { parseRawLlmOutput } from './llm-parse.mjs';

const REFINER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { type: 'string', maxLength: 500 }
  }
};

export function truncateAtWordBoundary(text, maxChars = 500) {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) {
    return value;
  }

  const raw = value.slice(0, maxChars);
  const boundary = Math.max(
    raw.lastIndexOf(' '),
    raw.lastIndexOf('\n'),
    raw.lastIndexOf('。'),
    raw.lastIndexOf('，'),
    raw.lastIndexOf('.'),
    raw.lastIndexOf(','),
    raw.lastIndexOf('!'),
    raw.lastIndexOf('?')
  );
  const cut = boundary >= Math.floor(maxChars * 0.6) ? raw.slice(0, boundary) : raw;
  return cut.trimEnd();
}

export async function refineContentToLimit(content, {
  enabled = true,
  maxChars = 500,
  taskType = 'summarize_pending'
} = {}) {
  const source = String(content ?? '').trim();
  if (source.length <= maxChars) {
    return source;
  }

  if (!enabled) {
    return truncateAtWordBoundary(source, maxChars);
  }

  try {
    const raw = await callClaudeP([
      'Refine the following memory to fit within 500 characters while preserving the key durable information.',
      'Return strict JSON only: {"content":"..."}',
      '',
      source
    ].join('\n'), {
      taskType,
      jsonSchema: REFINER_SCHEMA
    });
    const parsed = parseRawLlmOutput(raw);
    const refined = String(parsed?.content ?? '').trim();
    if (refined && refined.length <= (maxChars + 1)) {
      return refined;
    }
    if (refined) {
      return truncateAtWordBoundary(refined, maxChars);
    }
  } catch {}

  return truncateAtWordBoundary(source, maxChars);
}
