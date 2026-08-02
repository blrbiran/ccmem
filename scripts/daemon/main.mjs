import { ConfigError, loadConfig } from '../lib/config.mjs';
import { openDb } from '../lib/db.mjs';
import { getProvider } from '../lib/embedding/provider.mjs';
import { currentEmbeddingSig } from '../lib/embedding/signature.mjs';
import { acquireDaemonLock, refreshHeartbeat, releaseDaemonLock } from './lock.mjs';
import { dispatchTask } from './dispatch.mjs';
import { pendingEmbeddings } from './tasks/vec-backfill.mjs';
import {
  checkPendingRestart,
  checkSchemaStaleness,
  getStartupSchemaVersion,
  scheduleGracefulRestart,
  writeDaemonStartupState
} from './self-restart.mjs';
import { mainLoop, reclaimOrphanedTasks } from './loop.mjs';

function semanticRuntimeEnabled(db) {
  const cfg = loadConfig();
  const kv = db.prepare(`SELECT value FROM config_kv WHERE key = 'embedding.enabled'`).get()?.value ?? null;
  return kv != null ? kv === 'true' : Boolean(cfg.embedding?.enabled);
}

async function warmSemanticProvider(db) {
  if (!semanticRuntimeEnabled(db)) {
    return;
  }

  const cfg = loadConfig();
  let provider = null;
  try {
    provider = getProvider(cfg);
    await provider?.load?.();
  } catch {}

  // Signature-aware: after migration 016, every pre-v0.13 row has
  // embedding_sig IS NULL. A NULL-only pending count would see "0 pending"
  // on a store that is fully embedded but entirely stale, never queue
  // vec_backfill, and leave semantic retrieval silently degraded to
  // lexical-only forever — the exact failure mode this task exists to fix.
  if (pendingEmbeddings(db, currentEmbeddingSig(provider, cfg)) <= 0) {
    return;
  }

  const queued = Number(db.prepare(
    `SELECT COUNT(*) AS n
     FROM tasks
     WHERE type = 'vec_backfill'
       AND status IN ('queued', 'running')`
  ).get()?.n ?? 0);

  if (queued === 0) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (type, payload, scheduled_for, enqueued_at, status)
       VALUES ('vec_backfill', '{}', ?, ?, 'queued')`
    ).run(now, now);
  }
}

// Read the config before anything else claims a resource. launchd restarts a
// daemon that exits, so a broken config file is written to daemon.err.log over
// and over — a raw stack there is unreadable, and dying after acquireDaemonLock
// churns the lock row on every retry for no reason. Starting on DEFAULT_CONFIG
// instead is not an option: it would run transformers-local against a store of
// openai vectors and rebuild Finding 12 silently.
try {
  loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) {
    throw error;
  }

  process.stderr.write(`ccmem: daemon not starting — ${error.message}\n`);
  process.exit(1);
}

const db = openDb();
acquireDaemonLock(db);
// Must run before warmSemanticProvider: its vec_backfill re-queue guard counts
// 'running' rows, so a leftover orphan would suppress the queue for good.
const reclaimed = reclaimOrphanedTasks(db);
if (reclaimed > 0) {
  process.stderr.write(`ccmem: reclaimed ${reclaimed} task(s) left running by a previous daemon\n`);
}
const startedAt = Date.now();
const startupVersion = getStartupSchemaVersion(db);
writeDaemonStartupState(db, startupVersion, process.pid);
await warmSemanticProvider(db);
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
