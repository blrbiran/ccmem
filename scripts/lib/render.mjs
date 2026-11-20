// Issue #416: the score line was visible to the model but is engineering telemetry.
// Every component is already persisted in `recent_injections`, so dropping it from
// the rendered block loses no signal and saves ~60 bytes per row (6 rows/turn).
export function renderRetrievedBlock(rows) {
  const lines = ['=== ccmem: retrieved for current prompt ===', ''];
  for (const row of rows) {
    lines.push(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}`);
  }
  return lines.join('\n');
}

export function renderStableContext(projectKey, rows) {
  const globals = rows.filter((row) => row.scope === 'global');
  const project = rows.filter((row) => row.scope === 'project');
  const lines = ['=== ccmem: stable context ===', ''];

  if (globals.length) {
    lines.push('[GLOBAL]');
    for (const row of globals) {
      lines.push(`- ${row.pinned ? '(pinned) ' : ''}${row.content}`);
    }
    lines.push('');
  }

  if (project.length) {
    lines.push(`[PROJECT ${projectKey}]`);
    for (const row of project) {
      lines.push(`- ${row.pinned ? '(pinned) ' : ''}${row.content}`);
    }
  }

  return lines.join('\n').trim();
}
