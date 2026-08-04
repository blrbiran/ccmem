import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../lib/config.mjs';
import { openaiEmbedding } from '../../lib/embedding/openai.mjs';
import { getDataRoot } from '../../lib/paths.mjs';

export const DEFAULT_PROBE_FILE = 'embed-latency-probe.jsonl';

/** Resolved by both the writer here and diagnose --feedback, so the path rule
 * lives in exactly one place and cannot drift. */
export function probeFile(probeCfg) {
  return path.join(getDataRoot(), probeCfg?.file || DEFAULT_PROBE_FILE);
}

/**
 * Measures one query-embedding round trip against a deliberately loose ceiling,
 * so the latency distribution can be read WITHOUT the 800ms censoring that
 * openai_timeout_ms imposes on the hook path.
 *
 * It is isolated from the circuit breaker and the query-vector cache on purpose:
 * a probe that reported its own timeouts to recordEmbedFailure would open the
 * gate on real retrieval — the instrument would manufacture the phenomenon it
 * measures. Do not "unify" this with the retrieval path.
 */
export async function runEmbedLatencyProbe(db, _task, deps = {}) {
  const cfg = deps.config ?? loadConfig();
  const embedding = cfg?.embedding ?? {};
  const probeCfg = embedding.latency_probe ?? {};

  if (probeCfg.enabled !== true) {
    return { skipped: 'disabled' };
  }

  if (embedding.provider !== 'openai') {
    return { skipped: 'provider' };
  }

  const apiKey = process.env.OPENAI_API_KEY ?? embedding.openai_api_key ?? null;
  if (!apiKey) {
    return { skipped: 'no_api_key' };
  }

  const picked = db.prepare('SELECT content FROM memories ORDER BY RANDOM() LIMIT 1').get();
  const text = String(picked?.content ?? '').slice(0, 2000);
  if (!text) {
    return { skipped: 'no_text' };
  }

  const timeoutMs = Number(probeCfg.timeout_ms ?? 10000);
  const provider = deps.provider ?? openaiEmbedding;
  const override = {
    embedding: { ...embedding, openai_timeout_ms: timeoutMs, api_timeout_ms: timeoutMs }
  };

  // load() does the dynamic import('openai') and constructs the client. The
  // hook path awaits provider.load(config) BEFORE it starts its own timer
  // (retrieval.mjs, just above tEmbed), so retrieval_embed_ms is the HTTP round
  // trip alone. Mirroring that here is what makes the two numbers comparable:
  // inside t0, `ms` would be import + construction + round trip — strictly
  // larger, and worst on the first probe after every daemon start.
  //
  // A load failure (SDK missing, key rejected at construction) is also not a
  // latency observation. Returning early keeps it out of the file instead of
  // landing an ok:false row with a near-zero ms that would drag the left tail
  // of the distribution down with no way to tell afterwards.
  try {
    await provider.load(override);
  } catch (caught) {
    return { skipped: 'load_failed', error: String(caught?.message ?? caught).slice(0, 200) };
  }

  const t0 = Date.now();
  let ok = true;
  let error = null;
  try {
    await provider.embed([text], override);
  } catch (caught) {
    ok = false;
    error = String(caught?.message ?? caught).slice(0, 200);
  }
  const ms = Date.now() - t0;

  // The dim here is the CONFIGURED one, not the observed one — openai_dim
  // defaults to null, so a run against a 3072-dim model can be stamped :1536.
  // What actually discriminates two distributions is the model name, which is
  // read from the same config and is correct. Deliberately not importing
  // currentEmbeddingSig to fix the label: a minimal import surface is itself
  // one of this probe's isolation properties.
  const signature = `${embedding.provider}:${embedding.openai_model ?? 'text-embedding-3-small'}:${embedding.openai_dim ?? 1536}`;

  mkdirSync(getDataRoot(), { recursive: true });
  appendFileSync(
    probeFile(probeCfg),
    `${JSON.stringify({
      ts: Date.now(),
      ms,
      ok,
      error,
      timed_out_at_probe_limit: !ok && ms >= timeoutMs,
      // The ceiling that produced this row. timeout_ms is user-configurable and
      // this file never rotates, so a mid-campaign change would otherwise make
      // every earlier row uninterpretable — the same implicit-bound problem
      // that made the hook path's censoring invisible in the first place.
      timeout_ms: timeoutMs,
      text_chars: text.length,
      signature
    })}\n`
  );

  return { ok, ms };
}
