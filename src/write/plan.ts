import { LIMITS, noteFor, type KaktusInvoice, type KaktusSupplier } from "../kaktus/invoice.js";
import { isCalendarDate, type Company } from "../kaktus/tables.js";
import { fitText, isStorable } from "../kaktus/text.js";
import { InputError, JsonReader, type TaxyClient } from "../taxy/input.js";
import { formatFixed, MONEY_SCALE, numberToFixed, RATE_SCALE, type Money } from "../util/fixed.js";
import type { DocumentRef, DocumentResult, Notice } from "./types.js";

export interface PlanContext {
  clients: ReadonlyMap<number, TaxyClient>;
  companies: ReadonlyMap<string, Company>;
}

/** A validated document ready to be written to one Kaktus company. */
export interface WritePlan {
  ref: DocumentRef & { id: string; kaktusFirma: string };
  company: Company;
  invoice: KaktusInvoice;
  warnings: Notice[];
}

export type Plan = { kind: "write"; plan: WritePlan } | { kind: "rejected"; result: DocumentResult };

const VAT_RATES: readonly number[] = [0, 12, 21];
/** N12.2 range in haléře. */
const MIN_AMOUNT = -9_999_999_999;
const MAX_AMOUNT = 99_999_999_999;
/** N10.4 range of the exchange rate. */
const MAX_RATE = 999_999_999;
/** Tolerated difference between stated VAT and base × rate before a warning (line-level rounding). */
const VAT_TOLERANCE: Money = 100;
/** Rounding of the total to whole crowns is at most 0.50 (findings: Decisions → Rounding). */
const MAX_ROUNDING: Money = 50;

export function planDocument(raw: unknown, context: PlanContext): Plan {
  const ref: DocumentRef = { id: null, klientId: null, kaktusFirma: null, cisloDokladu: null };
  try {
    return { kind: "write", plan: mapDocument(raw, context, ref) };
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return {
      kind: "rejected",
      result: { ...ref, stav: "rejected", kaktusDoklad: null, kod: error.code, zprava: error.message, varovani: [] },
    };
  }
}

/** Fills `ref` as it goes, so a rejection reports everything known about the document. */
function mapDocument(raw: unknown, context: PlanContext, ref: DocumentRef): WritePlan {
  const doc = JsonReader.object(raw, "");
  const id = doc.string("id");
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
    throw new InputError("INVALID_FIELD", `id "${id}" must be 1-50 letters, digits, "_" or "-"`);
  }
  ref.id = id;
  ref.klientId = doc.integer("klientId");
  ref.cisloDokladu = doc.optionalString("cisloDokladu");

  const type = doc.string("typ");
  if (type !== "faktura_prijata") throw new InputError("UNSUPPORTED_TYPE", `typ "${type}" is not supported`);
  const state = doc.string("stav");
  if (state !== "schvaleno") throw new InputError("NOT_APPROVED", `stav is "${state}"; only "schvaleno" is written`);

  const company = authorize(doc, ref.klientId, context);
  ref.kaktusFirma = company.id;

  const warnings: Notice[] = [];
  const supplierNumber = identifier(doc, "cisloDokladu", LIMITS.supplierNumber);
  const variableSymbol = doc.optionalString("variabilniSymbol");
  if (variableSymbol !== null && !/^\d{1,10}$/.test(variableSymbol)) {
    throw new InputError("INVALID_FIELD", `variabilniSymbol "${variableSymbol}" must be 1-10 digits`);
  }
  const currency = doc.string("mena");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new InputError("INVALID_FIELD", `mena "${currency}" must be a 3-letter currency code`);
  }

  return {
    ref: { ...ref, id, kaktusFirma: company.id },
    company,
    invoice: {
      supplierNumber,
      variableSymbol,
      supplier: mapSupplier(doc.object("dodavatel"), warnings),
      issueDate: requiredDate(doc, "datumVystaveni"),
      taxPointDate: date(doc, "duzp"),
      dueDate: date(doc, "datumSplatnosti"),
      ...mapAmounts(doc, currency, warnings),
      currency,
      rate: mapRate(doc, currency),
      text: fit("popis", doc.optionalString("popis"), LIMITS.text, warnings),
      note: noteFor(id),
    },
    warnings,
  };
}

