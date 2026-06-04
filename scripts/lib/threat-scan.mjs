const ROLE_INJECTION = /<system>|<assistant>|^system:|^assistant:/im;
const HIDDEN_UNICODE = /[​‌‍﻿]/;

const TIER2_PATTERNS = [
  { re: /ignore (all |the )?(previous|prior) instructions/i, score: 0.45, evidence: 'ignore_previous_instructions' },
  { re: /(?:rm\s+-rf\s+\/|sudo\s+rm\s+-rf|del\s+\/f\s+\/s\s+\/q)/i, score: 0.7, evidence: 'destructive_command' },
  { re: /curl\b[^\n|]{0,120}\|\s*(?:bash|sh)\b/i, score: 0.55, evidence: 'curl_pipe_shell' },
  { re: /(?:api[_ -]?key|secret|token|password)\b.{0,80}\b(?:print|dump|exfiltrate|upload|send)/i, score: 0.45, evidence: 'credential_exfiltration' },
  { re: /(?:exfiltrate|steal|leak|export)\b.{0,80}\b(?:secret|token|credential|password)/i, score: 0.45, evidence: 'secret_exfiltration' },
  { re: /(?:bypass|disable)\b.{0,60}\b(?:sandbox|guardrail|security|safety)/i, score: 0.4, evidence: 'security_bypass' }
];

export function evaluateTier1(content) {
  if (ROLE_INJECTION.test(content)) {
    return {
      ok: false,
      reason: 'role injection pattern detected'
    };
  }

  if (HIDDEN_UNICODE.test(content)) {
    return {
      ok: false,
      reason: 'hidden unicode detected'
    };
  }

  return {
    ok: true,
    reason: null
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

export function evaluateTier3(t2Result, source) {
  if (!t2Result || t2Result.action !== 'force_demote') {
    return { action: 'allow' };
  }

  if (source === 'user_explicit' || source === 'cron_consolidated') {
    return { action: 'force_demote' };
  }

  if (Array.isArray(t2Result.evidence) && t2Result.evidence.length > 0) {
    return { action: 'quarantine' };
  }

  return { action: 'allow' };
}
