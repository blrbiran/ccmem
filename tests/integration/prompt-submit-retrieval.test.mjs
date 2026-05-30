import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-retrieval-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { cmdSave } = await import('../../scripts/lib/cmd/save.mjs');
const { handlePromptSubmit } = await import('../../scripts/handlers/prompt-submit.mjs');

test('prompt-submit retrieves relevant memories', async () => {
  const db = openDb();
  await cmdSave(db, {
    cwd: process.cwd(),
    content: 'API routes live under /app/api',
    scope: 'project',
    type: 'fact'
  });

  const result = await handlePromptSubmit({
    cwd: process.cwd(),
    prompt: 'add a route under app api'
  });

  assert.match(result.additionalContext, /app\/api/);
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
