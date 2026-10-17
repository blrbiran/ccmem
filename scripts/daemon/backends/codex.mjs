import { writeFileSync } from 'node:fs';
import path from 'node:path';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed);
      }
    } catch {}
  }
  return events;
}

function to24Hour(hour, meridiem) {
  const h = hour % 12;
  return meridiem.toUpperCase() === 'PM' ? h + 12 : h;
}

/**
 * Codex prints the reset in local time, in one of two shapes
 * (codex-rs protocol/src/error.rs format_retry_timestamp):
 *   "Oct 22nd, 2026 2:13 PM"  -- a later day
 *   "2:13 PM"                 -- today
 * Anything else is null: an unknown reset time, never a guessed one.
 */
export function parseCodexResetAt(text, now = new Date()) {
  const source = String(text ?? '');
  const dated = source.match(/try again at ([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?, (\d{4}),? (\d{1,2}):(\d{2}) ?(AM|PM)/i);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    if (month === -1) {
      return null;
    }
    return new Date(Number(dated[3]), month, Number(dated[2]), to24Hour(Number(dated[4]), dated[6]), Number(dated[5])).getTime();
  }

  const timeOnly = source.match(/try again at (\d{1,2}):(\d{2}) ?(AM|PM)/i);
  if (timeOnly) {
    const reset = new Date(now);
    reset.setHours(to24Hour(Number(timeOnly[1]), timeOnly[3]), Number(timeOnly[2]), 0, 0);
    return reset.getTime();
  }

  return null;
}

export const codexBackend = {
  id: 'codex',
  label: 'codex exec',

  buildInvocation(prompt, { jsonSchema, model, command, workDir }) {
    const outputFile = path.join(workDir, 'last.txt');
    const args = [
      'exec',
      '--ephemeral',
      '-s', 'read-only',
      '--skip-git-repo-check',
      // Recursion guard: ccmem's Codex hooks must not fire inside a ccmem
      // summarization (spec §5.5). CCMEM_INTERNAL=1 is the second layer.
      '-c', 'features.hooks=false',
      '--json',
      '-o', outputFile
    ];
    if (model) {
      args.push('-m', model);
    }
    if (jsonSchema) {
      const schemaFile = path.join(workDir, 'schema.json');
      writeFileSync(schemaFile, JSON.stringify(jsonSchema), { mode: 0o600 });
      args.push('--output-schema', schemaFile);
    }
    args.push('-');

    return {
      command: command ?? 'codex',
      args,
      env: {},
      stdin: String(prompt ?? ''),
      outputFile,
      outputFormat: 'jsonl'
    };
  },

  // The answer is the last agent message Codex writes to -o, not the JSONL
  // event stream on stdout. A successful exit that wrote nothing is a failure:
  // returning '' would read downstream as "the model extracted nothing".
  readResult({ outputFileText }) {
    if (typeof outputFileText !== 'string') {
      throw new Error('codex exec exit 0 but wrote no last message');
    }
    return outputFileText;
  },

  // turn.completed carries usage (codex-rs exec/src/exec_events.rs). Codex
  // reports no price, so cost is always null.
  extractUsage({ stdout }) {
    const withUsage = parseJsonLines(stdout).filter((event) => event.usage && typeof event.usage === 'object').at(-1);
    return {
      input_tokens: finiteOrNull(withUsage?.usage?.input_tokens),
      output_tokens: finiteOrNull(withUsage?.usage?.output_tokens),
      total_cost_usd: null
    };
  },

  // Only Codex's own error channels are read: stderr, and the `error` /
  // `turn.failed` events. Agent messages are model text, and a transcript that
  // talks about a usage limit must not look like one.
  classifyExhaustion({ stderr, stdout }) {
    const errorText = parseJsonLines(stdout)
      .map((event) => (event.type === 'error' ? event.message : event.type === 'turn.failed' ? event.error?.message : null))
      .filter((message) => typeof message === 'string');
    const text = [String(stderr ?? ''), ...errorText].join('\n');
    if (!/usage limit|try again at/i.test(text)) {
      return { exhausted: false, resetAt: null };
    }
    return { exhausted: true, resetAt: parseCodexResetAt(text) };
  }
};
