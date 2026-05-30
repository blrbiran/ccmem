import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStableContext } from '../../scripts/lib/render.mjs';

test('renderStableContext groups global and project sections', () => {
  const text = renderStableContext('github.com/me/repo', [
    { scope: 'global', content: 'Prefer concise answers', pinned: 0 },
    { scope: 'project', content: 'Use pnpm test before commit', pinned: 1 }
  ]);

  assert.match(text, /=== ccmem: stable context ===/);
  assert.match(text, /\[GLOBAL\]/);
  assert.match(text, /\[PROJECT github.com\/me\/repo\]/);
});
