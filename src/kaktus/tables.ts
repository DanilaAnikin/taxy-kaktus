import { join } from "node:path";
import { DbfFormatError, readDbf, type DbfFieldType, type DbfRecord, type DbfTable } from "./dbf.js";
import { MONEY_SCALE, parseFixed, RATE_SCALE, type Money, type Rate } from "../util/fixed.js";

export interface Company {
  id: string;
  name: string;
  ico: string | null;
  dic: string | null;
  folder: string;
  vatPayer: boolean | null;
}

export interface Partner {
  id: number;
  deleted: boolean;
  name: string;
  ico: string | null;
  dic: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  bankAccount: string | null;
  note: string | null;
}

export interface ReceivedInvoice {
  id: number;
  deleted: boolean;
  number: string;
  supplierNumber: string | null;
  variableSymbol: string | null;
  partnerId: number | null;
  issueDate: string | null;
  taxPointDate: string | null;
  dueDate: string | null;
  paidDate: string | null;
  base0: Money;
  base12: Money;
  vat12: Money;
  base21: Money;
  vat21: Money;
  total: Money;
  currency: string | null;
  rate: Rate;
  text: string | null;
  note: string | null;
}

const COMPANY_FIELDS = { ID: "C", NAZEV: "C", ICO: "C", DIC: "C", SLOZKA: "C", PLATCE: "L" } as const;
const PARTNER_FIELDS = {
  ID: "N",
  NAZEV: "C",
  ICO: "N",
  DIC: "C",
  ULICE: "C",
  MESTO: "C",
  PSC: "C",
  STAT: "C",
  UCET: "C",
  POZN: "C",
} as const;
const INVOICE_FIELDS = {
  ID: "N",
  DOKLAD: "C",
  CISLODOD: "C",
  VS: "C",
  PARTNER: "N",
  DATVYST: "D",
  DATZDAN: "D",
  DATSPL: "D",
  DATUHR: "D",
  ZAKL0: "N",
  ZAKL12: "N",
  DPH12: "N",
  ZAKL21: "N",
  DPH21: "N",
  CELKEM: "N",
  MENA: "C",
  KURZ: "N",
  TEXT: "C",
  POZN: "C",
} as const;

export async function readCompanies(dataDir: string): Promise<Company[]> {
  const path = join(dataDir, "FIRMY.DBF");
  const companies = await readTable(path, COMPANY_FIELDS, (r) => {
    if (r.deleted) return null;
    const id = r.required("ID");
    if (!/^\d{4}$/.test(id)) r.fail("ID", `company id "${id}" is not four digits`);
    const folder = r.required("SLOZKA");
    if (!/^[A-Za-z0-9_-]+$/.test(folder)) r.fail("SLOZKA", `unsafe folder name "${folder}"`);
    return {
      id,
      name: r.required("NAZEV"),
      ico: r.ico("ICO"),
      dic: r.text("DIC"),
      folder,
      vatPayer: r.logical("PLATCE"),
    };
  });
  const ids = companies.map((company) => company.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined) throw new DbfFormatError(`${path}: company id ${twice} appears twice`);
  return companies;
}

export function readPartners(companyDir: string): Promise<Partner[]> {
  return readTable(join(companyDir, "ADRESAR.DBF"), PARTNER_FIELDS, (r) => ({
    id: r.requiredInteger("ID"),
    deleted: r.deleted,
    name: r.required("NAZEV"),
    ico: r.ico("ICO"),
    dic: r.text("DIC"),
    street: r.text("ULICE"),
    city: r.text("MESTO"),
    zip: r.text("PSC"),
    country: r.text("STAT"),
    bankAccount: r.text("UCET"),
    note: r.text("POZN"),
  }));
}

