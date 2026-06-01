import test from 'node:test';
import assert from 'node:assert/strict';
import { RAN_BY } from '../../scripts/lib/task-runs.mjs';

test('RAN_BY constants are stable', () => {
  assert.deepEqual(RAN_BY, {
    DAEMON: 'daemon',
    OPPORTUNISTIC: 'opportunistic',
    MANUAL: 'manual'
  });
});
