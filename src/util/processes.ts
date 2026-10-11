import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** A running process as the operating system lists it. */
export interface ProcessInfo {
  pid: number;
  /**
   * Start time in ms since the epoch; null when the system does not say. ps rounds it down, on Linux by up to 2 s,
   * and Linux derives it from the boot time, which moves when the clock is set. Windows keeps the creation time.
   */
  startedAt: number | null;
  commandLine: string;
}

const LIST_TIMEOUT_MS = 30_000;
const STOP_WAIT_MS = 5_000;

// One line per process: "<pid> <start in ms> <command line>", written past PowerShell's formatting (no wrapping).
// PowerShell 5.1 is part of every supported Windows.
const WINDOWS_LIST = `
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
Get-CimInstance Win32_Process | ForEach-Object {
  $started = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { '' }
  [Console]::Out.WriteLine(('{0} {1} {2}' -f $_.ProcessId, $started, ($_.CommandLine -replace '[\\r\\n]', ' ')))
}`;

/** Running processes with their start times and command lines; rejects when the list cannot be read. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  let processes: ProcessInfo[];
  if (process.platform === "win32") {
    const script = Buffer.from(WINDOWS_LIST, "utf16le").toString("base64");
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", script]);
    processes = parse(output, /^(\d+) (\d*) ?(.*)$/, (started) => (started ? Number(started) : null));
  } else {
    // "  123 Sat Oct 10 12:34:56 2026 /usr/bin/node app.js", start in UTC
    const output = await run("ps", ["-A", "-ww", "-o", "pid=,lstart=,args="], { LC_ALL: "C", TZ: "UTC" });
    const line = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;
    processes = parse(output, line, (started) => Date.parse(`${started} UTC`));
  }
  // An empty or garbled list must not pass for "nothing is running".
  if (!processes.some((info) => info.pid === process.pid)) throw new Error("the process list misses this process");
  return processes;
}

/** Whether a process with this pid exists; it may be another process that reuses the pid. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills the process and waits until it is gone; false when it still runs after 5 s or may not be killed. */
export async function stopProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  for (let waited = 0; waited < STOP_WAIT_MS && isAlive(pid); waited += 50) await sleep(50);
  return !isAlive(pid);
}

function parse(output: string, line: RegExp, startedAt: (text: string) => number | null): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const text of output.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.exec(text);
    if (match) processes.push({ pid: Number(match[1]), startedAt: startedAt(match[2]!), commandLine: match[3]! });
  }
  return processes;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: LIST_TIMEOUT_MS,
      windowsHide: true,
    };
    execFile(command, args, options, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const exit =
        typeof error.code === "number" ? `exit ${error.code}: ${stderr.trim().split(/\r?\n/)[0]}` : error.code;
      reject(new Error(`${command}: ${error.killed ? "timed out" : exit}`));
    });
  });
}
