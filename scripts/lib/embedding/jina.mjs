import { loadConfig } from '../config.mjs';

let loaded = false;
let apiKey = null;
let timeoutMs = 30000;

function configFrom(override = null) {
  const embedding = override?.embedding ?? loadConfig().embedding ?? {};
  const timeout = Number(embedding.api_timeout_ms ?? 30000);
  return {
    apiKey: process.env.JINA_API_KEY ?? embedding.jina_api_key ?? null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000
  };
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

export const jinaEmbedding = {
  modelId: 'jina-embeddings-v3',
  dim: 1024,

  isLoaded() {
    return loaded;
  },

  applyConfig(override = null) {
    const cfg = configFrom(override);
    apiKey = cfg.apiKey;
    timeoutMs = cfg.timeoutMs;
    return cfg;
  },

  async load(override = null) {
    const cfg = this.applyConfig(override);
    if (!cfg.apiKey) {
      throw new Error('JINA_API_KEY not set');
    }
    loaded = true;
  },

  async embed(texts, override = null) {
    if (!Array.isArray(texts) || texts.length === 0) {
      return [];
    }

    if (!loaded) {
      await this.load(override);
    } else {
      this.applyConfig(override);
    }

    const batchSize = 100;
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((text) => String(text ?? ''));
      const timer = withTimeout(timeoutMs);
      try {
        const response = await fetch('https://api.jina.ai/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: this.modelId,
            input: batch,
            task: 'text-matching'
          }),
          signal: timer.signal
        });
        if (!response.ok) {
          throw new Error(`Jina API ${response.status}: ${await response.text()}`);
        }
        const data = await response.json();
        for (const item of data.data ?? []) {
          const vector = new Float32Array(item.embedding);
          results.push(vector);
        }
      } finally {
        timer.clear();
      }
    }

    return results;
  },

  unload() {
    loaded = false;
    apiKey = null;
    timeoutMs = 30000;
  }
};
