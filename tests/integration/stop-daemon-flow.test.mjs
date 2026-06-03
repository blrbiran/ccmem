import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-daemon-'));

const wakePath = path.join(process.env.CCMEM_DATA_ROOT, 'daemon.wake');
const { touchWakeFile } = await import('../../scripts/daemon/wake.mjs');
const { dispatchTask } = await import('../../scripts/daemon/dispatch.mjs');
const { acquireDaemonLock, isDaemonAlive } = await import('../../scripts/daemon/lock.mjs');
const { mainLoop } = await import('../../scripts/daemon/loop.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');

function resetStopDaemonState(db) {
  db.prepare(`DELETE FROM audit_log_targets`).run();
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM recent_injections`).run();
  db.prepare(`DELETE FROM memory_feedback`).run();
  db.prepare(`DELETE FROM session_context`).run();
  db.prepare(`DELETE FROM injection_cache`).run();
  db.prepare(`DELETE FROM task_runs`).run();
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM memories`).run();
  db.prepare(`DELETE FROM daemon_lock`).run();
  rmSync(wakePath, { force: true });
}

function setClaudeBridgeEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearClaudeBridgeEnv() {
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: null,
    CCMEM_CLAUDE_P_COMMAND: null,
    CCMEM_CLAUDE_P_ARGS_JSON: null,
    CCMEM_CLAUDE_P_TIMEOUT_MS: null
  });
}

function buildBridgeScriptSuccess(outputText) {
  return "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',(chunk)=>{input+=chunk;});process.stdin.on('end',()=>{process.stdout.write(JSON.stringify([{content: input.includes('remember my preference') ? '" + outputText + "' : 'Wrong prompt', type: 'rule', scope: 'project', tags: ['stop-bridge']}]))});";
}

function buildBridgeScriptFailure(stderrText, exitCode) {
  return `process.stderr.write(${JSON.stringify(stderrText)});process.exit(${exitCode});`;
}

function writeTranscript(filePath, userText, assistantText) {
  writeFileSync(
    filePath,
    `{"type":"user","message":{"content":[{"type":"text","text":${JSON.stringify(userText)}}]}}\n` +
      `{"type":"assistant","message":{"content":[{"type":"text","text":${JSON.stringify(assistantText)}}]}}\n`
  );
}

function setBridgeCommand(scriptPath) {
  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([scriptPath])
  });
}

function getStopTask(db, sessionId) {
  return db.prepare(
    `SELECT status, error_excerpt
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = ?`
  ).get(sessionId);
}

function getLatestAutoMemory(db) {
  return db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred'
     ORDER BY id DESC
     LIMIT 1`
  ).get();
}

function getLatestAudit(db, action) {
  return db.prepare(
    `SELECT action, details
     FROM audit_log
     WHERE action = ?
     ORDER BY id DESC
     LIMIT 1`
  ).get(action);
}

function countAutoMemories(db) {
  return db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred'`
  ).get();
}

function runUntilFirstTask(db) {
  let stop = false;

  return Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      await dispatchTask(loopDb, task);
      stop = true;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);
}

