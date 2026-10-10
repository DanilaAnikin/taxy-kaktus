export const STATUSES = ["written", "already_exists", "rejected", "needs_review", "deferred", "error"] as const;

/**
 * written         written now and verified in FAKPRI.DBF
 * already_exists  already in Kaktus (written earlier or entered by the accountant); not written again
 * rejected        invalid data or refused by Kaktus; fix in TAXY
 * needs_review    conflicts with Kaktus data, or written differently than sent; a human decides
 * deferred        company busy or open in Kaktus, or recovery pending; retry later
 * error           Kaktus or the environment failed; safe to retry
 */
export type Status = (typeof STATUSES)[number];

export interface Notice {
  kod: string;
  zprava: string;
}

export interface DocumentRef {
  id: string | null;
  klientId: number | null;
  kaktusFirma: string | null;
  cisloDokladu: string | null;
}

export interface DocumentResult extends DocumentRef {
  stav: Status;
  kaktusDoklad: string | null;
  kod: string | null;
  zprava: string | null;
  varovani: Notice[];
}

export interface CompanyEvent extends Notice {
  kaktusFirma: string;
}

export interface WriteReport {
  vytvoreno: string;
  souhrn: Record<Status, number>;
  udalosti: CompanyEvent[];
  doklady: DocumentResult[];
}
