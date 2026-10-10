import type { Money, Rate } from "../util/fixed.js";

/** Kaktus field sizes (findings D5); longer values are silently cut by Kaktus (I10). */
export const LIMITS = {
  name: 40,
  street: 40,
  city: 30,
  zip: 6,
  supplierNumber: 20,
  variableSymbol: 10,
  text: 50,
  note: 60,
} as const;

export interface KaktusSupplier {
  name: string;
  ico: string | null;
  dic: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
}

/** A received invoice exactly as sent in a batch and expected back in FAKPRI.DBF. */
export interface KaktusInvoice {
  supplierNumber: string;
  variableSymbol: string | null;
  supplier: KaktusSupplier;
  issueDate: string;
  taxPointDate: string | null;
  dueDate: string | null;
  base0: Money;
  base12: Money;
  vat12: Money;
  base21: Money;
  vat21: Money;
  total: Money;
  currency: string;
  /** null for CZK; Kaktus then stores 1.0000. */
  rate: Rate | null;
  text: string | null;
  /** "TAXY <document id>": our idempotency key inside Kaktus. */
  note: string;
}

const NOTE_PREFIX = "TAXY ";

export function noteFor(documentId: string): string {
  return `${NOTE_PREFIX}${documentId}`;
}

/** The TAXY document id stored in a FAKPRI note, or null. */
export function documentIdOf(note: string | null): string | null {
  return /(?:^|\s)TAXY (\S+)/.exec(note ?? "")?.[1] ?? null;
}
