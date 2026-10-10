import { rmSync } from "node:fs";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kaktusProgram } from "../src/kaktus/process.js";
import type { WriteOptions } from "../src/write/write.js";

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

/** A Kaktus copy with write options pointing into it (connector state in `<dir>/state`). */
export async function kaktusSetup() {
  const dir = await kaktusCopy();
  const options: WriteOptions = {
    dataDir: join(dir, "DATA"),
    program: kaktusProgram(join(dir, "kaktus.cjs")),
    stateDir: join(dir, "state"),
    timeoutMs: 30_000,
  };
  return { dir, options, fakpri: (company: string) => readFile(join(dir, "DATA", company, "FAKPRI.DBF")) };
}
