/**
 * Everything that determines what a stored vector MEANS: provider + model + dim.
 * If any of the three changes, old vectors are no longer comparable to new
 * query vectors, and comparing them anyway yields silent garbage.
 */
export function currentEmbeddingSig(provider, config = null) {
  // No loaded provider, or one that cannot state its width, means no signature
  // exists — return null and let callers treat the cosine lane as unavailable.
  // Synthesising one from config instead (the old `?? 0`) produced a dimension no
  // stored vector can ever have, so every comparison missed: the daemon counted the
  // whole store as pending forever and `diagnose --retrieval` called every row stale,
  // both while embedding was simply switched off. A module whose job is to make
  // incomparable vectors loud must not fail quietly itself.
  const dim = Number(provider?.dim ?? 0) || 0;
  if (!provider || !dim) {
    return null;
  }

  const e = config?.embedding ?? {};

  let model;
  if (provider.modelId) {
    model = String(provider.modelId);
  } else {
    switch (e.provider) {
      case 'openai': model = String(e.openai_model ?? 'text-embedding-3-small'); break;
      case 'jina':   model = 'jina-embeddings-v3'; break;
      default:       model = String(e.model ?? 'Xenova/all-MiniLM-L6-v2');
    }
  }
  // 'transformers-local', not 'local': the tag must be a name providerByName()
  // accepts, or a signature can name a provider that cannot be constructed.
  return `${e.provider ?? 'transformers-local'}:${model}:${dim}`;
}
