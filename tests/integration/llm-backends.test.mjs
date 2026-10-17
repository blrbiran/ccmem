import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The daemon's LLM work runs on Claude, Codex or OMP behind one seam
 * (callClaudeP, spec §5.5). What these tests protect:
 *
 * - Recursion: a summarization child that loads ccmem's own hooks/extension
 *   would queue its own transcript for summarization, forever. Each backend's
 *   guard (CCMEM_INTERNAL=1, Codex hooks off, OMP extensions off) and its
 *   neutral cwd (no human AGENTS.md/rules loaded) are asserted on the argv,
 *   env and cwd the child actually saw.
 * - Result: callers parse what callClaudeP returns, so each backend must hand
 *   back the model's answer, not its event stream.
 * - Cost: usage the tool did not report stays null. A guessed number would
 *   pass for a measurement in the cost report.
 * - Exhaustion: a quota error must be told apart from an ordinary failure, with
 *   the reset time Codex prints, so the task waits instead of burning retries.
 *
 * No real codex/omp is ever run: llm.commands points at fake binaries.
 */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-llm-backends-'));
const fakeDir = mkdtempSync(path.join(tmpdir(), 'ccmem-llm-fakes-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CODEX_HOME = path.join(fakeDir, 'codex-home');
process.env.CCMEM_OMP_AGENT_DIR = path.join(fakeDir, 'omp-agent');
delete process.env.CCMEM_CONFIG_PATH;
delete process.env.CCMEM_CLAUDE_P_COMMAND;
delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;

const RECORD = path.join(fakeDir, 'record.json');
process.env.CCMEM_FAKE_RECORD = RECORD;

const { callClaudeP } = await import('../../scripts/daemon/claude-p.mjs');
const { daemonCostFile } = await import('../../scripts/lib/metrics.mjs');
const { codexBackend } = await import('../../scripts/daemon/backends/codex.mjs');
const { ompBackend } = await import('../../scripts/daemon/backends/omp.mjs');
const { buildSummarizePrompt, SUMMARIZE_PENDING_JSON_SCHEMA } = await import('../../scripts/daemon/tasks/summarize-pending.mjs');
const { CONTRADICTION_SCHEMA } = await import('../../scripts/lib/llm-prompts/contradiction-audit.mjs');
const { MONTHLY_META_SCHEMA } = await import('../../scripts/lib/llm-prompts/monthly-meta-synthesis.mjs');
const { MERGE_SCHEMA } = await import('../../scripts/lib/llm-prompts/contradiction-merge.mjs');
const { SYNTHESIS_V2_SCHEMA } = await import('../../scripts/lib/llm-prompts/weekly-synthesis-v2.mjs');
const { STALE_CHECK_SCHEMA } = await import('../../scripts/lib/llm-prompts/stale-check.mjs');
const { refineContentToLimit } = await import('../../scripts/lib/content-refiner.mjs');
const { resolveCommand } = await import('../../scripts/daemon/claude-p.mjs');
const { openDb } = await import('../../scripts/lib/db.mjs');
const { mainLoop } = await import('../../scripts/daemon/loop.mjs');

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
});

// Shared head of both fakes: record what the child saw, then behave per
// CCMEM_FAKE_MODE. Written as a real executable so it is spawned exactly like
// the real binary would be (by path, from llm.commands).
const RECORDER = `
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const mode = process.env.CCMEM_FAKE_MODE ?? 'ok';
const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const record = {
  args,
  cwd: process.cwd(),
  internal: process.env.CCMEM_INTERNAL ?? null,
  claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
  stdin
};
`;

const FAKE_CODEX = path.join(fakeDir, 'fake-codex');
writeFileSync(FAKE_CODEX, `#!${process.execPath}
${RECORDER}
const schemaPath = at('--output-schema');
record.schema = schemaPath && fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : null;
fs.writeFileSync(process.env.CCMEM_FAKE_RECORD, JSON.stringify(record));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'thread.started', thread_id: 't1' });
out({ type: 'turn.started' });
if (mode === 'limit') {
  out({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro or try again at Oct 22nd, 2026 2:13 PM." });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
  process.exit(1);
}
if (mode === 'fail') {
  // Model text that merely mentions a usage limit is not an exhaustion.
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'the user hit a usage limit; try again at noon' } });
  process.stderr.write('codex: unrelated failure');
  process.exit(2);
}
if (mode === 'hang') {
  setTimeout(() => {}, 60000);
} else {
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex answer' } });
  if (mode !== 'nousage') {
    out({ type: 'turn.completed', usage: { input_tokens: 700, cached_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 0 } });
  }
  if (mode !== 'nooutput') {
    fs.writeFileSync(at('-o'), 'codex answer');
  }
  process.exit(0);
}
`);
chmodSync(FAKE_CODEX, 0o700);