/** The document may be written only into the company of its client, and only if it is addressed to that company. */
function authorize(doc: JsonReader, klientId: number, context: PlanContext): Company {
  const client = context.clients.get(klientId);
  if (!client) throw new InputError("UNKNOWN_CLIENT", `client ${klientId} is not in klienti.json`);
  const company = context.companies.get(client.kaktusFirma);
  if (!company) {
    throw new InputError(
      "UNKNOWN_COMPANY",
      `Kaktus company ${client.kaktusFirma} of client ${klientId} does not exist`,
    );
  }
  if (company.ico !== client.ico) {
    throw new InputError(
      "CLIENT_COMPANY_MISMATCH",
      `client ${klientId} has IČO ${client.ico}, Kaktus company ${company.id} has ${company.ico}`,
    );
  }
  const buyerIco = doc.object("odberatel").string("ico");
  if (buyerIco !== company.ico) {
    throw new InputError(
      "BUYER_MISMATCH",
      `buyer IČO ${buyerIco} is not company ${company.id} of client ${klientId} (IČO ${company.ico})`,
    );
  }
  return company;
}

function mapSupplier(supplier: JsonReader, warnings: Notice[]): KaktusSupplier {
  const ico = supplier.optionalString("ico");
  if (ico !== null && !isValidIco(ico)) {
    throw new InputError("INVALID_ICO", `dodavatel.ico "${ico}" is not a valid IČO`);
  }
  const dic = supplier.optionalString("dic");
  if (dic !== null && !/^[A-Z]{2}[0-9A-Z]{2,12}$/.test(dic)) {
    throw new InputError("INVALID_FIELD", `dodavatel.dic "${dic}" is not a valid DIČ`);
  }
  const country = supplier.optionalString("stat");
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    throw new InputError("INVALID_FIELD", `dodavatel.stat "${country}" must be a 2-letter country code`);
  }
  const name = fit("dodavatel.nazev", supplier.string("nazev"), LIMITS.name, warnings);
  if (name === null) throw new InputError("MISSING_FIELD", "dodavatel.nazev is missing");
  return {
    name,
    ico,
    dic,
    street: fit("dodavatel.ulice", supplier.optionalString("ulice"), LIMITS.street, warnings),
    city: fit("dodavatel.mesto", supplier.optionalString("mesto"), LIMITS.city, warnings),
    zip: fit("dodavatel.psc", supplier.optionalString("psc"), LIMITS.zip, warnings),
    country,
  };
}

/** VAT lines are summed per rate; a total off by rounding to whole crowns is balanced in Zaklad0 (outside VAT). */
function mapAmounts(doc: JsonReader, currency: string, warnings: Notice[]) {
  const perRate = new Map<number, { base: Money; vat: Money }>();
  for (const [index, raw] of doc.array("rozpisDph").entries()) {
    const line = JsonReader.object(raw, `rozpisDph[${index}]`);
    const rate = line.number("sazba");
    if (!VAT_RATES.includes(rate)) {
      throw new InputError("UNSUPPORTED_VAT_RATE", `${line.name("sazba")} ${rate} % is not 0, 12 or 21`);
    }
    const base = money(line, "zaklad");
    const vat = money(line, "dph");
    if (rate === 0 && vat !== 0) throw new InputError("INVALID_FIELD", `${line.name("dph")} must be 0 at the 0 % rate`);
    const sum = perRate.get(rate) ?? { base: 0, vat: 0 };
    perRate.set(rate, { base: sum.base + base, vat: sum.vat + vat });
  }
  for (const [rate, { base, vat }] of perRate) {
    const expected = Math.round((base * rate) / 100);
    if (Math.abs(vat - expected) > VAT_TOLERANCE) {
      warnings.push({
        kod: "VAT_DEVIATION",
        zprava: `VAT ${show(vat)} at ${rate} % differs from ${show(expected)} (base ${show(base)})`,
      });
    }
  }

  const amounts = {
    base0: perRate.get(0)?.base ?? 0,
    base12: perRate.get(12)?.base ?? 0,
    vat12: perRate.get(12)?.vat ?? 0,
    base21: perRate.get(21)?.base ?? 0,
    vat21: perRate.get(21)?.vat ?? 0,
    total: money(doc, "celkem"),
  };
  const sum = amounts.base0 + amounts.base12 + amounts.vat12 + amounts.base21 + amounts.vat21;
  const difference = amounts.total - sum;
  if (difference !== 0) {
    const isRounding = currency === "CZK" && amounts.total % 100 === 0 && Math.abs(difference) <= MAX_ROUNDING;
    if (!isRounding) {
      throw new InputError("TOTAL_MISMATCH", `celkem ${show(amounts.total)} differs from bases + VAT ${show(sum)}`);
    }
    amounts.base0 += difference;
    warnings.push({
      kod: "ROUNDING",
      zprava: `rounding ${show(difference)} to whole crowns written to Zaklad0 (outside VAT)`,
    });
  }
  for (const [field, value] of Object.entries(amounts)) {
    if (value < MIN_AMOUNT || value > MAX_AMOUNT) {
      throw new InputError("INVALID_FIELD", `${field} ${show(value)} is out of Kaktus range`);
    }
  }
  return amounts;
}

