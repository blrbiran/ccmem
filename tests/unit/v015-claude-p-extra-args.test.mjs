import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `--tools ""` for summarize_pending.
 *
 * WHY this matters, not just what it does (Rule 9): a summarize_pending call
 * carries ~22k tokens of built-in tool definitions it never uses — the task is
 * a fixed-shape JSON extraction from a 1000-character excerpt. Measured over 8
 * calls per arm, dropping them cut cache_creation from ~27,400 to ~5,775
 * tokens and cost from $0.378 to $0.157 per call while extracting MORE
 * memories (68 vs 59). See handoff XXXI.3.
 *
 * The injection is deliberately scoped two ways, and both are load-bearing:
 *   - by taskType, because only summarize_pending was ever measured; and
 *   - to the production argv path only, because every integration test drives
 *     this module by supplying CCMEM_CLAUDE_P_ARGS_JSON, and injecting into
 *     caller-supplied argv would rewrite what those tests assert on.
 */

const { resolveCommand } = await import('../../scripts/daemon/claude-p.mjs');

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const CLEAN_ENV = { CCMEM_CLAUDE_P_ARGS_JSON: null, CCMEM_CLAUDE_P_COMMAND: null };

test('summarize_pending gets --tools with an empty value', () => {
  const { args } = withEnv(CLEAN_ENV, () => resolveCommand({ taskType: 'summarize_pending' }));

  const at = args.indexOf('--tools');
  assert.notEqual(at, -1, 'summarize_pending argv must carry --tools');
  assert.equal(
    args[at + 1],
    '',
    '--tools must be followed by an empty string; a missing value would make the CLI consume the next flag'
  );
});

test('a task type that was never measured gets no extra args', () => {
  const { args } = withEnv(CLEAN_ENV, () => resolveCommand({ taskType: 'weekly_synthesis' }));

  assert.equal(
    args.includes('--tools'),
    false,
    'only summarize_pending was measured; other task types must keep their current argv'
  );
});

test('caller-supplied argv is never rewritten', () => {
  const supplied = ['-p', '--output-format', 'text'];
  const { args } = withEnv(CLEAN_ENV, () =>
    resolveCommand({ taskType: 'summarize_pending', args: supplied })
  );

  assert.equal(
    args.includes('--tools'),
    false,
    'opts.args means the caller is specifying argv; injecting would break every integration test that asserts on it'
  );
});

test('CCMEM_CLAUDE_P_ARGS_JSON suppresses injection', () => {
  const { args } = withEnv(
    { ...CLEAN_ENV, CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify(['/fake/script.mjs']) },
    () => resolveCommand({ taskType: 'summarize_pending' })
  );

  assert.equal(
    args.includes('--tools'),
    false,
    'the env override is how integration tests substitute a fake claude binary'
  );
});

test('--tools survives the structured-output rewrite', () => {
  const { args } = withEnv(CLEAN_ENV, () =>
    resolveCommand({
      taskType: 'summarize_pending',
      jsonSchema: { type: 'object', properties: {} }
    })
  );

  assert.equal(args.includes('--tools'), true, '--tools must coexist with --json-schema');
  assert.equal(args.includes('--json-schema'), true, 'structured output must still be requested');

  // Deliberately NOT asserted: that --tools precedes --json-schema. It always
  // does, because withStructuredOutputArgs strips that pair and re-appends it
  // last -- no reachable mutation makes the order come out differently, so the
  // assertion could never fail and would only look like coverage. Verified by
  // mutation: moving the injection to the end of baseArgs produces a
  // byte-identical argv.
});
