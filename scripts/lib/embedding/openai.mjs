import { loadConfig } from '../config.mjs';
import { importOptional } from './optional-import.mjs';

let client = null;
let currentConfigKey = null;

export function openaiConfigFrom(override = null) {
  const embedding = override?.embedding ?? loadConfig().embedding ?? {};
  const modelId = String(embedding.openai_model ?? 'text-embedding-3-small');
  const baseURL = process.env.OPENAI_BASE_URL ?? embedding.openai_base_url ?? null;
  const apiKey = process.env.OPENAI_API_KEY ?? embedding.openai_api_key ?? null;
  const timeout = Number(embedding.openai_timeout_ms ?? embedding.api_timeout_ms ?? 30000);
  const dim = Number(embedding.openai_dim ?? 1536);
  return {
    modelId,
    baseURL,
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    // The SDK retries twice by default, which turns a timeout into a multiple
    // of itself: openai_timeout_ms: 800 measured 1683ms of wall clock on the
    // hook path — one attempt plus one retry — against a 2000ms hook budget.
    // A timeout is only a budget if nothing silently repeats it. Failures are
    // not lost: the backfill re-queues them and the circuit breaker covers a
    // provider that is down.
    maxRetries: 0,
    dim: Number.isFinite(dim) && dim > 0 ? dim : 1536
  };
}

function configKey(cfg) {
  return JSON.stringify([cfg.modelId, cfg.baseURL, cfg.apiKey, cfg.timeoutMs, cfg.maxRetries]);
}

export const openaiEmbedding = {
  modelId: 'text-embedding-3-small',
  dim: 1536,

  isLoaded() {
    return client !== null;
  },

  applyConfig(override = null) {
    const cfg = openaiConfigFrom(override);
    this.modelId = cfg.modelId;
    this.dim = cfg.dim;
    return cfg;
  },

  async load(override = null) {
    const cfg = this.applyConfig(override);
    if (!cfg.apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    const nextKey = configKey(cfg);
    if (client && currentConfigKey === nextKey) {
      return;
    }

    const { default: OpenAI } = await importOptional('openai', 'openai');
    client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL ?? undefined,
      timeout: cfg.timeoutMs,
      maxRetries: cfg.maxRetries
    });
    currentConfigKey = nextKey;
  },

  async embed(texts, override = null) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    await this.load(override);
    const batchSize = 100;
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((text) => String(text ?? ''));
      const response = await client.embeddings.create({
        model: this.modelId,
        input: batch
      });

      for (const item of response.data ?? []) {
        const vector = new Float32Array(item.embedding);
        if (Number.isFinite(vector.length) && vector.length > 0) {
          this.dim = vector.length;
        }
        results.push(vector);
      }
    }

    return results;
  },

  unload() {
    client = null;
    currentConfigKey = null;
    this.modelId = 'text-embedding-3-small';
    this.dim = 1536;
  }
};
