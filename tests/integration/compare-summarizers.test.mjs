import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/acceptance/compare-summarizers.mjs makes real, paid model calls, so
 * what matters most is that it calls nothing until the human passes
 * --i-approve-paid-calls, and that it says first what it would call. The
 * report is what the human judges from, so each backend's own memories must
 * land in that backend's row with the five criteria left empty.
 *
 * No real model is ever run: llm.commands points at fake claude/codex binaries
 * that append to a marker file whenever they are invoked.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/acceptance/compare-summarizers.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'ccmem-compare-test-'));
const MARKER = path.join(work, 'calls.log');

const { CRITERIA, detectAgent, parseArgs, renderReport } = await import('../../scripts/acceptance/compare-summarizers.mjs');

test.after(() => rmSync(work, { recursive: true, force: true }));

const CLAUDE_MEMORY = 'Use pnpm rather than npm for every build in this repository, because the lockfile is pnpm-lock.yaml.';
const CODEX_MEMORY = 'Run the linter before each commit in this repository; CI rejects unlinted code.';

const FAKE_CLAUDE = path.join(work, 'fake-claude');
writeFileSync(FAKE_CLAUDE, `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CCMEM_FAKE_MARKER, 'claude\\n');
const answer = { synthesized: [{ content: ${JSON.stringify(CLAUDE_MEMORY)}, type: 'rule', scope: 'project', tags: ['build'] }] };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: answer, usage: { input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0.01 }));
`);
chmodSync(FAKE_CLAUDE, 0o700);

const FAKE_CODEX = path.join(work, 'fake-codex');
writeFileSync(FAKE_CODEX, `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CCMEM_FAKE_MARKER, 'codex\\n');
const args = process.argv.slice(2);
const answer = { synthesized: [{ content: ${JSON.stringify(CODEX_MEMORY)}, type: 'rule', scope: 'project', tags: ['lint'] }] };
fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(answer));
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 800, cached_input_tokens: 0, output_tokens: 30 } }) + '\\n');
`);
chmodSync(FAKE_CODEX, 0o700);

const CONFIG = path.join(work, 'config.json');
writeFileSync(CONFIG, JSON.stringify({ llm: { commands: { claude: FAKE_CLAUDE, codex: FAKE_CODEX, omp: path.join(work, 'no-omp') } } }));

// Long enough to pass summarize_pending's 200-char minimum after cleaning.
const CODEX_TRANSCRIPT = path.join(work, 'rollout.jsonl');
writeFileSync(CODEX_TRANSCRIPT, [
  { type: 'session_meta', payload: { id: 'compare-codex', cwd: work } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The build keeps failing on CI because someone used npm install and the lockfile drifted.' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I switched the scripts to pnpm and regenerated pnpm-lock.yaml so CI and local builds agree.' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Good. From now on always use pnpm here, and lint before committing.' }] } }
].map((line) => JSON.stringify(line)).join('\n'));

const OMP_TRANSCRIPT = path.join(work, 'omp.jsonl');
writeFileSync(OMP_TRANSCRIPT, [
  { type: 'title', title: 'compare' },
  { type: 'session', version: 3, id: 'compare-omp', cwd: work },
  { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'The config loader only reads JSON; a YAML file broke the release last week.' } },
  { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Converted config.yaml to config.json and added a check that rejects YAML config files in CI.' }] } },
  { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: 'Thanks, keep every config file in JSON from now on please.' } }
].map((line) => JSON.stringify(line)).join('\n'));

function run(args) {
  const env = { ...process.env, CCMEM_FAKE_MARKER: MARKER };
  return spawnSync(process.execPath, ['--no-warnings', '--experimental-sqlite', SCRIPT, ...args], { cwd: work, env, encoding: 'utf8' });
}

function calls() {
  return existsSync(MARKER) ? readFileSync(MARKER, 'utf8').split('\n').filter(Boolean) : [];
}

test('without the approval flag it names the backends and transcripts, then calls and writes nothing', () => {
  rmSync(MARKER, { force: true });
  const out = path.join(work, 'unapproved.md');
  const result = run(['--out', out, '--config', CONFIG, '--backends', 'claude,codex', CODEX_TRANSCRIPT, OMP_TRANSCRIPT]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /2 transcript\(s\) x 2 backend\(s\) = 4 summarize call\(s\)/);
  assert.match(result.stdout, new RegExp(`claude \\(command ${FAKE_CLAUDE}`));
  assert.match(result.stdout, new RegExp(`codex \\(command ${FAKE_CODEX}, gpt-6-luna\\)`));
  assert.match(result.stdout, /rollout\.jsonl \(codex\)/);
  assert.match(result.stdout, /omp\.jsonl \(omp\)/);
  assert.match(result.stdout, /--i-approve-paid-calls/);
  assert.deepEqual(calls(), []);
  assert.equal(existsSync(out), false);
});

