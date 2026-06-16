const MAX_PATTERN_LENGTH = 500;
const MAX_GROUP_COUNT = 20;
const MAX_ALTERNATION_COUNT = 20;
const MAX_RUNTIME_MS = 50;
const SAFETY_SAMPLES = [
  'a'.repeat(2000),
  `${'a'.repeat(2000)}X`,
  ' '.repeat(2000),
  `${'ab'.repeat(1000)}X`,
  `${'a'.repeat(1000)}!${'a'.repeat(1000)}`
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

export function isPatternSafe(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return { safe: false, reason: 'empty' };
  }

  if (looksUnsafe(pattern)) {
    return { safe: false, reason: 'heuristic_reject' };
  }

  try {
    const regex = new RegExp(pattern);
    if (exceedsRuntimeBudget(regex)) {
      return { safe: false, reason: 'runtime_budget_exceeded' };
    }
    return { safe: true, reason: null };
  } catch {
    return { safe: false, reason: 'invalid_regex' };
  }
}

export function compileSafePattern(pattern) {
  const verdict = isPatternSafe(pattern);
  if (!verdict.safe) {
    return null;
  }

  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
