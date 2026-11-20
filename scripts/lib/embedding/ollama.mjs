import { loadConfig } from '../config.mjs';

let loaded = false;
let baseUrl = 'http://localhost:11434';
let modelId = null;
let dim = 0;
let probedDim = 0;
let probedKey = null;
let timeoutMs = 30000;

function configFrom(override = null) {
  const embedding = override?.embedding ?? loadConfig().embedding ?? {};
  const configured = String(embedding.ollama_base_url ?? 'http://localhost:11434').trim();
  const timeout = Number(embedding.ollama_timeout_ms ?? embedding.api_timeout_ms ?? 30000);
  const configuredDim = Number(embedding.ollama_dim ?? 0);
  return {
    // Trailing slashes turn `/api/embed` into `//api/embed` on some proxies.
    baseUrl: configured.replace(/\/+$/, '') || 'http://localhost:11434',
    modelId: embedding.ollama_model == null || String(embedding.ollama_model).trim() === ''
      ? null
      : String(embedding.ollama_model).trim(),
    dim: Number.isFinite(configuredDim) && configuredDim > 0 ? configuredDim : 0,
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

function requireModel() {
  if (!modelId) {
    throw new Error(
      'OLLAMA_MODEL not set: set embedding.ollama_model (for example "bge-m3") before enabling the ollama provider'
    );
  }
}

async function request(path, body = null) {
  const timer = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: body === null ? undefined : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
      signal: timer.signal
    });
    if (!response.ok) {
      throw new Error(`Ollama ${path} ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  } finally {
    timer.clear();
  }
}

async function embedBatch(texts) {
  const data = await request('/api/embed', { model: modelId, input: texts });
  const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Ollama /api/embed returned ${embeddings.length} embeddings for ${texts.length} inputs`);
  }

  return embeddings.map((item) => {
    const vector = new Float32Array(item);
    if (vector.length > 0) {
      // The configured dim is a guess; the provider's answer is the truth. The
      // signature follows this value, so a wrong guess would re-embed forever.
      dim = vector.length;
      probedDim = vector.length;
    }
    return vector;
  });
}

export const ollamaEmbedding = {
  modelId: null,
  dim: 0,

  isLoaded() {
    return loaded;
  },

  applyConfig(override = null) {
    const cfg = configFrom(override);
    const key = `${cfg.baseUrl}\u0000${cfg.modelId ?? ''}`;
    // A different endpoint or model is a different embedding space: a dimension
    // observed for the old pair must not survive.
    if (key !== probedKey) {
      probedKey = key;
      probedDim = 0;
    }
    baseUrl = cfg.baseUrl;
    modelId = cfg.modelId;
    // A configured dim is only a starting guess. Once the provider answered,
    // keep that answer across later applyConfig calls (embed re-applies config).
    dim = probedDim || cfg.dim;
    timeoutMs = cfg.timeoutMs;
    this.modelId = modelId;
    this.dim = dim;
    return cfg;
  },

  async probe(override = null) {
    this.applyConfig(override);
    requireModel();

    const data = await request('/api/tags');
    const models = Array.isArray(data.models)
      ? data.models.map((item) => String(item?.name ?? item?.model ?? ''))
      : [];
    const present = models.some((name) => name === modelId || name.startsWith(`${modelId}:`));
    if (!present) {
      throw new Error(`Ollama model ${modelId} is not installed: run \`ollama pull ${modelId}\``);
    }

    return { ok: true, detail: `${baseUrl} serves ${modelId}` };
  },

  async load(override = null) {
    this.applyConfig(override);
    requireModel();
    await this.probe(override);
    if (!probedDim) {
      const [probe] = await embedBatch(['dimension probe']);
      if (!probe || probe.length === 0) {
        throw new Error('Ollama /api/embed returned an empty embedding');
      }
    }
    this.dim = dim;
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
      requireModel();
    }

    const batchSize = 32;
    const results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((text) => String(text ?? ''));
      results.push(...(await embedBatch(batch)));
    }
    this.dim = dim;
    return results;
  },

  unload() {
    loaded = false;
    baseUrl = 'http://localhost:11434';
    modelId = null;
    dim = 0;
    probedDim = 0;
    probedKey = null;
    timeoutMs = 30000;
  }
};