const COMMIT_FORMAT = /^(?:feat|fix|docs|chore|refactor|style|test|perf|ci|build)\(/i;
const FILE_PATH_HEAVY = /(?:\/[\w.-]+){2,}/g;

export function checkQuality(content, cfgOverride = null) {
  const text = String(content ?? '').trim();
  const cfg = cfgOverride ?? {};
  const minChars = Number(cfg.min_chars ?? 15);

  if (text.length < (Number.isFinite(minChars) ? minChars : 15)) {
    return { pass: false, reason: 'too_short' };
  }

  if (COMMIT_FORMAT.test(text)) {
    return { pass: false, reason: 'commit_format' };
  }

  const pathMatches = text.match(FILE_PATH_HEAVY) ?? [];
  const pathChars = pathMatches.join('').length;
  if (pathChars > text.length * 0.5) {
    return { pass: false, reason: 'too_specific' };
  }

  return { pass: true, reason: null };
}
