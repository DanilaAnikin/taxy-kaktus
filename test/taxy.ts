import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBook, type Book } from "../src/kaktus/company.js";
import { documentIdOf } from "../src/kaktus/invoice.js";
import { readCompanies } from "../src/kaktus/tables.js";
import { loadClients } from "../src/taxy/input.js";
import { planDocument, type PlanContext, type WritePlan } from "../src/write/plan.js";
import { DATA_DIR, ROOT } from "./helpers.js";

type Json = Record<string, unknown>;

export const DOCUMENTS: Json[] = JSON.parse(readFileSync(join(ROOT, "taxy", "doklady-k-zapisu.json"), "utf8"));
export const CLIENTS_PATH = join(ROOT, "taxy", "klienti.json");

/** Outcome of the task data on fresh Kaktus data; every other document is written (docs/findings.md). */
const NOT_WRITTEN: Record<string, string> = {
  doc_c36efaf63f: "already_exists",
  doc_d38c9d950c: "rejected UNKNOWN_CLIENT",
  doc_846133b7f9: "rejected PERIOD_CLOSED",
  doc_61ed535421: "needs_review DELETED_IN_KAKTUS",
  doc_00d80d05f4: "rejected BUYER_MISMATCH",
  doc_a88ae33500: "already_exists",
  doc_00a5091cef: "already_exists",
  doc_340661d8d9: "rejected MISSING_FIELD",
  doc_fd03b52d28: "already_exists",
};
export const EXPECTED = Object.fromEntries(
  DOCUMENTS.map((document) => [document.id, NOT_WRITTEN[String(document.id)] ?? "written"]),
);
export const WRITTEN_IDS = Object.keys(EXPECTED).filter((id) => EXPECTED[id] === "written");

/** A TAXY document from the task data, optionally changed (`patch` is merged one level deep). */
export function taxyDocument(id: string, patch: Json = {}): Json {
  const original = DOCUMENTS.find((document) => document.id === id);
  if (!original) throw new Error(`no document ${id}`);
  const copy = structuredClone(original);
  for (const [key, value] of Object.entries(patch)) {
    const current = copy[key];
    copy[key] = isObject(current) && isObject(value) ? { ...current, ...value } : value;
  }
  return copy;
}

export async function planContext(): Promise<PlanContext> {
  const companies = await readCompanies(DATA_DIR);
  return {
    clients: await loadClients(CLIENTS_PATH),
    companies: new Map(companies.map((company) => [company.id, company])),
  };
}

export async function writePlan(document: Json): Promise<WritePlan> {
  const planned = planDocument(document, await planContext());
  if (planned.kind !== "write") throw new Error(`rejected: ${planned.result.zprava}`);
  return planned.plan;
}

export function book(company: string): Promise<Book> {
  return readBook(join(DATA_DIR, company));
}

/** TAXY document id → Kaktus numbers of the active FAKPRI records that carry it, in both companies. */
export async function taxyRecords(dataDir: string): Promise<Map<string, string[]>> {
  const records = new Map<string, string[]>();
  for (const company of ["0001", "0002"]) {
    for (const record of (await readBook(join(dataDir, company))).invoices) {
      const id = documentIdOf(record.note);
      if (id !== null && !record.deleted) records.set(id, [...(records.get(id) ?? []), record.number]);
    }
  }
  return records;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
