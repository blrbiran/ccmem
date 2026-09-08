import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
const DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-reval-batch-'));
process.env.CCMEM_DATA_ROOT = DATA_ROOT;

const { openDb } = await import('../../scripts/lib/db.mjs');
const { DEFAULT_CONFIG } = await import('../../scripts/lib/config.mjs');
const { revalidationAuditCore } = await import('../../scripts/lib/revalidation.mjs');

function writeConfig(overrides) {
  writeFileSync(path.join(DATA_ROOT, 'config.json'), JSON.stringify(overrides), 'utf8');
}

function seedUnscanned(db, n) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO memories (scope, project_key, type, source, content, trust_score,
                           decay_status, created_at, updated_at, last_touched_at,
                           last_scanned_patterns_version)
     VALUES ('project', 'p', 'fact', 'user_explicit', ?, 0.5, 'active', ?, ?, ?, NULL)`
  );
  for (let i = 0; i < n; i += 1) insert.run(`benign note number ${i}`, now, now, now);
}

function stampedCount(db, version) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM memories WHERE last_scanned_patterns_version = ?'
  ).get(version).n;
}

// 🔴 为什么这条门断言的是【库里真正被盖上章的行数】，而不是返回值、更不是默认值常量：
// §ⅩⅩⅩⅢ.1 变异③ 记过一次 —— 只断言默认值的 config 守卫【抓不到】"调用点无视
// config"。返回的 scanned 是 candidates.length，与实际写盘的 UPDATE 是两件事，
// 所以两个都断言，且以库里的那个为准。
// 现实中什么操作会让它红：有人把 revalidation.mjs:61 的 batch_size 写死成常量
// （变异 M2 已实测：写死 100 ⇒ 本条红在 stamped=12，而不是别的地方）。
test('revalidation stamps exactly the configured batch_size, not a hardcoded number', () => {
  writeConfig({ security: { revalidation: { batch_size: 5 } } });
  const db = openDb();
  const version = DEFAULT_CONFIG.security.scan_patterns_version;
  seedUnscanned(db, 12);

  const result = revalidationAuditCore(db, { trigger: 'manual', suppressAudit: true });

  assert.equal(result.scanned, 5, 'returned scanned count ignored the configured batch_size');
  assert.equal(
    stampedCount(db, version),
    5,
    'the number of rows actually stamped on disk did not match the configured batch_size'
  );
  db.close();
});

// 这条门守的是【那个数为什么是这个数】，不是那个数本身（断言常量等于常量是同义反复）。
// 整批扫描跑在一个 BEGIN IMMEDIATE 事务里，事务持有期间别的写入方只能等；
// 等不过 busy_timeout 就不是变慢而是【报错】。实测（10,759 行真实记忆的副本）
// 每行约 0.10 ms、最坏 0.131 ms，且一次 10,759 行的批把一个并发写入方顶住 668 ms、
// 零 SQLITE_BUSY。⇒ 默认值必须让最坏事务时长远低于 busy_timeout。
// 现实中什么操作会让它红：有人为了"一次扫完"把默认批调到几万。
const MEASURED_WORST_MS_PER_ROW = 0.131;
const MAX_FRACTION_OF_BUSY_TIMEOUT = 0.25;

test('the default batch_size keeps the write transaction well inside busy_timeout', () => {
  const db = openDb();
  const busyTimeoutMs = db.prepare('PRAGMA busy_timeout').get().timeout;
  assert.ok(busyTimeoutMs > 0, '前提自检：拿不到 busy_timeout 的话这条门测的就不是同一件事');

  const batch = DEFAULT_CONFIG.security.revalidation.batch_size;
  const projectedMs = batch * MEASURED_WORST_MS_PER_ROW;
  const budgetMs = busyTimeoutMs * MAX_FRACTION_OF_BUSY_TIMEOUT;

  assert.ok(
    projectedMs <= budgetMs,
    `default batch_size ${batch} projects to a ${projectedMs.toFixed(0)}ms write transaction, ` +
      `over the ${budgetMs.toFixed(0)}ms budget (${MAX_FRACTION_OF_BUSY_TIMEOUT} of busy_timeout ${busyTimeoutMs}ms)`
  );
  db.close();
});
