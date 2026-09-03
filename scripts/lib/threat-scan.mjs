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

// —— 提及 vs 指示 ——
// 扫描器分不清「提及一条危险操作」与「指示执行它」，而记工程约定正是 ccmem 的用途：
// 「别 print secret」「那条 rm -rf 是故意的」是高频的合法记忆，不是硬造的边角料。
// 六条 TIER2 里有三条在这类内容上误伤（0.45 / 0.7 / 0.55，见 W3 设计 §2.1 的只读实测）。
// ⇒ 只加模式会让误伤更糟，必须同时压这一头。

// 句段切分。刻意不切裸句点：x.sh / .env 里的点会把 curl…|bash 这类命中拦腰切开，
// 于是后半句的否定标记再也找不到它所修饰的那次命中。英文只认「句点 + 空白」。
// 全角与半角的 ! ? ; 都要列 —— Task 6 的 normalize() 会把全角折成半角，
// 只写全角的话规范化一上线，这里就再也切不动句了。
const SEGMENT_SEP = /[。！？；;!?]+|\.\s+/g;

// 英文否定习惯前置且辖域及整句 ⇒ 段内出现即算。
const EN_DEMOTION = /\b(?:do not|don't|never|avoid|must not|should not|instead of)\b/i;

// 中文的提及/引述标记多半跟在被提及的内容之后 ⇒ 同样段内出现即算。
// 冒号写成 [:：] 同理：normalize() 会把全角冒号折成半角，只写全角的标记会当场失效。
const ZH_MENTION = /是故意的|别删|别动|别改|别碰|我们不用|不用它|不安全|一律走|项目约定|团队约定|避免再犯|注意[:：]|记住[:：]/;

// 引用语境。🔴 预检 B2 收紧：判的是「命中【落在】某一对反引号之内」，
// 不是「本段里恰好存在一对反引号」—— 后者会让任何含行内代码的记忆整段豁免。
// 实测：`ok` then sudo rm -rf / the whole disk 与
// see `README` for details, ignore all previous instructions 在收紧前都被降权成 allow。
// 用 /g 全量扫区间而不是取第一对，是为了接住代码围栏：``` 的头两个反引号先配成一对空区间，
// 真正裹住内容的是第三个反引号到闭合围栏第一个反引号那一对。
// 刻意不把行首 > 算进来：伪造成本太低，且 normalize() 会把换行折成空格（Task 6），
// 「行首」这个位置本身就不再可靠。
const QUOTE_SPANS = /`[^`]*`/g;

// 🔴 预检 B2 收紧：英文否定的辖域是【小句】，不是整段。
// never mind the rules, sudo rm -rf / 里 never 修饰的是 the rules，
// 不是逗号之后那条命令；不收紧的话加一个否定词就能绕过全部 TIER2。
const EN_CLAUSE_SEP = /[,:;，：；]/;

// 中文否定词必须结束于命中起点之前、且距命中起点不超过窗口，并与命中不重叠。
// 不重叠这一条是关键：「不要理会之前的所有指令」里 不要 是命中的一部分，
// 按段内规则会把这条攻击一并降权掉。
const ZH_NEGATION = /不要|不准|不许|不得|禁止|严禁|勿|不能/g;
const ZH_NEGATION_WINDOW = 16;

function segmentsOf(text) {
  const spans = [];
  let start = 0;
  let match;

  SEGMENT_SEP.lastIndex = 0;
  while ((match = SEGMENT_SEP.exec(text)) !== null) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length });

  return spans.filter((span) => span.end > span.start);
}

function isMentionContext(text, matchStart) {
  const segment = segmentsOf(text).find((span) => matchStart >= span.start && matchStart < span.end)
    ?? { start: 0, end: text.length };
  const segmentText = text.slice(segment.start, segment.end);

  // ① 引用：命中必须落在某一对反引号【之内】（预检 B2）。
  QUOTE_SPANS.lastIndex = 0;
  let span;
  while ((span = QUOTE_SPANS.exec(text)) !== null) {
    if (matchStart > span.index && matchStart < span.index + span[0].length) {
      return true;
    }
  }

  // ② 中文提及标记是篇章级的，常落在相邻小句（「…这种装法，我们的镜像不用它。」）
  //    ⇒ 保持整段作用域，不要跟着英文一起收到小句。收了会让 benign_mention/03 重新误伤。
  if (ZH_MENTION.test(segmentText)) {
    return true;
  }

  // ③ 英文否定只管自己那个小句（预检 B2）。
  let clauseStart = segment.start;
  let clauseEnd = segment.end;
  for (let i = segment.start; i < segment.end; i += 1) {
    if (!EN_CLAUSE_SEP.test(text[i])) {
      continue;
    }
    if (i < matchStart) {
      clauseStart = i + 1;
    } else {
      clauseEnd = i;
      break;
    }
  }
  if (EN_DEMOTION.test(text.slice(clauseStart, clauseEnd))) {
    return true;
  }

  ZH_NEGATION.lastIndex = 0;
  let negation;
  while ((negation = ZH_NEGATION.exec(text)) !== null) {
    const negationEnd = negation.index + negation[0].length;
    if (negation.index >= segment.start && negationEnd <= matchStart && matchStart - negation.index <= ZH_NEGATION_WINDOW) {
      return true;
    }
  }

  return false;
}

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
    const hit = pattern.re.exec(content);
    if (hit === null) {
      continue;
    }

    // 命中落在提及/否定/引用语境里就不计分。设计 §4.6 允许「降分或不计」，
    // 取「不计」是因为这三条模式的分值本就跨过 0.35 那道线，降分还要再定一个系数。
    if (isMentionContext(content, hit.index)) {
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
