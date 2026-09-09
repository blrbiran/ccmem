import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'ccmem-stop-budget-'));
const launchAgentDir = path.join(dataRoot, 'LaunchAgents');
const fakeLaunchctlPath = path.join(dataRoot, 'refuse-launchctl.sh');
mkdirSync(launchAgentDir, { recursive: true });

// 护栏，不是布景：没有 plist 时 stopDaemon 走的是 spawn 分支，launchctl 本不该被调用。
// 但取 LaunchAgent 目录的函数在 CCMEM_LAUNCHAGENT_DIR 未设时会回落到 ~/Library/LaunchAgents,
// 那里就是生产 plist —— 一旦哪天回落发生，真 launchctl 会被对着 com.ccmem.daemon 跑。
// 于是这里同时钉死目录并把 launchctl 换成一个只会失败的假二进制：真被调到就是响的，不是静默的。
writeFileSync(fakeLaunchctlPath, '#!/bin/sh\necho "launchctl must not be reached by this test" >&2\nexit 1\n');
chmodSync(fakeLaunchctlPath, 0o755);

process.env.CCMEM_TEST_MODE = '1';
process.env.CCMEM_DATA_ROOT = dataRoot;
process.env.CCMEM_LAUNCHAGENT_DIR = launchAgentDir;
process.env.CCMEM_LAUNCHCTL_BIN = fakeLaunchctlPath;

const { openDb, getDbPath } = await import('../../scripts/lib/db.mjs');
const { cmdAdminDaemon } = await import('../../scripts/lib/admin/daemon.mjs');

const HOLD_MS = 3000;

function killIfAlive(pid, signal = 'SIGKILL') {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockRow(db) {
  return db.prepare(`SELECT holder_pid FROM daemon_lock WHERE id = 1`).get() ?? null;
}

async function waitForLock(db, present, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = lockRow(db);
    if (present ? row : !row) {
      return Date.now();
    }

    await sleep(25);
  }

  return null;
}

