import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-v2-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { handleStop } = await import('../../scripts/handlers/stop.mjs');

test('migration upgrades schema to version 2', () => {
  const db = openDb();
  const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get();
  assert.equal(row.version, 2);
  const recent = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recent_injections'").get();
  assert.ok(recent);
  db.close();
});

test('stop hook writes session_context and summarize task', async () => {
  const transcript = path.join(process.env.CCMEM_DATA_ROOT, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user","message":{"content":[{"type":"text","text":"hello"}]}}\n');
  const db = openDb();
  await handleStop(db, { session_id: 's1', transcript_path: transcript, cwd: process.cwd() });
  const task = db.prepare("SELECT type FROM tasks WHERE type='summarize_pending'").get();
  const ctx = db.prepare("SELECT session_id FROM session_context WHERE session_id='s1'").get();
  assert.equal(task.type, 'summarize_pending');
  assert.equal(ctx.session_id, 's1');
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
