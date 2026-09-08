import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secretScan } from '../../scripts/lib/threat-scan.mjs';

// 为什么门开在【误伤】这一半，与 threat-scan-benign.test.mjs 同一个理由，但这里是
// 具名的一条：SECRET_PATTERNS 里那条 credential_assignment 已被删除。
//
// 它被删不是因为松，是因为【无法与本语料区分】。实测（3,540 条 global 记忆）：
//   - 原样（两个 0x08 字节，见下面第三条）：命中 0，它从落地起就没执行过；
//   - 只把 0x08 补成 \b：命中 6，【6 条全是假阳性】——就是下面这六条；
//   - 收紧到「关键字紧邻分隔符 + 值为 ≥8 的可打印 ASCII」：命中 1，
//     那 1 条仍是假阳性（10484，一条讲怎么生成密码的规则）。
// 同期 4 条具名规则在生产里真开过火：revalidation_quarantine_in 累计 2 条，
// 两条都是 secret:openai_key。⇒ 留下具名的，删掉通用的。
//
// 🔴 现实中什么操作会让本条判据变红：有人把那条通用规则「修好」再加回来 ——
// 这不是假想，本轮设计中途我自己就差点这么做（补 \b 那一步看着显然且正确）。
// 六条 fixture 是从活语料里【原样取出的真实匹配片段】，不是构造的。
const LIVE_CORPUS_FALSE_POSITIVES = [
  'secret metadata: byte counts, shape verdicts, SAS param ',
  'token cap: "if you exceed the budget, say so in th',
  'token accounting (人裁记账): tally harness token spend per review la',
  'token budgets: a per-task ceiling and a lower per-sess',
  'token cost and context: when the next phase (e.g. `writing-plan',
  'password: `PGPASS=$(openssl rand -hex 24)`. Do not use gen'
];

for (const text of LIVE_CORPUS_FALSE_POSITIVES) {
  test(`live-corpus benign text is not a secret: ${text.slice(0, 32)}`, () => {
    assert.deepEqual(
      secretScan(text),
      [],
      `secretScan flagged benign prose as a credential.\n  text: ${text}`
    );
  });
}

// 反面守卫：上面那条门单靠自己会被「把 SECRET_PATTERNS 整个删空」满足。
// 这一条钉住删除的边界 —— 四条具名规则必须仍然各自命中。
const NAMED_PATTERNS_MUST_STILL_FIRE = [
  ['openai_key', 'my key is sk-abcdefghij1234567890'],
  ['github_token', 'ghp_ABCDEFGHIJKLMNOPQRST1234'],
  ['google_api_key', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWX12345'],
  ['private_key', '-----BEGIN RSA PRIVATE KEY-----']
];

for (const [name, text] of NAMED_PATTERNS_MUST_STILL_FIRE) {
  test(`named secret pattern still fires: ${name}`, () => {
    assert.deepEqual(secretScan(text), [name]);
  });
}

// 🔴 这一条守的是【真实缺陷本身】，不是它的症状。
// credential_assignment 那条正则写的是 \b(?:…)\b，但源文件里落下的是【两个 0x08
// 字节】（字面退格符），不是 \b 转义 —— 所以它要求内容里出现一个退格符才可能命中，
// 而记忆内容里永远不会有。这就是 §ⅩⅩⅨ.2.2 那条「死正则」的机械成因。
// 删掉那条规则的同时这两个字节也一并消失；本条门防的是同样的字节再次混进来。
test('threat-scan.mjs contains no literal 0x08 bytes', () => {
  const source = readFileSync(new URL('../../scripts/lib/threat-scan.mjs', import.meta.url));
  const offsets = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === 0x08) offsets.push(i);
  }
  assert.deepEqual(
    offsets,
    [],
    `found literal backspace byte(s) at offset(s) ${offsets.join(', ')} — ` +
      'a \\b escape was almost certainly saved as a raw 0x08, which silently kills the pattern'
  );
});
