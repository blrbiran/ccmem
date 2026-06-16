function renderScore(score) {
  if (!score) {
    return '';
  }

  return ` | score fused=${Number(score.fused ?? 0).toFixed(3)} fts=${Number(score.fts ?? 0).toFixed(3)} jaccard=${Number(score.jaccard ?? 0).toFixed(3)} semantic=${Number(score.semantic ?? 0).toFixed(3)}`;
}

export function renderRetrievedBlock(rows) {
  const lines = ['=== ccmem: retrieved for current prompt ===', ''];
  for (const row of rows) {
    lines.push(`[m${row.id}] ${row.type} | ${row.scope} ${row.content}${renderScore(row.score)}`);
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
