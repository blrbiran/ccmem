import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.mjs';
import { insertMemory } from './save.mjs';

function runtimeEmbeddingEnabled(db) {
  const cfg = loadConfig();
  const kv = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.enabled'`).get()?.value ?? null;
  return kv != null ? kv === 'true' : Boolean(cfg.embedding?.enabled);
}

function parseTags(tags) {
  if (Array.isArray(tags)) {
    return tags;
  }

  if (typeof tags === 'string' && tags.trim()) {
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

export async function cmdImport(db, { cwd, filePath }) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  let imported = 0;
  let skipped = 0;

  for (const memory of data.memories ?? []) {
    try {
      await insertMemory(db, {
        cwd,
        content: memory.content,
        type: memory.type,
        scope: memory.scope,
        projectKey: memory.project_key ?? null,
        pinned: Number(memory.pinned) ? 1 : 0,
        tags: parseTags(memory.tags),
        source: 'external',
        embedSync: false
      });
      imported += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    imported,
    skipped,
    pending_embeddings: runtimeEmbeddingEnabled(db) ? imported : 0
  };
}
