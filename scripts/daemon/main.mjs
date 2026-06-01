import { openDb } from '../lib/db.mjs';
import { acquireDaemonLock, refreshHeartbeat } from './lock.mjs';
import { mainLoop } from './loop.mjs';

const db = openDb();
acquireDaemonLock(db);
const timer = setInterval(() => refreshHeartbeat(db), 20000);
let stop = false;

process.on('SIGTERM', () => {
  stop = true;
  clearInterval(timer);
  db.close();
  process.exit(0);
});

await mainLoop(db, () => stop, async () => {});
