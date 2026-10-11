import { spawn } from "node:child_process";
import { basename, extname } from "node:path";
import { listProcesses } from "../util/processes.js";

/** How to start an import; the batch and response paths are appended to `args`. */
export interface KaktusProgram {
  command: string;
  args: string[];
}

/** The simulator script runs on the current Node (`kaktus.cjs import`); KAKTUS.EXE takes `/IMPORT` (manual, section 2). */
export function kaktusProgram(path: string): KaktusProgram {
  return [".cjs", ".js", ".mjs"].includes(extname(path).toLowerCase())
    ? { command: process.execPath, args: [path, "import"] }
    : { command: path, args: ["/IMPORT"] };
}

export interface ImportRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

const MAX_OUTPUT = 16 * 1024;
/** How long to wait for the rest of the output after Kaktus exits; a helper process may keep the pipes open. */
const OUTPUT_GRACE_MS = 200;

/**
 * Runs the import of one batch and kills it after the timeout. Resolves when Kaktus exits, for any exit code;
 * rejects only when the program cannot be started. On Windows, Node puts the import into a job object that
 * kills it when the connector exits; elsewhere it can outlive a killed connector (see `runningImports`).
 */
export function runImport(
  program: KaktusProgram,
  batchPath: string,
  responsePath: string,
  timeoutMs: number,
): Promise<ImportRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(program.command, [...program.args, batchPath, responsePath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const collect = (chunk: string) => {
      if (output.length < MAX_OUTPUT) output += chunk.slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      const finish = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ exitCode, signal, timedOut, output: output.trim() });
      };
      const grace = setTimeout(finish, OUTPUT_GRACE_MS);
      child.once("close", () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}

/**
 * Imports of this batch still running, found by its file names in their command line; e.g. an import whose
 * connector was killed. Rejects when the process list cannot be read.
 */
export async function runningImports(files: { batch: string; response: string }): Promise<number[]> {
  const names = [basename(files.batch), basename(files.response)];
  return (await listProcesses())
    .filter((info) => info.pid !== process.pid && names.every((name) => info.commandLine.includes(name)))
    .map((info) => info.pid);
}
