import { open, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildBatch, MAX_BATCH_SIZE } from "../kaktus/batch.js";
import { openedBy, readBook, type Book } from "../kaktus/company.js";
import { DbfFormatError } from "../kaktus/dbf.js";
import { documentIdOf } from "../kaktus/invoice.js";
import { runImport, type ImportRun, type KaktusProgram } from "../kaktus/process.js";
import { parseResponse, type ResponseDocument } from "../kaktus/response.js";
import { readCompanies, type Company } from "../kaktus/tables.js";
import type { TaxyClient } from "../taxy/input.js";
import { writeFileAtomic } from "../util/fs.js";
import { lockCompany, type CompanyLock } from "./lock.js";
import { findInBook, linkSupplier, naturalKeys, verifyRecord, type BookMatch, type LinkedSupplier } from "./match.js";
import { planDocument, type WritePlan } from "./plan.js";
import { StateStore, type BatchFiles, type JournalEntry } from "./state.js";
import {
  STATUSES,
  type CompanyEvent,
  type DocumentResult,
  type Notice,
  type Status,
  type WriteReport,
} from "./types.js";

export interface WriteOptions {
  dataDir: string;
  program: KaktusProgram;
  stateDir: string;
  timeoutMs: number;
}

/**
 * Imports in a row without a usable outcome (crash, hang, unreadable response) that stop a company for the run.
 * After a failed import documents go one at a time, so a document Kaktus fails on cannot block the others.
 */
const MAX_FAILED_IMPORTS = 3;
const IMPORT_LOG_TAIL = 64 * 1024;

/** Writes TAXY documents to Kaktus and reports a final status for each of them, in input order. */
export async function writeKaktus(
  documents: readonly unknown[],
  clients: ReadonlyMap<number, TaxyClient>,
  options: WriteOptions,
): Promise<WriteReport> {
  const companies = new Map((await readCompanies(options.dataDir)).map((company) => [company.id, company]));
  const results: DocumentResult[] = [];
  const byCompany = new Map<string, { index: number; plan: WritePlan }[]>();
  const seenIds = new Set<string>();
  documents.forEach((raw, index) => {
    const planned = planDocument(raw, { clients, companies });
    if (planned.kind === "rejected") {
      results[index] = planned.result;
      return;
    }
    const { plan } = planned;
    if (seenIds.has(plan.ref.id)) {
      results[index] = result(
        plan,
        "rejected",
        "DUPLICATE_ID",
        `id ${plan.ref.id} appears more than once in the input`,
      );
      return;
    }
    seenIds.add(plan.ref.id);
    byCompany.set(plan.company.id, [...(byCompany.get(plan.company.id) ?? []), { index, plan }]);
  });

  const state = new StateStore(options.stateDir);
  // An unfinished batch is recovered even if no document goes to its company in this run.
  for (const company of await state.pendingCompanies()) {
    if (companies.has(company) && !byCompany.has(company)) byCompany.set(company, []);
  }
  const events: CompanyEvent[] = [];
  for (const [id, items] of byCompany) {
    const companyResults = await new CompanyRun(
      companies.get(id)!,
      items.map((item) => item.plan),
      options,
      state,
      events,
    ).execute();
    for (const { index, plan } of items) results[index] = companyResults.get(plan.ref.id)!;
  }

  const souhrn = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<Status, number>;
  for (const document of results) souhrn[document.stav] += 1;
  return { vytvoreno: new Date().toISOString(), souhrn, udalosti: events, doklady: results };
}

/** A batch member: the invoice as sent (supplier possibly renamed to a Kaktus partner), its partner and warnings. */
interface Prepared extends LinkedSupplier {
  plan: WritePlan;
}

interface Batch {
  items: Prepared[];
  /** Partners before the batch; a partner the import links that is not among them is a new one. */
  knownPartnerIds: Set<number>;
}

/** How the import ended, before looking at FAKPRI.DBF. */
type ImportOutcome =
  | { kind: "response"; documents: ResponseDocument[] }
  | { kind: "unknown"; reason: string }
  | ({ kind: "final"; stop: boolean; notSent?: Stop } & Stop);

interface Stop {
  status: Status;
  kod: string;
  zprava: string;
}

