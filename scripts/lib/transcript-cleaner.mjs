import { compileSafePattern, isPatternSafe } from './pattern-safety.mjs';

const DEFAULT_RULES = [
  {
    name: 'git_diff',
    match(line) {
      return /^diff --git /.test(line);
    },
    continue(line) {
      return /^diff --git /.test(line) || /^[+\-@\\]/.test(line);
    }
  },
  {
    name: 'test_output',
    match(line) {
      return /^[ \t]*(?:[✓✗]|(?:PASS|FAIL|ok|not ok)\b)/.test(line);
    },
    continue(line) {
      return /^[ \t]*(?:[✓✗]|(?:PASS|FAIL|ok|not ok|#|TAP)\b)/.test(line);
    }
  },
  {
    name: 'stack_trace',
    match(line) {
      return /^(?:Error|TypeError|ReferenceError|SyntaxError):/.test(line);
    },
    continue(line) {
      return /^[ \t]+at /.test(line);
    }
  },
  {
    name: 'file_tree',
    match(line) {
      return /^[ \t]*[├└│]/.test(line);
    },
    continue(line) {
      return /^[ \t]*[├└│ ]/.test(line);
    }
  },
  {
    name: 'cli_output',
    match(line) {
      return /^(?:npm WARN|npm ERR!|added \d+ packages|up to date)/.test(line);
    },
    continue(line) {
      return /^(?:npm |added |up to date|removed )/.test(line);
    }
  }
];

function stripRule(lines, rule) {
  const kept = [];
  let removed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!rule.match(line)) {
      kept.push(line);
      continue;
    }

    removed = true;

    if (typeof rule.end === 'function') {
      i += 1;
      while (i < lines.length) {
        if (rule.end(lines[i])) {
          break;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
    while (i < lines.length && rule.continue(lines[i])) {
      i += 1;
    }
    i -= 1;
  }

  return { lines: kept, removed };
}

function loadRules(cfgOverride = null) {
  if (Array.isArray(cfgOverride?.rules)) {
    return cfgOverride.rules;
  }

  const extra = Array.isArray(cfgOverride?.extra_rules)
    ? cfgOverride.extra_rules.map((rule) => {
        const startSafety = isPatternSafe(rule?.start_pattern);
        const endSafety = isPatternSafe(rule?.end_pattern);
        if (!startSafety.safe || !endSafety.safe) {
          process.stderr.write(`ccmem: extra_rule pattern rejected: ${!startSafety.safe ? startSafety.reason : endSafety.reason}\n`);
          return null;
        }
        const start = compileSafePattern(rule?.start_pattern);
        const end = compileSafePattern(rule?.end_pattern);
        if (!start || !end) {
          return null;
        }
        return {
          name: String(rule?.name ?? 'extra_rule'),
          match(line) {
            return start.test(line);
          },
          end(line) {
            return end.test(line);
          }
        };
      }).filter(Boolean)
    : [];

  return [...DEFAULT_RULES, ...extra];
}

export function cleanTranscript(text, cfgOverride = null) {
  if (!text || typeof text !== 'string') {
    return { cleaned: '', rules_hit: [], before: 0, after: 0 };
  }

  const rules = loadRules(cfgOverride);
  let lines = text.split('\n');
  const rulesHit = [];

  for (const rule of rules) {
    const next = stripRule(lines, rule);
    lines = next.lines;
    if (next.removed) {
      rulesHit.push(rule.name);
    }
  }

  const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    cleaned,
    rules_hit: rulesHit,
    before: text.length,
    after: cleaned.length
  };
}
