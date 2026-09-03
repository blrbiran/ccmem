import { readFileSync } from 'node:fs';

// 001_initial.sql:46 的 CHECK 约束枚举的就是这六个。语料里写别的值，tier3 会按
// "有 evidence 就 quarantine" 那条分支走，跑出来的最终动作与真实写入不一致。
export const VALID_SOURCES = new Set([
  'user_explicit',
  'cron_consolidated',
  'cerebrum_import',
  'tool_output',
  'auto_inferred',
  'external'
]);

const VALID_EXPECT = new Set(['allow', 'non_allow']);
const REQUIRED_FIELDS = ['id', 'class', 'source', 'content', 'expect', 'note'];

export function parsePayloadLines(text, file) {
  const rows = [];
  const seen = new Set();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }

    const at = `${file}:${i + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${at}: not valid JSON: ${error.message}`);
    }

    for (const field of REQUIRED_FIELDS) {
      if (typeof row[field] !== 'string' || row[field] === '') {
        throw new Error(`${at}: field "${field}" must be a non-empty string`);
      }
    }

    if (!VALID_SOURCES.has(row.source)) {
      throw new Error(`${at}: source "${row.source}" is not one of ${[...VALID_SOURCES].join(', ')}`);
    }

    if (!VALID_EXPECT.has(row.expect)) {
      throw new Error(`${at}: expect "${row.expect}" must be "allow" or "non_allow"`);
    }

    if (seen.has(row.id)) {
      throw new Error(`${at}: duplicate id "${row.id}"`);
    }

    seen.add(row.id);
    rows.push(row);
  }

  return rows;
}

// url 既可以是 URL 也可以是普通路径字符串（scratchpad 里的一次性脚本用后者更省事）。
export function loadPayloads(url) {
  const file = String(url).split('/').pop();
  return parsePayloadLines(readFileSync(url, 'utf8'), file);
}