const FAKE_OMP = path.join(fakeDir, 'fake-omp');
writeFileSync(FAKE_OMP, `#!${process.execPath}
${RECORDER}
fs.writeFileSync(process.env.CCMEM_FAKE_RECORD, JSON.stringify(record));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'session', version: 3, id: 's1' });
// The user prompt is echoed back as a message_end too. Its text mentions a
// quota and a 429 on purpose: classifying the whole stream would mistake the
// transcript being summarized for the provider's error.
out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'we hit a 429 quota yesterday' }] } });
const assistant = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'omp ' }, { type: 'text', text: 'answer' }], stopReason: 'stop' };
if (mode === 'usage') {
  assistant.usage = { input: 500, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 560, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
if (mode === 'limit') {
  out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider returned 429: rate limit exceeded', errorStatus: 429 } });
  process.exit(1);
}
if (mode === 'fail') {
  out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'connection reset' } });
  process.exit(1);
}
if (mode === 'error-exit-0') {
  out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'upstream model unavailable' } });
  out({ type: 'agent_end', messages: [] });
  process.exit(0);
}
out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }], stopReason: 'toolUse' } });
out({ type: 'message_end', message: assistant });
out({ type: 'agent_end', messages: [] });
process.exit(0);
`);
chmodSync(FAKE_OMP, 0o700);

function writeConfig(llm) {
  writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ llm }));
}

function useFakes(backend, mode = 'ok', extra = {}) {
  // An exhaustion an earlier test recorded would keep that backend from
  // running here (backend-state.mjs); every test starts with none.
  const db = openDb();
  db.exec('DELETE FROM llm_backend_state; DELETE FROM llm_switch_proposals;');
  db.close();
  writeConfig({ backend, commands: { codex: FAKE_CODEX, omp: FAKE_OMP }, ...extra });
  process.env.CCMEM_FAKE_MODE = mode;
  rmSync(RECORD, { force: true });
}

function recorded() {
  return JSON.parse(readFileSync(RECORD, 'utf8'));
}

