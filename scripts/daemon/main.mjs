import { openDb } from '../lib/db.mjs';
import { acquireDaemonLock, refreshHeartbeat, releaseDaemonLock } from './lock.mjs';
import { dispatchTask } from './dispatch.mjs';
import { mainLoop } from './loop.mjs';

const db = openDb();
acquireDaemonLock(db);
const timer = setInterval(() => refreshHeartbeat(db), 20000);
let stop = false;

process.on('SIGTERM', () => {
  stop = true;
  clearInterval(timer);
  releaseDaemonLock(db);
  db.close();
  process.exit(0);
});

try {
  await mainLoop(db, () => stop, dispatchTask);
} finally {
  clearInterval(timer);
  releaseDaemonLock(db);
  db.close();
}
