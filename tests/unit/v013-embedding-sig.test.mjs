import test from 'node:test';
import assert from 'node:assert/strict';
import { currentEmbeddingSig } from '../../scripts/lib/embedding/signature.mjs';
import { transformersLocal } from '../../scripts/lib/embedding/transformers-local.mjs';

// These two used to pass `null` for the provider and read model/dim out of config.
// Production never does that: every call site derives the signature from a loaded
// provider (ledger, Task 6). Fixtures now match the shape production actually uses.
test('signature is provider:model:dim', () => {
  assert.equal(
    currentEmbeddingSig(
      { modelId: 'text-embedding-3-small', dim: 1536 },
      { embedding: { provider: 'openai' } }
    ),
    'openai:text-embedding-3-small:1536'
  );
});

test('changing only the dimension changes the signature', () => {
  const cfg = { embedding: { provider: 'openai' } };
  assert.notEqual(
    currentEmbeddingSig({ modelId: 'text-embedding-3-small', dim: 1536 }, cfg),
    currentEmbeddingSig({ modelId: 'text-embedding-3-small', dim: 512 }, cfg)
  );
});

// The live provider's modelId MUST win over the config fallback. The previous
// fixture used 'jina-embeddings-v3', which is byte-identical to the fallback
// this function hardcodes for provider 'jina' — so the override branch never
// had to fire and mutating it to `if (false)` killed nothing. The model here
// deliberately differs from that fallback.
test('a live provider overrides config for model and dim', () => {
  assert.equal(
    currentEmbeddingSig({ modelId: 'jina-embeddings-v4', dim: 2048 }, { embedding: { provider: 'jina' } }),
    'jina:jina-embeddings-v4:2048',
    'the loaded provider knows its real identity; the config fallback is only a guess'
  );
});

test('local provider defaults produce a stable signature', () => {
  assert.equal(
    currentEmbeddingSig({ dim: 384 }, { embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' } }),
    'local:Xenova/all-MiniLM-L6-v2:384'
  );
});

// Finding 9. Without a provider there is no signature, and saying so is the whole
// job of this module. The old code answered with a synthesised string whose dim came
// from `?? 0` — a width no vector can ever have — so every consumer compared stored
// rows against a signature nothing could match: `diagnose --retrieval` reported the
// entire store as stale, and the daemon's pending count stayed permanently above zero
// and re-queued vec_backfill forever, all while embedding was switched off.
//
// null is the honest answer, and every consumer already treats a null signature as
// "the cosine lane is unavailable" rather than "nothing matches".
test('no provider means no signature', () => {
  assert.equal(
    currentEmbeddingSig(null, { embedding: { provider: 'openai', openai_model: 'text-embedding-3-small', openai_dim: 1536 } }),
    null,
    'a config declaration is a guess about a provider that is not loaded, not a signature'
  );
  assert.equal(currentEmbeddingSig(null, {}), null);
});

test('a provider with no usable dimension has no signature', () => {
  assert.equal(
    currentEmbeddingSig({ modelId: 'text-embedding-3-small' }, { embedding: { provider: 'openai' } }),
    null,
    'dim 0 is not a dimension; emitting it would silently mismatch every stored row'
  );
});

// I1 regression. `embedding.model` is the single supported way to change the
// DEFAULT provider's model. transformersLocal hardcoded modelId as a static
// property and had no applyConfig, so getProvider() never told it which model
// was configured — two different embedding spaces reported an identical
// signature, which is exactly the silent-cosine-garbage failure the signature
// exists to prevent.
test('transformersLocal.applyConfig makes embedding.model visible to the signature', (t) => {
  const original = transformersLocal.modelId;
  t.after(() => { transformersLocal.modelId = original; });

  const defaultCfg = { embedding: { provider: 'transformers-local', model: 'Xenova/all-MiniLM-L6-v2' } };
  transformersLocal.applyConfig(defaultCfg);
  const defaultSig = currentEmbeddingSig(transformersLocal, defaultCfg);

  const switchedCfg = { embedding: { provider: 'transformers-local', model: 'Xenova/bge-base-en-v1.5' } };
  transformersLocal.applyConfig(switchedCfg);
  const switchedSig = currentEmbeddingSig(transformersLocal, switchedCfg);

  assert.equal(defaultSig, 'transformers-local:Xenova/all-MiniLM-L6-v2:384');
  assert.equal(switchedSig, 'transformers-local:Xenova/bge-base-en-v1.5:384');
  assert.notEqual(defaultSig, switchedSig,
    'a different embedding space must not report the same signature — stored vectors would be compared against incomparable query vectors');
});

test('transformersLocal.applyConfig falls back to the packaged model when none is configured', (t) => {
  const original = transformersLocal.modelId;
  t.after(() => { transformersLocal.modelId = original; });

  transformersLocal.applyConfig({ embedding: { provider: 'transformers-local' } });
  assert.equal(transformersLocal.modelId, 'Xenova/all-MiniLM-L6-v2');
});
