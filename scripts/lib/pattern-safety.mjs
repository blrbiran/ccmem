const MAX_PATTERN_LENGTH = 500;
const MAX_GROUP_COUNT = 20;
const MAX_ALTERNATION_COUNT = 20;
const MAX_RUNTIME_MS = 50;
const SAFETY_SAMPLES = [
  'a'.repeat(2000),
  `${'a'.repeat(2000)}X`,
  ' '.repeat(2000),
  `${'ab'.repeat(1000)}X`
];

function looksUnsafe(pattern) {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return true;
  }

  const groups = pattern.match(/\((?!\?[:=!<])/g) ?? [];
  if (groups.length > MAX_GROUP_COUNT) {
    return true;
  }

  const alternations = pattern.match(/\|(?![^[]*\])/g) ?? [];
  if (alternations.length > MAX_ALTERNATION_COUNT) {
    return true;
  }

  if (/\\[1-9]/.test(pattern)) {
    return true;
  }

  if (/\(\?<([=!])/.test(pattern)) {
    return true;
  }

  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)) {
    return true;
  }

  if (/\((?:[^()\\]|\\.)*\{\d+(?:,\d*)?\}(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)) {
    return true;
  }

  return false;
}

function exceedsRuntimeBudget(regex) {
  const started = process.hrtime.bigint();
  for (const sample of SAFETY_SAMPLES) {
    regex.test(sample);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs > MAX_RUNTIME_MS) {
      return true;
    }
  }
  return false;
}

export function compileSafePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return null;
  }

  if (looksUnsafe(pattern)) {
    return null;
  }

  try {
    const regex = new RegExp(pattern);
    if (exceedsRuntimeBudget(regex)) {
      return null;
    }
    return regex;
  } catch {
    return null;
  }
}
