import { callClaudeP } from '../daemon/claude-p.mjs';
import { parseRawLlmOutput } from './llm-parse.mjs';

function refinerSchema(maxChars) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
      content: { type: 'string', maxLength: maxChars }
    }
  };
}

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

// True for a call that failed because the backend could not answer now --
// exhausted (claude-p.mjs sets error.exhaustion), rate-limited (retryAfter) or
// timed out -- as opposed to one that answered badly. Such a failure says
// nothing about the content, so it is not a reason to reject it.
export function isTransientLlmError(error) {
  return error?.exhaustion != null || Number(error?.retryAfter) > 0 || error?.timedOut === true;
}

// Rewrites over-long content with the LLM. It never slices: when the rewrite
// is disabled, fails, or is still too long after one re-ask, it returns
// ok:false with the full original so the caller can keep it out of memory
// and record why (spec A2). A transient failure (isTransientLlmError) is
// thrown instead, so the daemon loop retries the task rather than reject the
// memory for good (spec G5). `mockOutputs` is a test seam, consumed in order.
export async function refineContentToLimit(content, {
  enabled = true,
  maxChars = 500,
  taskType = 'summarize_pending',
  mockOutputs = null
} = {}) {
  const source = String(content ?? '').trim();
  if (source.length <= maxChars) {
    return { ok: true, content: source };
  }

  if (!enabled) {
    return { ok: false, reason: 'refiner_disabled', content: source };
  }

  // Once a test supplies mock outputs, running out of them is a failure
  // (refine_failed), never a fall-through to a real model call.
  const mocks = Array.isArray(mockOutputs) ? [...mockOutputs] : null;
  const nextMock = () => {
    if (!mocks.length) {
      throw new Error('refiner mockOutputs exhausted');
    }
    return String(mocks.shift());
  };
  const ask = async (instruction) => {
    const raw = await callClaudeP([
      instruction,
      'Return strict JSON only: {"content":"..."}',
      '',
      source
    ].join('\n'), {
      taskType,
      jsonSchema: refinerSchema(maxChars),
      ...(mocks ? { mockOutput: nextMock() } : {})
    });
    return String(parseRawLlmOutput(raw)?.content ?? '').trim();
  };

  try {
    let refined = await ask(
      `Refine the following memory to fit within ${maxChars} characters while preserving the key durable information.`
    );
    if (refined.length > maxChars) {
      refined = await ask(
        `Rewrite the following memory so it must be ≤ ${maxChars} characters, keeping only the key durable information. Your previous attempt was ${refined.length} characters, which is too long.`
      );
    }
    if (!refined) {
      return { ok: false, reason: 'refine_failed', content: source };
    }
    if (refined.length > maxChars) {
      return { ok: false, reason: 'still_too_long', content: source };
    }
    return { ok: true, content: refined };
  } catch (error) {
    if (isTransientLlmError(error)) {
      throw error;
    }
    return { ok: false, reason: 'refine_failed', content: source };
  }
}
