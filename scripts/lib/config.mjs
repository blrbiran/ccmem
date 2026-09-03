import { existsSync, readFileSync } from 'node:fs';
import { getConfigPath } from './paths.mjs';

export const DEFAULT_CONFIG = {
  version: '0.14',
  inject: { max_chars: 4000, max_per_prompt: 6 },
  save: { max_chars_per_memory: 500 },
  injection: { file_based: true },
  eval: {
    disable_scope_isolation: false
  },
  embedding: {
    enabled: false,
    provider: 'transformers-local',
    model: 'Xenova/all-MiniLM-L6-v2',
    quantized: true,
    backfill_batch_size: 50,
    openai_api_key: null,
    jina_api_key: null,
    api_timeout_ms: 30000,
    openai_timeout_ms: 1200,
    backfill_timeout_ms: 30000,
    openai_base_url: null,
    openai_model: 'text-embedding-3-small',
    openai_dim: null,
    latency_probe: {
      // Strictly `enabled === true` to run. Note this is the OPPOSITE of the
      // adjacent decision-data flag (metrics.mjs recordDecisionMetric treats
      // anything but an explicit `false` as on): recording must default to on,
      // sending real API requests must default to off. Read the design doc
      // before changing either.
      enabled: false,
      interval_ms: 300000,
      timeout_ms: 10000,
      file: 'embed-latency-probe.jsonl'
    }
  },
  dedup: {
    enabled: true,
    window_days: 30,
    fts_candidate_limit: 20,
    jaccard_threshold: 0.3,
    trigram_size: 3,
    cosine_threshold: 0.85
  },
  retrieval: {
    like_fallback: {
      enabled: true,
      trigger_when_fts_below: 3,
      max_terms: 5
    },
    weights: {
      fts: 0.4,
      jaccard: 0.2,
      semantic: 0.4
    }
  },
  feedback: {
    l1_positive: {
      enabled: true,
      cosine_threshold: 0.65
    },
    // `enabled` here gates EXISTENCE (false = no probe rows are produced at
    // all). Do not confuse it with metrics.decision_data.enabled, which gates
    // only DURABILITY — rows are still produced, they just fall back to the
    // rotated metrics.jsonl.
    l25_probe: {
      enabled: true,
      max_per_turn: 8,
      // Random never-injected-this-session memories scored against the same
      // reply, per turn-aligned turn — the noise floor v0.14 compares the main
      // distribution against. 0 disables the cohort without disabling the probe.
      control_sample_size: 3
    }
  },
  recent_injections: { retention_days: 14, max_per_session: 20 },
  summarize: {
    min_transcript_after_clean: 200,
    transcript_cleaner: {
      enabled: true,
      extra_rules: []
    },
    content_refiner: {
      enabled: true
    },
    quality_gate: {
      enabled: true,
      min_chars: 15,
      rules_enabled: {
        too_short: true,
        commit_format: true,
        too_specific: true,
        version_snapshot: true,
        test_count: true,
        timestamp_dominant: true,
        path_list: true,
        env_failure: true,
        negative_assertion: true
      }
    }
  },
  adaptive_decay: {
    consolidated_fast_expire_days: 60,
    consolidated_max_depth_for_expire: 1,
    candidate_expire_archive_days: 30
  },
  injection_observability: {
    never_injected_alert_ratio: 0.15,
    low_quality_threshold: 0.3
  },
  cross_project: {
    audit: {
      enabled: true,
      schedule_weekday: 0,
      schedule_hour: 4,
      schedule_minute: 47,
      cosine_threshold: 0.85,
      min_projects: 2,
      min_trust: 0.5,
      max_candidates_per_run: 5,
      dedup_window_days: 30,
      max_pairs: 500000
    },
    alert_retention_days: 60
  },
  llm: {
    claude_p_timeout_per_task: {
      summarize_pending: 60000,
      l4_review: 90000,
      weekly_synthesis: 180000,
      security_audit: 180000,
      contradiction_audit: 180000,
      monthly_meta_synthesis: 180000,
      contradiction_merge: 60000
    }
  },
  hook_budget_ms: {
    session_start: { p50: 50, p95: 300 },
    prompt_submit: { p50: 50, p95: 100 },
    stop: { p50: 50, p95: 200 }
  },
  cron: {
    daily_at: '02:17',
    weekly_at: 'Sun 03:17',
    dead_letter_alert: 5
  },
  contradiction: {
    audit: {
      enabled: true,
      schedule_weekday: 0,
      schedule_hour: 4,
      schedule_minute: 17,
      cosine_threshold: 0.7,
      max_pairs_per_batch: 30,
      dedup_window_days: 30
    },
    alert_retention_days: 60
  },
  security: {
    scan_patterns_version: '2026.07',
    // Flat under `security`, not `security.tier3`, so it isn't miscategorized
    // as a dead key by proximity — but that placement hides a real dependency:
    // save.mjs only calls evaluateTier3 at all when tier3.enabled is true, so
    // this switch is itself gated by tier3.enabled. If tier3.enabled is false,
    // setting this to true is inert. See design doc §3.1.
    quarantine_all_sources_at_write: false,
    tier3: {
      enabled: true
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
    },
    revalidation: {
      lazy_enabled: true,
      daily_enabled: true,
      batch_size: 100,
      flag_trust_threshold: 0.6
    }
  },
  metrics_rollup: {
    enabled: true,
    retention_days: 90,
    min_days_for_tuning: 7
  },
  metrics: {
    decision_data: {
      enabled: true,
      file: 'l25-probe.jsonl',
      retention_days: 0
    }
  },
  consolidation: {
    minBatchSize: 5,
    maxClusterSize: 15,
    cluster_tight_threshold: 0.75,
    cluster_loose_threshold: 0.5,
    stale_check_enabled: true,
    quality: {
      cosine_dup_threshold: 0.9
    },
    monthly: {
      enabled: true,
      min_consolidated: 30
    }
  },
  tuning_suggest: {
    pool_b_zero_quarantine_ratio: 0.7,
    dedup_window_p90_ratio: 0.5,
    sunset_resurrect_high_rate: 0.5
  },
  daemon: {
    platform_install_fallback_node_paths: [
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/bin/node'
    ],
    self_restart_on_schema_mismatch: true,
    self_restart_check_interval_ms: 20000
  },
  migration_backup: {
    max_keep: 5
  },
  context_history: {
    retention_days: 30
  }
};