/** Writes the documents of one company: one connector at a time, batch by batch, each verified in the DBF. */
class CompanyRun {
  private readonly results = new Map<string, DocumentResult>();
  private readonly dir: string;
  private batchCount = 0;
  private failedImports = 0;

  constructor(
    private readonly company: Company,
    private readonly plans: readonly WritePlan[],
    private readonly options: WriteOptions,
    private readonly state: StateStore,
    private readonly events: CompanyEvent[],
  ) {
    this.dir = join(options.dataDir, company.folder);
  }

  async execute(): Promise<Map<string, DocumentResult>> {
    let lock: CompanyLock | null = null;
    try {
      lock = await lockCompany(this.dir);
      if (!lock) {
        const zprava = "another connector run is writing to this company";
        this.finishAll(this.plans, { status: "deferred", kod: "COMPANY_BUSY", zprava });
        return this.results;
      }
      await this.process(lock);
    } catch (error) {
      // Nothing more is attempted; a journal left behind drives the recovery in the next run.
      this.finishAll(this.plans, this.halt("error", "UNEXPECTED_ERROR", (error as Error).message));
    } finally {
      await lock?.release().catch((error: Error) => this.event("LOCK_NOT_RELEASED", error.message));
    }
    return this.results;
  }

  private async process(lock: CompanyLock): Promise<void> {
    const journal = await this.state.readJournal(this.company.id);
    const user = await openedBy(this.dir);
    if (user !== null) {
      const zprava = `company is open in Kaktus (${user})`;
      if (journal) this.event("RECOVERY_POSTPONED", `batch ${journal.batchId}: ${zprava}`);
      return this.finishAll(this.plans, { status: "deferred", kod: "COMPANY_OPEN", zprava });
    }
    if (journal) {
      const recovered = await this.recover(journal, false);
      if (typeof recovered === "object") return this.finishAll(this.plans, recovered);
    }

    let queue: WritePlan[] = [...this.plans];
    while (queue.length > 0) {
      const book = await this.readBookOrNull();
      if (!book) {
        const zprava =
          "company data fail the integrity check and no interrupted batch of ours explains it; manual check needed";
        return this.finishAll(queue, this.halt("error", "KAKTUS_DATA_CORRUPTED", zprava));
      }
      // Documents wait only for a fuller batch or a same-key batch member, so an empty batch means none wait.
      const { batch, waiting } = this.selectBatch(queue, book);
      if (batch.items.length === 0) return;
      if (!(await lock.renew())) {
        const zprava = "another connector run took over the company lock";
        return this.finishAll(queue, { status: "deferred", kod: "COMPANY_BUSY", zprava });
      }
      const { retry, stop } = await this.writeBatch(batch);
      queue = [...retry, ...waiting];
      if (stop) return this.finishAll(queue, stop);
    }
  }

  /** Resolves documents already in the book; picks the next batch, never two copies of the same invoice. */
  private selectBatch(queue: readonly WritePlan[], book: Book): { batch: Batch; waiting: WritePlan[] } {
    const size = this.failedImports > 0 ? 1 : MAX_BATCH_SIZE;
    const items: Prepared[] = [];
    const waiting: WritePlan[] = [];
    const keys = new Set<string>();
    for (const plan of queue) {
      const match = findInBook(plan.ref.id, plan.invoice, book);
      if (match.kind !== "none") {
        this.resolveFromBook(plan, match);
        continue;
      }
      const planKeys = naturalKeys(plan.invoice);
      if (items.length === size || planKeys.some((key) => keys.has(key))) {
        waiting.push(plan);
        continue;
      }
      for (const key of planKeys) keys.add(key);
      const linked = linkSupplier(plan.invoice, book.partners);
      items.push({ ...linked, plan, warnings: [...plan.warnings, ...linked.warnings] });
    }
    return { batch: { items, knownPartnerIds: new Set(book.partners.map((partner) => partner.id)) }, waiting };
  }

