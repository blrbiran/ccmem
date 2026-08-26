import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-w1-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');

// 命中 TIER2_PATTERNS 的 destructive_command（0.7 分 > 0.35 门槛），
// 同时避开 Tier-1 的 role-injection / hidden-unicode，否则会卡在更前面的门上。
const DANGEROUS = 'deploy note: sudo rm -rf /var/tmp/build-cache before retry';

// loadConfig() 每次调用都重新读盘（无缓存），所以写一次文件就能改变下一次 insertMemory 的行为。
function writeConfig(quarantineAllSources) {
  const configPath = path.join(dataRoot, `config-${quarantineAllSources}.json`);
  writeFileSync(configPath, JSON.stringify({
    version: '0.13',
    security: {
      tier3: { enabled: true },
      quarantine_all_sources_at_write: quarantineAllSources
    }
  }));
  process.env.CCMEM_CONFIG_PATH = configPath;
  return configPath;
}

test('前提自检：配置真的生效了，不是静默回落到默认值', async () => {
  const configPath = writeConfig(true);
  const { loadConfig } = await import('../../scripts/lib/config.mjs');
  const cfg = loadConfig();
  // loadConfig 对不存在的 CCMEM_CONFIG_PATH 是**静默回落**到 store 自己的 config.json，
  // 所以"设了环境变量"不等于"配置生效了"。这一条把它钉死。
  assert.equal(cfg.security.quarantine_all_sources_at_write, true,
    `配置没生效，读的可能不是 ${configPath}`);
  assert.equal(cfg.security.tier3.enabled, true, 'tier3 关着的话 evaluateTier3 根本不会被调用');
});

test('开关关着时：user_explicit 被降级而不是隔离（回归锁）', async () => {
  writeConfig(false);
  const db = openDb();
  db.prepare('DELETE FROM memories').run();

  const result = await insertMemory(db, {
    cwd: dataRoot,
    content: DANGEROUS,
    source: 'user_explicit',
    embedSync: false
  });

  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id);
  assert.notEqual(row.decay_status, 'quarantine', '开关关着时不该被隔离');
  assert.equal(row.type, 'episode', 'force_demote 会把 type 压成 episode');
});

test('开关打开时：user_explicit 真的被隔离，且三个副作用都发生了', async () => {
  writeConfig(true);
  const db = openDb();
  db.prepare('DELETE FROM memories').run();

  const result = await insertMemory(db, {
    cwd: dataRoot,
    content: DANGEROUS,
    source: 'user_explicit',
    embedSync: false
  });

  // insertMemory 的返回值形状（实测 save.mjs:163-169）：
  // { id, scope, project_key, type, decay_status, embedded, ... }
  assert.equal(result.decay_status, 'quarantine', '返回值应当也报告隔离状态');
  assert.equal(result.embedded, false, '返回值的 embedded 应为 false');

  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id);

  // ① 状态
  assert.equal(row.decay_status, 'quarantine');
  assert.ok(Number(row.quarantined_at) > 0, 'quarantined_at 应被写上时间戳');

  // ② 信任度被砍 —— user_explicit 的初始 trust 是 0.9（trust.mjs），
  //    quarantine 分支把它压到 0.3。谁要打开这个开关，得知道自己在放弃什么。
  assert.equal(Number(row.trust_score), 0.3,
    'trust 应从 user_explicit 的初始 0.9 被压到 0.3');

  // ③ 没有向量 —— quarantine 状态直接跳过 buildEmbedding。
  //    没有向量意味着这条记忆对 cosine 检索那条 lane 永久不可见（除非日后 vec-backfill 捞回）。
  assert.equal(row.embedding, null, 'quarantine 写入不生成向量');

  // ④ 标签
  assert.match(String(row.tags ?? ''), /quarantine_at_write/);
});
