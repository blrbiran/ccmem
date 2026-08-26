import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTier2, evaluateTier3 } from '../../scripts/lib/threat-scan.mjs';

// 一条真的会命中 Tier-2 的内容：TIER2_PATTERNS 里 destructive_command 打 0.7 分，
// 高于 force_demote 的 0.35 门槛。刻意避开 Tier-1 的 role-injection 与 hidden-unicode，
// 免得测试其实卡在更前面的门上（那样就测不到 Tier-3 了）。
const DANGEROUS = 'deploy note: sudo rm -rf /var/tmp/build-cache before retry';

function t2(content = DANGEROUS) {
  return evaluateTier2(content, 'user_explicit', 'fact');
}

test('前提自检：DANGEROUS 确实产生 force_demote 且带证据', () => {
  const result = t2();
  assert.equal(result.action, 'force_demote');
  assert.ok(result.evidence.length > 0, '没有证据的话后面的真值表测的就不是同一件事');
});

// ---- 真值表：spec §3.3 的四行，逐行一个测试 ----

test('t2 不是 force_demote 时，无论开关都 allow（开关不得扩大入口条件）', () => {
  const safe = evaluateTier2('just a normal note about tea', 'user_explicit', 'fact');
  assert.equal(safe.action, 'allow');
  assert.equal(evaluateTier3(safe, 'user_explicit').action, 'allow');
  assert.equal(
    evaluateTier3(safe, 'user_explicit', { quarantineAllSourcesAtWrite: true }).action,
    'allow'
  );
});

test('开关默认关时，user_explicit 仍被豁免成 force_demote（回归锁）', () => {
  assert.equal(evaluateTier3(t2(), 'user_explicit').action, 'force_demote');
  assert.equal(
    evaluateTier3(t2(), 'user_explicit', {}).action,
    'force_demote',
    '空 options 必须与完全不传第三个参数等价'
  );
  assert.equal(
    evaluateTier3(t2(), 'user_explicit', { quarantineAllSourcesAtWrite: false }).action,
    'force_demote'
  );
});

test('开关默认关时，cron_consolidated 同样被豁免（回归锁）', () => {
  assert.equal(evaluateTier3(t2(), 'cron_consolidated').action, 'force_demote');
});

test('开关打开时，user_explicit 落到证据检查 ⇒ quarantine', () => {
  assert.equal(
    evaluateTier3(t2(), 'user_explicit', { quarantineAllSourcesAtWrite: true }).action,
    'quarantine'
  );
});

test('开关打开时，cron_consolidated 同样 ⇒ quarantine', () => {
  assert.equal(
    evaluateTier3(t2(), 'cron_consolidated', { quarantineAllSourcesAtWrite: true }).action,
    'quarantine'
  );
});

test('非豁免 source 不受开关影响：两种开关值下都是 quarantine', () => {
  assert.equal(evaluateTier3(t2(), 'auto_inferred').action, 'quarantine');
  assert.equal(
    evaluateTier3(t2(), 'auto_inferred', { quarantineAllSourcesAtWrite: true }).action,
    'quarantine'
  );
});
