import type { Book } from "../kaktus/company.js";
import { documentIdOf, type KaktusInvoice, type KaktusSupplier } from "../kaktus/invoice.js";
import type { Partner, ReceivedInvoice } from "../kaktus/tables.js";
import { formatFixed, MONEY_SCALE, RATE_SCALE } from "../util/fixed.js";
import type { Notice } from "./types.js";

export type BookMatch =
  | { kind: "none" }
  | { kind: "exists"; record: ReceivedInvoice; by: string; differences: string[] }
  | { kind: "conflict"; record: ReceivedInvoice; by: string; differences: string[] }
  | { kind: "duplicate"; records: ReceivedInvoice[]; by: string }
  | { kind: "deleted"; record: ReceivedInvoice };

/**
 * Finds the document in the book: by our TAXY id in POZN first, then by supplier and the supplier's
 * document number (entered by the accountant or by an earlier duplicate). Deleted records count too.
 * Same invoice = same total, currency and issue date; other differences are only reported.
 */
export function findInBook(documentId: string, invoice: KaktusInvoice, book: Book): BookMatch {
  const ours = book.invoices.filter((record) => documentIdOf(record.note) === documentId);
  if (ours.length > 0) return classify(ours, invoice, "TAXY id");

  const partnerIds = new Set(supplierPartners(invoice.supplier, book.partners).map((partner) => partner.id));
  const sameNumber = book.invoices.filter(
    (record) =>
      record.partnerId !== null &&
      partnerIds.has(record.partnerId) &&
      record.supplierNumber !== null &&
      looseKey(record.supplierNumber) === looseKey(invoice.supplierNumber),
  );
  return sameNumber.length > 0 ? classify(sameNumber, invoice, "supplier and document number") : { kind: "none" };
}

/**
 * Keys of the same invoice from the same supplier, as identified by IČO, DIČ or name.
 * Two documents sharing a key never go into one batch.
 */
export function naturalKeys(invoice: KaktusInvoice): string[] {
  const { ico, dic, name } = invoice.supplier;
  const number = looseKey(invoice.supplierNumber);
  return [ico && `ICO ${ico}`, dic && `DIC ${dic}`, `NAME ${looseKey(name)}`]
    .filter((key): key is string => Boolean(key))
    .map((key) => `${key}|${number}`);
}

/** The supplier as it goes into the batch, and the partner Kaktus will link it to (null: a new partner). */
export interface LinkedSupplier {
  invoice: KaktusInvoice;
  partnerId: number | null;
  warnings: Notice[];
}

/**
 * Predicts the Kaktus partner: by IČO, the lowest id; without IČO, the exact name among partners without
 * IČO; deleted partners and DIČ are ignored (findings I11). A supplier without IČO known in Kaktus under
 * another spelling (same name apart from case, accents, spaces and punctuation, no other DIČ) is sent under
 * the Kaktus name, so no duplicate partner is created. DIČ alone does not link: VAT groups share one DIČ.
 */
export function linkSupplier(invoice: KaktusInvoice, partners: readonly Partner[]): LinkedSupplier {
  const warnings: Notice[] = [];
  const active = partners.filter((partner) => !partner.deleted).sort((a, b) => a.id - b.id);
  let supplier = invoice.supplier;
  let partner: Partner | undefined;
  if (supplier.ico !== null) {
    partner = active.find((p) => p.ico === supplier.ico);
  } else {
    const { dic, name } = supplier;
    const sameSupplier = (p: Partner) => looseKey(p.name) === looseKey(name) && (!p.dic || !dic || p.dic === dic);
    const withoutIco = active.filter((p) => p.ico === null);
    partner = withoutIco.find((p) => p.name === name);
    if (!partner) {
      partner = withoutIco.find(sameSupplier);
      if (partner) {
        supplier = { ...supplier, name: partner.name };
        warnings.push({
          kod: "LINKED_BY_NAME",
          zprava: `supplier without IČO linked to Kaktus partner ${partner.id} "${partner.name}"`,
        });
      }
    }
    const withIco = partner ? undefined : active.find((p) => p.ico !== null && sameSupplier(p));
    if (withIco) {
      warnings.push({
        kod: "SUPPLIER_WITHOUT_ICO",
        zprava: `Kaktus has this supplier as partner ${withIco.id} with IČO ${withIco.ico}; without the IČO Kaktus creates a new partner`,
      });
    }
  }
  if (invoice.vat12 + invoice.vat21 !== 0 && supplier.dic === null && !partner?.dic) {
    warnings.push({
      kod: "SUPPLIER_WITHOUT_DIC",
      zprava: "invoice charges VAT, but the supplier has no DIČ in TAXY or Kaktus",
    });
  }
  if (supplier.dic !== null && partner?.dic && partner.dic !== supplier.dic) {
    warnings.push({
      kod: "SUPPLIER_DIC_DIFFERS",
      zprava: `Kaktus partner ${partner.id} keeps DIČ ${partner.dic}, TAXY has ${supplier.dic}`,
    });
  }
  return {
    invoice: supplier === invoice.supplier ? invoice : { ...invoice, supplier },
    partnerId: partner?.id ?? null,
    warnings,
  };
}

/**
 * Differences between a written record and what was sent; empty means the write is verified.
 * The partner must be the predicted one, or a new one (`knownPartnerIds`: partners before the batch).
 */
