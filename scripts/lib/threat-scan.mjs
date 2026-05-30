const ROLE_INJECTION = /<system>|<assistant>|^system:|^assistant:/im;
const HIDDEN_UNICODE = /[​‌‍﻿]/;

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
