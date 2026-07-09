function stripFences(raw) {
  return String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

function tryParseJson(raw) {
  try {
    return JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
}

function unwrapClaudeEnvelope(parsed) {
  let value = parsed;

  if (value && typeof value === 'object' && value.structured_output != null) {
    value = value.structured_output;
  }

  if (value && typeof value === 'object' && value.type === 'result') {
    if (value.structured_output != null) {
      return value.structured_output;
    }
    if (typeof value.result === 'string') {
      return tryParseJson(value.result);
    }
    return value.result ?? null;
  }

  return value;
}

function normalizeSynthesizedArray(parsed, { skipTruncate = false, maxContentChars = 500 } = {}) {
  const normalized = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.synthesized) ? parsed.synthesized : []);

  return normalized
    .map((item) => {
      const temporalType = ['permanent', 'temporary', 'time-bound'].includes(item?.temporal_type)
        ? item.temporal_type
        : null;
      const investigated = item?.investigated == null ? null : String(item.investigated).slice(0, 200).trim();
      const learned = item?.learned == null ? null : String(item.learned).slice(0, 200).trim();
      const completed = item?.completed == null ? null : String(item.completed).slice(0, 200).trim();
      const nextSteps = item?.next_steps == null ? null : String(item.next_steps).slice(0, 200).trim();

      return {
        content: skipTruncate
          ? String(item?.content ?? '')
          : String(item?.content ?? '').slice(0, maxContentChars),
        type: ['rule', 'fact', 'episode'].includes(item?.type) ? item.type : 'fact',
        scope: item?.scope === 'global' ? 'global' : 'project',
        tags: Array.isArray(item?.tags) ? item.tags.slice(0, 10).map((tag) => String(tag)) : [],
        source_ids: Array.isArray(item?.source_ids) ? item.source_ids.filter(Number.isInteger) : [],
        output_type: ['rule', 'consolidated'].includes(item?.output_type) ? item.output_type : 'consolidated',
        ...(investigated ? { investigated } : {}),
        ...(learned ? { learned } : {}),
        ...(completed ? { completed } : {}),
        ...(nextSteps ? { next_steps: nextSteps } : {}),
        ...(temporalType ? { temporal_type: temporalType } : {})
      };
    })
    .map((item) => ({ ...item, content: item.content.trim() }))
    .filter((item) => item.content.length > 0);
}

export function parseRawLlmOutput(raw) {
  const parsed = tryParseJson(raw);
  if (parsed == null) {
    return null;
  }
  return unwrapClaudeEnvelope(parsed);
}

export function parseLlmJson(raw, options = {}) {
  const parsed = parseRawLlmOutput(raw);
  if (parsed == null) {
    return [];
  }
  return normalizeSynthesizedArray(parsed, options);
}
