export function parseLlmJson(raw) {
  let s = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }

  if (parsed && typeof parsed === 'object' && parsed.type === 'result' && parsed.result != null) {
    if (typeof parsed.result === 'string') {
      const inner = parsed.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      try {
        parsed = JSON.parse(inner);
      } catch {
        return [];
      }
    } else {
      parsed = parsed.result;
    }
  }

  const normalized = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.synthesized) ? parsed.synthesized : []);

  return normalized
    .map((item) => ({
      content: String(item?.content ?? '').slice(0, 300),
      type: ['rule', 'fact', 'episode'].includes(item?.type) ? item.type : 'fact',
      scope: item?.scope === 'global' ? 'global' : 'project',
      tags: Array.isArray(item?.tags) ? item.tags.slice(0, 10).map((tag) => String(tag)) : [],
      source_ids: Array.isArray(item?.source_ids) ? item.source_ids.filter(Number.isInteger) : [],
      output_type: ['rule', 'consolidated'].includes(item?.output_type) ? item.output_type : 'consolidated'
    }))
    .filter((item) => item.content.length > 0);
}
