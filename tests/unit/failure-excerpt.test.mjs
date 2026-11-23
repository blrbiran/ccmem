import test from 'node:test';
import assert from 'node:assert/strict';

const { failureExcerpt } = await import('../../scripts/daemon/failure-excerpt.mjs');

// Tester #448: `codex exec --json` writes `type:"error"` items and `turn.failed`
// to STDOUT and leaves stderr at 0 bytes, so `codex exec exit 1: ` was the whole
// excerpt — the live 404 that killed a summarize run ("magpie knows no model …")
// was invisible. The excerpt must read stdout when stderr is empty, and it must
// pick the structured message rather than a 900-byte JSON line.
const turnFailed = JSON.stringify({
  type: 'turn.failed',
  error: { message: `unexpected status 404 Not Found: magpie knows no model "group/this-model-does-not-exist-xyz"` }
});

test('stderr wins when it says anything', () => {
  assert.equal(failureExcerpt({ stderr: 'boom\n', stdout: turnFailed }), 'boom');
});

test('an empty stderr falls back to the turn.failed message on stdout', () => {
  const excerpt = failureExcerpt({ stderr: '  \n', stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${turnFailed}\n` });
  assert.match(excerpt, /magpie knows no model/);
  assert.doesNotMatch(excerpt, /turn\.failed/);
});

test('the last error item wins when a retry printed several', () => {
  const first = JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 404)' });
  const second = JSON.stringify({ type: 'error', message: 'boom at the end' });
  const excerpt = failureExcerpt({ stderr: '', stdout: `${first}\n${second}\n` });
  assert.match(excerpt, /boom at the end/);
});

test('plain stdout (a CLI that prints prose) gives its tail', () => {
  const excerpt = failureExcerpt({ stderr: '', stdout: `${'x'.repeat(500)}THE-REAL-REASON` });
  assert.match(excerpt, /THE-REAL-REASON$/);
  assert.ok(excerpt.length <= 200);
});

test('nothing anywhere is an empty excerpt, not a crash', () => {
  assert.equal(failureExcerpt({ stderr: '', stdout: '' }), '');
});

test('the excerpt is bounded', () => {
  const excerpt = failureExcerpt({ stderr: '', stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'y'.repeat(5000) } }) });
  assert.ok(excerpt.length <= 200);
});