  private resolveFromBook(plan: WritePlan, match: Exclude<BookMatch, { kind: "none" }>): void {
    switch (match.kind) {
      case "exists": {
        const zprava = `already in Kaktus as ${match.record.number} (matched by ${match.by})`;
        const differences = match.differences.map((difference) => ({ kod: "DIFFERS_FROM_KAKTUS", zprava: difference }));
        return this.finish(plan, { status: "already_exists", kod: null, zprava }, match.record.number, differences);
      }
      case "conflict": {
        const zprava = `Kaktus has ${match.record.number} (matched by ${match.by}) with different data: ${match.differences.join("; ")}`;
        return this.finish(plan, { status: "needs_review", kod: "CONFLICT_IN_KAKTUS", zprava }, match.record.number);
      }
      case "duplicate": {
        const numbers = match.records.map((record) => record.number);
        const zprava = `Kaktus has this invoice ${numbers.length} times (matched by ${match.by}): ${numbers.join(", ")}`;
        return this.finish(plan, { status: "needs_review", kod: "DUPLICATE_IN_KAKTUS", zprava }, numbers[0]);
      }
      case "deleted": {
        const zprava = `matches ${match.record.number}, deleted in Kaktus ("${match.record.text ?? ""}"); not written again without a human decision`;
        return this.finish(plan, { status: "needs_review", kod: "DELETED_IN_KAKTUS", zprava }, match.record.number);
      }
    }
  }

