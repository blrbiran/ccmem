import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// scripts/run-tests.sh points HOME at a temp dir inside the suite's data root,
// so every default derived from os.homedir() (~/.claude/ccmem, ~/.codex,
// ~/.omp/agent, ~/Library/LaunchAgents) is temp for every test, including one
// that forgets its own override. If this goes red, the suite can write into
// the human's real home: stop and fix the runner before running anything else.
test('the test runner gives every test a temp HOME, not the real one', () => {
  const home = os.homedir();
  assert.notEqual(home, os.userInfo().homedir);
  assert.ok(process.env.CCMEM_DATA_ROOT, 'run the suite through scripts/run-tests.sh');
  assert.equal(path.dirname(home), process.env.CCMEM_DATA_ROOT);
});

test('the test runner drops inherited variables that would outrank the temp HOME', () => {
  for (const name of ['CODEX_HOME', 'CCMEM_OMP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'CCMEM_LAUNCHAGENT_DIR']) {
    assert.equal(process.env[name], undefined, name);
  }
});
