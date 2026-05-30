import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_CONFIG = {
  version: '0.2',
  inject: { max_chars: 4000, max_per_prompt: 6 },
  save: { max_chars_per_memory: 300 },
  retrieval: {
    like_fallback: {
      enabled: true,
      trigger_when_fts_below: 3,
      max_terms: 5
    }
  }
};

export function loadConfig() {
  const userPath = process.env.CCMEM_CONFIG_PATH;
  if (!userPath || !existsSync(userPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...JSON.parse(readFileSync(userPath, 'utf8'))
  };
}
