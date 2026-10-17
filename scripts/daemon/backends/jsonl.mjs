// Shared by the backends whose CLIs print one JSON event per line (codex
// --json, omp --mode json).

export function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Lines that are not JSON objects (a stray warning, a partial last line) are
// skipped rather than failing the whole call.
export function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed);
      }
    } catch {}
  }
  return events;
}
