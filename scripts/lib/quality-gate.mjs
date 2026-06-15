const COMMIT_FORMAT = /^(?:feat|fix|docs|chore|refactor|style|test|perf|ci|build)\(/i;
const FILE_PATH_HEAVY = /(?:\/[\w.-]+){2,}/g;
const VERSION_SNAPSHOT = /\b(?:v?\d+\.\d+|version\s*[=:]\s*\d+|schema\s*(?:version)?\s*\d+)/i;
const TEST_COUNT = /\b\d+\s*\/\s*\d+\s*(?:pass|tests?|fail)\b/i;
const TEST_COUNT_NAMED = /\b(?:UT|IT|E2E)\s*\d+\s*pass\b/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const FILE_PATH = /[\w.-]+\/[\w./-]+/g;
const PATH_LIST_VERB = /\b(?:use|add|create|remove|change|update|prefer|avoid)\b/i;

export function checkQuality(content, cfgOverride = null) {
  const text = String(content ?? '').trim();
  const cfg = cfgOverride ?? {};
  const enabled = cfg.rules_enabled ?? {};
  const minChars = Number(cfg.min_chars ?? 15);

  if (enabled.too_short !== false && text.length < (Number.isFinite(minChars) ? minChars : 15)) {
    return { pass: false, reason: 'too_short' };
  }

  if (enabled.commit_format !== false && COMMIT_FORMAT.test(text)) {
    return { pass: false, reason: 'commit_format' };
  }

  const pathMatches = text.match(FILE_PATH_HEAVY) ?? [];
  const pathChars = pathMatches.join('').length;
  if (enabled.too_specific !== false && pathChars > text.length * 0.5) {
    return { pass: false, reason: 'too_specific' };
  }

  if (enabled.version_snapshot !== false && VERSION_SNAPSHOT.test(text) && text.length < 60) {
    return { pass: false, reason: 'version_snapshot' };
  }

  if (enabled.test_count !== false && (TEST_COUNT.test(text) || TEST_COUNT_NAMED.test(text))) {
    return { pass: false, reason: 'test_count' };
  }

  if (enabled.timestamp_dominant !== false) {
    const dateMatches = text.match(ISO_DATE) ?? [];
    if (dateMatches.join('').length > text.length * 0.3) {
      return { pass: false, reason: 'timestamp_dominant' };
    }
  }

  if (enabled.path_list !== false) {
    const paths = text.match(FILE_PATH) ?? [];
    if (paths.length >= 3 && !PATH_LIST_VERB.test(text)) {
      return { pass: false, reason: 'path_list' };
    }
  }

  return { pass: true, reason: null };
}
