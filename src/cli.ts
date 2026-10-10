#!/usr/bin/env node
import { parseArgs } from "node:util";
import { kaktusProgram } from "./kaktus/process.js";
import { readKaktus } from "./read.js";
import { InputError, loadClients, loadDocuments } from "./taxy/input.js";
import { writeJsonAtomic } from "./util/fs.js";
import { STATUSES } from "./write/types.js";
import { writeKaktus } from "./write/write.js";

const USAGE = `Usage:
  kaktus-connector read  [--data <dir>] [--out <file>]
  kaktus-connector write [--data <dir>] [--kaktus <program>] [--clients <file>] [--documents <file>]
                         [--state <dir>] [--out <file>] [--timeout <seconds>]

  --data       Kaktus DATA directory (default: kaktus/DATA)
  --out        output JSON (default: output/read.json, output/write-report.json)
  --kaktus     KAKTUS.EXE or the simulator script (default: kaktus/kaktus.cjs)
  --clients    TAXY clients (default: taxy/klienti.json)
  --documents  TAXY documents to write (default: taxy/doklady-k-zapisu.json)
  --state      connector state: locks, journal, backups, batches (default: .kaktus-state)
  --timeout    import timeout in seconds, 1-600 (default: 60)

Exit codes:
  0  success; write: every document has a final status
  1  failure, or write: some documents are deferred or failed and must be retried
  2  invalid usage or input`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "read") return runRead(args);
  if (command === "write") return runWrite(args);
  throw new UsageError(command ? `unknown command "${command}"` : "missing command");
}

async function runRead(args: string[]): Promise<number> {
  const { data, out } = options(args, { data: "kaktus/DATA", out: "output/read.json" });
  const result = await readKaktus(data);
  await writeJsonAtomic(out, result);
  for (const company of result.firmy) {
    const summary = company.chyba
      ? `FAILED: ${company.chyba}`
      : `suppliers: ${company.dodavatele.length}, received invoices: ${company.fakturyPrijate.length}, warnings: ${company.varovani.length}`;
    console.log(`${company.kaktusFirma} ${company.nazev}: ${summary}`);
  }
  console.log(`Output: ${out}`);
  return result.firmy.some((company) => company.chyba) ? 1 : 0;
}

async function runWrite(args: string[]): Promise<number> {
  const o = options(args, {
    data: "kaktus/DATA",
    kaktus: "kaktus/kaktus.cjs",
    clients: "taxy/klienti.json",
    documents: "taxy/doklady-k-zapisu.json",
    state: ".kaktus-state",
    out: "output/write-report.json",
    timeout: "60",
  });
  // The company lock is renewed before each batch and abandoned after 30 min, so one import must stay well below that.
  const timeout = Number(o.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
    throw new UsageError("--timeout must be a whole number of seconds from 1 to 600");
  }

  const report = await writeKaktus(await loadDocuments(o.documents), await loadClients(o.clients), {
    dataDir: o.data,
    program: kaktusProgram(o.kaktus),
    stateDir: o.state,
    timeoutMs: timeout * 1000,
  });
  await writeJsonAtomic(o.out, report);

  for (const document of report.doklady) {
    const detail = [document.kaktusDoklad, document.kod, document.zprava].filter(Boolean).join(" ");
    const warnings =
      document.varovani.length > 0 ? ` [${document.varovani.map((warning) => warning.kod).join(", ")}]` : "";
    console.log(
      `${document.id ?? "?"}  ${document.kaktusFirma ?? "----"}  ${document.stav.padEnd(14)} ${detail}${warnings}`,
    );
  }
  for (const event of report.udalosti) console.log(`${event.kaktusFirma} ${event.kod}: ${event.zprava}`);
  console.log(STATUSES.map((status) => `${status}: ${report.souhrn[status]}`).join(", "));
  console.log(`Output: ${o.out}`);
  return report.souhrn.deferred + report.souhrn.error > 0 ? 1 : 0;
}

function options<T extends Record<string, string>>(args: string[], defaults: T): T {
  try {
    const spec = Object.fromEntries(
      Object.entries(defaults).map(([name, value]) => [name, { type: "string" as const, default: value }]),
    );
    return parseArgs({ args, options: spec, strict: true, allowPositionals: false }).values as T;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(`Error: ${error.message}`);
    if (error instanceof UsageError) console.error(`\n${USAGE}`);
    process.exitCode = error instanceof UsageError || error instanceof InputError ? 2 : 1;
  },
);
