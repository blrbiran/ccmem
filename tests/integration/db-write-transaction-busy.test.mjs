import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-write-tx-busy-'));

const { openDb, ensureSchema, getDbPath } = await import('../../scripts/lib/db.mjs');

// 这台机器上的 node:sqlite 没有 fts5 模块，别的机器上可能有。两条分支写的东西不同，
// 但都要写，所以两边都能守住这条不变式 —— 判据按实际支持情况取。
function hasFts5() {
  const probe = new DatabaseSync(':memory:');
  try {
    probe.exec("CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='trigram')");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

// 为什么这条不变式值得守：ensureSchema 的写事务用 deferred BEGIN 时，事务先读
// （查 sqlite_master 看表/触发器在不在）再升级为写（CREATE/DROP TRIGGER 等 DDL）。
// 只要别的连接在这两步之间提交过，SQLite 判定读快照已失效，返回 SQLITE_BUSY_SNAPSHOT
// （extended errcode 517）并且**不调用 busy handler** —— openDb() 里那句
// `PRAGMA busy_timeout = 5000` 对这一类失败完全无效，调用方直接吃到 `database is locked`。
// 写事务必须用 BEGIN IMMEDIATE：开始就取写锁 ⇒ 没有可失效的读快照 ⇒ 竞争回到
// busy_timeout 的管辖范围，变成"等一下"而不是"立刻炸"。
function withConcurrentCommitDuringTransaction(db, writer) {
  let inTransaction = false;
  let injections = 0;

  // 注入必须落在事务内的第一次读之后（deferred 事务的读快照正是那一刻确定的）、
  // 且在 DDL 之前，否则制造不出升级死锁。
  const injectOnce = () => {
    if (!inTransaction || injections > 0) {
      return;
    }

    injections += 1;
    try {
      writer.exec(
        `INSERT INTO config_kv (key, value, set_at) VALUES ('ccmem_busy_probe', '1', 1)
         ON CONFLICT(key) DO UPDATE SET value = value || '1'`
      );
    } catch {
      // 修好之后写事务在 BEGIN 就持有写锁，这一笔注入会被挡下（普通 SQLITE_BUSY，走 busy_timeout）。
      // 那正是期望的行为：竞争被序列化，而不是污染别人的读快照。
    }
  };

  return {
    get injections() {
      return injections;
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...args) => {
          const row = stmt.get(...args);
          injectOnce();
          return row;
        },
        all: (...args) => {
          const rows = stmt.all(...args);
          injectOnce();
          return rows;
        },
        run: (...args) => stmt.run(...args)
      };
    },
    exec: (sql) => {
      if (/^\s*BEGIN\b/i.test(sql)) {
        inTransaction = true;
      }
      if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) {
        inTransaction = false;
      }
      return db.exec(sql);
    },
    close: () => db.close()
  };
}

function triggerExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1").get(name));
}

test('ensureSchema survives a foreign commit landing inside its write transaction', () => {
  const ftsSupported = hasFts5();

  // 先把 schema 建好，并让 supportsFts 的模块级缓存生效 —— 否则事务内的第一次读会落在
  // FTS 探测那条分支上，注入点就不在要测的位置了。
  openDb().close();

  const writer = new DatabaseSync(getDbPath());
  writer.exec('PRAGMA journal_mode = WAL;');
  // 刻意给短的 busy_timeout：修好之后这笔注入注定被写锁挡下，不该让测试在这里干等 5 秒。
  writer.exec('PRAGMA busy_timeout = 100;');

  const db = openDb();

  // 制造一件"事务必须写"的事。两条分支方向相反：
  //  - 支持 FTS：触发器缺失 ⇒ reconcileFtsArtifacts 要 CREATE 回来。
  //  - 不支持 FTS：触发器存在 ⇒ 它要 DROP 掉。
  // 没有这一步，稳态下那个事务全是读，压根不会去升级锁，测试就测不到东西。
  if (ftsSupported) {
    db.exec('DROP TRIGGER IF EXISTS memories_ai');
  } else {
    db.exec('DROP TRIGGER IF EXISTS memories_ai');
    db.exec('CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN SELECT 1; END');
  }
  assert.equal(
    triggerExists(db, 'memories_ai'),
    !ftsSupported,
    'setup failed: the FTS trigger state does not force reconcileFtsArtifacts to write'
  );

  const seam = withConcurrentCommitDuringTransaction(db, writer);

  let thrown = null;
  try {
    ensureSchema(seam);
  } catch (error) {
    thrown = error;
  }

  // 先证明仪器真的开火了：注入只在事务内的第一次读之后发生一次。一旦 ensureSchema 不再
  // 经由 prepare()/exec() 走这条路，仪器会静默失效，而"没抛错"这种否定式判断会被一个
  // 压根没被施加条件的运行满足，测试就悄悄失去分辨力。
  assert.ok(
    seam.injections > 0,
    'the concurrent-commit seam never fired — ensureSchema no longer reads through this db handle inside its transaction, so this test can no longer fail'
  );

  assert.equal(
    thrown,
    null,
    `ensureSchema failed with ${thrown?.errcode} ${thrown?.message} because another connection committed inside its ` +
      'write transaction: a deferred BEGIN lets SQLite invalidate the read snapshot and return SQLITE_BUSY_SNAPSHOT ' +
      'without ever consulting busy_timeout'
  );

  // 钉正面语义：事务要把 FTS 触发器收敛到与本机 FTS 支持一致的状态，而不只是"没抛错"。
  assert.equal(
    triggerExists(db, 'memories_ai'),
    ftsSupported,
    'ensureSchema returned without converging the FTS insert trigger its transaction was supposed to write'
  );

  writer.close();
  db.close();
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
