#!/usr/bin/env node
/**
 * Free end-to-end acceptance for the Codex and OMP integrations (Task 12,
 * step 1). It never starts a real codex or omp, never runs the daemon and
 * never calls a model: it does what each agent would do with ccmem's
 * integration and checks what ccmem leaves behind.
 *
 *   Codex: `ccmem install codex`, then the three installed hook commands run
 *   through a shell with Codex's stdin payloads (SessionStart, UserPromptSubmit,
 *   Stop) against a synthetic rollout file, then `ccmem uninstall codex`.
 *   OMP: `ccmem install omp`, then the written loader is imported under bun (or
 *   node) with a fake `pi` and driven through session_start, before_agent_start,
 *   session_stop and session_switch, then `ccmem uninstall omp`.
 *
 * Every location it writes is taken from the environment and must sit under a
 * temp directory, or it refuses before touching anything:
 *
 *   CODEX_HOME, CCMEM_OMP_AGENT_DIR, CCMEM_DATA_ROOT  existing temp dirs
 *   CCMEM_E2E_CWD                                     existing temp dir, the "project"
 *
 * PI_CODING_AGENT_DIR, OMP_PROFILE, PI_PROFILE and CCMEM_CONFIG_PATH must be
 * unset. Usage:
 *
 *   node scripts/acceptance/e2e-codex-omp.mjs [--omp-runtime <bun|node path>]
 *
 * Prints one `ok` / `not ok` line per check and exits non-zero on any failure.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'scripts/cli.mjs');
const DIR_VARS = ['CODEX_HOME', 'CCMEM_OMP_AGENT_DIR', 'CCMEM_DATA_ROOT', 'CCMEM_E2E_CWD'];
const MUST_BE_UNSET = ['PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'CCMEM_CONFIG_PATH', 'CCMEM_INTERNAL'];

function tempRoots() {
  const roots = new Set();
  for (const candidate of [os.tmpdir(), '/tmp', '/private/tmp']) {
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // not present on this machine
    }
  }
  return [...roots];
}

/** Returns the reasons to refuse; empty means every location is a temp dir. */
export function refusalReasons(env = process.env) {
  const reasons = [];
  const roots = tempRoots();
  const resolved = [];
  for (const name of DIR_VARS) {
    const value = env[name];
    if (!value) {
      reasons.push(`${name} is not set`);
      continue;
    }
    let real;
    try {
      real = realpathSync(value);
    } catch {
      reasons.push(`${name}=${value} does not exist (create it with mktemp -d)`);
      continue;
    }
    if (!statSync(real).isDirectory()) {
      reasons.push(`${name}=${value} is not a directory`);
      continue;
    }
    if (!roots.some((root) => real.startsWith(`${root}${path.sep}`))) {
      reasons.push(`${name}=${value} is not under a temp dir (${roots.join(', ')})`);
    }
    resolved.push([name, real]);
  }
  for (const [name, real] of resolved) {
    for (const [other, otherReal] of resolved) {
      if (name !== other && (real === otherReal || real.startsWith(`${otherReal}${path.sep}`))) {
        reasons.push(`${name} must not be ${other} or inside it`);
      }
    }
  }
  for (const name of MUST_BE_UNSET) {
    if (env[name] !== undefined) {
      reasons.push(`${name} must be unset`);
    }
  }
  return reasons;
}

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(`${ok ? 'ok' : 'not ok'} - ${label}${detail ? ` (${detail})` : ''}\n`);
  return ok;
}

function note(text) {
  process.stdout.write(`# ${text}\n`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Every file under dir: relative path -> { sha256, mode }. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out[path.relative(dir, full)] = { sha256: sha256(full), mode: (statSync(full).mode & 0o777).toString(8) };
      }
    }
  };
  walk(dir);
  return out;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (!a) {
      changed.push(`added ${key}`);
    } else if (!b) {
      changed.push(`removed ${key}`);
    } else if (a.sha256 !== b.sha256 || a.mode !== b.mode) {
      changed.push(`changed ${key}`);
    }
  }
  return changed;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, ['--no-warnings', '--experimental-sqlite', CLI, ...args], { cwd, env: process.env, encoding: 'utf8' });
}

function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8);
}

