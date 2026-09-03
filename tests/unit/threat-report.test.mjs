import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOk, summarize, benignFpRate, diffBaseline } from '../../scripts/threat-report.mjs';

const r = (over) => ({ id: 'x/01', class: 'c', expect: 'non_allow', action: 'allow', ok: false, ...over });

test('isOk reads correctness against expect, not against a fixed action', () => {
  assert.equal(isOk({ expect: 'non_allow' }, 'quarantine'), true);
  assert.equal(isOk({ expect: 'non_allow' }, 'allow'), false);
  assert.equal(isOk({ expect: 'allow' }, 'allow'), true);
  assert.equal(isOk({ expect: 'allow' }, 'force_demote'), false);
});

test('summarize counts detection per class', () => {
  const rows = summarize([
    r({ class: 'chinese', action: 'allow' }),
    r({ class: 'chinese', action: 'quarantine' }),
    r({ class: 'double_space', action: 'quarantine' })
  ]);
  assert.deepEqual(rows, [
    { class: 'chinese', n: 2, detected: 1, rate: 0.5 },
    { class: 'double_space', n: 1, detected: 1, rate: 1 }
  ]);
});

// FP rate 只看 expect==='allow' 的那一半 —— 设计 §4.3：只收无害句子的对照组会让
// FP rate 恒为 0，那张表就没有信息量，所以这个分母必须是 benign 语料的全部。
test('benignFpRate counts benign rows that did not stay allowed', () => {
  assert.deepEqual(benignFpRate([
    r({ expect: 'allow', action: 'allow' }),
    r({ expect: 'allow', action: 'force_demote' }),
    r({ expect: 'non_allow', action: 'allow' })
  ]), { n: 2, fp: 1, rate: 0.5 });
});

// 逐条 delta 是误伤回归真正要抓的东西：汇总率看不出「修好了哪几条、弄坏了哪几条」。
// FIXED/BROKEN 判的是「对不对」而不是「动作变没变」—— force_demote → quarantine
// 两者都算检出，不该报成修好或弄坏。
test('diffBaseline classifies by correctness, not by action equality', () => {
  const results = [
    { id: 'a', expect: 'non_allow', action: 'quarantine', ok: true },
    { id: 'b', expect: 'allow', action: 'force_demote', ok: false },
    { id: 'c', expect: 'non_allow', action: 'force_demote', ok: true },
    { id: 'd', expect: 'non_allow', action: 'allow', ok: false }
  ];
  const baseline = { actions: { a: 'allow', b: 'allow', c: 'quarantine', d: 'allow', e: 'allow' } };
  const diff = diffBaseline(results, baseline);
  assert.deepEqual(diff.fixed, ['a']);
  assert.deepEqual(diff.broken, ['b']);
  assert.deepEqual(diff.same, ['c', 'd']);
  assert.deepEqual(diff.gone, ['e']);
  assert.deepEqual(diff.new, []);
});

test('diffBaseline reports ids absent from the baseline as new', () => {
  const diff = diffBaseline([{ id: 'z', expect: 'allow', action: 'allow', ok: true }], { actions: {} });
  assert.deepEqual(diff.new, ['z']);
});

// 报告脚本不进 CI（设计 §4.1），但这个测试文件会 import 它 —— 若 main() 在 import 时就跑，
// npm test 会顺手把 baseline.json 重写掉，快照断言从此永远是绿的。
// 断的是行为（import 什么也不产出），不是它长什么样。
// 刻意用一个真实的 importer 文件而不是 node -e：-e 下 process.argv[1] 是 undefined，
// 那个 guard 无论写成什么样都不会触发，等于没考。
test('importing the report module runs nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmem-threat-'));
  try {
    const importer = join(dir, 'importer.mjs');
    const target = new URL('../../scripts/threat-report.mjs', import.meta.url).href;
    writeFileSync(importer, `await import(${JSON.stringify(target)});\n`);
    assert.equal(execFileSync('/usr/local/bin/node', [importer], { encoding: 'utf8' }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
