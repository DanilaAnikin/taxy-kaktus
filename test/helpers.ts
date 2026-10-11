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
export const CLI = join(ROOT, "dist", "src", "cli.js");

const tempDirs: string[] = [];
process.once("exit", () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A file still held open (Windows) only leaves a temp dir behind; it must not fail the tests.
    }
  }
});

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

/** Runs `fn` with a PATH where neither ps nor PowerShell is found, as on a system without a process list. */
export async function withoutProcessList<T>(fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = join(tmpdir(), "no-process-list");
  try {
    return await fn();
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
}