// Freeze DEFAULT_CONFIG to prevent accidental runtime mutations process-wide.
// All callers should use structuredClone before modifying the config.
//
// Deep, not shallow: Object.freeze alone left every nested section writable, so
// one caller mutating e.g. DEFAULT_CONFIG.metrics.decision_data in place would
// silently change what every later loadConfig() in the process returns — and
// almost all of this config lives at depth 2 or 3. structuredClone (used by
// mergeConfig and applyV08Compatibility) returns unfrozen copies, so callers
// are unaffected.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

deepFreeze(DEFAULT_CONFIG);

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

function applyV08Compatibility(config) {
  const next = structuredClone(config);
  if (next.consolidation?.cluster_loose_threshold == null && next.consolidation?.cluster_threshold != null) {
    next.consolidation.cluster_loose_threshold = next.consolidation.cluster_threshold;
  }
  return next;
}

/** Thrown only for a config file the operator has to go fix by hand. */
export class ConfigError extends Error {}

export function loadConfig() {
  // CCMEM_CONFIG_PATH has no persistent source — it is in no shell rc, no
  // launchctl environment and no Claude setting — so it is present only in
  // shells where someone exported it by hand, and absent in every process
  // launched any other way. Returning DEFAULT_CONFIG when it is missing meant
  // those processes silently ran a different embedding provider against the
  // same store than the ones that had it (Finding 12): hooks embedded queries
  // with MiniLM, produced a signature no stored vector carried, and retrieval
  // degraded to lexical without a single error. The store's own config.json is
  // the answer they should have had all along; the variable now only overrides
  // it.
  const userPath = process.env.CCMEM_CONFIG_PATH;
  const path = userPath && existsSync(userPath) ? userPath : getConfigPath();
  if (!existsSync(path)) {
    return applyV08Compatibility(DEFAULT_CONFIG);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Naming the file is the whole point. The bare SyntaxError says
    // "<anonymous_script>:1" and a byte offset, which tells an operator
    // nothing about which of their files is broken.
    throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
  }

  // Valid JSON of the wrong shape used to merge to nothing and leave the
  // process on DEFAULT_CONFIG — indistinguishable from having no config at
  // all, silently, which is how a store of openai vectors ends up being
  // queried by a transformers-local process (Finding 12).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(
      `${path} must contain a JSON object, found ${Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`}`
    );
  }

  return applyV08Compatibility(mergeConfig(DEFAULT_CONFIG, parsed));
}