function jsonl(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function codexRollout(sessionId, cwd) {
  const at = (s) => `2026-10-17T09:00:${String(s).padStart(2, '0')}.000Z`;
  const item = (s, payload) => ({ timestamp: at(s), type: 'response_item', payload });
  const msg = (role, type, text) => ({ type: 'message', role, content: [{ type, text }] });
  return jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id: sessionId, timestamp: at(0), cwd, originator: 'codex_cli_rs', cli_version: '0.160.0' } },
    item(1, msg('developer', 'input_text', '<permissions instructions>sandbox policy</permissions instructions>')),
    item(2, msg('user', 'input_text', `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`)),
    item(3, msg('developer', 'input_text', '## ccmem context\nRead `.ccmem/context-x.md` at session start and after context compaction.')),
    { timestamp: at(4), type: 'turn_context', payload: { cwd, approval_policy: 'on-request', model: 'gpt-6-luna' } },
    item(5, msg('user', 'input_text', 'Please switch the build to pnpm.')),
    item(6, { type: 'function_call', name: 'shell', arguments: '{"command":["cat",".ccmem/context-x.md"]}', call_id: 'c1' }),
    item(7, { type: 'function_call_output', call_id: 'c1', output: '=== ccmem: stable context ===\n- e2e seed rule' }),
    item(8, msg('assistant', 'output_text', 'Switched the build to pnpm and regenerated the lockfile.')),
    item(9, msg('user', 'input_text', 'Thanks. Always use pnpm in this repository.')),
    item(10, msg('assistant', 'output_text', 'Noted: pnpm from now on.'))
  ]);
}

function ompSession(sessionId, cwd) {
  return jsonl([
    { type: 'title', title: 'e2e', titleSource: 'auto' },
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-10-17T09:00:00.000Z', cwd },
    { type: 'message', id: 'e1', parentId: null, timestamp: '2026-10-17T09:00:01.000Z', message: { role: 'user', content: 'How should the config file be formatted?' } },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-10-17T09:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Use JSON; it is what the loader reads.' }] } },
    { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-10-17T09:00:03.000Z', message: { role: 'user', content: 'Good, keep it JSON from now on.' } },
    { type: 'message', id: 'e4', parentId: 'e3', timestamp: '2026-10-17T09:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Will do.' }] } }
  ]);
}

function hookStatus(result) {
  return `exit ${result.status}${result.stderr ? `, stderr ${JSON.stringify(result.stderr.trim())}` : ''}`;
}