function runUntilFailure(db) {
  let stop = false;

  return Promise.race([
    mainLoop(db, () => stop, async (loopDb, task) => {
      stop = true;
      await dispatchTask(loopDb, task);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);
}

function assertWakeAndApplied(db, sessionId, expectedContent) {
  const task = getStopTask(db, sessionId);
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.equal(task.status, 'completed');
  assert.equal(memory.content, expectedContent);
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, sessionId);
  assert.equal(details.inserted_count, 1);
}

function assertWakeAndFailure(db, sessionId, pattern) {
  const task = getStopTask(db, sessionId);
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(task.status, 'failed');
  assert.match(task.error_excerpt, pattern);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);
}

function closeDb(db) {
  clearClaudeBridgeEnv();
  db.close();
}

function configureBridge(scriptPath) {
  setBridgeCommand(scriptPath);
}

function writeSuccessScript(scriptPath, outputText) {
  writeFileSync(scriptPath, buildBridgeScriptSuccess(outputText));
}

function writeFailureScript(scriptPath, stderrText, exitCode) {
  writeFileSync(scriptPath, buildBridgeScriptFailure(stderrText, exitCode));
}

function prepareStopBridgeSession(db, sessionId, transcriptPath, userText = 'remember my preference', assistantText = 'I will remember that.') {
  resetStopDaemonState(db);
  writeTranscript(transcriptPath, userText, assistantText);
  return handleStop(db, {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: process.cwd()
  });
}

function closeStopDb(db) {
  closeDb(db);
}

function assertStopBridgeSuccess(db, sessionId, expectedContent) {
  assertWakeAndApplied(db, sessionId, expectedContent);
}

function assertStopBridgeFailure(db, sessionId, pattern) {
  assertWakeAndFailure(db, sessionId, pattern);
}

function runStopLoopSuccess(db) {
  return runUntilFirstTask(db);
}

function runStopLoopFailure(db) {
  return runUntilFailure(db);
}

function setupBridge(scriptPath) {
  configureBridge(scriptPath);
}

function teardownBridge() {
  clearClaudeBridgeEnv();
}

function closeStopResources(db) {
  closeStopDb(db);
}

function prepareBridgeSuccess(scriptPath, outputText) {
  writeSuccessScript(scriptPath, outputText);
}

function prepareBridgeFailure(scriptPath, stderrText, exitCode) {
  writeFailureScript(scriptPath, stderrText, exitCode);
}

function handleStopSession(db, sessionId, transcriptPath) {
  return prepareStopBridgeSession(db, sessionId, transcriptPath);
}

function assertStopWakeAndApplied(db, sessionId, expectedContent) {
  assertStopBridgeSuccess(db, sessionId, expectedContent);
}

function assertStopWakeAndFailure(db, sessionId, pattern) {
  assertStopBridgeFailure(db, sessionId, pattern);
}

function runStopSuccess(db) {
  return runStopLoopSuccess(db);
}

function runStopFailure(db) {
  return runStopLoopFailure(db);
}

function installBridge(scriptPath) {
  setupBridge(scriptPath);
}

function uninstallBridge() {
  teardownBridge();
}

function finalizeStopDb(db) {
  closeStopResources(db);
}

function prepareStopSession(db, sessionId, transcriptPath) {
  return handleStopSession(db, sessionId, transcriptPath);
}

function assertStopApplied(db, sessionId, expectedContent) {
  assertStopWakeAndApplied(db, sessionId, expectedContent);
}

function assertStopFailed(db, sessionId, pattern) {
  assertStopWakeAndFailure(db, sessionId, pattern);
}

function runStopDispatch(db) {
  return runStopSuccess(db);
}

function runStopDispatchFailure(db) {
  return runStopFailure(db);
}

function useBridge(scriptPath) {
  installBridge(scriptPath);
}

function clearBridge() {
  uninstallBridge();
}

function closeStop(db) {
  finalizeStopDb(db);
}

function seedStopSession(db, sessionId, transcriptPath) {
  return prepareStopSession(db, sessionId, transcriptPath);
}

function assertStopSuccess(db, sessionId, expectedContent) {
  assertStopApplied(db, sessionId, expectedContent);
}

function assertStopFailure(db, sessionId, pattern) {
  assertStopFailed(db, sessionId, pattern);
}

function drainStop(db) {
  return runStopDispatch(db);
}

function drainStopFailure(db) {
  return runStopDispatchFailure(db);
}

function enableBridge(scriptPath) {
  useBridge(scriptPath);
}

function disableBridge() {
  clearBridge();
}

function finishStop(db) {
  closeStop(db);
}

function createStopSession(db, sessionId, transcriptPath) {
  return seedStopSession(db, sessionId, transcriptPath);
}

function verifyStopSuccess(db, sessionId, expectedContent) {
  assertStopSuccess(db, sessionId, expectedContent);
}

function verifyStopFailure(db, sessionId, pattern) {
  assertStopFailure(db, sessionId, pattern);
}

function runStopDrain(db) {
  return drainStop(db);
}

function runStopDrainFailure(db) {
  return drainStopFailure(db);
}

function enableStopBridge(scriptPath) {
  enableBridge(scriptPath);
}

function disableStopBridge() {
  disableBridge();
}

function finishStopSession(db) {
  finishStop(db);
}

function seedStopBridge(db, sessionId, transcriptPath) {
  return createStopSession(db, sessionId, transcriptPath);
}

function verifyAppliedStop(db, sessionId, expectedContent) {
  verifyStopSuccess(db, sessionId, expectedContent);
}

function verifyFailedStop(db, sessionId, pattern) {
  verifyStopFailure(db, sessionId, pattern);
}

function dispatchStop(db) {
  return runStopDrain(db);
}

function dispatchStopFailure(db) {
  return runStopDrainFailure(db);
}

function startStopBridge(scriptPath) {
  enableStopBridge(scriptPath);
}

function stopStopBridge() {
  disableStopBridge();
}

function releaseStop(db) {
  finishStopSession(db);
}

function setupStopBridge(db, sessionId, transcriptPath) {
  return seedStopBridge(db, sessionId, transcriptPath);
}

function assertAppliedStop(db, sessionId, expectedContent) {
  verifyAppliedStop(db, sessionId, expectedContent);
}

function assertFailedStop(db, sessionId, pattern) {
  verifyFailedStop(db, sessionId, pattern);
}

function driveStop(db) {
  return dispatchStop(db);
}

function driveStopFailure(db) {
  return dispatchStopFailure(db);
}

function beginBridge(scriptPath) {
  startStopBridge(scriptPath);
}

function endBridge() {
  stopStopBridge();
}

function closeStopState(db) {
  releaseStop(db);
}

function primeStopBridge(db, sessionId, transcriptPath) {
  return setupStopBridge(db, sessionId, transcriptPath);
}

function expectStopApplied(db, sessionId, expectedContent) {
  assertAppliedStop(db, sessionId, expectedContent);
}

function expectStopFailure(db, sessionId, pattern) {
  assertFailedStop(db, sessionId, pattern);
}

function runStopBridge(db) {
  return driveStop(db);
}

function runStopBridgeFailure(db) {
  return driveStopFailure(db);
}

function configureStopBridge(scriptPath) {
  beginBridge(scriptPath);
}

function resetStopBridge() {
  endBridge();
}

function finishStopState(db) {
  closeStopState(db);
}

function seedStopBridgeFlow(db, sessionId, transcriptPath) {
  return primeStopBridge(db, sessionId, transcriptPath);
}

function expectStopBridgeApplied(db, sessionId, expectedContent) {
  expectStopApplied(db, sessionId, expectedContent);
}

function expectStopBridgeFailed(db, sessionId, pattern) {
  expectStopFailure(db, sessionId, pattern);
}

function drainStopBridge(db) {
  return runStopBridge(db);
}

function drainStopBridgeFailure(db) {
  return runStopBridgeFailure(db);
}

function useStopBridge(scriptPath) {
  configureStopBridge(scriptPath);
}

function clearStopBridge() {
  resetStopBridge();
}

function finalizeStopState(db) {
  finishStopState(db);
}

function createStopBridgeFlow(db, sessionId, transcriptPath) {
  return seedStopBridgeFlow(db, sessionId, transcriptPath);
}

function assertStopBridgeApplied(db, sessionId, expectedContent) {
  expectStopBridgeApplied(db, sessionId, expectedContent);
}

function assertStopBridgeTaskFailed(db, sessionId, pattern) {
  expectStopBridgeFailed(db, sessionId, pattern);
}

function dispatchStopBridge(db) {
  return drainStopBridge(db);
}

function dispatchStopBridgeFailure(db) {
  return drainStopBridgeFailure(db);
}

function enableConfiguredBridge(scriptPath) {
  useStopBridge(scriptPath);
}

function disableConfiguredBridge() {
  clearStopBridge();
}

function closeStopBridgeDb(db) {
  finalizeStopState(db);
}

function enqueueStopBridge(db, sessionId, transcriptPath) {
  return createStopBridgeFlow(db, sessionId, transcriptPath);
}

function verifyStopBridgeAppliedResult(db, sessionId, expectedContent) {
  assertStopBridgeApplied(db, sessionId, expectedContent);
}

function verifyStopBridgeFailedResult(db, sessionId, pattern) {
  assertStopBridgeTaskFailed(db, sessionId, pattern);
}

function runStopBridgeDispatch(db) {
  return dispatchStopBridge(db);
}

function runStopBridgeDispatchFailure(db) {
  return dispatchStopBridgeFailure(db);
}

function activateConfiguredBridge(scriptPath) {
  enableConfiguredBridge(scriptPath);
}

function deactivateConfiguredBridge() {
  disableConfiguredBridge();
}

function closeStopBridgeState(db) {
  closeStopBridgeDb(db);
}

function seedStopBridgeRuntime(db, sessionId, transcriptPath) {
  return enqueueStopBridge(db, sessionId, transcriptPath);
}

function expectStopBridgeAppliedResult(db, sessionId, expectedContent) {
  verifyStopBridgeAppliedResult(db, sessionId, expectedContent);
}

function expectStopBridgeFailureResult(db, sessionId, pattern) {
  verifyStopBridgeFailedResult(db, sessionId, pattern);
}

function drainConfiguredStopBridge(db) {
  return runStopBridgeDispatch(db);
}

function drainConfiguredStopBridgeFailure(db) {
  return runStopBridgeDispatchFailure(db);
}

function startConfiguredBridge(scriptPath) {
  activateConfiguredBridge(scriptPath);
}

function stopConfiguredBridge() {
  deactivateConfiguredBridge();
}

function disposeStopBridge(db) {
  closeStopBridgeState(db);
}

function prepareConfiguredStopBridge(db, sessionId, transcriptPath) {
  return seedStopBridgeRuntime(db, sessionId, transcriptPath);
}

function assertConfiguredStopBridgeApplied(db, sessionId, expectedContent) {
  expectStopBridgeAppliedResult(db, sessionId, expectedContent);
}

function assertConfiguredStopBridgeFailed(db, sessionId, pattern) {
  expectStopBridgeFailureResult(db, sessionId, pattern);
}

function runConfiguredStopBridge(db) {
  return drainConfiguredStopBridge(db);
}

function runConfiguredStopBridgeFailure(db) {
  return drainConfiguredStopBridgeFailure(db);
}

function enableRealBridge(scriptPath) {
  startConfiguredBridge(scriptPath);
}

function disableRealBridge() {
  stopConfiguredBridge();
}

function finishStopBridge(db) {
  disposeStopBridge(db);
}

function seedConfiguredStopBridge(db, sessionId, transcriptPath) {
  return prepareConfiguredStopBridge(db, sessionId, transcriptPath);
}

function assertRealBridgeApplied(db, sessionId, expectedContent) {
  assertConfiguredStopBridgeApplied(db, sessionId, expectedContent);
}

function assertRealBridgeFailed(db, sessionId, pattern) {
  assertConfiguredStopBridgeFailed(db, sessionId, pattern);
}

function runRealBridge(db) {
  return runConfiguredStopBridge(db);
}

function runRealBridgeFailure(db) {
  return runConfiguredStopBridgeFailure(db);
}

function useRealBridge(scriptPath) {
  enableRealBridge(scriptPath);
}

function clearRealBridge() {
  disableRealBridge();
}

function completeStopBridge(db) {
  finishStopBridge(db);
}

function queueStopBridge(db, sessionId, transcriptPath) {
  return seedConfiguredStopBridge(db, sessionId, transcriptPath);
}

test('wake file is created and daemon lock is live', () => {
  const db = openDb();
  acquireDaemonLock(db);
  touchWakeFile();

  assert.equal(isDaemonAlive(db), true);
  assert.equal(existsSync(wakePath), true);

  db.close();
});

test('stop hook wake lets mainLoop dispatch summarize_pending stub', async () => {
  const db = openDb();
  resetStopDaemonState(db);
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-session.jsonl');

  writeTranscript(transcript, 'remember my preference', 'I will remember that.');
  await handleStop(db, {
    session_id: 's-flow',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  await runUntilFirstTask(db);

  const task = getStopTask(db, 's-flow');
  const audit = getLatestAudit(db, 'summarize_pending_stub');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.equal(task.status, 'completed');
  assert.equal(audit.action, 'summarize_pending_stub');
  assert.equal(details.session_id, 's-flow');
  assert.equal(details.transcript_entry_count, 2);
  assert.match(details.transcript_excerpt, /user: remember my preference/);
  assert.match(details.transcript_excerpt, /assistant: I will remember that\./);

  clearClaudeBridgeEnv();
  db.close();
});

test('stop hook wake can drive configured claude bridge end to end', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-stub.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered preference'));
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFirstTask(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const task = getStopTask(db, 's-flow-bridge');
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.equal(task.status, 'completed');
  assert.equal(memory.content, 'Bridge remembered preference');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(details.session_id, 's-flow-bridge');
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake re-enqueues the same seq after a completed bridge run and later applies successfully', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-completed-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-completed-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered again'));
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-completed-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFirstTask(db);

    await handleStop(db, {
      session_id: 's-flow-bridge-completed-retry',
      transcript_path: transcript,
      cwd: process.cwd()
    });

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-completed-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-completed-retry'
     ORDER BY id ASC`
  ).all();
  const memories = db.prepare(
    `SELECT content, source, tags
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'Bridge remembered again'
     ORDER BY id ASC`
  ).all();
  const audits = db.prepare(
    `SELECT details
     FROM audit_log
     WHERE action = 'summarize_pending_applied'
       AND json_extract(details, '$.session_id') = 's-flow-bridge-completed-retry'
     ORDER BY id ASC`
  ).all();

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq]), [
    ['completed', 2],
    ['completed', 2]
  ]);
  assert.equal(memories.length, 2);
  for (const memory of memories) {
    assert.equal(memory.source, 'auto_inferred');
    assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  }
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    const details = JSON.parse(audit.details);
    assert.equal(details.last_message_seq, 2);
    assert.equal(details.inserted_count, 1);
  }

  db.close();
});

test('stop hook wake supersedes a stale bridge result when a newer stop seq arrives during the bridge wait and later applies the newer seq', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-stale.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-stale.mjs');
  const release = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-stale.release');

  resetStopDaemonState(db);
  writeFileSync(
    script,
    [
      "import { existsSync } from 'node:fs';",
      "const release = process.argv[2];",
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      'process.stdin.resume();',
      'while (!existsSync(release)) {',
      '  await sleep(10);',
      '}',
      "process.stdout.write(JSON.stringify([{content:'Bridge stale preference',type:'rule',scope:'project',tags:['stop-stale']}]))"
    ].join('\n')
  );
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-stale',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script, release])
  });

  const loopPromise = runUntilFirstTask(db);

  await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const task = getStopTask(db, 's-flow-bridge-stale');
      if (task?.status === 'running') {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - started > 1000) {
        clearInterval(timer);
        reject(new Error('stop bridge task did not enter running state'));
      }
    }, 10);
  });

  writeFileSync(
    transcript,
    '{"type":"user","message":{"content":[{"type":"text","text":"remember my preference"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n' +
      '{"type":"user","message":{"content":[{"type":"text","text":"and this follow-up too"}]}}\n'
  );
  await handleStop(db, {
    session_id: 's-flow-bridge-stale',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  writeFileSync(release, 'ok');

  try {
    await loopPromise;

    writeFileSync(script, buildBridgeScriptSuccess('Bridge fresh preference'));
    setBridgeCommand(script);

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-stale' &&
          payload.last_message_seq === 3
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-stale'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const stale = db.prepare(
    `SELECT COUNT(*) AS n
     FROM memories
     WHERE source = 'auto_inferred' AND content = 'Bridge stale preference'`
  ).get();
  const applied = getLatestAudit(db, 'summarize_pending_applied');
  const appliedDetails = JSON.parse(applied.details);
  const audit = getLatestAudit(db, 'summarize_pending_superseded');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq]), [
    ['superseded', 2],
    ['completed', 3]
  ]);
  assert.equal(stale.n, 0);
  assert.equal(memory.content, 'Bridge fresh preference');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_superseded');
  assert.equal(details.session_id, 's-flow-bridge-stale');
  assert.equal(details.last_message_seq, 2);
  assert.equal(applied.action, 'summarize_pending_applied');
  assert.equal(appliedDetails.session_id, 's-flow-bridge-stale');
  assert.equal(appliedDetails.last_message_seq, 3);
  assert.equal(appliedDetails.inserted_count, 1);

  db.close();
});

test('stop hook wake preserves task failure when configured claude bridge exits non-zero', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-fail.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-fail.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, buildBridgeScriptFailure('stop bridge failed', 12));
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-fail',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const task = getStopTask(db, 's-flow-bridge-fail');
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(task.status, 'failed');
  assert.match(task.error_excerpt, /claude -p exit 12: stop bridge failed/);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake re-enqueues the same seq after a bridge failure and later applies successfully', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-fail-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-fail-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, buildBridgeScriptFailure('stop bridge failed', 12));
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-fail-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after retry'));
    await handleStop(db, {
      session_id: 's-flow-bridge-fail-retry',
      transcript_path: transcript,
      cwd: process.cwd()
    });

    setBridgeCommand(script);

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-fail-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-fail-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq]), [
    ['failed', 2],
    ['completed', 2]
  ]);
  assert.equal(memory.content, 'Bridge remembered after retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-fail-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake preserves task failure when configured claude bridge times out', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-timeout.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-timeout.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-timeout',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
    CCMEM_CLAUDE_P_TIMEOUT_MS: '50'
  });

  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-timeout'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a timeout-scheduled retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-timeout-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-timeout-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stdin.resume();setTimeout(() => {}, 1000);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-timeout-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setClaudeBridgeEnv({
    CCMEM_ENABLE_REAL_CLAUDE_P: '1',
    CCMEM_CLAUDE_P_COMMAND: process.execPath,
    CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
    CCMEM_CLAUDE_P_TIMEOUT_MS: '50'
  });

  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after timeout retry'));
    setClaudeBridgeEnv({
      CCMEM_ENABLE_REAL_CLAUDE_P: '1',
      CCMEM_CLAUDE_P_COMMAND: process.execPath,
      CCMEM_CLAUDE_P_ARGS_JSON: JSON.stringify([script]),
      CCMEM_CLAUDE_P_TIMEOUT_MS: null
    });

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-timeout-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-timeout-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-timeout-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p timeout after 50ms/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after timeout retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-timeout-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake preserves rate-limit retry scheduling for configured claude bridge', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 1234);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a rate-limit-scheduled retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 1234ms');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after rate-limit retry'));
    setBridgeCommand(script);

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-rate-limit-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-rate-limit-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 1234ms/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after rate-limit retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-rate-limit-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake defaults rate-limit retry scheduling to 60 seconds when retry-after is missing for configured claude bridge', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-default.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-default.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-default',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-default'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a default-rate-limit retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-default-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-default-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-default-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after default rate-limit retry'));
    setBridgeCommand(script);

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-rate-limit-default-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-rate-limit-default-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-default-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after default rate-limit retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-rate-limit-default-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake converts second-based retry-after into milliseconds for configured claude bridge', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-seconds.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-seconds.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-seconds',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-seconds'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 2_000);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a second-based retry-after retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-seconds-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-seconds-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2s');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-seconds-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after second-based retry'));
    setBridgeCommand(script);

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-rate-limit-seconds-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-rate-limit-seconds-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-seconds-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2s/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after second-based retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-rate-limit-seconds-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake converts minute-based retry-after into milliseconds for configured claude bridge', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-minutes.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-minutes.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-minutes',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-minutes'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 120_000);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a minute-based retry-after retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-minutes-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-rate-limit-minutes-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('429 rate limit; retry-after: 2m');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-rate-limit-minutes-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after minute-based retry'));
    setBridgeCommand(script);

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-rate-limit-minutes-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-rate-limit-minutes-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-rate-limit-minutes-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: 429 rate limit; retry-after: 2m/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after minute-based retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-rate-limit-minutes-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test('stop hook wake defaults too-many-requests retry scheduling to 60 seconds for configured claude bridge', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-too-many-requests.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-too-many-requests.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-too-many-requests',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, scheduled_for, enqueued_at
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-too-many-requests'
     ORDER BY id ASC`
  ).all();
  const memory = countAutoMemories(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');

  assert.equal(existsSync(wakePath), true);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'failed');
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[0].attempts, 1);
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].attempts, 1);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(tasks[1].scheduled_for - tasks[1].enqueued_at, 60_000);
  assert.equal(memory.n, 0);
  assert.equal(audit, undefined);

  db.close();
});

