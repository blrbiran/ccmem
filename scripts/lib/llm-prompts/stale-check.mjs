export const STALE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stale_candidates'],
  properties: {
    stale_candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          reason: { type: 'string', maxLength: 200 }
        }
      }
    }
  }
};

export function buildStaleCheckPrompt(memories) {
  const data = JSON.stringify((memories ?? []).map((memory) => ({
    id: memory.id,
    content: String(memory.content ?? '').slice(0, 200),
    type: memory.type,
    age_days: Math.floor((Date.now() - Number(memory.created_at ?? Date.now())) / 86400000)
  })));

  return `<<SYSTEM>>
You are checking a memory store for STALE entries.

<<TASK>>
Flag memories that are likely outdated because they describe time-bound states.
Do not flag timeless preferences, stable facts, or durable rules.
If none are stale, return {"stale_candidates": []}.

<<MEMORIES>>
${data}

<<OUTPUT — strict JSON, no prose>>`;
}
