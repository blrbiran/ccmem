import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEntryText } from '../../scripts/lib/transcript.mjs';

const MARKERS = [
  '=== ccmem: stable context ===',
  '=== ccmem: retrieved for current prompt ===',
  '<!-- ccmem: no relevant memories -->'
];

// Shapes in which ccmem-injected content actually appears in a transcript.
// None of these may survive extraction, or the agent will re-learn its own output.
const ENTRIES = [
  {
    name: 'tool_result (the Read of .ccmem/context-*.md)',
    entry: {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: `${MARKERS[1]}\n\n[m42*] rule | global  Prefer ESM imports`
        }]
      }
    }
  },
  {
    name: 'hook payload / system-reminder shape',
    entry: {
      type: 'system',
      message: {
        role: 'user',
        content: [{
          type: 'tool_use',
          input: { additionalContext: `${MARKERS[0]}\n\n[GLOBAL]\n- some remembered rule` }
        }]
      }
    }
  },
  {
    name: 'empty-context sentinel in a tool_result',
    entry: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: MARKERS[2] }] }
    }
  }
];

for (const { name, entry } of ENTRIES) {
  test(`ccmem-injected content does not survive extraction: ${name}`, () => {
    const text = extractEntryText(entry);
    for (const marker of MARKERS) {
      assert.equal(
        text.includes(marker),
        false,
        `extractEntryText leaked "${marker}" — the recall loop is now OPEN. `
        + 'Injected memories would be re-extracted as new ones by summarize_pending. '
        + 'If you widened the content-part filter on purpose, you must also add an '
        + 'explicit ccmem-marker strip rule to transcript-cleaner.mjs.'
      );
    }
  });
}

test('extraction still works for genuine assistant text', () => {
  const entry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'real reply' }] }
  };
  assert.equal(extractEntryText(entry), 'real reply');
});
