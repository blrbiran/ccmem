import { CCMEM_MARKERS } from './codex.mjs';

// oh-my-pi session JSONL (~/.omp/agent/sessions/<cwd>/<ts>_<uuid>.jsonl).
// A `title` slot and the `session` header come first; every later line is an
// entry { type, id, parentId, timestamp, ... }. Entries form a tree, and
// branching leaves abandoned turns in the file. OMP rebuilds the active leaf
// from the last physical entry and walks parentId to the root; so does this.

const HEADER_TYPES = new Set(['title', 'session']);

function messageText(content) {
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

function activeBranch(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  let current = entries[entries.length - 1];
  // A repeated id means a corrupt cycle; stop there, as OMP itself does.
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  return branch.reverse();
}

// Tool results keep empty content: a result may be the read of ccmem's own
// context file, and tool output is not conversation. A user message carrying
// ccmem's injected text is dropped for the same reason.
function normalizeOmpEntry(entry) {
  if (entry.type !== 'message') {
    return null;
  }
  const { role, content } = entry.message ?? {};
  if (role === 'toolResult') {
    return { type: 'tool', message: { content: '' } };
  }
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  const text = messageText(content);
  if (role === 'user' && CCMEM_MARKERS.some((marker) => text.includes(marker))) {
    return null;
  }
  return { type: role, message: { content: text } };
}

export function parseOmpLines(lines) {
  const entries = lines.filter((line) => line && typeof line === 'object' && !HEADER_TYPES.has(line.type));
  return activeBranch(entries).map(normalizeOmpEntry).filter(Boolean);
}
