import { formatFixed, MONEY_SCALE, RATE_SCALE } from "../util/fixed.js";
import { encode } from "./encoding.js";
import type { KaktusInvoice } from "./invoice.js";
import { isStorable } from "./text.js";

/** Kaktus processes at most 20 documents per batch and silently ignores the rest (findings I3). */
export const MAX_BATCH_SIZE = 20;

/** Builds an import batch. Always Windows-1250: Kaktus ignores the XML encoding declaration (findings I1). */
export function buildBatch(company: string, invoices: readonly KaktusInvoice[]): Buffer {
  if (invoices.length === 0 || invoices.length > MAX_BATCH_SIZE) {
    throw new RangeError(`a batch must contain 1 to ${MAX_BATCH_SIZE} documents, got ${invoices.length}`);
  }
  if (!/^\d{4}$/.test(company)) throw new RangeError(`invalid company id "${company}"`);
  const lines = [
    '<?xml version="1.0" encoding="windows-1250"?>',
    `<KaktusDavka verze="3.2" firma="${company}">`,
    ...invoices.flatMap(invoiceLines),
    "</KaktusDavka>",
    "",
  ];
  return encode(lines.join("\r\n"), "cp1250");
}

function invoiceLines(invoice: KaktusInvoice): string[] {
  const { supplier } = invoice;
  const money = (value: number) => formatFixed(value, MONEY_SCALE);
  const lines = [
    "  <FakturaPrijata>",
    element(4, "CisloDodavatele", invoice.supplierNumber),
    element(4, "VarSymbol", invoice.variableSymbol),
    "    <Dodavatel>",
    element(6, "Nazev", supplier.name),
    element(6, "ICO", supplier.ico),
    element(6, "DIC", supplier.dic),
    element(6, "Ulice", supplier.street),
    element(6, "Mesto", supplier.city),
    element(6, "PSC", supplier.zip),
    element(6, "Stat", supplier.country),
    "    </Dodavatel>",
    element(4, "DatumVystaveni", invoice.issueDate),
    element(4, "DatumZdanPlneni", invoice.taxPointDate),
    element(4, "DatumSplatnosti", invoice.dueDate),
    element(4, "Zaklad0", money(invoice.base0)),
    element(4, "Zaklad12", money(invoice.base12)),
    element(4, "DPH12", money(invoice.vat12)),
    element(4, "Zaklad21", money(invoice.base21)),
    element(4, "DPH21", money(invoice.vat21)),
    element(4, "Celkem", money(invoice.total)),
    element(4, "Mena", invoice.currency),
    element(4, "Kurz", invoice.rate === null ? null : formatFixed(invoice.rate, RATE_SCALE)),
    element(4, "Text", invoice.text),
    element(4, "Poznamka", invoice.note),
    "  </FakturaPrijata>",
  ];
  return lines.filter((line): line is string => line !== null);
}

/**
 * Omits empty optional values; Kaktus treats a present but empty required element as missing (findings I8).
 * Refuses text Kaktus would store as "?" (findings I1); callers fit free text beforehand.
 */
function element(indent: number, name: string, value: string | null): string | null {
  if (value === null) return null;
  if (!isStorable(value)) throw new RangeError(`${name} "${value}" contains characters Kaktus cannot store`);
  return `${" ".repeat(indent)}<${name}>${escapeText(value)}</${name}>`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
