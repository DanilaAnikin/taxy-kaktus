import { rmSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (tests run from dist/test). */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA_DIR = join(ROOT, "kaktus", "DATA");

const tempDirs: string[] = [];
process.once("exit", () => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Copy of the Kaktus package in a temp dir, so tests never touch repo data. */
export async function kaktusCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-test-"));
  tempDirs.push(dir);
  await cp(join(ROOT, "kaktus"), dir, { recursive: true });
  return dir;
}
