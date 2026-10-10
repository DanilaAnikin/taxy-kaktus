import { join } from "node:path";
import { readBook } from "./kaktus/company.js";
import { readCompanies, type Company, type Partner, type ReceivedInvoice } from "./kaktus/tables.js";
import { fixedToNumber, MONEY_SCALE, RATE_SCALE, type Money } from "./util/fixed.js";

// Output reuses the TAXY document schema (Czech keys, as in taxy/doklady-k-zapisu.json),
// so invoices read from Kaktus are directly comparable with documents TAXY sends for writing.

export interface ReadOutput {
  vytvoreno: string;
  firmy: CompanyOutput[];
}

export interface CompanyOutput {
  kaktusFirma: string;
  nazev: string;
  ico: string | null;
  dic: string | null;
  platceDph: boolean | null;
  dodavatele: SupplierOutput[];
  fakturyPrijate: InvoiceOutput[];
  varovani: Warning[];
  chyba?: string;
}

export interface SupplierOutput extends Address {
  kaktusId: number;
  ucet: string | null;
  poznamka: string | null;
}

export interface Address {
  nazev: string;
  ico: string | null;
  dic: string | null;
  ulice: string | null;
  mesto: string | null;
  psc: string | null;
  stat: string | null;
}

export interface InvoiceOutput {
  typ: "faktura_prijata";
  cisloDokladu: string | null;
  variabilniSymbol: string | null;
  dodavatel: Address | null;
  odberatel: { nazev: string; ico: string | null };
  datumVystaveni: string | null;
  duzp: string | null;
  datumSplatnosti: string | null;
  rozpisDph: { sazba: number; zaklad: number; dph: number }[];
  celkem: number;
  mena: string | null;
  kurz: number | null;
  popis: string | null;
  kaktus: { id: number; doklad: string; partnerId: number | null; datumUhrady: string | null; poznamka: string | null };
}

export interface Warning {
  kod: "DUPLICATE_SUPPLIER_ICO" | "MISSING_SUPPLIER" | "DELETED_SUPPLIER" | "TOTAL_MISMATCH";
  zprava: string;
}

/** Reads all companies; a broken company is reported in `chyba` without stopping the others. */
export async function readKaktus(dataDir: string, now = new Date()): Promise<ReadOutput> {
  const companies = await readCompanies(dataDir);
  const firmy: CompanyOutput[] = [];
  for (const company of companies) {
    try {
      const { invoices, partners } = await readBook(join(dataDir, company.folder));
      firmy.push(toCompanyOutput(company, partners, invoices));
    } catch (error) {
      firmy.push({
        ...companyHeader(company),
        dodavatele: [],
        fakturyPrijate: [],
        varovani: [],
        chyba: (error as Error).message,
      });
    }
  }
  return { vytvoreno: now.toISOString(), firmy };
}

function toCompanyOutput(company: Company, partners: Partner[], invoices: ReceivedInvoice[]): CompanyOutput {
  const varovani: Warning[] = [];
  const active = partners.filter((partner) => !partner.deleted);
  const byId = new Map(partners.map((partner) => [partner.id, partner]));

  const icoGroups = new Map<string, number[]>();
  for (const partner of active) {
    if (partner.ico) icoGroups.set(partner.ico, [...(icoGroups.get(partner.ico) ?? []), partner.id]);
  }
  for (const [ico, ids] of icoGroups) {
    if (ids.length > 1) {
      varovani.push({ kod: "DUPLICATE_SUPPLIER_ICO", zprava: `Partners ${ids.join(", ")} share IČO ${ico}` });
    }
  }

  const fakturyPrijate = invoices
    .filter((invoice) => !invoice.deleted)
    .map((invoice) => {
      const partner = invoice.partnerId === null ? undefined : byId.get(invoice.partnerId);
      if (!partner) {
        const reference =
          invoice.partnerId === null ? "has no partner" : `references missing partner ${invoice.partnerId}`;
        varovani.push({ kod: "MISSING_SUPPLIER", zprava: `Invoice ${invoice.number} ${reference}` });
      } else if (partner.deleted) {
        varovani.push({
          kod: "DELETED_SUPPLIER",
          zprava: `Invoice ${invoice.number} references deleted partner ${partner.id}`,
        });
      }
      const sum = invoice.base0 + invoice.base12 + invoice.vat12 + invoice.base21 + invoice.vat21;
      if (sum !== invoice.total) {
        varovani.push({
          kod: "TOTAL_MISMATCH",
          zprava: `Invoice ${invoice.number}: total ${money(invoice.total)} != bases + VAT ${money(sum)}`,
        });
      }
      return toInvoiceOutput(company, invoice, partner);
    });

  return {
    ...companyHeader(company),
    dodavatele: active.map((partner) => ({
      kaktusId: partner.id,
      ...toAddress(partner),
      ucet: partner.bankAccount,
      poznamka: partner.note,
    })),
    fakturyPrijate,
    varovani,
  };
}

function toInvoiceOutput(company: Company, invoice: ReceivedInvoice, partner: Partner | undefined): InvoiceOutput {
  const rates: [number, Money, Money][] = [
    [21, invoice.base21, invoice.vat21],
    [12, invoice.base12, invoice.vat12],
    [0, invoice.base0, 0],
  ];
  return {
    typ: "faktura_prijata",
    cisloDokladu: invoice.supplierNumber,
    variabilniSymbol: invoice.variableSymbol,
    dodavatel: partner ? toAddress(partner) : null,
    odberatel: { nazev: company.name, ico: company.ico },
    datumVystaveni: invoice.issueDate,
    duzp: invoice.taxPointDate,
    datumSplatnosti: invoice.dueDate,
    rozpisDph: rates
      .filter(([, base, vat]) => base !== 0 || vat !== 0)
      .map(([sazba, base, vat]) => ({ sazba, zaklad: money(base), dph: money(vat) })),
    celkem: money(invoice.total),
    mena: invoice.currency,
    kurz: invoice.currency === null || invoice.currency === "CZK" ? null : fixedToNumber(invoice.rate, RATE_SCALE),
    popis: invoice.text,
    kaktus: {
      id: invoice.id,
      doklad: invoice.number,
      partnerId: invoice.partnerId,
      datumUhrady: invoice.paidDate,
      poznamka: invoice.note,
    },
  };
}

function companyHeader(company: Company) {
  return {
    kaktusFirma: company.id,
    nazev: company.name,
    ico: company.ico,
    dic: company.dic,
    platceDph: company.vatPayer,
  };
}

function toAddress(partner: Partner): Address {
  return {
    nazev: partner.name,
    ico: partner.ico,
    dic: partner.dic,
    ulice: partner.street,
    mesto: partner.city,
    psc: partner.zip,
    stat: partner.country,
  };
}

function money(value: Money): number {
  return fixedToNumber(value, MONEY_SCALE);
}
