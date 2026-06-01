import { wakeRecently } from './wake.mjs';

export async function mainLoop(db, shouldStop, dispatch) {
  while (!shouldStop()) {
    const due = db.prepare(
      `SELECT *
       FROM tasks
       WHERE status = 'queued' AND scheduled_for < ?
       ORDER BY scheduled_for ASC`
    ).all(Date.now());

    if (!due.length) {
      await new Promise((resolve) => setTimeout(resolve, wakeRecently() ? 30000 : 300000));
      continue;
    }

    for (const task of due) {
      await dispatch(db, task);
    }
  }
}
