#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readKaktus } from "./read.js";
import { writeJsonAtomic } from "./util/fs.js";

const USAGE = `Usage:
  kaktus-connector read [--data <dir>] [--out <file>]

  --data   Kaktus DATA directory (default: kaktus/DATA)
  --out    output JSON file (default: output/read.json)

Exit codes: 0 success, 1 failure or partial failure, 2 invalid usage.`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "read") return runRead(args);
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

function options<T extends Record<string, string>>(args: string[], defaults: T): T {
  try {
    const spec = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, { type: "string" as const, default: value }]));
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
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
