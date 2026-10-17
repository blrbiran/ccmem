// Codex CLI rollout JSONL (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Each line is { timestamp, type, payload }. Only `response_item` lines carry
// the conversation; everything else (session_meta, turn_context, event_msg,
// compacted, ...) is bookkeeping and is dropped.

// Codex injects its own context as user-role messages. They are not the user
// talking, and summarizing them would turn AGENTS.md and environment details
// into "memories".
const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '# AGENTS.md instructions'
];

// ccmem's own injected text. Re-reading it would let the summarizer re-learn
// its own output (the recall loop, see tests/unit/v013-recall-loop.test.mjs).
export const CCMEM_MARKERS = [
  '## ccmem context',
  '=== ccmem: ',
  '<!-- ccmem: no relevant memories -->'
];

const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);

function messageText(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => (part?.type === 'input_text' || part?.type === 'output_text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function isInjectedUserText(text) {
  const head = text.trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => head.startsWith(prefix))
    || CCMEM_MARKERS.some((marker) => text.includes(marker));
}

// One rollout line -> one entry, or null when it carries no conversation.
// Tool calls keep empty content: arguments and outputs are not conversation,
// and an output may be the read of ccmem's own context file. Their outputs
// (`*_output`) are dropped so each call counts once.
function normalizeCodexLine(line) {
  if (line?.type !== 'response_item') {
    return null;
  }
  const item = line.payload;
  if (TOOL_CALL_TYPES.has(item?.type)) {
    return { type: 'tool', message: { content: '' } };
  }
  if (item?.type !== 'message') {
    return null;
  }
  const text = messageText(item.content);
  if (item.role === 'assistant') {
    return { type: 'assistant', message: { content: text } };
  }
  if (item.role === 'user' && !isInjectedUserText(text)) {
    return { type: 'user', message: { content: text } };
  }
  // developer-role items are Codex's own instructions.
  return null;
}

export function parseCodexLines(lines) {
  return lines.map(normalizeCodexLine).filter(Boolean);
}