  private async writeBatch(batch: Batch): Promise<{ retry: WritePlan[]; stop: Stop | null }> {
    const batchId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${this.company.id}-${++this.batchCount}`;
    const files = this.state.batchFiles(this.company.id, batchId);
    await writeFileAtomic(
      files.batch,
      buildBatch(
        this.company.id,
        batch.items.map((item) => item.invoice),
      ),
    );
    const journal = await this.state.beginBatch(
      { batchId, company: this.company.id, documentIds: batch.items.map((item) => item.plan.ref.id) },
      this.dir,
      this.options.timeoutMs,
    );
    return this.settle(batch, await this.runKaktus(files, batch.items.length), journal);
  }

  private async runKaktus(files: BatchFiles, documentCount: number): Promise<ImportOutcome> {
    let run: ImportRun;
    try {
      run = await runImport(this.options.program, files.batch, files.response, this.options.timeoutMs);
    } catch (error) {
      return {
        kind: "final",
        stop: true,
        status: "error",
        kod: "KAKTUS_NOT_STARTED",
        zprava: `Kaktus could not be started: ${(error as Error).message}`,
      };
    }
    const detail = run.output ? `: ${run.output}` : "";
    if (run.timedOut) {
      return { kind: "unknown", reason: `Kaktus timed out after ${this.options.timeoutMs / 1000} s and was stopped` };
    }
    switch (run.exitCode) {
      case 0:
        if (!(await this.importLogged(files.batch))) {
          // Kaktus imported the batch, but into other data than we read and verify (another DATA folder).
          const elsewhere = `Kaktus processed the batch but ${join(this.dir, "IMPORT.LOG")} has no record of it: Kaktus writes to other data than ${resolve(this.dir)}`;
          return {
            kind: "final",
            stop: true,
            ...this.halt("needs_review", "KAKTUS_DATA_MISMATCH", `${elsewhere}; the batch may be written there`),
            notSent: { status: "error", kod: "KAKTUS_DATA_MISMATCH", zprava: `not sent: ${elsewhere}` },
          };
        }
        try {
          return {
            kind: "response",
            documents: parseResponse(await readFile(files.response), this.company.id, documentCount),
          };
        } catch (error) {
          return { kind: "unknown", reason: `unusable import response (${(error as Error).message})` };
        }
      case 2:
        return {
          kind: "final",
          stop: false,
          status: "error",
          kod: "BATCH_REJECTED",
          zprava: `Kaktus could not read the batch${detail}`,
        };
      case 3:
        return {
          kind: "final",
          stop: true,
          status: "deferred",
          kod: "COMPANY_OPEN",
          zprava: `company was opened in Kaktus${detail}`,
        };
      case 4:
        return {
          kind: "final",
          stop: true,
          status: "error",
          kod: "UNKNOWN_COMPANY",
          zprava: `Kaktus does not know company ${this.company.id}${detail}`,
        };
      default:
        return { kind: "unknown", reason: `Kaktus ended with ${run.exitCode ?? run.signal}${detail}` };
    }
  }

  /** Kaktus logs every processed batch in the company's IMPORT.LOG (findings I14). */
  private async importLogged(batchPath: string): Promise<boolean> {
    const handle = await open(join(this.dir, "IMPORT.LOG"), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return false;
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, IMPORT_LOG_TAIL);
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
      return buffer.toString("latin1").includes(`;${basename(batchPath)};`);
    } finally {
      await handle.close();
    }
  }

  /** FAKPRI.DBF decides: a document is written only if its record (found by TAXY id) matches what was sent. */
  private async settle(
    batch: Batch,
    outcome: ImportOutcome,
    journal: JournalEntry,
  ): Promise<{ retry: WritePlan[]; stop: Stop | null }> {
    let book = await this.readBookOrNull();
    if (!book) {
      const recovered = await this.recover(journal, true);
      if (typeof recovered === "object") {
        this.finishAll(
          batch.items.map((item) => item.plan),
          recovered,
        );
        return { retry: [], stop: recovered };
      }
      book = await readBook(this.dir);
      if (recovered === "restored") {
        outcome = { kind: "unknown", reason: "the import corrupted the data, which were restored from the backup" };
      }
    }

    const current = book;
    const undetermined: WritePlan[] = [];
    batch.items.forEach((item, index) => {
      const { plan } = item;
      const record = current.invoices.find(
        (candidate) => !candidate.deleted && documentIdOf(candidate.note) === plan.ref.id,
      );
      const response = outcome.kind === "response" ? outcome.documents[index] : undefined;
      if (record) {
        const mismatches = verifyRecord(record, current.partners, item, batch.knownPartnerIds);
        if (response?.ok === true && response.number !== record.number) {
          mismatches.push(`response says ${response.number}`);
        }
        if (response?.ok === false) mismatches.push(`response says ${response.code}`);
        if (mismatches.length > 0) {
          // Retrying cannot fix a record that is already written: a human must check it in Kaktus.
          const zprava = `written as ${record.number}, but it differs from what was sent: ${mismatches.join("; ")}`;
          return this.finish(
            plan,
            { status: "needs_review", kod: "VERIFICATION_FAILED", zprava },
            record.number,
            item.warnings,
          );
        }
        const reconciled =
          outcome.kind === "unknown"
            ? [{ kod: "RECONCILED", zprava: `${outcome.reason}; write confirmed in FAKPRI.DBF` }]
            : [];
        return this.finish(plan, { status: "written", kod: null, zprava: null }, record.number, [
          ...item.warnings,
          ...reconciled,
        ]);
      }
      if (outcome.kind === "response") {
        if (response?.ok === false) {
          const kod = response.code === "E220" ? "PERIOD_CLOSED" : "KAKTUS_REJECTED";
          return this.finish(
            plan,
            { status: "rejected", kod, zprava: `Kaktus ${response.code}: ${response.message}` },
            null,
            item.warnings,
          );
        }
        const zprava = `Kaktus reported ${response?.ok ? response.number : "success"}, but no such record is in FAKPRI.DBF`;
        return this.finish(plan, { status: "needs_review", kod: "VERIFICATION_FAILED", zprava }, null, item.warnings);
      }
      if (outcome.kind === "final") return this.finish(plan, outcome, null, item.warnings);
      undetermined.push(plan);
    });
    await this.state.endBatch(journal);

    if (outcome.kind === "final") return { retry: [], stop: outcome.stop ? (outcome.notSent ?? outcome) : null };
    if (outcome.kind === "response" || undetermined.length === 0) {
      this.failedImports = 0;
      return { retry: [], stop: null };
    }
    this.failedImports += 1;
    let retry = undetermined;
    if (batch.items.length === 1) {
      const zprava = `Kaktus failed on this document alone (${outcome.reason})`;
      this.finish(
        undetermined[0]!,
        { status: "error", kod: "KAKTUS_IMPORT_FAILED", zprava },
        null,
        batch.items[0]!.warnings,
      );
      retry = [];
    }
    if (this.failedImports >= MAX_FAILED_IMPORTS) {
      const zprava = `${outcome.reason}; ${MAX_FAILED_IMPORTS} imports in a row failed, company stopped for this run`;
      return { retry, stop: { status: "error", kod: "KAKTUS_IMPORT_FAILED", zprava } };
    }
    return { retry, stop: null };
  }

  /**
   * Finishes a batch that did not end normally. Intact data: the documents are reconciled by TAXY id.
   * Corrupted data: guarded restore from the pre-batch backup (docs/findings.md, Decisions → Recovery).
   * Returns why the company cannot continue, or how the batch was finished.
   */
  private async recover(journal: JournalEntry, importEnded: boolean): Promise<Stop | "intact" | "restored"> {
    if (journal.companyDir !== resolve(this.dir)) {
      const zprava = `journal of batch ${journal.batchId} belongs to ${journal.companyDir}, not ${resolve(this.dir)}; connector state is shared by two Kaktus data folders; manual check needed`;
      return this.halt("error", "KAKTUS_STATE_MISMATCH", zprava);
    }
    if (!importEnded && Date.now() <= Date.parse(journal.deadline)) {
      // The run that started this batch died; its import may still be writing until the deadline.
      const zprava = `batch ${journal.batchId} of an earlier run may still be importing until ${journal.deadline}`;
      return this.halt("deferred", "RECOVERY_POSTPONED", zprava);
    }
    const how = importEnded ? "interrupted during the import" : "interrupted in an earlier run";
    if (await this.readBookOrNull()) {
      await this.state.endBatch(journal);
      this.event(
        "INTERRUPTED_BATCH",
        `batch ${journal.batchId} was ${how}; data intact, documents reconciled by TAXY id`,
      );
      return "intact";
    }
    const corrupted = `company data corrupted, batch ${journal.batchId} ${how}`;
    const user = await openedBy(this.dir);
    if (user !== null) {
      return this.halt("deferred", "RECOVERY_POSTPONED", `${corrupted}; company is open in Kaktus (${user})`);
    }
    const blockers = await this.state.restoreBlockers(journal, this.dir);
    if (blockers.length > 0) {
      const zprava = `${corrupted}; automatic restore refused: ${blockers.join("; ")}; backup: ${journal.backupDir}`;
      return this.halt("error", "KAKTUS_DATA_CORRUPTED", zprava);
    }
    const quarantine = await this.state.restore(journal, this.dir);
    if (!(await this.readBookOrNull())) {
      const zprava = `${corrupted}; the restored backup is not readable; corrupted files: ${quarantine}`;
      return this.halt("error", "KAKTUS_DATA_CORRUPTED", zprava);
    }
    await this.state.endBatch(journal);
    this.event(
      "RESTORED_FROM_BACKUP",
      `${corrupted}; restored from the pre-batch backup, corrupted files kept in ${quarantine}`,
    );
    return "restored";
  }

  private async readBookOrNull(): Promise<Book | null> {
    try {
      return await readBook(this.dir);
    } catch (error) {
      if (error instanceof DbfFormatError) return null;
      throw error;
    }
  }

  private finish(
    plan: WritePlan,
    outcome: { status: Status; kod: string | null; zprava: string | null },
    number: string | null = null,
    warnings: Notice[] = [],
  ): void {
    this.results.set(plan.ref.id, result(plan, outcome.status, outcome.kod, outcome.zprava, number, warnings));
  }

  /** Gives every still unfinished document the same outcome. */
  private finishAll(plans: readonly WritePlan[], outcome: Stop): void {
    for (const plan of plans) if (!this.results.has(plan.ref.id)) this.finish(plan, outcome, null, plan.warnings);
  }

  /** A company-level problem: recorded as an event, so it is visible even when no document is affected. */
  private halt(status: Status, kod: string, zprava: string): Stop {
    this.event(kod, zprava);
    return { status, kod, zprava };
  }

  private event(kod: string, zprava: string): void {
    this.events.push({ kaktusFirma: this.company.id, kod, zprava });
  }
}

function result(
  plan: WritePlan,
  status: Status,
  kod: string | null,
  zprava: string | null,
  number: string | null = null,
  warnings: Notice[] = [],
): DocumentResult {
  return { ...plan.ref, stav: status, kaktusDoklad: number, kod, zprava, varovani: warnings };
}
