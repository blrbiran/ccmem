import { finiteOrNull, parseJsonLines } from './jsonl.mjs';

// `--mode json` prints every message_end, the echoed user prompt included; the
// answer is the last one the assistant produced.
function assistantMessages(stdout) {
  return parseJsonLines(stdout)
    .filter((event) => event.type === 'message_end' && event.message?.role === 'assistant')
    .map((event) => event.message);
}

export const ompBackend = {
  id: 'omp',
  label: 'omp -p',
  // Runs in a per-call dir so no repo rules/AGENTS.md are loaded.
  isolatedCwd: true,

  buildInvocation(prompt, { jsonSchema, model, command }) {
    // Recursion guard: --no-extensions keeps ccmem's own OMP extension out of
    // the child; --no-session keeps the call from becoming a session ccmem
    // would later learn from. Rules/skills/tools are off so a summarization
    // runs on the prompt alone.
    const args = ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--mode', 'json'];
    if (model) {
      args.push('--model', model);
    }

    // OMP has no structured-output flag, so the schema is part of the prompt.
    const text = String(prompt ?? '');
    const stdin = jsonSchema
      ? `${text}\n\nReturn JSON matching this schema: ${JSON.stringify(jsonSchema)}`
      : text;

    return { command: command ?? 'omp', args, env: {}, stdin, outputFormat: 'jsonl' };
  },

  readResult({ stdout }) {
    const last = assistantMessages(stdout).at(-1);
    if (!last) {
      throw new Error('omp -p exit 0 but printed no assistant message');
    }
    const content = Array.isArray(last.content) ? last.content : [];
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    // OMP can exit 0 with the provider's error on the last assistant message
    // and no text. Returning '' would read downstream as "the model extracted
    // nothing" (the same guard as codex's empty -o file).
    if (!text && (last.errorMessage || last.stopReason === 'error')) {
      throw new Error(`omp -p exit 0 but the assistant reported an error: ${String(last.errorMessage ?? 'stopReason error').slice(0, 200)}`);
    }
    return text;
  },

  // usage.input / usage.output (pi-catalog Usage). usage.cost.total is left
  // out on purpose: OMP computes it from its model catalog, and for a model
  // with no price there (a local LiteLLM route) it reads 0 -- a number that
  // would pass for a measured free call.
  extractUsage({ stdout }) {
    const usage = assistantMessages(stdout).at(-1)?.usage;
    return {
      input_tokens: finiteOrNull(usage?.input),
      output_tokens: finiteOrNull(usage?.output),
      total_cost_usd: null
    };
  },

  // Only stderr and the assistant's own error fields are read: the echoed user
  // prompt is the transcript being summarized and may mention any of these words.
  classifyExhaustion({ stderr, stdout }) {
    const errorText = assistantMessages(stdout)
      .flatMap((message) => [message.errorMessage, message.errorStatus == null ? null : String(message.errorStatus)])
      .filter((value) => typeof value === 'string');
    const text = [String(stderr ?? ''), ...errorText].join('\n');
    return { exhausted: /429|rate limit|quota|insufficient/i.test(text), resetAt: null };
  }
};
