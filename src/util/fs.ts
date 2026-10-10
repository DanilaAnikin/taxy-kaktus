import { copyFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Write to a temp file and rename, so readers never see a half-written file; on disk before it returns. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameRetrying(temp, path);
  await syncDirectory(dirname(path));
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copies a file and flushes the copy to disk, so it survives a power loss. */
export async function copyFileDurable(source: string, target: string): Promise<void> {
  await copyFile(source, target);
  const handle = await open(target, "r+"); // Windows flushes only handles with write access
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes new and renamed directory entries. Windows cannot open directories; NTFS journals them anyway. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Antivirus and indexers on Windows briefly hold new files open, so a rename fails for a moment; retry for ~3 s. */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!TRANSIENT.has((error as NodeJS.ErrnoException).code ?? "") || attempt >= 7) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}
