import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-w1-'));
process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;

// node --test 在同一个文件内按顺序执行顶层 test()（非并发）。下面三条测试共享同一个
// process.env.CCMEM_CONFIG_PATH 和同一个 db 连接，正是依赖了这个顺序保证 —— 每条测试
// 先写自己的配置文件再调用 insertMemory，靠的是"上一条测试已经跑完"而不是显式同步。
// 如果这个顺序保证将来变了（比如换成并发 runner），失败模式是几条测试互相踩到对方的
// 配置，产生一次静默的误通过，而不是报错。
test.after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { insertMemory } = await import('../../scripts/lib/cmd/save.mjs');

// 命中 TIER2_PATTERNS 的 destructive_command（0.7 分 > 0.35 门槛），
// 同时避开 Tier-1 的 role-injection / hidden-unicode，否则会卡在更前面的门上。
const DANGEROUS = 'deploy note: sudo rm -rf /var/tmp/build-cache before retry';

// loadConfig() 每次调用都重新读盘（无缓存），所以写一次文件就能改变下一次 insertMemory 的行为。
//
// withEmbedding 控制是否在 embedding 上打开一个真实可用的 provider：
// CCMEM_TEST_MODE=1 下 transformers-local.load()（transformers-local.mjs:70-74）
// 会装一个确定性的 stub extractor 而不是下载真实模型，所以打开它不会碰网络，
// 但确实会走一遍真正的 buildEmbedding 路径。这是"没有向量"断言的对照组：
// 没有这个开关，embedding.enabled 默认是 false，buildEmbedding 必返回 null，
// 那条断言就和 quarantine 分支没有任何因果关系。
function writeConfig(quarantineAllSources, { withEmbedding = false } = {}) {
  const configPath = path.join(dataRoot, `config-${quarantineAllSources}-${withEmbedding}.json`);
  const config = {
    version: '0.13',
    security: {
      tier3: { enabled: true },
      quarantine_all_sources_at_write: quarantineAllSources
    }
  };
  if (withEmbedding) {
    config.embedding = { enabled: true, provider: 'transformers-local' };
  }
  writeFileSync(configPath, JSON.stringify(config));
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
  writeConfig(false, { withEmbedding: true });
  const db = openDb();
  db.prepare('DELETE FROM memories').run();

  const result = await insertMemory(db, {
    cwd: dataRoot,
    content: DANGEROUS,
    source: 'user_explicit',
    embedSync: true
  });

  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id);
  assert.notEqual(row.decay_status, 'quarantine', '开关关着时不该被隔离');
  assert.equal(row.type, 'episode', 'force_demote 会把 type 压成 episode');

  // 对照组：证明在这个测试环境里，一个非隔离的写入确实能生成向量。
  // 没有这一条，on-switch 测试里的 "row.embedding === null" 可能只是因为
  // embedding provider 压根没启用，和 quarantine 分支毫无关系。
  assert.notEqual(row.embedding, null, '对照组：非隔离写入应当生成向量，否则下面的"无向量"断言没有意义');
});

test('开关打开时：user_explicit 真的被隔离，且三个副作用都发生了', async () => {
  writeConfig(true, { withEmbedding: true });
  const db = openDb();
  db.prepare('DELETE FROM memories').run();

  const result = await insertMemory(db, {
    cwd: dataRoot,
    content: DANGEROUS,
    source: 'user_explicit',
    embedSync: true
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

  // ③ 没有向量 —— quarantine 状态直接跳过 buildEmbedding。这里 embedding provider
  //    是真实启用的（见上一条测试的对照组），所以 null 只能来自 quarantine 分支本身，
  //    不是因为 provider 从没跑起来过。
  //    没有向量意味着这条记忆对 cosine 检索那条 lane 永久不可见（除非日后 vec-backfill 捞回）。
  assert.equal(row.embedding, null, 'quarantine 写入不生成向量');

  // ④ 标签 —— 精确成员检查，而不是子串匹配（子串会被
  //    "not_quarantine_at_write_really" 这样的假标签蒙混过去）。
  const tags = JSON.parse(row.tags ?? '[]');
  assert.ok(tags.includes('quarantine_at_write'),
    `tags 应包含 quarantine_at_write，实际为 ${row.tags}`);
});
