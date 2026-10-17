#!/usr/bin/env node
/**
 * Paid quality comparison of the summarizer backends (spec §7, Task 12 step 2).
 *
 * Runs each transcript through ccmem's real summarize_pending path once per
 * backend, each backend against its own fresh temp data root, and writes a
 * side-by-side markdown report with the five criteria the human approved as
 * empty columns for the human to judge. EVERY BACKEND CALL IS A REAL, PAID
 * MODEL CALL, so nothing is called without --i-approve-paid-calls; without it
 * the script prints what it would call and exits 1.
 *
 *   node scripts/acceptance/compare-summarizers.mjs --out report.md \
 *     [--backends claude,codex,omp] [--config config.json] \
 *     [--i-approve-paid-calls] <transcript>...
 *
 * --backends  defaults to the shipped llm.backend_order.
 * --config    a ccmem config.json; only its `llm` section (commands, models,
 *             timeouts) is used. Without it the shipped llm defaults are used.
 * --out       the markdown file to write; an existing file is never overwritten.
 *
 * Each transcript's agent (claude-code, codex, omp) is detected from its first
 * line. The project key for project-scoped memories is the cwd's.
 *
 * Internals: each (backend, transcript) runs in a child process of this same
 * file with CCMEM_DATA_ROOT pointing at that backend's temp root and the job in
 * CCMEM_COMPARE_WORKER; the parent sets that variable only after approval.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '../..');
const KNOWN_BACKENDS = ['claude', 'codex', 'omp'];
const APPROVE_FLAG = '--i-approve-paid-calls';
const USAGE = `usage: compare-summarizers.mjs --out <report.md> [--backends claude,codex,omp] [--config <config.json>] [${APPROVE_FLAG}] <transcript>...`;

// The human's five criteria (spec §7), verbatim in meaning.
export const CRITERIA = [
  ['actionable', 'tells you what to do next time, not a one-off log'],
  ['self-contained', 'readable without the original conversation, carries why and when it applies'],
  ['correct scope', 'global vs project'],
  ['no duplicates / contradictions', 'with existing memories'],
  ['complete & well-formed', 'not truncated, no raw JSON in content']
];

/** Returns { options } or { error }. Pure: reads no files. */
export function parseArgs(argv, defaultBackends) {
  const options = { backends: [...defaultBackends], config: null, out: null, approved: false, transcripts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === APPROVE_FLAG) {
      options.approved = true;
    } else if (arg === '--backends' || arg === '--config' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${arg} needs a value` };
      }
      i += 1;
      if (arg === '--backends') {
        options.backends = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))];
      } else {
        options[arg.slice(2)] = value;
      }
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg}` };
    } else {
      options.transcripts.push(arg);
    }
  }

  const unknown = options.backends.filter((id) => !KNOWN_BACKENDS.includes(id));
  if (unknown.length > 0 || options.backends.length === 0) {
    return { error: `--backends must name some of ${KNOWN_BACKENDS.join(', ')} (got ${options.backends.join(',') || 'none'})` };
  }
  if (!options.out) {
    return { error: '--out is required' };
  }
  if (options.transcripts.length === 0) {
    return { error: 'name at least one transcript' };
  }
  return { options };
}

/** The agent a transcript came from, read off its first parseable line. */
export function detectAgent(transcriptPath) {
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === 'session_meta') {
      return 'codex';
    }
    if (entry?.type === 'title' || entry?.type === 'session') {
      return 'omp';
    }
    return 'claude-code';
  }
  return 'claude-code';
}