function noHookFailure(result) {
  return result.status === 0 && !/failed \(/.test(result.stderr ?? '');
}

async function main() {
  const argv = process.argv.slice(2);
  const runtimeIdx = argv.indexOf('--omp-runtime');
  const reasons = refusalReasons();
  const expectedArgs = runtimeIdx === -1 ? 0 : 2;
  if (argv.length !== expectedArgs || (runtimeIdx !== -1 && (runtimeIdx !== 0 || !argv[1]))) {
    reasons.push(`unexpected arguments ${JSON.stringify(argv)}; usage: e2e-codex-omp.mjs [--omp-runtime <path>]`);
  }
  if (reasons.length > 0) {
    process.stderr.write(`e2e-codex-omp: refusing to run:\n${reasons.map((r) => `  - ${r}`).join('\n')}\n`);
    process.exit(2);
  }

  const codexHome = process.env.CODEX_HOME;
  const agentDir = process.env.CCMEM_OMP_AGENT_DIR;
  const dataRoot = process.env.CCMEM_DATA_ROOT;
  const cwd = realpathSync(process.env.CCMEM_E2E_CWD);
  const { openDb } = await import('../lib/db.mjs');
  const { contextFileName } = await import('../lib/context-file.mjs');
  const { getContextFilePath } = await import('../lib/context-file.mjs');

  const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  note(`commit ${head}; node ${process.version} at ${process.execPath}`);
  note(`CODEX_HOME=${codexHome} CCMEM_OMP_AGENT_DIR=${agentDir} CCMEM_DATA_ROOT=${dataRoot} cwd=${cwd}`);

  // The "project": a git repo with a remote, so the project key is the remote's.
  if (!existsSync(path.join(cwd, '.git'))) {
    spawnSync('git', ['init', '-q', cwd]);
    spawnSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'https://example.invalid/e2e/demo.git']);
  }

  const seedGlobal = runCli(['save', '--global', 'e2e seed rule: always run the linter before committing'], cwd);
  const seedProject = runCli(['save', 'e2e project fact: this repository builds with pnpm'], cwd);
  check(seedGlobal.status === 0 && seedProject.status === 0, 'seeded one global and one project memory', `${seedGlobal.stdout.trim()} / ${seedProject.stdout.trim()}`);

  const query = (sql, ...params) => {
    const db = openDb();
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };

  // ---- Codex ---------------------------------------------------------------
  note('codex');
  const foreignHooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop-hook', timeout: 3 }] }] } };
  const hooksFile = path.join(codexHome, 'hooks.json');
  writeFileSync(hooksFile, `${JSON.stringify(foreignHooks)}\n`, { mode: 0o644 });
  writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\n', { mode: 0o644 });
  const codexSession = '019a0000-0000-7000-8000-00000000e2e1';
  const rolloutDir = path.join(codexHome, 'sessions/2026/10/17');
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = path.join(rolloutDir, `rollout-2026-10-17T09-00-00-${codexSession}.jsonl`);
  writeFileSync(rollout, codexRollout(codexSession, cwd));
  const codexBefore = snapshot(codexHome);
  const hooksShaBefore = sha256(hooksFile);

  const install = runCli(['install', 'codex'], cwd);
  check(install.status === 0, 'ccmem install codex exits 0', hookStatus(install));
  check(/run \/hooks to approve/.test(install.stdout), 'install tells the human to approve in /hooks');
  const installed = JSON.parse(readFileSync(hooksFile, 'utf8'));
  check(installed.hooks.Stop[0].hooks[0].command === 'echo user-stop-hook', 'the foreign Stop hook is kept first (its trust index is unchanged)');
  check(modeOf(hooksFile) === '644', 'the existing hooks.json keeps its mode', modeOf(hooksFile));
  const backups = readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.bak.'));
  check(backups.length === 1 && sha256(path.join(codexHome, backups[0])) === hooksShaBefore, 'a hooks.json.bak.<ms> holds the original bytes', backups.join(','));
  check(readFileSync(path.join(codexHome, 'config.toml'), 'utf8') === 'model = "gpt-6-luna"\n', 'config.toml is not touched');

  const commands = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const ours = (installed.hooks[event] ?? []).flatMap((group) => group.hooks).filter((hook) => hook.command.includes('/scripts/hook.mjs'));
    check(ours.length === 1, `exactly one ccmem ${event} hook`, ours.map((hook) => hook.command).join(' | '));
    commands[event] = ours[0]?.command;
  }
  const shaInstalled = sha256(hooksFile);
  const reinstall = runCli(['install', 'codex'], cwd);
  check(reinstall.status === 0 && /nothing changed/.test(reinstall.stdout) && sha256(hooksFile) === shaInstalled, 're-running install is a no-op');

  // Codex runs each command hook through a shell with the event's JSON on stdin.
  const base = { session_id: codexSession, transcript_path: rollout, cwd, model: 'gpt-6-luna', permission_mode: 'default' };
  const runCodexHook = (event, payload) => {
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-c', commands[event]], { cwd, env: process.env, encoding: 'utf8', input: JSON.stringify({ ...base, hook_event_name: event, ...payload }) });
    note(`codex ${event} hook took ${Date.now() - started} ms wall clock (Codex timeout 5 s)`);
    return result;
  };

  const start = runCodexHook('SessionStart', { source: 'startup' });
  check(noHookFailure(start), 'codex SessionStart hook succeeds', hookStatus(start));
  const startOut = JSON.parse(start.stdout || '{}').hookSpecificOutput ?? {};
  const instruction = startOut.additionalContext ?? '';
  const contextName = contextFileName(codexSession);
  check(startOut.hookEventName === 'SessionStart', 'SessionStart output names its event');
  check(instruction.includes(`.ccmem/${contextName}`), 'the instruction names this session\'s context file', contextName);
  check(Buffer.byteLength(instruction, 'utf8') <= 1024, 'the instruction is at most 1024 bytes', `${Buffer.byteLength(instruction, 'utf8')} bytes`);
  check(instruction.includes('after context compaction') && !/claude|\/compact/i.test(instruction), 'the instruction uses Codex wording, not Claude\'s');
  check(!instruction.includes('e2e seed rule'), 'no memory text goes into the conversation at session start');
  const contextFile = getContextFilePath(cwd, codexSession);
  check(existsSync(contextFile) && readFileSync(contextFile, 'utf8').includes('e2e seed rule'), 'session start writes the context file with the stable rules', contextFile);

  const prompt = runCodexHook('UserPromptSubmit', { turn_id: 'turn-1', prompt: 'Switch the build to pnpm' });
  check(noHookFailure(prompt), 'codex UserPromptSubmit hook succeeds', hookStatus(prompt));
  const promptOut = JSON.parse(prompt.stdout || '{}').hookSpecificOutput ?? {};
  check(promptOut.hookEventName === 'UserPromptSubmit' && promptOut.additionalContext === '', 'prompt-submit injects nothing into the conversation');
  const promptContext = existsSync(contextFile) ? readFileSync(contextFile, 'utf8') : '';
  check(promptContext.includes('e2e seed rule') && promptContext.includes('pnpm'), 'the context file holds the stable rule and the retrieved pnpm fact');

  const stop = runCodexHook('Stop', { turn_id: 'turn-1', stop_hook_active: false, last_assistant_message: 'Noted: pnpm from now on.' });
  check(noHookFailure(stop) && stop.stdout === '{}', 'codex Stop hook succeeds and prints {}', hookStatus(stop));

  const codexCtx = query('SELECT agent, message_count, tool_calls, last_seq FROM session_context WHERE session_id = ?', codexSession)[0];
  check(codexCtx?.agent === 'codex', 'session_context.agent is codex', JSON.stringify(codexCtx));
  // 11 rollout lines -> 2 user + 2 assistant + 1 tool call; the environment
  // context, developer items, tool output and bookkeeping lines are dropped.
  check(codexCtx?.message_count === 5 && codexCtx?.tool_calls === 1 && codexCtx?.last_seq === 5, 'the rollout is counted through the Codex parser: 5 entries, 1 tool call, injected context dropped');
  const codexTasks = query("SELECT payload FROM tasks WHERE type = 'summarize_pending' AND json_extract(payload, '$.session_id') = ?", codexSession).map((row) => JSON.parse(row.payload));
  check(codexTasks.length === 1 && codexTasks[0].agent === 'codex' && codexTasks[0].transcript_path === rollout, 'one summarize_pending task queued with agent codex and the rollout path', JSON.stringify(codexTasks));

  const uninstall = runCli(['uninstall', 'codex'], cwd);
  check(uninstall.status === 0 && /back to what it was before install/.test(uninstall.stdout), 'ccmem uninstall codex restores the file', hookStatus(uninstall));
  check(sha256(hooksFile) === hooksShaBefore, 'hooks.json sha256 equals its pre-install sha256', hooksShaBefore);
  const codexChanges = diffSnapshots(codexBefore, snapshot(codexHome));
  check(codexChanges.every((change) => /^added hooks\.json\.bak\.\d+$/.test(change)), 'nothing else under CODEX_HOME changed except the install backup', codexChanges.join(', ') || 'no changes');
  check(!existsSync(path.join(dataRoot, 'installs/codex.json')), 'the codex install record is removed');

  // ---- OMP -----------------------------------------------------------------
  note('omp');
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(path.join(agentDir, 'extensions/other.ts'), 'export default () => {};\n', { mode: 0o644 });
  // Distinct 8-char prefixes: the context file is named after the first 8
  // characters of the session id, so sharing the Codex session's prefix would
  // let the Codex run's file stand in for the OMP one.
  const ompA = '019b1111-0000-7000-8000-00000000e2ea';
  const ompB = '019b2222-0000-7000-8000-00000000e2eb';
  const sessionsDir = path.join(agentDir, 'sessions/e2e');
  mkdirSync(sessionsDir, { recursive: true });
  const fileA = path.join(sessionsDir, `2026-10-17T09-00-00_${ompA}.jsonl`);
  const fileB = path.join(sessionsDir, `2026-10-17T09-10-00_${ompB}.jsonl`);
  writeFileSync(fileA, ompSession(ompA, cwd));
  writeFileSync(fileB, ompSession(ompB, cwd));
  const ompBefore = snapshot(agentDir);
  check(!existsSync(getContextFilePath(cwd, ompA)), 'no context file exists yet for the OMP session');

  const ompInstall = runCli(['install', 'omp'], cwd);
  check(ompInstall.status === 0, 'ccmem install omp exits 0', hookStatus(ompInstall));
  const loader = path.join(agentDir, 'extensions/ccmem.ts');
  check(existsSync(loader) && modeOf(loader) === '600', 'the loader is written 0600', existsSync(loader) ? modeOf(loader) : 'missing');
  const loaderSha = existsSync(loader) ? sha256(loader) : null;
  const ompReinstall = runCli(['install', 'omp'], cwd);
  check(ompReinstall.status === 0 && /nothing changed/.test(ompReinstall.stdout) && sha256(loader) === loaderSha, 're-running install omp is a no-op');

  let runtime = runtimeIdx === -1 ? null : argv[runtimeIdx + 1];
  if (!runtime) {
    const which = spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' });
    runtime = which.status === 0 ? which.stdout.trim() : process.execPath;
  }
  const version = spawnSync(runtime, ['--version'], { encoding: 'utf8' }).stdout.trim();
  note(`loading the OMP loader under ${runtime} ${version}`);

  // A fake `pi`: records handlers and sent messages, then drives the events in
  // the order OMP emits them. Only the API slice the extension declares.
  const driveDir = mkdtempSync(path.join(os.tmpdir(), 'ccmem-e2e-omp-drive-'));
  const drive = path.join(driveDir, 'drive.mjs');
  writeFileSync(drive, `
const [loaderPath, cwd, idA, fileA, idB, fileB] = process.argv.slice(2);
const { default: extension } = await import(new URL('file://' + loaderPath).href);
const handlers = {};
const messages = [];
extension({
  on(event, handler) { (handlers[event] ??= []).push(handler); },
  sendMessage(message, options) { messages.push({ message, options }); }
});
const ctx = (id, file, extra = {}) => ({ cwd, mode: 'interactive', sessionManager: { getSessionId: () => id, getSessionFile: () => file }, ...extra });
const emit = async (event, payload, context) => {
  const results = [];
  // typeof, because JSON would turn an undefined return into null.
  for (const handler of handlers[event] ?? []) results.push(typeof await handler(payload, context));
  return results;
};
const out = { registered: Object.keys(handlers).sort(), returns: {} };
out.returns.session_start = await emit('session_start', { type: 'session_start' }, ctx(idA, fileA));
out.afterStart = messages.length;
await emit('session_start', { type: 'session_start' }, ctx(idA, fileA));
out.afterRepeat = messages.length;
out.returns.before_agent_start = await emit('before_agent_start', { prompt: 'Keep the config file JSON' }, ctx(idA, fileA));
out.returns.session_stop = await emit('session_stop', { session_id: idA, session_file: fileA }, ctx(idA, fileA));
out.returns.session_switch = await emit('session_switch', { type: 'session_switch', reason: 'new' }, ctx(idB, fileB));
out.afterSwitch = messages.length;
await emit('session_start', {}, ctx('sub-' + idA, fileA, { agent: { kind: 'sub' } }));
await emit('session_start', {}, ctx('print-' + idA, fileA, { mode: 'print' }));
await emit('session_stop', { session_id: 'sub-' + idA, session_file: fileA }, ctx('sub-' + idA, fileA, { agent: { kind: 'sub' } }));
out.afterSkipped = messages.length;
out.messages = messages;
process.stdout.write(JSON.stringify(out));
`);
  const driven = spawnSync(runtime, [drive, loader, cwd, ompA, fileA, ompB, fileB], { cwd, env: process.env, encoding: 'utf8', timeout: 60000 });
  rmSync(driveDir, { recursive: true, force: true });
  check(driven.status === 0, `the loader loads and runs under ${path.basename(runtime)}`, hookStatus(driven));
  let out = {};
  try {
    out = JSON.parse(driven.stdout);
  } catch {
    check(false, 'the drive script printed its JSON', driven.stdout.slice(0, 200));
  }
  check(JSON.stringify(out.registered) === JSON.stringify(['before_agent_start', 'session_start', 'session_stop', 'session_switch']), 'the extension registers exactly its four events', JSON.stringify(out.registered));
  const first = out.messages?.[0];
  check(out.afterStart === 1 && first?.message?.customType === 'ccmem' && first?.message?.display === false && first?.options?.deliverAs === 'nextTurn', 'session_start sends one hidden next-turn message');
  check(first?.message?.content?.includes(`.ccmem/${contextFileName(ompA)}`) && first.message.content.includes('after compaction') && !/claude|\/compact/i.test(first.message.content), 'it is the OMP read instruction for this session');
  check(Buffer.byteLength(first?.message?.content ?? '', 'utf8') <= 1024, 'the OMP instruction is at most 1024 bytes', `${Buffer.byteLength(first?.message?.content ?? '', 'utf8')} bytes`);
  check(out.afterRepeat === 1, 'a repeated session_start for the same session sends nothing more');
  const returned = [...(out.returns?.before_agent_start ?? []), ...(out.returns?.session_stop ?? [])];
  check(returned.length === 2 && returned.every((value) => value === 'undefined'), 'before_agent_start and session_stop return undefined (the system prompt is never touched)');
  check(out.afterSwitch === 2 && out.messages?.[1]?.message?.content?.includes(`.ccmem/${contextFileName(ompB)}`), 'session_switch instructs the new session once');
  check(out.afterSkipped === 2, 'subagent and print-mode events send nothing');

  const ompContext = getContextFilePath(cwd, ompA);
  check(existsSync(ompContext) && readFileSync(ompContext, 'utf8').includes('e2e seed rule'), 'before_agent_start rewrote the OMP session\'s context file', ompContext);
  const ompCtx = query('SELECT session_id, agent, message_count FROM session_context WHERE session_id IN (?, ?) ORDER BY session_id', ompA, ompB);
  check(ompCtx.length === 2 && ompCtx.every((row) => row.agent === 'omp'), 'session_context.agent is omp for both sessions', JSON.stringify(ompCtx));
  check(ompCtx.find((row) => row.session_id === ompA)?.message_count === 4, 'the OMP session file is counted through the OMP parser: 4 messages');
  const ompTasks = query("SELECT payload FROM tasks WHERE type = 'summarize_pending' AND json_extract(payload, '$.agent') = 'omp'").map((row) => JSON.parse(row.payload));
  check(ompTasks.length === 1 && ompTasks[0].session_id === ompA && ompTasks[0].transcript_path === fileA, 'one summarize_pending task queued with agent omp and the session file', JSON.stringify(ompTasks));
  const skippedRows = query("SELECT session_id FROM session_context WHERE session_id LIKE 'sub-%' OR session_id LIKE 'print-%'");
  check(skippedRows.length === 0, 'subagent and print sessions left nothing in the database');

  const ompUninstall = runCli(['uninstall', 'omp'], cwd);
  check(ompUninstall.status === 0 && !existsSync(loader), 'ccmem uninstall omp removes the loader', hookStatus(ompUninstall));
  const ompChanges = diffSnapshots(ompBefore, snapshot(agentDir));
  check(ompChanges.length === 0, 'the OMP agent dir is byte-identical to before install (sha256 of every file)', ompChanges.join(', ') || 'no changes');
  check(!existsSync(path.join(dataRoot, 'installs/omp.json')), 'the omp install record is removed');

  // ---- metrics: every hook run above recorded no error ---------------------
  const metricsFile = path.join(dataRoot, 'metrics.jsonl');
  const rows = existsSync(metricsFile) ? readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.hook) : [];
  check(rows.length > 0 && rows.every((row) => row.error == null), 'every hook metrics row has error=null', `${rows.length} rows`);
  for (const hook of ['session_start', 'prompt_submit', 'stop']) {
    const ms = rows.filter((row) => row.hook === hook).map((row) => Math.round(row.ms_total));
    note(`${hook} ms_total as recorded by ccmem: ${ms.join(', ')}`);
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} checks failed)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  await main();
}
