import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readPartners, readReceivedInvoices, type Partner, type ReceivedInvoice } from "./tables.js";

/** Received invoices and partners of one company, deleted records included. */
export interface Book {
  invoices: ReceivedInvoice[];
  partners: Partner[];
}

/** Invoices first: an import running meanwhile only adds partners, so every invoice finds its partner. */
export async function readBook(companyDir: string): Promise<Book> {
  const invoices = await readReceivedInvoices(companyDir);
  return { invoices, partners: await readPartners(companyDir) };
}

/**
 * Who has the company open in Kaktus (FIRMA.LCK, findings I6), or null when it is closed.
 * A lock file that exists but cannot be read (held open by Kaktus on Windows) also means open.
 */
export async function openedBy(companyDir: string): Promise<string | null> {
  try {
    const owner = (await readFile(join(companyDir, "FIRMA.LCK"), "utf8")).trim();
    return owner === "" ? "unknown user" : owner;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === "ENOENT" ? null : `unknown user, FIRMA.LCK not readable: ${code}`;
  }
}
