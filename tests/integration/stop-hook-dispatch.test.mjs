import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-stop-hook-'));
const transcript = path.join(dataRoot, 'session.jsonl');
writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');

const env = {
  ...process.env,
  CCMEM_TEST_MODE: '1',
  CCMEM_DATA_ROOT: dataRoot
};

const NODE = '/usr/local/bin/node';
const HOOK = '/Users/biran/code/skills/ccmem/scripts/hook.mjs';

test('hook.mjs stop writes hook output and DB side effects', async () => {
  const output = execFileSync(
    NODE,
    [HOOK, 'stop'],
    {
      cwd: '/Users/biran/code/skills/ccmem',
      env,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 's-hook',
        transcript_path: transcript,
        cwd: '/Users/biran/code/skills/ccmem'
      })
    }
  );

  assert.match(output, /"hookEventName":"Stop"/);

  process.env.CCMEM_TEST_MODE = '1';
  process.env.CCMEM_DATA_ROOT = dataRoot;
  const { openDb } = await import('../../scripts/lib/db.mjs');
  const db = openDb();
  const task = db.prepare("SELECT type FROM tasks WHERE type='summarize_pending'").get();
  const ctx = db.prepare("SELECT session_id FROM session_context WHERE session_id='s-hook'").get();
  assert.equal(task.type, 'summarize_pending');
  assert.equal(ctx.session_id, 's-hook');
  db.close();
});

test.after(() => rmSync(dataRoot, { recursive: true, force: true }));
