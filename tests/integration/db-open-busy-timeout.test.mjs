import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-open-busy-'));
// 关掉 FTS，理由同 db-write-transaction-busy：被测的是开库时的 pragma 次序，与 FTS 无关，
// 按本机是否支持 fts5 分叉只会留下一条谁都没跑过的路径。
process.env.CCMEM_DISABLE_FTS5 = '1';

const { openDb, getDbPath } = await import('../../scripts/lib/db.mjs');

// 为什么这条不变式值得守：openDb() 里 `PRAGMA journal_mode = WAL` 排在
// `PRAGMA busy_timeout = 5000` **前面**，而打开/恢复 WAL 本身要拿排它锁。busy handler
// 那时还没装上 ⇒ 一旦有别的进程正在开同一个库，这句 pragma 会**立刻**抛
// `database is locked`（实测 errcode 5 SQLITE_BUSY 与 261 SQLITE_BUSY_RECOVERY，耗时 2–10ms），
// 配置好的 5 秒容忍度对它完全无效。实测：12 个进程并发开一个已建好、已是 WAL 的库，
// 240 次里 12 次这样炸（5%）；只把这两行调换即 0/240。
//
// 这不是测试专有的问题 —— hook、CLI、daemon 每次开库都走这条路径，任何一次并发都可能
// 让调用方 0ms 吃到一个本该被等掉的错误。
test('openDb honours its own busy_timeout while another connection holds the database', async (t) => {
  // 先把库建好，让被测的那次 openDb 面对的是稳态：库已存在、已是 WAL。
  openDb().close();

  // 用裸连接持锁，避免持锁方自己也走被测代码路径。locking_mode=EXCLUSIVE 拿的是**文件级**
  // 排它锁 —— 这正是上一轮排除这条时没测到的竞争类型（当时只测了「已是 WAL + 持写事务」，
  // 那种条件下这句 pragma 确实是 no-op，于是得出了错误的排除结论）。
  const holder = new DatabaseSync(getDbPath());
  holder.exec('PRAGMA busy_timeout = 5000;');
  holder.exec('PRAGMA locking_mode = EXCLUSIVE;');
  holder.exec('BEGIN IMMEDIATE;');
  holder.exec(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('ccmem_open_busy_probe', '1', 1)
     ON CONFLICT(key) DO UPDATE SET value = value || '1'`
  );

  // 锁全程持住，不做定时释放。原因：openDb() 是同步阻塞的，它会把事件循环占死，
  // 同进程里的释放定时器永远等不到执行 —— 那是测试自己的死锁，不是被测行为。
  // 于是判据改成**等待时长**：锁一直不放时，正确行为就是"等满 busy_timeout 再失败"，
  // 而缺陷行为是"约 2ms 立刻失败"。两者都以抛错收场，能分开它们的只有耗时。
  // 代价是这条测试固定要跑满 5 秒（busy_timeout 是硬编码的 5000）。
  t.after(() => {
    holder.exec('ROLLBACK;');
    holder.close();
  });

  const startedAt = Date.now();
  let thrown = null;
  try {
    openDb().close();
  } catch (error) {
    thrown = error;
  }
  const elapsedMs = Date.now() - startedAt;

  // 断言 1 钉的是注入的**结果**而不是"注入跑过了"：只有排它锁真的被持住，这次开库才会
  // 失败。锁若根本没施加，稳态开库约 2ms 就成功了，这条会先红 —— 于是"缺陷不在"和
  // "仪器坏了"分得开。
  assert.notEqual(thrown, null, 'the exclusive holder must actually have blocked the open');

  // 断言 2 是被测行为本身：失败必须发生在 busy_timeout 用尽之后，证明 busy handler 在
  // 这条路径上真的生效了。缺陷代码在这里给出的是约 2ms。
  assert.equal(
    elapsedMs >= 4000,
    true,
    `openDb must let its own busy_timeout govern the wait, but it gave up after ${elapsedMs}ms (errcode=${thrown?.errcode})`
  );
});

test.after(() => {
  rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true });
});
