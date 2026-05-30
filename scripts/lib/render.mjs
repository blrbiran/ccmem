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
