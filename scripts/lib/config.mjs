import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_CONFIG = {
  version: '0.3',
  inject: { max_chars: 4000, max_per_prompt: 6 },
  save: { max_chars_per_memory: 300 },
  retrieval: {
    like_fallback: {
      enabled: true,
      trigger_when_fts_below: 3,
      max_terms: 5
    }
  },
  recent_injections: { retention_days: 14, max_per_session: 20 },
  llm: {
    claude_p_timeout_per_task: {
      summarize_pending: 60000,
      l4_review: 90000,
      weekly_synthesis: 180000,
      security_audit: 180000
    }
  },
  security: {
    scan_patterns_version: '2026-06-04-v03',
    tier3: {
      enabled: true,
      block_user_explicit: false
    },
    tier1_5_security: {
      enabled: true,
      trust_max: 0.2,
      cluster_min_size: 5
    },
    audit: {
      enabled: true,
      schedule_weekday: 0,
      schedule_hour: 3,
      schedule_minute: 47,
      catch_up_days: 7,
      maxPerBatch: 30,
      globalReferenceMaxRows: 50,
      pool_a: {
        trustMin: 0.2,
        trustMax: 0.5,
        windowDays: 14,
        maxRows: 50
      },
      pool_b: {
        windowDays: 7,
        clusterMinSize: 3,
        maxRows: 50
      },
      pool_c: {
        unhelpfulMin: 3,
        windowDays: 7,
        maxRows: 50
      }
    },
    cross_scope: {
      similarity_min: 0.6,
      dedup_window_days: 30,
      alert_retention_days: 60
    },
    quarantine: {
      sunset_days: 30,
      hard_delete_days: 14,
      resurrect_trust: 0.4
    }
  }
};

function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return structuredClone(override ?? base);
  }

  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const merged = { ...structuredClone(base) };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : structuredClone(value);
    }
    return merged;
  }

  return structuredClone(override ?? base);
}

export function loadConfig() {
  const userPath = process.env.CCMEM_CONFIG_PATH;
  if (!userPath || !existsSync(userPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(userPath, 'utf8')));
}
