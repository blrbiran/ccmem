export const MONTHLY_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthesized'],
  properties: {
    synthesized: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'source_ids'],
        properties: {
          content: { type: 'string', maxLength: 80 },
          source_ids: {
            type: 'array',
            items: { type: 'integer' }
          }
        }
      }
    }
  }
};

export function buildMonthlyMetaPrompt(consolidated, scope) {
  const data = JSON.stringify(consolidated.map((item) => ({
    id: item.id,
    content: String(item.content ?? '').slice(0, 200),
    depth: Number(item.consolidation_depth ?? 0),
    trust: Math.round(Number(item.trust_score ?? 0) * 100) / 100
  })));

  return `<<SYSTEM>>
You are a META-SYNTHESIS engine for a memory store. The memories below are
consolidated summaries. Find higher-level meta-patterns and return strict JSON.

<<CONSTRAINTS>>
- Content MUST be <= 80 characters
- source_ids must reference contributing consolidated memories
- If no meta-pattern exists, return {"synthesized": []}
- Scope: ${scope}

<<CONSOLIDATED MEMORIES>>
${data}`;
}
