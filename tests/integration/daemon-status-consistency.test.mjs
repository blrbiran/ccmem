import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'ccmem-status-consistency-'));

const { openDb } = await import('../../scripts/lib/db.mjs');
const { acquireDaemonLock } = await import('../../scripts/daemon/lock.mjs');
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');
const { cmdStats } = await import('../../scripts/lib/cmd/stats.mjs');
const { cmdAdminDiagnose } = await import('../../scripts/lib/admin/diagnose.mjs');

// 复现 2026-08-08 23:12:56 实测抓到的那次交错：daemon_lock 那一行在快照读 lock 时还不存在，
// 到随后的存活判定再读它时已经存在（两次读之间隔着 readInstallState / readWrapperPid /
// isProcessAlive 三次 I/O，全量跑下这个窗口足够别的进程把锁插进去）。
// 按查询形状撕，而不是按次序：快照读（取 holder_pid 那条）落空，存活判定读（只取
// heartbeat_at）照常看得见行。按次序撕会被嵌套调用提前耗掉引信 —— cmdStats 会先经
// maybeRunTier15 → maybeRespawnContainerFallback → loadDaemonStatus 读一次锁。
function withTornLockRead(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      if (/FROM daemon_lock/i.test(sql) && /holder_pid/i.test(sql)) {
        return { get: () => undefined, all: () => [], run: (...args) => stmt.run(...args) };
      }

      return stmt;
    },
    exec: (sql) => db.exec(sql),
    close: () => {}
  };
}

// 为什么这条不变式值得守：这个快照就是 CLI 直接打给操作者的那一个。撕开之后
// `admin daemon restart` 的 container-fallback 路径会打出 "daemon started pid=null"，
// 把一次成功的启动说成缺了 pid。而 daemon_lock.holder_pid 是 NOT NULL 列
// （migrations/002_v02.sql），所以 alive 为真时 pid 为空只可能来自同一快照里的两次读取被撕开。
function assertConsistentSnapshot(snapshot, where) {
  assert.equal(
    snapshot.alive === true && snapshot.pid == null,
    false,
    `${where} reported alive=${snapshot.alive} with pid=${snapshot.pid}: ` +
      'a single status snapshot must not claim the daemon is alive while reporting no holder pid'
  );
}

test('admin daemon status never claims alive while reporting no pid', async () => {
  const db = openDb();
  acquireDaemonLock(db);

  const snapshot = await cmdAdminDaemon(withTornLockRead(db), { verb: 'status' });

  assertConsistentSnapshot(snapshot, 'admin daemon status');
  db.close();
});

test('stats never claims the daemon is alive while reporting no pid', async () => {
  const db = openDb();
  acquireDaemonLock(db);

  const stats = await cmdStats(withTornLockRead(db));

  assertConsistentSnapshot(stats.tier2, 'stats');
  db.close();
});

test('admin diagnose never claims the daemon is alive while reporting no pid', async () => {
  const db = openDb();
  acquireDaemonLock(db);

  const diagnosis = await cmdAdminDiagnose(withTornLockRead(db), {});

  assertConsistentSnapshot(diagnosis.daemon, 'admin diagnose');
  db.close();
});