test('stop hook wake applies summarize_pending after a too-many-requests retry later succeeds', async () => {
  const db = openDb();
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-too-many-requests-retry.jsonl');
  const script = path.join(process.env.CCMEM_DATA_ROOT, 'stop-daemon-bridge-too-many-requests-retry.mjs');

  resetStopDaemonState(db);
  writeFileSync(script, "process.stderr.write('too many requests');process.exit(29);");
  writeTranscript(transcript, 'remember my preference', 'ok');
  await handleStop(db, {
    session_id: 's-flow-bridge-too-many-requests-retry',
    transcript_path: transcript,
    cwd: process.cwd()
  });

  setBridgeCommand(script);
  try {
    await runUntilFailure(db);

    writeFileSync(script, buildBridgeScriptSuccess('Bridge remembered after too-many-requests retry'));
    setBridgeCommand(script);

    db.prepare(
      `UPDATE tasks
       SET scheduled_for = ?
       WHERE type = 'summarize_pending'
         AND status = 'queued'
         AND json_extract(payload, '$.session_id') = ?`
    ).run(Date.now() - 1, 's-flow-bridge-too-many-requests-retry');

    let stop = false;
    await Promise.race([
      mainLoop(db, () => stop, async (loopDb, task) => {
        await dispatchTask(loopDb, task);
        const payload = JSON.parse(task.payload ?? '{}');
        if (
          task.type === 'summarize_pending' &&
          payload.session_id === 's-flow-bridge-too-many-requests-retry' &&
          payload.last_message_seq === 2
        ) {
          stop = true;
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
    ]);
  } finally {
    clearClaudeBridgeEnv();
  }

  const tasks = db.prepare(
    `SELECT status, error_excerpt, attempts, json_extract(payload, '$.last_message_seq') AS last_message_seq
     FROM tasks
     WHERE type = 'summarize_pending'
       AND json_extract(payload, '$.session_id') = 's-flow-bridge-too-many-requests-retry'
     ORDER BY id ASC`
  ).all();
  const memory = getLatestAutoMemory(db);
  const audit = getLatestAudit(db, 'summarize_pending_applied');
  const details = JSON.parse(audit.details);

  assert.equal(existsSync(wakePath), true);
  assert.deepEqual(tasks.map((task) => [task.status, task.last_message_seq, task.attempts]), [
    ['failed', 2, 1],
    ['completed', 2, 2]
  ]);
  assert.match(tasks[0].error_excerpt, /claude -p exit 29: too many requests/);
  assert.equal(tasks[1].error_excerpt, null);
  assert.equal(memory.content, 'Bridge remembered after too-many-requests retry');
  assert.equal(memory.source, 'auto_inferred');
  assert.deepEqual(JSON.parse(memory.tags), ['stop-bridge']);
  assert.equal(audit.action, 'summarize_pending_applied');
  assert.equal(details.session_id, 's-flow-bridge-too-many-requests-retry');
  assert.equal(details.last_message_seq, 2);
  assert.equal(details.inserted_count, 1);

  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
