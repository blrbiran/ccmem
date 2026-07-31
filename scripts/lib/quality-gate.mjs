const COMMIT_FORMAT = /^(?:feat|fix|docs|chore|refactor|style|test|perf|ci|build)\(/i;
const FILE_PATH_HEAVY = /(?:\/[\w.-]+){2,}/g;
const VERSION_SNAPSHOT = /\b(?:v?\d+\.\d+|version\s*[=:]\s*\d+|schema\s*(?:version)?\s*\d+)/i;
const TEST_COUNT = /\b\d+\s*\/\s*\d+\s*(?:pass|tests?|fail)\b/i;
const TEST_COUNT_NAMED = /\b(?:UT|IT|E2E)\s*\d+\s*pass\b/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const FILE_PATH = /[\w.-]+\/[\w./-]+/g;
const PATH_LIST_VERB = /\b(?:use|add|create|remove|change|update|prefer|avoid)\b/i;

// High-confidence traces of "the tool is not installed / not configured".
const ENV_FAILURE = /(?:command not found|no such file or directory|\bENOENT\b|is not recognized as|not installed|could not be found|找不到命令|未安装|无法找到该?命令)/i;

// Blanket negations of a tool's usability. Deliberately excludes 不支持 / 不要用 /
// never use / avoid — those appear constantly in legitimate conventions.
const NEGATIVE_ASSERTION = /(?:\b(?:doesn['’]?t|does not|will not|won['’]?t|cannot|can['’]?t)\s+work\b|\bis (?:not available|unavailable|broken)\b|用不了|没法用|跑不起来|不可用)/i;

// Same script-detection range as CJK_RANGE in feedback.mjs (kept in sync by
// eye, not import — feedback.mjs is heavy and this module sits on the intake
// path, where every millisecond counts toward the hook budget).
const CJK_RANGE = /[一-鿿぀-ヿ가-힯]/;

// Short text containing a failure string IS the failure report; long text
// containing one is usually the remedy, which the extraction prompt asks for.
// `.length` counts a CJK character the same as a Latin one, but CJK carries
// far more information per character: the same remedy runs ~58 chars in
// Chinese ("遇到 command not found 时先跑 nvm use 22 ...") vs ~150 in English.
// A single flat threshold can't serve both scripts — 120 lets short CJK
// failure reports straight into the store, while 50 would let 60-120-char
// English environment failures (e.g. "Error: ENOENT no such file or directory
// when running the setup script") straight into the store too. So the gate
// is script-aware, mirroring the has_cjk field in feedback.mjs (Task 3),
// which also segments by script rather than blending one threshold across
// both.
const ENV_FAILURE_MAX_LEN_LATIN = 120;
const ENV_FAILURE_MAX_LEN_CJK = 50;

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

  if (enabled.env_failure !== false && ENV_FAILURE.test(text)) {
    const maxLen = CJK_RANGE.test(text) ? ENV_FAILURE_MAX_LEN_CJK : ENV_FAILURE_MAX_LEN_LATIN;
    if (text.length < maxLen) {
      return { pass: false, reason: 'env_failure' };
    }
  }

  // No length gate here, by design: a blanket negation hardens into a refusal
  // regardless of length.
  if (enabled.negative_assertion !== false && NEGATIVE_ASSERTION.test(text)) {
    return { pass: false, reason: 'negative_assertion' };
  }

  return { pass: true, reason: null };
}
