import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-write-tx-busy-'));
// 关掉 FTS，让 reconcileFtsArtifacts 在任何机器上都走同一条分支（丢弃残留触发器）。
// 被测的是事务原语，与 FTS 无关；按本机是否支持 fts5 分叉只会留下一条谁都没跑过的路径。
process.env.CCMEM_DISABLE_FTS5 = '1';

const { openDb, ensureSchema, getDbPath } = await import('../../scripts/lib/db.mjs');

// 为什么这条不变式值得守：ensureSchema 的写事务若用 deferred BEGIN，事务会先读
// （查 sqlite_master 看表/触发器在不在）再升级为写（CREATE/DROP TRIGGER 等 DDL）。
// 只要别的连接在这两步之间提交过，SQLite 判定读快照已失效，返回 SQLITE_BUSY_SNAPSHOT
// （extended errcode 517，报文 `database is locked`）并且**不调用 busy handler** ——
// openDb() 里那句 `PRAGMA busy_timeout = 5000` 对这一类失败完全无效，调用方 0ms 吃到抛错。
// 写事务必须用 BEGIN IMMEDIATE：开始就取写锁 ⇒ 没有可失效的读快照 ⇒ 竞争回到 busy_timeout
// 的管辖范围，对手写入被序列化（普通 SQLITE_BUSY，errcode 5），而不是反过来污染我们。
function withConcurrentCommitDuringTransaction(db, writer) {
  let inTransaction = false;
  // null = 从未注入。注入结果本身就是判据：只数"注入跑过几次"不够 —— 注入可能因为与本缺陷
  // 无关的原因（表名写错、连接坏了）当场失败，条件根本没被施加，而缺陷代码会照样绿。
  let outcome = null;

  const injectOnce = () => {
    if (!inTransaction || outcome) {
      return;
    }

    try {
      writer.exec(
        `INSERT INTO config_kv (key, value, set_at) VALUES ('ccmem_busy_probe', '1', 1)
         ON CONFLICT(key) DO UPDATE SET value = value || '1'`
      );
      outcome = { committed: true, errcode: null };
    } catch (error) {
      outcome = { committed: false, errcode: error.errcode };
    }
  };

  return {
    get outcome() {
      return outcome;
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

test('explicit FTS maintenance holds the write lock from BEGIN, so a rival commit cannot poison it', () => {
  openDb().close();

  const writer = new DatabaseSync(getDbPath());
  writer.exec('PRAGMA journal_mode = WAL;');
  // 刻意给短的 busy_timeout：修好之后这笔注入注定被写锁挡下，不该让测试在这里干等 5 秒。
  writer.exec('PRAGMA busy_timeout = 100;');

  const db = openDb();

  try {
    // 制造一件"事务必须写"的事：FTS 关着而触发器还在 ⇒ reconcileFtsArtifacts 必须把它丢掉。
    // 没有这一步，稳态下压根不会进事务（db.mjs 的 ftsReconcileNeeded 会挡在门外），测试就测不到东西。
    db.exec('DROP TRIGGER IF EXISTS memories_ai');
    db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END`);

    const seam = withConcurrentCommitDuringTransaction(db, writer);

    let thrown = null;
    try {
      ensureSchema(seam, { migrate: true });
    } catch (error) {
      thrown = error;
    }

    // 先证明条件确实被施加了 —— 不是"注入回调跑过"，而是"对手写入真的撞上了我们持有的写锁"。
    // 这三条把仪器的三种失效方式都变成红：从未注入（outcome 为 null）、
    // 注入因无关原因失败（errcode 不是 5，例如表名写错会得到 1）、
    // 以及 BEGIN 退回 deferred 导致对手成功提交（committed 为 true）。
    assert.notEqual(seam.outcome, null, 'the concurrent-commit seam never fired inside the transaction');
    assert.equal(
      seam.outcome.committed,
      false,
      'the rival write committed inside ensureSchema transaction — the transaction did not hold the write lock from BEGIN'
    );
    assert.equal(
      seam.outcome.errcode,
      5,
      `the rival write failed with errcode ${seam.outcome.errcode} instead of SQLITE_BUSY(5): ` +
        'it was not blocked by our write lock, so this test no longer imposes the condition it claims to'
    );

    assert.equal(
      thrown,
      null,
      `ensureSchema failed with ${thrown?.errcode} ${thrown?.message} while another connection wrote concurrently: ` +
        'a deferred BEGIN lets SQLite invalidate the read snapshot and return SQLITE_BUSY_SNAPSHOT without ever ' +
        'consulting busy_timeout'
    );

    // 钉正面语义：事务要把触发器真的丢掉，而不只是"没抛错"。
    assert.equal(
      triggerExists(db, 'memories_ai'),
      false,
      'ensureSchema returned without dropping the stale FTS trigger its transaction was supposed to remove'
    );
  } finally {
    writer.close();
    db.close();
  }
});

test('FTS repair rechecks the daemon lock inside its own transaction after a schema upgrade', () => {
  const db = openDb();
  const writer = new DatabaseSync(getDbPath());
  try {
    db.exec(`
      ALTER TABLE tasks DROP COLUMN reclaimed_ms;
      DELETE FROM schema_migrations WHERE to_version = 21;
      UPDATE schema_meta SET version = 20;
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    let transactions = 0;
    const seam = {
      prepare: db.prepare.bind(db),
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE' && ++transactions === 2) {
          const now = Date.now();
          writer.prepare(`INSERT INTO daemon_lock (id, holder_pid, hostname, acquired_at, heartbeat_at, alive)
            VALUES (1, ?, 'test-daemon', ?, ?, 1)`).run(process.pid, now, now);
        }
        return db.exec(sql);
      }
    };

    assert.throws(() => ensureSchema(seam, { migrate: true }), /stop the running daemon/);
    assert.equal(transactions, 2);
    assert.equal(db.prepare('SELECT version FROM schema_meta').get().version, 21);
    assert.equal(triggerExists(db, 'memories_ai'), true, 'an active daemon prevents the FTS repair');
  } finally {
    db.exec('DELETE FROM daemon_lock');
    writer.close();
    db.close();
  }
});

test('ordinary open without the FTS5 module removes only built-in canonical triggers without a backup', async () => {
  const previous = process.env.CCMEM_DISABLE_FTS5;
  delete process.env.CCMEM_DISABLE_FTS5;
  const ftsDb = await import('../../scripts/lib/db.mjs?no-fts5-module');
  const seed = new DatabaseSync(getDbPath());
  try {
    seed.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='trigram');
      DROP TRIGGER IF EXISTS memories_ai;
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN SELECT 1; END;
    `);
    const before = ftsDb.listMigrationBackups();
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.prepare = function (sql) {
      return prepare.call(this, sql.includes('pragma_module_list')
        ? sql.replace('pragma_module_list', "(SELECT 'not-fts5' AS name)") : sql);
    };
    DatabaseSync.prototype.exec = function (sql) {
      if (/USING fts5|VACUUM INTO/.test(sql)) {
        throw Object.assign(new Error('no such module: fts5'), { errcode: 1 });
      }
      return exec.call(this, sql);
    };
    try {
      const db = ftsDb.openDb();
      try {
        assert.equal(triggerExists(db, 'memories_ai'), false);
        assert.equal(triggerExists(db, 'memories_au'), true);
        db.exec(`INSERT INTO memories (scope, type, content, source, last_touched_at, created_at, updated_at)
          VALUES ('global', 'rule', 'write without FTS5', 'user_explicit', 1, 1, 1)`);
        assert.ok(db.prepare("SELECT id FROM memories WHERE content = 'write without FTS5'").get());
      } finally { db.close(); }
      seed.exec(`CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END`);
      const reopened = ftsDb.openDb();
      try {
        assert.equal(triggerExists(reopened, 'memories_fts_insert'), true);
      } finally { reopened.close(); }
      assert.deepEqual(ftsDb.listMigrationBackups(), before);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      DatabaseSync.prototype.exec = exec;
    }
  } finally {
    process.env.CCMEM_DISABLE_FTS5 = previous;
    seed.close();
  }
});

test.after(() => rmSync(process.env.CCMEM_DATA_ROOT, { recursive: true, force: true }));
