import { loadConfig } from '../lib/config.mjs';
import { openDb } from '../lib/db.mjs';
import { acquireDaemonLock, refreshHeartbeat, releaseDaemonLock } from './lock.mjs';
import { dispatchTask } from './dispatch.mjs';
import {
  checkPendingRestart,
  checkSchemaStaleness,
  getStartupSchemaVersion,
  scheduleGracefulRestart,
  writeDaemonStartupState
} from './self-restart.mjs';
import { mainLoop } from './loop.mjs';

const db = openDb();
acquireDaemonLock(db);
const startedAt = Date.now();
const startupVersion = getStartupSchemaVersion(db);
writeDaemonStartupState(db, startupVersion, process.pid);
let currentTask = null;
let stop = false;

const heartbeatIntervalMs = Number(loadConfig().daemon?.self_restart_check_interval_ms ?? 20000);
const timer = setInterval(() => {
  refreshHeartbeat(db);
  const stale = checkSchemaStaleness(db, startupVersion);
  if (!stale.stale) {
    return;
  }

  scheduleGracefulRestart(db, stale, {
    pid: process.pid,
    uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    currentTaskId: currentTask?.id ?? null,
    currentTaskType: currentTask?.type ?? null
  });
}, heartbeatIntervalMs);

process.on('SIGTERM', () => {
  stop = true;
  clearInterval(timer);
  releaseDaemonLock(db);
  db.close();
  process.exit(0);
});

try {
  await mainLoop(
    db,
    () => stop,
    async (loopDb, task) => {
      currentTask = { id: task.id, type: task.type };
      try {
        await dispatchTask(loopDb, task);
      } finally {
        currentTask = null;
      }
    },
    {
      afterTask: async (task) => {
        checkPendingRestart(
          db,
          { startupVersion, pid: process.pid, startedAt },
          { id: task.id, type: task.type }
        );
      }
    }
  );
} finally {
  clearInterval(timer);
  releaseDaemonLock(db);
  db.close();
}
