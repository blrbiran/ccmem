import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-refiner-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

// A stand-in for the LLM binary that always returns a rewrite that fits. If the
// refiner falls through to "a real call", it reaches this stub, and the result
// shows up as ok:true.
const stub = path.join(dataRoot, 'fake-claude.mjs');
writeFileSync(stub, 'process.stdout.write(JSON.stringify({ content: "short rewrite" }));\n');
process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub]);

const { refineContentToLimit } = await import('../../scripts/lib/content-refiner.mjs');

const source = 'y'.repeat(900);

test('control: without mockOutputs the refiner reaches the LLM binary', async () => {
  // Proves the stub is live, so the next test's ok:false means "no call made",
  // not "the call happened and failed".
  assert.deepEqual(await refineContentToLimit(source, { maxChars: 500 }), { ok: true, content: 'short rewrite' });
});

test('exhausted mockOutputs end as refine_failed, never as a real call', async () => {
  // the first rewrite is too long, so the re-ask finds the mock list empty
  const first = await refineContentToLimit(source, {
    maxChars: 500,
    mockOutputs: [JSON.stringify({ content: 'z'.repeat(700) })]
  });
  assert.deepEqual(first, { ok: false, reason: 'refine_failed', content: source });

  const none = await refineContentToLimit(source, { maxChars: 500, mockOutputs: [] });
  assert.deepEqual(none, { ok: false, reason: 'refine_failed', content: source });
});
