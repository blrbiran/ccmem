export const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merged_content', 'merge_possible'],
  properties: {
    merged_content: { type: 'string', maxLength: 500 },
    merge_possible: { type: 'boolean' },
    reason: { type: 'string', maxLength: 200 }
  }
};

export function buildMergePrompt(memA, memB) {
  return `<<SYSTEM>>
You are merging two contradictory memories into a single, more precise statement.

<<TASK>>
Memory A (id ${memA.id}, trust ${Number(memA.trust_score ?? 0).toFixed(2)}):
"${String(memA.content ?? '')}"

Memory B (id ${memB.id}, trust ${Number(memB.trust_score ?? 0).toFixed(2)}):
"${String(memB.content ?? '')}"

If they can be reconciled by adding context, produce one merged statement.
If they cannot both be true, set merge_possible=false and explain in reason.

<<CONSTRAINTS>>
- merged_content <= 500 chars
- do not invent unsupported context
- prefer higher-trust framing when both are plausible

<<OUTPUT — strict JSON, no prose>>`;
}
