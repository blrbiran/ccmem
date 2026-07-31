/**
 * Everything that determines what a stored vector MEANS: provider + model + dim.
 * If any of the three changes, old vectors are no longer comparable to new
 * query vectors, and comparing them anyway yields silent garbage.
 */
export function currentEmbeddingSig(provider, config = null) {
  const e = config?.embedding ?? {};
  const dim = Number(provider?.dim ?? e.openai_dim ?? 0) || 0;

  let model;
  if (provider?.modelId) {
    model = String(provider.modelId);
  } else {
    switch (e.provider) {
      case 'openai': model = String(e.openai_model ?? 'text-embedding-3-small'); break;
      case 'jina':   model = 'jina-embeddings-v3'; break;
      default:       model = String(e.model ?? 'Xenova/all-MiniLM-L6-v2');
    }
  }
  return `${e.provider ?? 'local'}:${model}:${dim}`;
}