export function verifyRecord(
  record: ReceivedInvoice,
  partners: readonly Partner[],
  linked: Pick<LinkedSupplier, "invoice" | "partnerId">,
  knownPartnerIds: ReadonlySet<number>,
): string[] {
  const { invoice } = linked;
  const checks: [string, unknown, unknown][] = [
    ["supplier number", record.supplierNumber, invoice.supplierNumber],
    ["variable symbol", record.variableSymbol, invoice.variableSymbol],
    ["issue date", record.issueDate, invoice.issueDate],
    ["tax point date", record.taxPointDate, invoice.taxPointDate ?? invoice.issueDate],
    ["due date", record.dueDate, invoice.dueDate],
    ["Zaklad0", record.base0, invoice.base0],
    ["Zaklad12", record.base12, invoice.base12],
    ["DPH12", record.vat12, invoice.vat12],
    ["Zaklad21", record.base21, invoice.base21],
    ["DPH21", record.vat21, invoice.vat21],
    ["total", record.total, invoice.total],
    ["currency", record.currency, invoice.currency],
    ["exchange rate", record.rate, invoice.rate ?? 10 ** RATE_SCALE],
    ["text", record.text, invoice.text],
    ["note", record.note, invoice.note],
  ];
  const mismatches = checks
    .filter(([, actual, sent]) => actual !== sent)
    .map(([label, actual, sent]) => `${label}: Kaktus ${String(actual)}, sent ${String(sent)}`);

  const partner = partners.find((candidate) => candidate.id === record.partnerId);
  const { supplier } = invoice;
  if (linked.partnerId !== null) {
    if (record.partnerId !== linked.partnerId) {
      mismatches.push(`supplier: Kaktus partner ${record.partnerId}, expected partner ${linked.partnerId}`);
    }
  } else if (
    !partner ||
    knownPartnerIds.has(partner.id) ||
    (supplier.ico !== null ? partner.ico !== supplier.ico : partner.name !== supplier.name)
  ) {
    mismatches.push(
      `supplier: Kaktus partner ${record.partnerId}, expected a new partner for ${supplier.ico ?? supplier.name}`,
    );
  }
  return mismatches;
}

/**
 * Text as people retype it: case, accents, spaces and punctuation ignored
 * ("PILA OŘECH SRO" = "Pila Ořech s.r.o.", "2026/0931" = "2026-0931").
 */
export function looseKey(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  return folded || text.toUpperCase();
}

function classify(records: ReceivedInvoice[], invoice: KaktusInvoice, by: string): BookMatch {
  const active = records.filter((record) => !record.deleted);
  if (active.length === 0) return { kind: "deleted", record: records[0]! };
  if (active.length > 1) return { kind: "duplicate", records: active, by };
  const record = active[0]!;
  const { core, other } = compare(record, invoice);
  return core.length > 0
    ? { kind: "conflict", record, by, differences: core }
    : { kind: "exists", record, by, differences: other };
}

/** Core fields decide whether it is the same invoice; other differences are only reported. */
function compare(record: ReceivedInvoice, invoice: KaktusInvoice): { core: string[]; other: string[] } {
  const money = (value: number) => formatFixed(value, MONEY_SCALE);
  const breakdown = (r: { base0: number; base12: number; vat12: number; base21: number; vat21: number }) =>
    `0 %: ${money(r.base0)}, 12 %: ${money(r.base12)} + ${money(r.vat12)}, 21 %: ${money(r.base21)} + ${money(r.vat21)}`;
  const core: [string, string | null, string | null][] = [
    ["total", money(record.total), money(invoice.total)],
    ["currency", record.currency, invoice.currency],
    ["issue date", record.issueDate, invoice.issueDate],
  ];
  const other: [string, string | null, string | null][] = [
    ["supplier number", record.supplierNumber, invoice.supplierNumber],
    ["variable symbol", record.variableSymbol, invoice.variableSymbol],
    ["tax point date", record.taxPointDate, invoice.taxPointDate ?? invoice.issueDate],
    ["due date", record.dueDate, invoice.dueDate],
    ["VAT breakdown", breakdown(record), breakdown(invoice)],
  ];
  if (invoice.rate !== null) {
    other.push(["exchange rate", formatFixed(record.rate, RATE_SCALE), formatFixed(invoice.rate, RATE_SCALE)]);
  }
  const describe = (list: [string, string | null, string | null][]) =>
    list
      .filter(([, kaktus, taxy]) => kaktus !== taxy)
      .map(([label, kaktus, taxy]) => `${label}: Kaktus ${kaktus ?? "empty"}, TAXY ${taxy ?? "empty"}`);
  return { core: describe(core), other: describe(other) };
}

/**
 * Partners that may represent the supplier, deleted ones included. Two IČOs decide alone;
 * when either side has none, the same DIČ or the same normalized name counts.
 */
function supplierPartners(supplier: KaktusSupplier, partners: readonly Partner[]): Partner[] {
  const name = looseKey(supplier.name);
  return partners.filter((partner) =>
    supplier.ico !== null && partner.ico !== null
      ? partner.ico === supplier.ico
      : (supplier.dic !== null && partner.dic === supplier.dic) || looseKey(partner.name) === name,
  );
}
