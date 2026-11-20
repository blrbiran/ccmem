import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ollamaEmbedding } from '../../scripts/lib/embedding/ollama.mjs';
import { currentEmbeddingSig } from '../../scripts/lib/embedding/signature.mjs';
import { getProvider, _resetProviderCache } from '../../scripts/lib/embedding/provider.mjs';

// getProvider() opens the control DB through readConfigKv. Standalone (outside run-tests.sh)
// this must not touch the human's real ~/.claude/ccmem.
process.env.CCMEM_DATA_ROOT ??= mkdtempSync(join(tmpdir(), 'ccmem-ollama-test-'));

function startOllama({ models = ['bge-m3:latest'], embedDim = 4 } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/embed') {
        const parsed = JSON.parse(body || '{}');
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: inputs.map(() => Array.from({ length: embedDim }, (_, i) => i / 10)) }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, calls, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const cfgFor = (baseUrl, extra = {}) => ({
  embedding: {
    enabled: true,
    provider: 'ollama',
    ollama_base_url: baseUrl,
    ollama_model: 'bge-m3',
    api_timeout_ms: 5000,
    ...extra
  }
});

test('ollama load probes tags and takes the dimension from the provider', async () => {
  const { server, baseUrl, calls } = await startOllama({ embedDim: 4 });
  try {
    ollamaEmbedding.unload();
    await ollamaEmbedding.load(cfgFor(baseUrl));

    assert.equal(ollamaEmbedding.isLoaded(), true);
    assert.equal(ollamaEmbedding.modelId, 'bge-m3');
    assert.equal(ollamaEmbedding.dim, 4, 'configured dim is a guess; /api/embed is the truth');
    assert.ok(calls.some((call) => call.url === '/api/tags'));
    assert.ok(calls.some((call) => call.url === '/api/embed'));
  } finally {
    server.close();
  }
});

test('a configured dim guess is replaced by the provider answer and does not come back', async () => {
  const { server, baseUrl } = await startOllama({ embedDim: 4 });
  try {
    ollamaEmbedding.unload();
    await ollamaEmbedding.load(cfgFor(baseUrl, { ollama_dim: 1536 }));
    assert.equal(ollamaEmbedding.dim, 4);
    ollamaEmbedding.applyConfig(cfgFor(baseUrl, { ollama_dim: 1536 }));
    assert.equal(ollamaEmbedding.dim, 4, 'applyConfig must not resurrect the configured guess after a probe');
  } finally {
    server.close();
  }
});

test('ollama embed returns one vector per input', async () => {
  const { server, baseUrl } = await startOllama({ embedDim: 3 });
  try {
    ollamaEmbedding.unload();
    const vectors = await ollamaEmbedding.embed(['a', 'b'], cfgFor(baseUrl));

    assert.equal(vectors.length, 2);
    assert.ok(vectors.every((vector) => vector instanceof Float32Array && vector.length === 3));
  } finally {
    server.close();
  }
});

test('ollama names an uninstalled model and the pull command', async () => {
  const { server, baseUrl } = await startOllama({ models: ['other:latest'] });
  try {
    ollamaEmbedding.unload();
    await assert.rejects(
      () => ollamaEmbedding.load(cfgFor(baseUrl)),
      /Ollama model bge-m3 is not installed: run `ollama pull bge-m3`/
    );
  } finally {
    server.close();
  }
});

test('ollama refuses to run without a configured model', async () => {
  const { server, baseUrl } = await startOllama();
  try {
    ollamaEmbedding.unload();
    await assert.rejects(
      () => ollamaEmbedding.load(cfgFor(baseUrl, { ollama_model: null })),
      /OLLAMA_MODEL not set: set embedding.ollama_model/
    );
  } finally {
    server.close();
  }
});

test('ollama reports an unreachable daemon instead of hanging', async () => {
  const { server, port } = await startOllama();
  await new Promise((resolve) => server.close(resolve));
  ollamaEmbedding.unload();
  await assert.rejects(() => ollamaEmbedding.probe(cfgFor(`http://127.0.0.1:${port}`)));
});

test('the ollama signature names the model and the provider-reported dimension', () => {
  assert.equal(
    currentEmbeddingSig({ modelId: 'bge-m3', dim: 1024 }, { embedding: { provider: 'ollama', ollama_model: 'bge-m3' } }),
    'ollama:bge-m3:1024'
  );
});

test('getProvider constructs the ollama provider from an explicit override', () => {
  try {
    const provider = getProvider(cfgFor('http://127.0.0.1:1'));
    assert.equal(provider, ollamaEmbedding);
    assert.equal(provider.modelId, 'bge-m3');
  } finally {
    _resetProviderCache();
  }
});