function costRows() {
  if (!existsSync(daemonCostFile())) return [];
  return readFileSync(daemonCostFile(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function llmTmpEntries() {
  const dir = path.join(dataRoot, 'tmp');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function assertNeutralCwd(cwd) {
  const tmpRoot = path.join(dataRoot, 'tmp');
  // macOS resolves /var to /private/var in the child's process.cwd().
  const real = (p) => p.replace(/^\/private/, '');
  assert.ok(real(cwd).startsWith(real(tmpRoot) + path.sep), `child cwd ${cwd} must be a fresh dir under ${tmpRoot}`);
  assert.notEqual(real(cwd), real(process.cwd()), 'the child must not run in the repo, where it would load its AGENTS.md / rules');
}

test('codex and omp invocations carry recursion guards', async () => {
  useFakes('codex');
  await callClaudeP('summarize this', { taskType: 'summarize_pending' });
  const codex = recorded();

  assert.deepEqual(codex.args.slice(0, 2), ['exec', '--ephemeral']);
  const c = codex.args.indexOf('-c');
  assert.notEqual(c, -1);
  assert.equal(codex.args[c + 1], 'features.hooks=false', 'Codex must not run ccmem hooks inside a ccmem summarization');
  const configOverrides = codex.args.filter((arg, i) => codex.args[i - 1] === '-c');
  assert.ok(configOverrides.includes('notify=[]'), "the human's legacy notify program must not fire for a background turn");
  assert.equal(codex.args[codex.args.indexOf('-s') + 1], 'read-only');
  assert.ok(codex.args.includes('--skip-git-repo-check'));
  assert.ok(codex.args.includes('--json'));
  assert.equal(codex.args.at(-1), '-', 'the prompt goes in on stdin');
  assert.equal(codex.stdin, 'summarize this');
  assert.equal(codex.internal, '1');
  assertNeutralCwd(codex.cwd);

  useFakes('omp');
  await callClaudeP('summarize this', { taskType: 'summarize_pending' });
  const omp = recorded();

  for (const flag of ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title']) {
    assert.ok(omp.args.includes(flag), `omp argv must carry ${flag}`);
  }
  assert.equal(omp.args[omp.args.indexOf('--mode') + 1], 'json');
  assert.equal(omp.args.includes('--model'), false, 'omp default is its own model role: no --model');
  assert.equal(omp.stdin, 'summarize this');
  assert.equal(omp.internal, '1');
  assertNeutralCwd(omp.cwd);

  assert.deepEqual(llmTmpEntries(), [], 'every per-call work dir is removed after the call');
});

test('codex: the answer is read from last.txt, model defaults to gpt-6-luna, schema goes to a file', async () => {
  useFakes('codex');
  const schema = { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string' } } };

  const result = await callClaudeP('p', { taskType: 'weekly_synthesis', jsonSchema: schema });

  assert.equal(result, 'codex answer', 'callers parse the answer, not the JSONL event stream');
  const { args, schema: written, cwd } = recorded();
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.deepEqual(JSON.parse(written), schema);
  const real = (p) => p.replace(/^\/private/, '');
  assert.equal(real(path.dirname(args[args.indexOf('-o') + 1])), real(cwd), 'last.txt lives in the per-call work dir');
  assert.equal(real(path.dirname(args[args.indexOf('--output-schema') + 1])), real(cwd));
});

test('codex: no schema means no --output-schema; a configured model replaces the default', async () => {
  useFakes('codex', 'ok', { models: { codex: 'gpt-x-test' } });
  await callClaudeP('p', { taskType: 'weekly_synthesis' });
  const { args } = recorded();
  assert.equal(args.includes('--output-schema'), false);
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-x-test');
});

test('codex: tokens come from turn.completed; cost stays null; the row names the backend', async () => {
  useFakes('codex', 'ok');
  await callClaudeP('p', { taskType: 'security_audit' });
  const row = costRows().at(-1);
  assert.equal(row.backend, 'codex');
  assert.equal(row.task_type, 'security_audit');
  assert.equal(row.input_tokens, 700);
  assert.equal(row.output_tokens, 80);
  assert.equal(row.total_cost_usd, null, 'codex reports no price; a guessed one would read as measured');
});

test('codex: no usage event means null tokens, never estimated', async () => {
  useFakes('codex', 'nousage');
  await callClaudeP('p', { taskType: 'security_audit' });
  const row = costRows().at(-1);
  assert.equal(row.backend, 'codex');
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
});

test('codex: exit 0 without last.txt is a failure, not an empty answer', async () => {
  useFakes('codex', 'nooutput');
  await assert.rejects(() => callClaudeP('p', { taskType: 'security_audit' }), /codex exec/);
});

test('codex: a usage-limit error is exhaustion with the printed reset time', async () => {
  useFakes('codex', 'limit');
  const error = await callClaudeP('p', { taskType: 'summarize_pending' }).then(() => null, (e) => e);

  assert.ok(error, 'must reject');
  assert.match(error.message, /^codex exec exit 1/);
  assert.equal(error.exhaustion?.backend, 'codex');
  assert.equal(error.exhaustion.resetAt, new Date(2026, 9, 22, 14, 13).getTime());
  assert.ok(error.retryAfter > 0, 'an exhausted backend makes the task wait, like a Claude 429');
});

test('codex: an ordinary failure is not exhaustion, even if the model text mentions a limit', async () => {
  useFakes('codex', 'fail');
  const error = await callClaudeP('p', { taskType: 'summarize_pending' }).then(() => null, (e) => e);
  assert.match(error.message, /^codex exec exit 2: codex: unrelated failure/);
  assert.equal(error.exhaustion, undefined);
  assert.equal(error.retryAfter, undefined);
});

test('codex classifyExhaustion parses both of Codex\'s reset formats', () => {
  const dated = codexBackend.classifyExhaustion({
    stderr: "You've hit your usage limit … try again at Oct 22nd, 2026 2:13 PM", stdout: '', exitCode: 1
  });
  assert.deepEqual(dated, { exhausted: true, resetAt: new Date(2026, 9, 22, 14, 13).getTime() });

  // Same-day resets print the time only (codex-rs protocol/src/error.rs format_retry_timestamp).
  const today = codexBackend.classifyExhaustion({ stderr: 'usage limit. Try again at 9:05 AM.', stdout: '', exitCode: 1 });
  const expected = new Date();
  expected.setHours(9, 5, 0, 0);
  assert.deepEqual(today, { exhausted: true, resetAt: expected.getTime() });

  assert.deepEqual(
    codexBackend.classifyExhaustion({ stderr: "You've hit your usage limit. Try again later.", stdout: '', exitCode: 1 }),
    { exhausted: true, resetAt: null },
    'no time printed: exhausted, reset unknown'
  );
  assert.deepEqual(codexBackend.classifyExhaustion({ stderr: 'network down', stdout: '', exitCode: 1 }), { exhausted: false, resetAt: null });
});

test('omp: the answer is the last assistant message_end text; schema rides in the prompt', async () => {
  useFakes('omp');
  const schema = { type: 'object', properties: { content: { type: 'string' } } };

  const result = await callClaudeP('extract', { taskType: 'weekly_synthesis', jsonSchema: schema });

  assert.equal(result, 'omp answer');
  const { stdin } = recorded();
  assert.ok(stdin.startsWith('extract'));
  assert.ok(stdin.includes(`Return JSON matching this schema: ${JSON.stringify(schema)}`), 'omp has no schema flag');
});

test('omp: usage comes from the assistant message_end; absent means null', async () => {
  useFakes('omp', 'usage', { models: { omp: 'some-role' } });
  await callClaudeP('p', { taskType: 'security_audit' });
  let row = costRows().at(-1);
  assert.equal(row.backend, 'omp');
  assert.equal(row.input_tokens, 500);
  assert.equal(row.output_tokens, 60);
  assert.equal(row.total_cost_usd, null, "OMP's cost is a catalog-price computation that reads 0 for unpriced models");
  const { args } = recorded();
  assert.equal(args[args.indexOf('--model') + 1], 'some-role');

  useFakes('omp', 'ok');
  await callClaudeP('p', { taskType: 'security_audit' });
  row = costRows().at(-1);
  assert.equal(row.input_tokens, null);
  assert.equal(row.output_tokens, null);
});

test('omp: a provider 429 is exhaustion; the echoed prompt mentioning a quota is not', async () => {
  useFakes('omp', 'limit');
  const limited = await callClaudeP('p', { taskType: 'summarize_pending' }).then(() => null, (e) => e);
  assert.match(limited.message, /^omp -p exit 1/);
  assert.equal(limited.exhaustion?.backend, 'omp');
  assert.equal(limited.exhaustion.resetAt, null);

  useFakes('omp', 'fail');
  const failed = await callClaudeP('p', { taskType: 'summarize_pending' }).then(() => null, (e) => e);
  assert.match(failed.message, /^omp -p exit 1/);
  assert.equal(failed.exhaustion, undefined, 'the user turn says "429 quota"; only the assistant error counts');

  assert.equal(ompBackend.classifyExhaustion({ stderr: 'insufficient credits', stdout: '', exitCode: 1 }).exhausted, true);
});

test('omp: exit 0 with an assistant error and no text is a failure, not an empty answer', async () => {
  useFakes('omp', 'error-exit-0');
  const failed = await callClaudeP('p', { taskType: 'summarize_pending' }).then((value) => ({ value }), (e) => e);
  assert.ok(failed instanceof Error, `resolved with ${JSON.stringify(failed.value)}`);
  assert.match(failed.message, /^omp -p exit 0 but the assistant reported an error: upstream model unavailable/);
});

test('claude stays the default backend and its row names it', async () => {
  writeConfig({});
  const stub = path.join(fakeDir, 'claude-stub.mjs');
  writeFileSync(stub, `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ cwd: process.cwd(), internal: process.env.CCMEM_INTERNAL, sid: process.env.CLAUDE_CODE_SESSION_ID ?? null })); });`);
  process.env.CCMEM_CLAUDE_P_COMMAND = process.execPath;
  process.env.CCMEM_CLAUDE_P_ARGS_JSON = JSON.stringify([stub]);
  try {
    const seen = JSON.parse(await callClaudeP('p', { taskType: 'security_audit' }));
    assert.equal(costRows().at(-1).backend, 'claude');
    assert.equal(seen.internal, '1');
    assert.ok(seen.sid, 'claude keeps its blacklisted CLAUDE_CODE_SESSION_ID');
    // No per-call cwd for claude: claude -p files each session under a
    // directory named after its cwd, so a fresh dir per call would add one
    // ~/.claude/projects entry per call.
    assert.equal(seen.cwd, process.cwd(), 'the claude child inherits the daemon cwd');
  } finally {
    delete process.env.CCMEM_CLAUDE_P_COMMAND;
    delete process.env.CCMEM_CLAUDE_P_ARGS_JSON;
  }
});

test('codex and omp children do not get a Claude session id', async () => {
  useFakes('codex');
  await callClaudeP('p', { taskType: 'security_audit' });
  assert.equal(recorded().claudeSessionId, null);
});

test('llm.commands.claude is used when no env override is set', async () => {
  const fakeClaude = path.join(fakeDir, 'fake-claude');
  writeFileSync(fakeClaude, `#!${process.execPath}\nrequire('node:fs').readFileSync(0); process.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fakeClaude, 0o700);
  writeConfig({ commands: { claude: fakeClaude } });
  const argv = JSON.parse(await callClaudeP('p', { taskType: 'weekly_synthesis' }));
  assert.deepEqual(argv, ['-p', '--output-format', 'text'], 'the built-in claude argv is unchanged');
});

test('an unknown llm.backend fails loudly instead of silently running claude', async () => {
  writeConfig({ backend: 'gemini' });
  await assert.rejects(() => callClaudeP('p', { taskType: 'security_audit' }), /llm\.backend.*gemini/);
});

test('a non-claude timeout is retried like a claude timeout', async () => {
  useFakes('codex', 'hang');
  const timeoutError = await callClaudeP('p', { taskType: 'security_audit', timeoutMs: 300 }).then(() => null, (e) => e);
  assert.equal(timeoutError?.message, 'codex exec timeout after 300ms');
  assert.equal(timeoutError.timedOut, true, 'the loop retries on this flag, not on the backend label');

  const db = openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status, attempts)
     VALUES ('backend-timeout', '{}', ?, ?, 'queued', 1)`
  ).run(now - 1000, now - 1000);
  let stop = false;
  await Promise.race([
    mainLoop(db, () => stop, async () => {
      stop = true;
      throw timeoutError;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loop timeout')), 1000))
  ]);
  const tasks = db.prepare(`SELECT status FROM tasks WHERE type = 'backend-timeout' ORDER BY id`).all();
  db.close();
  assert.deepEqual(tasks.map((t) => t.status), ['failed', 'queued'], 'a timed-out codex call gets a retry row');
});

test('the summarize prompt does not tell a non-Claude model it is Claude Code', () => {
  const prompt = buildSummarizePrompt('transcript');
  assert.equal(prompt.includes('Claude Code'), false);
  assert.ok(prompt.includes('FRESH coding-agent session'));
});

// Every schema a daemon task sends, keyed by its consumer. The refiner's is
// captured from a real refineContentToLimit call because it is built inline.
const NAMED_SCHEMAS = {
  SUMMARIZE_PENDING_JSON_SCHEMA,
  CONTRADICTION_SCHEMA,
  MONTHLY_META_SCHEMA,
  MERGE_SCHEMA,
  SYNTHESIS_V2_SCHEMA,
  STALE_CHECK_SCHEMA
};

function acceptsNull(schema) {
  return (Array.isArray(schema.type) && schema.type.includes('null'))
    || (Array.isArray(schema.enum) && schema.enum.includes(null))
    || (Array.isArray(schema.anyOf) && schema.anyOf.some((s) => s.type === 'null'));
}

// Walks the original and the written schema together. Strict mode (Codex
// sends strict: true) rejects an object that leaves any property out of
// `required`; an optional property must become required-and-nullable so the
// model may still decline to give a value.
function assertStrictShape(original, written, where) {
  if (original.items) {
    assertStrictShape(original.items, written.items, `${where}[]`);
  }
  if (!original.properties) {
    return;
  }
  const keys = Object.keys(original.properties);
  assert.deepEqual([...written.required].sort(), [...keys].sort(), `${where}: every property must be required`);
  assert.equal(written.additionalProperties, false, `${where}: additionalProperties must be false`);
  const wasRequired = new Set(original.required ?? []);
  for (const key of keys) {
    const before = original.properties[key];
    const after = written.properties[key];
    if (!wasRequired.has(key)) {
      assert.ok(acceptsNull(after), `${where}.${key} was optional, so it must accept null`);
    } else if (!acceptsNull(before)) {
      assert.equal(acceptsNull(after), false, `${where}.${key} was required; it must not become nullable`);
    }
    assertStrictShape(before, after, `${where}.${key}`);
  }
}

test('codex gets a strict-mode copy of every daemon schema; claude gets the original', async () => {
  useFakes('codex');
  for (const [name, schema] of Object.entries(NAMED_SCHEMAS)) {
    await callClaudeP('p', { taskType: 'weekly_synthesis', jsonSchema: schema });
    assertStrictShape(schema, JSON.parse(recorded().schema), name);

    const { args } = resolveCommand({ jsonSchema: schema });
    assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema), `${name}: claude receives the schema as written`);
  }

  // The refiner builds its schema inline; capture it through the fake.
  await refineContentToLimit('x'.repeat(600), { maxChars: 500, taskType: 'summarize_pending' });
  const refiner = JSON.parse(recorded().schema);
  assert.deepEqual(refiner.required, ['content']);
  assert.equal(refiner.additionalProperties, false);
  assert.equal(refiner.properties.content.maxLength, 500, 'maxLength is supported in strict mode for non-fine-tuned models, so it stays');
});
