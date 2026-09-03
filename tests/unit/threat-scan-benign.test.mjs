import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayloads } from '../fixtures/threat-payloads/load.mjs';
import { evaluateTier1, evaluateTier2, evaluateTier3 } from '../../scripts/lib/threat-scan.mjs';

// 为什么门开在误伤这一半，而不是检出率那一半（设计 §4.1）：
// 检出率会随每一次改强变动，做成断言就是一道永远在动的门；
// 而改强最可能弄坏的恰恰是误伤，那一头不该动。
// 而且在此之前 tier2/tier3 一条断言都没有 —— threat-scan.test.mjs 全文只有一个 test()，
// 只覆盖 tier1 的 role injection。"改强会弄坏误伤"这句话在零守卫的前提下成立得更硬。
const rows = loadPayloads(new URL('../fixtures/threat-payloads/benign.jsonl', import.meta.url));

for (const row of rows.filter((r) => r.expect === 'allow')) {
  test(`benign payload stays allowed: ${row.id}`, () => {
    assert.equal(evaluateTier1(row.content).ok, true, `${row.id} tripped tier1: ${row.content}`);
    const t2 = evaluateTier2(row.content, row.source);
    const t3 = evaluateTier3(t2, row.source);
    assert.equal(
      t3.action,
      'allow',
      `${row.id} -> ${t3.action} (score ${t2.score}, evidence ${t2.evidence.join('|')})\n  content: ${row.content}\n  note: ${row.note}`
    );
  });
}
