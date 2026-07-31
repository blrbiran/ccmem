import test from 'node:test';
import assert from 'node:assert/strict';
import { currentEmbeddingSig } from '../../scripts/lib/embedding/signature.mjs';

test('signature is provider:model:dim', () => {
  assert.equal(
    currentEmbeddingSig(null, { embedding: { provider: 'openai', openai_model: 'text-embedding-3-small', openai_dim: 1536 } }),
    'openai:text-embedding-3-small:1536'
  );
});

test('changing only the dimension changes the signature', () => {
  const base = { embedding: { provider: 'openai', openai_model: 'text-embedding-3-small', openai_dim: 1536 } };
  const narrowed = { embedding: { ...base.embedding, openai_dim: 512 } };
  assert.notEqual(currentEmbeddingSig(null, base), currentEmbeddingSig(null, narrowed));
});

test('a live provider overrides config for model and dim', () => {
  assert.equal(
    currentEmbeddingSig({ modelId: 'jina-embeddings-v3', dim: 1024 }, { embedding: { provider: 'jina' } }),
    'jina:jina-embeddings-v3:1024'
  );
});

test('local provider defaults produce a stable signature', () => {
  assert.equal(
    currentEmbeddingSig({ dim: 384 }, { embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' } }),
    'local:Xenova/all-MiniLM-L6-v2:384'
  );
});

test('missing provider field falls back to local', () => {
  assert.match(currentEmbeddingSig(null, {}), /^local:/);
});
