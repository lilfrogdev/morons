import { mkdir, open, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** A stale process lock may be reclaimed only when its recorded PID is gone. */
export async function acquireOwnerLock(path, errorMessage) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); }
      catch (error) { await handle.close(); await unlink(path); throw error; }
      return {
        async close() { await handle.close(); await unlink(path); },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt) throw new Error(errorMessage);
      // Serialize reclaimers so one cannot unlink a newer owner's lock.
      const reclaimPath = `${path}.reclaim`;
      try { await mkdir(reclaimPath, { mode: 0o700 }); }
      catch { throw new Error(errorMessage); }
      try {
      let before, owner;
      try {
        before = await stat(path);
        owner = JSON.parse(await readFile(path, 'utf8'));
      } catch { throw new Error(errorMessage); }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) throw new Error(errorMessage);
      try { process.kill(owner.pid, 0); throw new Error(errorMessage); }
      catch (probe) { if (probe?.code !== 'ESRCH') throw new Error(errorMessage); }
      const after = await stat(path).catch(() => null);
      if (!after || before.ino !== after.ino || before.dev !== after.dev) throw new Error(errorMessage);
      await unlink(path);
      } finally { await rmdir(reclaimPath); }
    }
  }
  throw new Error(errorMessage);
}
