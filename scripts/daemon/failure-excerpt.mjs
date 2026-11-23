import { parseJsonLines } from './backends/jsonl.mjs';

/** The excerpt budget a `tasks.error_excerpt` and the exhaustion record share (loop.mjs). */
export const FAILURE_EXCERPT_MAX = 200;

/**
 * Tester #448: the one-line reason a failed LLM subprocess is recorded with.
 *
 * `claude -p` reports on stderr, but `codex exec --json` writes its `type:"error"`
 * items and `turn.failed` to STDOUT and leaves stderr at 0 bytes — so a live failure
 * was stored as `codex exec exit 1: ` with nothing after the colon, and the real
 * cause (a 404 naming the model) existed only in a stream nobody read.
 *
 * stderr still wins whenever it says anything: it is the CLI's own failure text for
 * every backend that uses it, and this keeps those rows byte-identical. Only an empty
 * stderr falls back to stdout, and then to the structured field — the last
 * `turn.failed.error.message` / `error` item's message — rather than a raw JSON line,
 * because a single event can be 900 bytes while its message is the 90 that matter.
 */
export function failureExcerpt({ stderr = '', stdout = '' } = {}) {
  const fromStderr = String(stderr ?? '').trim();
  if (fromStderr !== '') {
    return fromStderr.slice(0, FAILURE_EXCERPT_MAX);
  }

  const text = String(stdout ?? '');
  const events = parseJsonLines(text);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const message = structuredMessage(events[i]);
    if (message !== null && message !== '') {
      return message.slice(0, FAILURE_EXCERPT_MAX);
    }
  }

  // Not a JSON-lines backend, or it printed no structured error: the tail is the part
  // that says why it died.
  return text.trim().slice(-FAILURE_EXCERPT_MAX);
}

function structuredMessage(event) {
  if (event === null || typeof event !== 'object') {
    return null;
  }
  for (const candidate of [event.error?.message, event.message, event.error?.detail, event.detail]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
  }
  return null;
}