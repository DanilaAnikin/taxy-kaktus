import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDbf } from "../kaktus/dbf.js";
import { copyFileDurable, renameRetrying, syncDirectory, writeJsonAtomic } from "../util/fs.js";
import { LOCK_FILE } from "./lock.js";

/** An import in progress. If it is still present at the next run, the import was interrupted. */
export interface JournalEntry {
  batchId: string;
  company: string;
  /** Absolute company folder; the journal and its backup belong to these data only. */
  companyDir: string;
  documentIds: string[];
  /** When the import was started, after the backup. */
  startedAt: string;
  /**
   * The import ends by then (start + import timeout + margin). Recovery waits for it only when it cannot list
   * processes; a restore needs the data unchanged since.
   */
  deadline: string;
  backupDir: string;
  /** File name → SHA-256 of the backup copy. */
  checksums: Record<string, string>;
}

export interface BatchFiles {
  batch: string;
  response: string;
}

const DEADLINE_MARGIN_MS = 5_000;
/** Files the import writes (findings I4, I14). Any other company file must be unchanged for a restore. */
const IMPORT_TARGETS = new Set(["FAKPRI.DBF", "ADRESAR.DBF", "IMPORT.LOG"]);
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/** Connector-owned files: journal, pre-batch backups, batches, quarantine. Paths are absolute, as Kaktus gets them. */
export class StateStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  batchFiles(company: string, batchId: string): BatchFiles {
    const dir = join(this.root, "batches", company);
    return { batch: join(dir, `${batchId}.xml`), response: join(dir, `${batchId}.odpoved.xml`) };
  }

  /** Companies with an unfinished batch. */
  async pendingCompanies(): Promise<string[]> {
    const names = await readdir(join(this.root, "journal")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  }

  async readJournal(company: string): Promise<JournalEntry | null> {
    const path = this.journalPath(company);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(text) as JournalEntry;
    } catch (error) {
      throw new Error(`journal ${path} is unreadable (${(error as Error).message}); manual check needed`);
    }
  }

  /**
   * Backs up the whole company folder, then records the batch in the journal; both are on disk before
   * the import starts. The deadline counts from now, after the backup.
   */
  async beginBatch(
    entry: Pick<JournalEntry, "batchId" | "company" | "documentIds">,
    companyDir: string,
    importTimeoutMs: number,
  ): Promise<JournalEntry> {
    const backupDir = join(this.root, "backups", entry.company, entry.batchId);
    await mkdir(backupDir, { recursive: true });
    const checksums: Record<string, string> = {};
    for (const name of await companyFiles(companyDir)) {
      await copyFileDurable(join(companyDir, name), join(backupDir, name));
      checksums[name] = await sha256(join(backupDir, name));
    }
    await syncDirectory(backupDir);
    const startedAt = Date.now();
    const journal: JournalEntry = {
      ...entry,
      companyDir: resolve(companyDir),
      startedAt: new Date(startedAt).toISOString(),
      deadline: new Date(startedAt + importTimeoutMs + DEADLINE_MARGIN_MS).toISOString(),
      backupDir,
      checksums,
    };
    await writeJsonAtomic(this.journalPath(entry.company), journal);
    return journal;
  }

  /** The batch is settled and the data verified: drop the journal and the backup. */
  async endBatch(entry: JournalEntry): Promise<void> {
    await rm(this.journalPath(entry.company), RM_OPTIONS);
    await rm(entry.backupDir, RM_OPTIONS);
  }

  /**
   * Reasons why the backup must not be restored automatically (empty = safe): the backup belongs to other
   * data, is incomplete or damaged, or someone else worked with the data (a file changed after the batch
   * deadline, or a file the import does not write differs from the backup).
   */
  async restoreBlockers(entry: JournalEntry, companyDir: string): Promise<string[]> {
    if (entry.companyDir !== resolve(companyDir)) return [`the backup is of ${entry.companyDir}`];
    const blockers: string[] = [];
    for (const [name, checksum] of Object.entries(entry.checksums)) {
      const backup = join(entry.backupDir, name);
      const backupChecksum = await sha256(backup).catch(() => null);
      if (backupChecksum === null) blockers.push(`backup of ${name} is missing`);
      else if (backupChecksum !== checksum) blockers.push(`backup of ${name} has a wrong checksum`);
      else if (/\.dbf$/i.test(name) && !isValidDbf(await readFile(backup), name)) {
        blockers.push(`backup of ${name} is not a valid DBF`);
      }
      if (!IMPORT_TARGETS.has(name.toUpperCase())) {
        const current = await sha256(join(companyDir, name)).catch(() => null);
        if (current !== checksum) blockers.push(`${name} changed since the backup`);
      }
    }
    const deadline = Date.parse(entry.deadline);
    for (const name of await companyFiles(companyDir)) {
      const { mtimeMs } = await stat(join(companyDir, name));
      if (mtimeMs > deadline) blockers.push(`${name} changed after the batch (${new Date(mtimeMs).toISOString()})`);
    }
    return blockers;
  }

  /** Moves the current files to quarantine and puts the backup back (temp file + rename). Returns the quarantine dir. */
  async restore(entry: JournalEntry, companyDir: string): Promise<string> {
    const quarantine = join(this.root, "quarantine", entry.company, entry.batchId);
    await mkdir(quarantine, { recursive: true });
    for (const name of await companyFiles(companyDir)) {
      await copyFileDurable(join(companyDir, name), join(quarantine, name));
    }
    for (const name of Object.keys(entry.checksums)) {
      const temp = join(companyDir, `${name}.restore`);
      await copyFileDurable(join(entry.backupDir, name), temp);
      await renameRetrying(temp, join(companyDir, name));
    }
    await syncDirectory(companyDir);
    return quarantine;
  }

  private journalPath(company: string): string {
    return join(this.root, "journal", `${company}.json`);
  }
}

/** Data files of a company folder; the lock files of the accountant (FIRMA.LCK) and of the connector are not data. */
async function companyFiles(companyDir: string): Promise<string[]> {
  const locks = new Set(["FIRMA.LCK", LOCK_FILE.toUpperCase()]);
  const entries = await readdir(companyDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !locks.has(entry.name.toUpperCase())).map((entry) => entry.name);
}

function isValidDbf(bytes: Buffer, name: string): boolean {
  try {
    parseDbf(bytes, name);
    return true;
  } catch {
    return false;
  }
}

/** Streams the file, so a large file in the company folder does not have to fit in memory. */
function sha256(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")));
  });
}
