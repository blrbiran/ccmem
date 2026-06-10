import { loadConfig } from '../config.mjs';

let extractor = null;

function buildStubVector(text) {
  const vec = new Float32Array(384);
  const value = String(text ?? '');

  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0;
    vec[i % vec.length] += ((code % 97) + 1) / 100;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) {
    norm += vec[i] * vec[i];
  }

  if (norm === 0) {
    vec[0] = 1;
    return vec;
  }

  const scale = Math.sqrt(norm);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] /= scale;
  }

  return vec;
}

export const transformersLocal = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  dim: 384,

  isLoaded() {
    return extractor !== null;
  },

  async load() {
    if (extractor) {
      return;
    }

    if (process.env.CCMEM_TEST_MODE === '1') {
      extractor = async (text) => ({ data: buildStubVector(text) });
      return;
    }

    const cfg = loadConfig().embedding ?? {};
    const { pipeline, env } = await import('@xenova/transformers');
    if (cfg.remote_host) {
      env.remoteHost = String(cfg.remote_host);
    }
    if (cfg.remote_path_template) {
      env.remotePathTemplate = String(cfg.remote_path_template);
    }

    extractor = await pipeline(
      'feature-extraction',
      cfg.model ?? this.modelId,
      { quantized: cfg.quantized !== false }
    );
  },

  async embed(texts) {
    if (!extractor) {
      await this.load();
    }

    const results = [];
    for (const text of texts) {
      const output = await extractor(String(text ?? ''), { pooling: 'mean', normalize: true });
      results.push(new Float32Array(output.data));
    }
    return results;
  },

  unload() {
    extractor = null;
  }
};
