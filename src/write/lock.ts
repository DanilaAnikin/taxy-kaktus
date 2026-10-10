import { randomUUID } from "node:crypto";
import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Our lock file in the Kaktus company folder. It lives with the data, so every connector writing to these
 * data (another state dir, another PC on a shared folder) sees it. Kaktus ignores it.
 */
export const LOCK_FILE = "TAXY-CONNECTOR.LOCK";

/** The exclusive right of one run to write to one company. */
export interface CompanyLock {
  /** Confirms the lock is still ours and marks it alive; false when another run has taken it over. */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/** A lock not renewed for this long is abandoned. Runs renew it before each batch, and a batch is bounded by the import timeout. */
const STALE_LOCK_MS = 30 * 60 * 1000;
/** A lock file is written at once; one still unreadable after this long was left by a crash. */
const UNREADABLE_LOCK_MS = 10 * 1000;

/** Exclusive lock per company across connector processes; null when another live run holds it. */
export async function lockCompany(companyDir: string): Promise<CompanyLock | null> {
  const path = join(companyDir, LOCK_FILE);
  const token = randomUUID();
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, owner, { flag: "wx" });
      return {
        renew: async () => {
          if (!(await isOwner(path, token))) return false;
          const now = new Date();
          await utimes(path, now, now);
          return true;
        },
        release: async () => {
          if (await isOwner(path, token)) await rm(path, { force: true, maxRetries: 5, retryDelay: 200 });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await isStaleLock(path))) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

interface LockOwner {
  pid?: unknown;
  host?: unknown;
  token?: unknown;
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

async function isOwner(path: string, token: string): Promise<boolean> {
  return (await readOwner(path))?.token === token;
}

/** Stale: its process is gone, or it has not been renewed for longer than a live run allows. */
async function isStaleLock(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info === null) return true;
  const age = Date.now() - info.mtimeMs;
  if (age > STALE_LOCK_MS) return true;
  const owner = await readOwner(path);
  if (owner === null) return age > UNREADABLE_LOCK_MS;
  return owner.host === hostname() && typeof owner.pid === "number" && !isAlive(owner.pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
