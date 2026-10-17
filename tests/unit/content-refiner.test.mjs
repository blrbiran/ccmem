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

const { refineContentToLimit, isTransientLlmError } = await import('../../scripts/lib/content-refiner.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');

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

test('a failure that says the backend cannot answer now is transient; any other is not', () => {
  assert.equal(isTransientLlmError(Object.assign(new Error('x'), { exhaustion: { backend: 'codex', resetAt: null } })), true);
  assert.equal(isTransientLlmError(Object.assign(new Error('x'), { retryAfter: 60000 })), true);
  assert.equal(isTransientLlmError(Object.assign(new Error('x'), { timedOut: true })), true);
  assert.equal(isTransientLlmError(new Error('claude -p exit 1: bad json')), false);
  assert.equal(isTransientLlmError(Object.assign(new Error('x'), { retryAfter: 0, timedOut: false })), false);
});

// A memory is rejected for good on refine_failed. A backend that is out of
// quota or rate-limited judged nothing about the memory, so the refiner must
// throw and leave the retry to the daemon loop (spec G5), not reject it.
async function withFailingStub(stderrLine, fn) {
  const failing = path.join(dataRoot, `fake-claude-fail-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(failing, `process.stderr.write(${JSON.stringify(stderrLine)});\nprocess.exit(1);\n`);
  const previous = process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([failing]);
  try {
    return await fn();
  } finally {
    process.env.CCMEM_CLAUDE_P_ARGS_JSON = previous;
    const db = openDb();
    try {
      db.prepare('DELETE FROM llm_backend_state').run();
      db.prepare('DELETE FROM llm_switch_proposals').run();
    } finally {
      db.close();
    }
  }
}

test('an exhausted backend is thrown, not turned into refine_failed', async () => {
  await withFailingStub('Claude usage limit reached. Your limit resets 5pm\n', async () => {
    await assert.rejects(refineContentToLimit(source, { maxChars: 500 }), (error) => {
      assert.ok(error.exhaustion, 'carries the exhaustion');
      return true;
    });
  });
});

test('a short rate limit is thrown with its retry-after, not turned into refine_failed', async () => {
  await withFailingStub('429 Too Many Requests; retry-after: 5s\n', async () => {
    await assert.rejects(refineContentToLimit(source, { maxChars: 500 }), (error) => {
      assert.equal(error.exhaustion, undefined);
      assert.equal(error.retryAfter, 5000);
      return true;
    });
  });
});

test('a plain failed call is still refine_failed', async () => {
  await withFailingStub('something else broke\n', async () => {
    assert.deepEqual(await refineContentToLimit(source, { maxChars: 500 }), { ok: false, reason: 'refine_failed', content: source });
  });
});
