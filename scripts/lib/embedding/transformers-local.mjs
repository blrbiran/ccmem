import { loadConfig } from '../config.mjs';
import { importOptional } from './optional-import.mjs';

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

const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export const transformersLocal = {
  modelId: DEFAULT_MODEL_ID,
  dim: 384,

  isLoaded() {
    return extractor !== null;
  },

  /**
   * Mirrors openai.mjs: getProvider() calls this so the provider's advertised
   * identity reflects the CONFIGURED model, not just the packaged default.
   * Without it, `embedding.model` — the single supported way to change the
   * default provider's model — was invisible to currentEmbeddingSig(), so two
   * different embedding spaces reported an identical signature and stored
   * vectors were silently cosined against incomparable query vectors.
   *
   * `dim` is deliberately NOT derived here. It is only knowable after the model
   * loads, and mutating it mid-run would change the signature between backfill
   * batches — each batch would see the previous batch's rows as stale and
   * re-embed them forever. modelId alone already makes the signature differ,
   * which is what forces the re-embed. A model whose real dim differs from 384
   * therefore reports a slightly wrong dim component but a correctly DISTINCT
   * signature, which is what the guarantee depends on.
   */
  applyConfig(override = null) {
    const cfg = override?.embedding ?? loadConfig().embedding ?? {};
    this.modelId = String(cfg.model ?? DEFAULT_MODEL_ID);
    return cfg;
  },

  async load(override = null) {
    if (extractor) {
      return;
    }

    if (process.env.CCMEM_TEST_MODE === '1') {
      this.applyConfig(override);
      extractor = async (text) => ({ data: buildStubVector(text) });
      return;
    }

    const cfg = this.applyConfig(override);
    const { pipeline, env } = await importOptional('@xenova/transformers', 'transformers-local');
    if (cfg.remote_host) {
      env.remoteHost = String(cfg.remote_host);
    }
    if (cfg.remote_path_template) {
      env.remotePathTemplate = String(cfg.remote_path_template);
    }

    // this.modelId, not cfg.model, so the model that is actually LOADED and the
    // model the signature ADVERTISES can never diverge.
    extractor = await pipeline(
      'feature-extraction',
      this.modelId,
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
