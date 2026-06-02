import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmJson } from '../../scripts/lib/llm-parse.mjs';

test('parseLlmJson parses fenced JSON arrays and strips unknown fields', () => {
  const raw = [
    '```json',
    '[',
    '  {',
    '    "content": "Prefer concise answers",',
    '    "type": "rule",',
    '    "scope": "global",',
    '    "tags": ["style", 42],',
    '    "source_ids": [1, "2", 3],',
    '    "promote_to_global": true',
    '  }',
    ']',
    '```'
  ].join('\n');

  const parsed = parseLlmJson(raw);

  assert.deepEqual(parsed, [
    {
      content: 'Prefer concise answers',
      type: 'rule',
      scope: 'global',
      tags: ['style', '42'],
      source_ids: [1, 3],
      output_type: 'consolidated'
    }
  ]);
});

test('parseLlmJson returns synthesized array from object payloads', () => {
  const parsed = parseLlmJson(JSON.stringify({
    synthesized: [
      {
        content: 'Repository uses App Router',
        type: 'fact',
        scope: 'project',
        tags: ['architecture'],
        output_type: 'rule'
      }
    ],
    ignored: true
  }));

  assert.deepEqual(parsed, [
    {
      content: 'Repository uses App Router',
      type: 'fact',
      scope: 'project',
      tags: ['architecture'],
      source_ids: [],
      output_type: 'rule'
    }
  ]);
});

test('parseLlmJson falls back safely on invalid JSON and empty content', () => {
  assert.deepEqual(parseLlmJson('not json'), []);
  assert.deepEqual(parseLlmJson(JSON.stringify([{ content: '', type: 'rule', scope: 'global' }])), []);
});

test('parseLlmJson normalizes invalid enum values and truncates long content', () => {
  const parsed = parseLlmJson(JSON.stringify([
    {
      content: 'x'.repeat(400),
      type: 'consolidated',
      scope: 'workspace',
      tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      output_type: 'episode'
    }
  ]));

  assert.equal(parsed[0].content.length, 300);
  assert.equal(parsed[0].type, 'fact');
  assert.equal(parsed[0].scope, 'project');
  assert.equal(parsed[0].tags.length, 10);
  assert.equal(parsed[0].output_type, 'consolidated');
});