// 为什么这条不变式值得守：stop 的等待方与被等方是**两个独立的常数**，而且没有任何代码
// 把它们绑在一起 —— 等待方是 daemon.mjs 里 waitFor 的默认 WAIT_TIMEOUT_MS，被等方是
// daemon 的 releaseDaemonLock（一条 DELETE，撞写锁时按 openDb() 设的 busy_timeout = 5000 等）。
// 等待方的预算低于被等方的最坏情况时，stop 会在 daemon 尚未来得及删锁行时放弃，把一次
// **确实成功**的 stop 报成 stop_timeout。这是假阴性：操作者据此会去重启、去 kill -9,
// 而实际上什么都不用做。bug-063 缺陷 1 是同一形状，当时只修了 start 一侧。
test('stop reports stopped when a write-lock holder delays the daemon past the old wait budget', async (t) => {
  const db = openDb();
  t.after(() => db.close());

  const started = await cmdAdminDaemon(db, { verb: 'start' });
  assert.equal(started.status, 'started', 'the spawn branch must actually bring a daemon up');
  t.after(() => {
    // 按 pid 收尾，不读锁行：锁行读不到时（本仓库见过这种连接）残留进程会一直挂在机器上。
    try {
      process.kill(started.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  });

  assert.notEqual(await waitForLock(db, true), null, 'the daemon must take the lock before we stop it');

  // 裸连接持写锁，避免持锁方自己走被测代码路径。持满 HOLD_MS 后由定时器提交释放 ——
  // stop 是 async 且中间有 sleep，所以这个定时器一定跑得到（这点与 db-open-busy-timeout
  // 那条不同：那里被测调用是同步阻塞的，定时释放永远等不到）。
  const holder = new DatabaseSync(getDbPath());
  holder.exec('PRAGMA busy_timeout = 5000;');
  holder.exec('BEGIN IMMEDIATE;');
  holder.exec(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('ccmem_stop_budget_probe', '1', 1)
     ON CONFLICT(key) DO UPDATE SET value = value || '1'`
  );

  let released = false;
  const releaseTimer = setTimeout(() => {
    holder.exec('COMMIT;');
    holder.close();
    released = true;
  }, HOLD_MS);
  t.after(() => {
    clearTimeout(releaseTimer);
    if (!released) {
      holder.exec('ROLLBACK;');
      holder.close();
    }
  });

  const beganAt = Date.now();
  const lockGonePromise = waitForLock(db, false);
  const stopped = await cmdAdminDaemon(db, { verb: 'stop' });
  const lockGoneAt = await lockGonePromise;

  // 断言 1 钉的是注入的**结果**：只有写锁真的挡住了 daemon 的 DELETE，锁行才会晚于旧预算
  // 才消失（无争用时约 50ms）。锁若根本没持住，这条先红 —— "缺陷不在" 与 "仪器坏了" 分得开。
  assert.notEqual(lockGoneAt, null, 'the daemon must have released the lock once the holder committed');
  const lockGoneMs = lockGoneAt - beganAt;
  assert.equal(
    lockGoneMs > 2000,
    true,
    `the write-lock holder must delay the release past the old 2000ms budget, but it took ${lockGoneMs}ms`
  );

  // 断言 2 是被测行为本身：stop 必须等到被等方自己的最坏情况用尽再判失败。
  // 缺陷代码在这里给出的是 stop_timeout —— 一次成功的 stop 被报成失败。
  assert.equal(
    stopped.status,
    'stopped',
    `stop must not report a timeout for a stop that succeeded (lock row gone at ${lockGoneMs}ms)`
  );
  assert.equal(stopped.pid, started.pid);
});

// 同一条不变式的另一半：container-fallback 装法下，stop 等的仍然是 daemon 删锁行那条
// DELETE，被等方的最坏情况一模一样。两条分支各写各的预算，就是同一个缺陷留一半。
test('the container-fallback stop honours the same budget as the spawned one', async (t) => {
  const db = openDb();
  t.after(() => db.close());

  // 直接写安装状态，而不是跑一遍 install：被测的是 stop 的等待预算，不是安装流程。
  writeFileSync(
    path.join(dataRoot, 'daemon-install-state.json'),
    JSON.stringify({ variant: 'container-fallback', node_path: process.execPath })
  );
  t.after(() => rmSync(path.join(dataRoot, 'daemon-install-state.json'), { force: true }));

  const started = await cmdAdminDaemon(db, { verb: 'start' });
  assert.equal(started.status, 'started', 'the fallback branch must actually bring a wrapper up');
  assert.equal(started.via, 'wrapper');
  t.after(() => {
    // wrapper 是 detached 的进程组长（sh + 它起的 node），按组收尾；再补一发按 daemon pid。
    killIfAlive(started.wrapper_pid ? -started.wrapper_pid : null);
    killIfAlive(started.pid);
  });

  const liveRow = await waitForLock(db, true);
  assert.notEqual(liveRow, null, 'the wrapper-started daemon must take the lock before we stop it');

  const holder = new DatabaseSync(getDbPath());
  holder.exec('PRAGMA busy_timeout = 5000;');
  holder.exec('BEGIN IMMEDIATE;');
  holder.exec(
    `INSERT INTO config_kv (key, value, set_at) VALUES ('ccmem_stop_budget_probe_wrapper', '1', 1)
     ON CONFLICT(key) DO UPDATE SET value = value || '1'`
  );

  let released = false;
  const releaseTimer = setTimeout(() => {
    holder.exec('COMMIT;');
    holder.close();
    released = true;
  }, HOLD_MS);
  t.after(() => {
    clearTimeout(releaseTimer);
    if (!released) {
      holder.exec('ROLLBACK;');
      holder.close();
    }
  });

  const beganAt = Date.now();
  const lockGonePromise = waitForLock(db, false);
  const stopped = await cmdAdminDaemon(db, { verb: 'stop' });
  const lockGoneAt = await lockGonePromise;

  assert.notEqual(lockGoneAt, null, 'the daemon must have released the lock once the holder committed');
  const lockGoneMs = lockGoneAt - beganAt;
  assert.equal(
    lockGoneMs > 2000,
    true,
    `the write-lock holder must delay the release past the old 2000ms budget, but it took ${lockGoneMs}ms`
  );

  assert.equal(
    stopped.status,
    'stopped',
    `the fallback stop must not report a timeout for a stop that succeeded (lock row gone at ${lockGoneMs}ms)`
  );
  assert.equal(stopped.via, 'wrapper');
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});