test('argument errors stop it before anything is called', () => {
  rmSync(MARKER, { force: true });
  const existing = path.join(work, 'existing.md');
  writeFileSync(existing, 'keep me');
  const cases = [
    ['--out', path.join(work, 'a.md'), '--backends', 'claude,gemini', '--i-approve-paid-calls', CODEX_TRANSCRIPT],
    ['--backends', 'claude', '--i-approve-paid-calls', CODEX_TRANSCRIPT],
    ['--out', path.join(work, 'b.md'), '--i-approve-paid-calls'],
    ['--out', path.join(work, 'c.md'), '--bogus', '--i-approve-paid-calls', CODEX_TRANSCRIPT],
    ['--out', path.join(work, 'd.md'), '--i-approve-paid-calls', path.join(work, 'missing.jsonl')],
    ['--out', existing, '--config', CONFIG, '--backends', 'claude', '--i-approve-paid-calls', CODEX_TRANSCRIPT]
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  }
  assert.deepEqual(calls(), []);
  assert.equal(readFileSync(existing, 'utf8'), 'keep me');
});

test('approved: each backend\'s memories land in its own row, with the five criteria left for the human', () => {
  rmSync(MARKER, { force: true });
  const out = path.join(work, 'report.md');
  const result = run(['--out', out, '--config', CONFIG, '--backends', 'claude,codex', '--i-approve-paid-calls', CODEX_TRANSCRIPT, OMP_TRANSCRIPT]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls().sort(), ['claude', 'claude', 'codex', 'codex']);

  const report = readFileSync(out, 'utf8');
  const split = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((part) => part.trim());
  const header = report.split('\n').find((line) => line.startsWith('| Backend |'));
  assert.deepEqual(split(header), ['Backend', 'Memories produced', ...CRITERIA.map(([name], index) => `${index + 1}. ${name}`), 'Notes']);

  const rowsOf = (title) => {
    const section = report.split('\n## ').find((part) => part.startsWith(title));
    assert.ok(section, `no section for ${title}\n${report}`);
    return Object.fromEntries(section.split('\n').filter((line) => /^\| (claude|codex) \|/.test(line)).map((line) => [split(line)[0], split(line)]));
  };

  const first = rowsOf('rollout.jsonl (codex)');
  assert.match(first.claude[1], /\[project\/rule\]\*\* Use pnpm rather than npm/, report);
  assert.doesNotMatch(first.claude[1], /Run the linter/);
  assert.match(first.codex[1], /\[project\/rule\]\*\* Run the linter before each commit/, report);
  assert.doesNotMatch(first.codex[1], /Use pnpm rather than npm/);
  assert.match(first.claude.at(-1), /in 900 \/ out 40 tokens/);
  assert.match(first.codex.at(-1), /in 800 \/ out 30 tokens/);

  // Each fake answers the same memory for the second transcript. A backend's
  // transcripts share its data root, so its second answer is a duplicate of
  // its first -- criterion 4 -- and the row says so instead of hiding it.
  const second = rowsOf('omp.jsonl (omp)');
  for (const row of [second.claude, second.codex]) {
    assert.equal(row[1], '_none_');
    assert.match(row.at(-1), /inserted 0, skipped 1 as duplicates/);
  }

  for (const row of [first.claude, first.codex, second.claude, second.codex]) {
    assert.equal(row.length, CRITERIA.length + 3);
    assert.deepEqual(row.slice(2, 2 + CRITERIA.length), CRITERIA.map(() => ''));
  }
});

test('report cells escape table and HTML syntax and keep line breaks', () => {
  const report = renderReport({
    backends: ['omp'],
    results: [{
      transcript: '/x/t.jsonl',
      agent: 'omp',
      cells: { omp: { memories: [{ scope: 'global', type: 'rule', content: 'a | b\nc <script>', tags: [] }], audits: [], costRows: [] } }
    }],
    commit: 'abc',
    generatedAt: 'now',
    llmSource: 'defaults'
  });
  assert.match(report, /a \\\| b<br>c &lt;script&gt;/);
  const errored = renderReport({
    backends: ['codex'],
    results: [{ transcript: '/x/t.jsonl', agent: 'codex', cells: { codex: { error: 'codex exec exit 1: quota' } } }],
    commit: 'abc',
    generatedAt: 'now',
    llmSource: 'defaults'
  });
  assert.match(errored, /\| codex \| \*\*error:\*\* codex exec exit 1: quota \|/);
});

test('parseArgs and detectAgent', () => {
  assert.deepEqual(parseArgs(['--out', 'r.md', 't.jsonl'], ['claude', 'codex', 'omp']).options.backends, ['claude', 'codex', 'omp']);
  assert.equal(parseArgs(['--out', 'r.md', 't.jsonl'], ['claude']).options.approved, false);
  assert.equal(parseArgs(['--out', '--i-approve-paid-calls', 't.jsonl'], ['claude']).error, '--out needs a value');
  const claude = path.join(work, 'claude.jsonl');
  writeFileSync(claude, '{"type":"user","message":{"content":"hi"}}\n');
  assert.equal(detectAgent(CODEX_TRANSCRIPT), 'codex');
  assert.equal(detectAgent(OMP_TRANSCRIPT), 'omp');
  assert.equal(detectAgent(claude), 'claude-code');
});