function cell(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function memoryLine(memory) {
  const tags = memory.tags?.length ? ` _(${cell(memory.tags.join(', '))})_` : '';
  const quarantined = memory.quarantined ? ' **(quarantined at write)**' : '';
  return `**[${memory.scope}/${memory.type}]** ${cell(memory.content)}${tags}${quarantined}`;
}

function tokensNote(costRows) {
  if (!costRows?.length) {
    return 'no call recorded';
  }
  return costRows.map((row) => {
    const tokens = row.input_tokens == null && row.output_tokens == null
      ? 'tokens not reported'
      : `in ${row.input_tokens ?? '?'} / out ${row.output_tokens ?? '?'} tokens`;
    const cost = row.total_cost_usd == null ? '' : `, $${row.total_cost_usd}`;
    return `${row.task_type ?? 'call'}: ${tokens}${cost}, ${row.wall_clock_ms} ms`;
  }).join('; ');
}

/**
 * The report. `results` is [{ transcript, agent, cells: { <backend>: { memories,
 * audits, costRows, error } } }]; criteria columns are left empty for the human.
 */
export function renderReport({ backends, results, commit, generatedAt, llmSource }) {
  const lines = [
    '# Summarizer quality comparison',
    '',
    `Generated ${generatedAt} from ccmem ${commit}; llm settings from ${llmSource}.`,
    'Each backend ran against its own fresh data root, transcripts in the order listed,',
    'so "existing memories" for criterion 4 are the ones that backend produced from the earlier transcripts.',
    '',
    'Criteria (fill each cell with pass / fail and a word of why):',
    ...CRITERIA.map(([name, meaning], index) => `${index + 1}. **${name}** — ${meaning}`),
    ''
  ];
  const header = ['Backend', 'Memories produced', ...CRITERIA.map(([name], index) => `${index + 1}. ${name}`), 'Notes'];

  for (const { transcript, agent, cells } of results) {
    lines.push(`## ${cell(path.basename(transcript))} (${agent})`, '', `\`${transcript}\``, '');
    lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
    for (const backend of backends) {
      const result = cells[backend] ?? {};
      const memories = result.error
        ? `**error:** ${cell(result.error)}`
        : (result.memories?.length ? result.memories.map(memoryLine).join('<br>') : '_none_');
      const notes = [
        ...(result.audits ?? []).map((audit) => cell(`${audit.action}${audit.reason ? `: ${audit.reason}` : ''}`)),
        cell(tokensNote(result.costRows))
      ].join('<br>');
      lines.push(`| ${backend} | ${memories} | ${CRITERIA.map(() => ' ').join(' | ')} | ${notes} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ---- worker: one transcript, one backend, inside that backend's data root ----

async function runWorker(job) {
  const { openDb } = await import('../lib/db.mjs');
  const { computeSessionStats, countTranscriptLines } = await import('../lib/transcript.mjs');
  const { resolveProjectKey } = await import('../lib/project-key.mjs');
  const { runSummarizePending } = await import('../daemon/tasks/summarize-pending.mjs');
  const { daemonCostFile } = await import('../lib/metrics.mjs');

  const db = openDb();
  try {
    const maxId = (table) => db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get().id;
    const memoriesBefore = maxId('memories');
    const auditsBefore = maxId('audit_log');
    const costBefore = existsSync(daemonCostFile()) ? readFileSync(daemonCostFile(), 'utf8').length : 0;
    const stats = computeSessionStats(job.transcript, job.agent);
    const seq = countTranscriptLines(job.transcript, job.agent);

    // What the Stop hook records before it queues the task.
    db.prepare(
      `INSERT INTO session_context (session_id, project_key, tool_calls, message_count, duration_ms, last_seq, updated_at, agent)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(job.sessionId, resolveProjectKey(process.cwd()), stats.toolCalls, stats.messageCount, seq, Date.now(), job.agent);
    await runSummarizePending(db, {
      id: 0,
      type: 'summarize_pending',
      payload: JSON.stringify({ session_id: job.sessionId, transcript_path: job.transcript, last_message_seq: seq, agent: job.agent })
    });

    const memories = db.prepare(
      `SELECT scope, type, content, tags, quarantined_at FROM memories WHERE id > ? ORDER BY id`
    ).all(memoriesBefore).map(({ quarantined_at: quarantinedAt, tags, ...row }) => ({
      ...row,
      tags: tags ? JSON.parse(tags) : [],
      quarantined: quarantinedAt != null
    }));
    const audits = db.prepare(
      `SELECT action, details FROM audit_log WHERE id > ? ORDER BY id`
    ).all(auditsBefore).map((row) => {
      const details = row.details ? JSON.parse(row.details) : {};
      const reason = row.action === 'summarize_pending_applied'
        ? `inserted ${details.inserted_count}, skipped ${details.skipped_count} as duplicates or unwritable`
        : details.reason ?? null;
      return { action: row.action, reason };
    });
    const costRows = existsSync(daemonCostFile())
      ? readFileSync(daemonCostFile(), 'utf8').slice(costBefore).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    process.stdout.write(JSON.stringify({ memories, audits, costRows }));
  } finally {
    db.close();
  }
}

// ---- parent -----------------------------------------------------------------

function describeBackend(id, llm) {
  const command = llm?.commands?.[id] ?? id;
  const model = llm?.models?.[id] ?? 'its default model';
  return `${id} (command ${command}, ${model})`;
}

function runJob({ backend, root, transcript, agent, index }) {
  const env = { ...process.env, CCMEM_DATA_ROOT: root };
  for (const name of ['CCMEM_CONFIG_PATH', 'CCMEM_CLAUDE_P_COMMAND', 'CCMEM_CLAUDE_P_ARGS_JSON', 'CCMEM_TEST_MODE', 'CCMEM_INTERNAL']) {
    delete env[name];
  }
  env.CCMEM_COMPARE_WORKER = JSON.stringify({ transcript, agent, sessionId: `compare-${backend}-${index}` });
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-sqlite', SELF], {
    env,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000
  });
  if (child.status !== 0) {
    return { error: (child.stderr || child.error?.message || `exit ${child.status}`).trim().slice(0, 500) };
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    return { error: `unreadable worker output: ${child.stdout.slice(0, 200)}` };
  }
}

async function main() {
  const { DEFAULT_CONFIG } = await import('../lib/config.mjs');
  const parsed = parseArgs(process.argv.slice(2), DEFAULT_CONFIG.llm.backend_order);
  if (parsed.error) {
    process.stderr.write(`compare-summarizers: ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const { options } = parsed;

  const missing = options.transcripts.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    process.stderr.write(`compare-summarizers: no such transcript: ${missing.join(', ')}\n`);
    process.exit(2);
  }
  if (existsSync(options.out)) {
    process.stderr.write(`compare-summarizers: ${options.out} exists; refusing to overwrite it\n`);
    process.exit(2);
  }
  let llm = structuredClone(DEFAULT_CONFIG.llm);
  if (options.config) {
    try {
      llm = { ...llm, ...JSON.parse(readFileSync(options.config, 'utf8')).llm };
    } catch (error) {
      process.stderr.write(`compare-summarizers: cannot read llm settings from ${options.config} (${error.message})\n`);
      process.exit(2);
    }
  }

  const transcripts = options.transcripts.map((file) => {
    const absolute = realpathSync(file);
    return { transcript: absolute, agent: detectAgent(absolute) };
  });
  const calls = transcripts.length * options.backends.length;
  process.stdout.write(
    `compare-summarizers: ${transcripts.length} transcript(s) x ${options.backends.length} backend(s) = ${calls} summarize call(s), ` +
    'plus one rewrite call per over-long memory. Every call is a real, paid model call.\n' +
    `  backends: ${options.backends.map((id) => describeBackend(id, llm)).join('; ')}\n` +
    transcripts.map(({ transcript, agent }) => `  transcript: ${transcript} (${agent})\n`).join('')
  );
  if (!options.approved) {
    process.stdout.write(`compare-summarizers: nothing was called. Re-run with ${APPROVE_FLAG} to make these calls.\n`);
    process.exit(1);
  }

  const results = transcripts.map((entry) => ({ ...entry, cells: {} }));
  for (const backend of options.backends) {
    const root = mkdtempSync(path.join(os.tmpdir(), `ccmem-compare-${backend}-`));
    try {
      writeFileSync(path.join(root, 'config.json'), `${JSON.stringify({ llm: { ...llm, backend, backend_order: [backend] } }, null, 2)}\n`, { mode: 0o600 });
      results.forEach((entry, index) => {
        process.stdout.write(`  ${backend}: ${path.basename(entry.transcript)}...\n`);
        entry.cells[backend] = runJob({ backend, root, transcript: entry.transcript, agent: entry.agent, index });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const commit = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';
  const report = renderReport({
    backends: options.backends,
    results,
    commit,
    generatedAt: new Date().toISOString(),
    llmSource: options.config ?? 'the shipped defaults'
  });
  writeFileSync(options.out, report, { flag: 'wx' });
  process.stdout.write(`compare-summarizers: wrote ${options.out}\n`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  if (process.env.CCMEM_COMPARE_WORKER) {
    await runWorker(JSON.parse(process.env.CCMEM_COMPARE_WORKER));
  } else {
    await main();
  }
}