export function readReceivedInvoices(companyDir: string): Promise<ReceivedInvoice[]> {
  return readTable(join(companyDir, "FAKPRI.DBF"), INVOICE_FIELDS, (r) => ({
    id: r.requiredInteger("ID"),
    deleted: r.deleted,
    number: r.required("DOKLAD"),
    supplierNumber: r.text("CISLODOD"),
    variableSymbol: r.text("VS"),
    partnerId: r.integer("PARTNER"),
    issueDate: r.date("DATVYST"),
    taxPointDate: r.date("DATZDAN"),
    dueDate: r.date("DATSPL"),
    paidDate: r.date("DATUHR"),
    base0: r.fixed("ZAKL0", MONEY_SCALE),
    base12: r.fixed("ZAKL12", MONEY_SCALE),
    vat12: r.fixed("DPH12", MONEY_SCALE),
    base21: r.fixed("ZAKL21", MONEY_SCALE),
    vat21: r.fixed("DPH21", MONEY_SCALE),
    total: r.fixed("CELKEM", MONEY_SCALE),
    currency: r.text("MENA"),
    rate: r.fixed("KURZ", RATE_SCALE),
    text: r.text("TEXT"),
    note: r.text("POZN"),
  }));
}

/**
 * Reads a table and maps each record (`null` skips it). Fails fast if a Kaktus version
 * changed the layout we rely on.
 */
function readTable<T>(
  path: string,
  expected: Readonly<Record<string, DbfFieldType>>,
  map: (row: Row) => T | null,
): Promise<T[]> {
  return readDbf(path, (table) => {
    for (const [name, type] of Object.entries(expected)) {
      const field = table.fields.find((candidate) => candidate.name === name);
      if (!field) throw new DbfFormatError(`${table.source}: missing field ${name}`);
      if (field.type !== type) {
        throw new DbfFormatError(`${table.source}: field ${name} is ${field.type}, expected ${type}`);
      }
    }
    return table.records.flatMap((record, index) => {
      const mapped = map(new Row(table, record, index));
      return mapped === null ? [] : [mapped];
    });
  });
}

/** Typed access to one record; every malformed value throws with the file, record and field. */
class Row {
  constructor(
    private readonly table: DbfTable,
    private readonly record: DbfRecord,
    private readonly index: number,
  ) {}

  get deleted(): boolean {
    return this.record.deleted;
  }

  fail(field: string, message: string): never {
    throw new DbfFormatError(`${this.table.source}: record ${this.index + 1}, ${field}: ${message}`);
  }

  text(field: string): string | null {
    const value = (this.record.values.get(field) ?? "").trim();
    return value === "" ? null : value;
  }

  required(field: string): string {
    return this.text(field) ?? this.fail(field, "empty");
  }

  integer(field: string): number | null {
    const value = this.text(field);
    if (value === null) return null;
    if (!/^-?\d+$/.test(value)) this.fail(field, `not an integer "${value}"`);
    return Number(value);
  }

  requiredInteger(field: string): number {
    return this.integer(field) ?? this.fail(field, "empty");
  }

  fixed(field: string, scale: number): number {
    try {
      return parseFixed(this.record.values.get(field) ?? "", scale);
    } catch (error) {
      return this.fail(field, (error as Error).message);
    }
  }

  /** IČO is 8 digits; ADRESAR stores it as a number, which drops leading zeros (findings D2). */
  ico(field: string): string | null {
    const value = this.text(field);
    if (value === null) return null;
    if (!/^\d{1,8}$/.test(value)) this.fail(field, `invalid IČO "${value}"`);
    return value.padStart(8, "0");
  }

  /** DBF date YYYYMMDD → YYYY-MM-DD. */
  date(field: string): string | null {
    const value = this.text(field);
    if (value === null) return null;
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    const iso = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
    if (!iso || !isCalendarDate(iso)) this.fail(field, `invalid date "${value}"`);
    return iso;
  }

  logical(field: string): boolean | null {
    const value = this.text(field);
    if (value === null || value === "?") return null;
    if (/^[TtYy]$/.test(value)) return true;
    if (/^[FfNn]$/.test(value)) return false;
    return this.fail(field, `invalid logical "${value}"`);
  }
}

export function isCalendarDate(iso: string): boolean {
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso);
}
