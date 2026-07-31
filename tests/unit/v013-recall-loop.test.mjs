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
//
// Each case below has a demonstrated failure mode: a specific widening of
// extractContentText (in scripts/lib/transcript.mjs) that reddens it. Confirmed
// manually during v0.13 Task 8 by applying each widening, re-running this file,
// and reverting (see task-8-report.md for the full before/after diffs and output):
//   - Case 1 and case 3 (tool_result shapes) redden when extractContentText is
//     widened to also accept `part.type === 'tool_result'` parts (reading
//     `part.content`).
//   - Case 2 (tool_use/additionalContext shape) does NOT redden under that same
//     tool_result widening — it travels a different field path. It reddens under
//     a separate widening: extractContentText also accepting `part.type ===
//     'tool_use'` parts and reading `part.input.additionalContext`. This is a
//     realistic future change (capturing hook-payload context), so this case is
//     not dead weight — do not remove it.
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