/** CZK has no rate (Kaktus stores 1.0000); any other currency requires one. */
function mapRate(doc: JsonReader, currency: string): number | null {
  const rate = doc.optionalNumber("kurz");
  if (currency === "CZK") {
    if (rate !== null && rate !== 1) throw new InputError("INVALID_FIELD", `kurz ${rate} given for a CZK document`);
    return null;
  }
  if (rate === null) throw new InputError("MISSING_RATE", `kurz is required for currency ${currency}`);
  const scaled = fixed(rate, RATE_SCALE, "kurz");
  if (scaled <= 0 || scaled > MAX_RATE) throw new InputError("INVALID_FIELD", `kurz ${rate} is out of range`);
  return scaled;
}

function money(reader: JsonReader, field: string): Money {
  return fixed(reader.number(field), MONEY_SCALE, reader.name(field));
}

function fixed(value: number, scale: number, name: string): number {
  try {
    return numberToFixed(value, scale);
  } catch {
    throw new InputError("INVALID_FIELD", `${name} ${value} must have at most ${scale} decimals`);
  }
}

function requiredDate(doc: JsonReader, field: string): string {
  return date(doc, field) ?? doc.string(field);
}

function date(doc: JsonReader, field: string): string | null {
  const value = doc.optionalString(field);
  if (value !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value))) {
    throw new InputError("INVALID_FIELD", `${field} "${value}" is not a valid YYYY-MM-DD date`);
  }
  return value;
}

/** Identifiers are never altered: they must fit Kaktus as they are. */
function identifier(doc: JsonReader, field: string, maxLength: number): string {
  const value = doc.string(field);
  if (!isStorable(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InputError("INVALID_FIELD", `${field} "${value}" contains characters Kaktus cannot store`);
  }
  if (value.length > maxLength) {
    throw new InputError("FIELD_TOO_LONG", `${field} "${value}" is longer than ${maxLength} characters`);
  }
  return value;
}

/** Free text is adapted to Kaktus, with a warning for every change. */
function fit(field: string, value: string | null, maxLength: number, warnings: Notice[]): string | null {
  if (value === null) return null;
  const fitted = fitText(value, maxLength);
  if (fitted.transliterated) {
    warnings.push({
      kod: "TRANSLITERATED",
      zprava: `${field}: characters Kaktus cannot store were replaced: "${value}" → "${fitted.value}"`,
    });
  }
  if (fitted.truncated) {
    warnings.push({ kod: "TRUNCATED", zprava: `${field}: shortened to ${maxLength} characters: "${fitted.value}"` });
  }
  return fitted.value === "" ? null : fitted.value;
}

/** Czech IČO: 8 digits with a mod-11 check digit. */
export function isValidIco(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false;
  const sum = [...ico.slice(0, 7)].reduce((total, digit, index) => total + Number(digit) * (8 - index), 0);
  return (11 - (sum % 11)) % 10 === Number(ico[7]);
}

function show(value: Money): string {
  return formatFixed(value, MONEY_SCALE);
}
