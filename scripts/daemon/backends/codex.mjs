import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { finiteOrNull, parseJsonLines } from './jsonl.mjs';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function nullable(schema) {
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'], ...(schema.enum ? { enum: withNull(schema.enum) } : {}) };
  }
  if (typeof schema.type === 'string') {
    return { ...schema, type: [schema.type, 'null'], ...(schema.enum ? { enum: withNull(schema.enum) } : {}) };
  }
  if (Array.isArray(schema.enum)) {
    return { ...schema, enum: withNull(schema.enum) };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function withNull(values) {
  return values.includes(null) ? values : [...values, null];
}

/**
 * Codex sends --output-schema to the Responses API with strict: true
 * (codex-rs core/src/session/turn.rs output_schema_strict, codex-api
 * src/common.rs create_text_param_for_request), and passes the file through
 * unchanged (exec/src/lib.rs load_output_schema). Strict mode requires every
 * object to list all of its properties in `required` and to set
 * additionalProperties: false, so an optional property is expressed as a
 * required, nullable one. Every consumer of these schemas already reads null
 * as "absent". Length keywords (maxLength) are kept: OpenAI documents them as
 * unsupported only for fine-tuned models.
 */
export function strictSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const next = { ...schema };
  if (next.items) {
    next.items = strictSchema(next.items);
  }
  if (Array.isArray(next.anyOf)) {
    next.anyOf = next.anyOf.map(strictSchema);
  }
  if (next.properties && typeof next.properties === 'object') {
    const required = new Set(Array.isArray(next.required) ? next.required : []);
    next.properties = Object.fromEntries(
      Object.entries(next.properties).map(([key, child]) => {
        const strictChild = strictSchema(child);
        return [key, required.has(key) ? strictChild : nullable(strictChild)];
      })
    );
    next.required = Object.keys(next.properties);
    next.additionalProperties = false;
  }
  return next;
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
  // Runs in a per-call dir: last.txt and schema.json live there, and no repo
  // AGENTS.md is picked up from the daemon's cwd.
  isolatedCwd: true,

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
      // The human's legacy notify program must not fire for a background turn.
      '-c', 'notify=[]',
      '--json',
      '-o', outputFile
    ];
    if (model) {
      args.push('-m', model);
    }
    if (jsonSchema) {
      const schemaFile = path.join(workDir, 'schema.json');
      writeFileSync(schemaFile, JSON.stringify(strictSchema(jsonSchema)), { mode: 0o600 });
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
