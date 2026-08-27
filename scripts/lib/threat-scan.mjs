const TIER1_PATTERNS = [
  { re: /<system>|<assistant>|^system:|^assistant:/im, reason: 'role injection pattern detected', pattern: 'role_injection' },
  { re: /[​‌‍﻿]/, reason: 'hidden unicode detected', pattern: 'hidden_unicode' }
];

const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{10,}/g, name: 'openai_key' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, name: 'github_token' },
  { re: /AIza[0-9A-Za-z_-]{20,}/g, name: 'google_api_key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, name: 'private_key' },
  { re: /(?:api[_ -]?key|secret|token|password).{0,20}[:=].{0,40}/gi, name: 'credential_assignment' }
];

const TIER2_PATTERNS = [
  { re: /ignore (all |the )?(previous|prior) instructions/i, score: 0.45, evidence: 'ignore_previous_instructions' },
  { re: /(?:rm\s+-rf\s+\/|sudo\s+rm\s+-rf|del\s+\/f\s+\/s\s+\/q)/i, score: 0.7, evidence: 'destructive_command' },
  { re: /curl\b[^\n|]{0,120}\|\s*(?:bash|sh)\b/i, score: 0.55, evidence: 'curl_pipe_shell' },
  { re: /(?:api[_ -]?key|secret|token|password)\b.{0,80}\b(?:print|dump|exfiltrate|upload|send)/i, score: 0.45, evidence: 'credential_exfiltration' },
  { re: /(?:exfiltrate|steal|leak|export)\b.{0,80}\b(?:secret|token|credential|password)/i, score: 0.45, evidence: 'secret_exfiltration' },
  { re: /(?:bypass|disable)\b.{0,60}\b(?:sandbox|guardrail|security|safety)/i, score: 0.4, evidence: 'security_bypass' }
];

export function tier1Scan(content) {
  for (const pattern of TIER1_PATTERNS) {
    if (pattern.re.test(content)) {
      return {
        matched: true,
        reason: pattern.reason,
        pattern: pattern.pattern
      };
    }
  }

  return {
    matched: false,
    reason: null,
    pattern: null
  };
}

export function secretScan(content) {
  const matches = [];

  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(content)) {
      matches.push(pattern.name);
    }
  }

  return [...new Set(matches)];
}

export function evaluateTier1(content) {
  const result = tier1Scan(content);
  return {
    ok: !result.matched,
    reason: result.reason
  };
}

export function evaluateTier2(content, source = 'user_explicit', type = 'fact') {
  let score = 0;
  const evidence = [];

  for (const pattern of TIER2_PATTERNS) {
    if (!pattern.re.test(content)) {
      continue;
    }

    score += pattern.score;
    evidence.push(pattern.evidence);
  }

  const uniqueEvidence = [...new Set(evidence)];
  const suspicionScore = Math.min(1, Number(score.toFixed(2)));

  return {
    action: suspicionScore >= 0.35 ? 'force_demote' : 'allow',
    score: suspicionScore,
    evidence: uniqueEvidence,
    source,
    type
  };
}

// options.quarantineAllSourcesAtWrite 由调用方从配置读出后传入（save.mjs）。
// 这里刻意不 loadConfig()：这个函数是纯的，测试才能穷举真值表而不用摆配置文件。
export function evaluateTier3(t2Result, source, options = {}) {
  if (!t2Result || t2Result.action !== 'force_demote') {
    return { action: 'allow' };
  }

  // 豁免只在开关关着时生效。开关打开后这两个 source 与其它 source 走同一条路。
  if (!options.quarantineAllSourcesAtWrite
      && (source === 'user_explicit' || source === 'cron_consolidated')) {
    return { action: 'force_demote' };
  }

  if (Array.isArray(t2Result.evidence) && t2Result.evidence.length > 0) {
    return { action: 'quarantine' };
  }

  return { action: 'allow' };
}
