import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buildBatch } from "../src/kaktus/batch.js";
import { readBook } from "../src/kaktus/company.js";
import { kaktusProgram, type KaktusProgram } from "../src/kaktus/process.js";
import { loadClients } from "../src/taxy/input.js";
import { isAlive } from "../src/util/processes.js";
import { lockCompany } from "../src/write/lock.js";
import { StateStore } from "../src/write/state.js";
import type { DocumentResult, WriteReport } from "../src/write/types.js";
import { writeKaktus, type WriteOptions } from "../src/write/write.js";
import { CLI, kaktusSetup, withoutProcessList } from "./helpers.js";
import {
  CLIENTS_PATH,
  DOCUMENTS,
  DOCUMENTS_PATH,
  EXPECTED,
  taxyDocument,
  taxyRecords,
  WRITTEN_IDS,
  writePlan,
} from "./taxy.js";

const clients = await loadClients(CLIENTS_PATH);
const BAKERY = DOCUMENTS.filter((document) => document.klientId === 4180);

test("writes the task data: every document gets its expected status", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(statuses(report), EXPECTED);
  assert.deepEqual(report.souhrn, {
    written: 28,
    already_exists: 4,
    rejected: 4,
    needs_review: 1,
    deferred: 0,
    error: 0,
  });

  const byId = documentsById(report);
  assert.equal(
    byId.get("doc_a88ae33500")?.kaktusDoklad,
    byId.get("doc_3c0d1615f6")?.kaktusDoklad,
    "the forwarded copy points to the first one",
  );
  assert.deepEqual(
    byId.get("doc_dc39d3bb48")?.varovani.map((warning) => warning.kod),
    ["ROUNDING"],
  );
  assert.deepEqual(
    byId.get("doc_8c8a7f4e87")?.varovani.map((warning) => warning.kod),
    ["SUPPLIER_WITHOUT_DIC"],
  );
  assert.equal(await batchCount(dir, "0001"), 2, "24 documents for company 0001 need two batches");
  assert.deepEqual(await readdir(join(dir, "state", "journal")), [], "no batch left open");
  assertWrittenOnce(await taxyRecords(options.dataDir), WRITTEN_IDS);
});

test("a second run writes nothing", async () => {
  const { options, fakpri } = await kaktusSetup();
  await writeKaktus(DOCUMENTS, clients, options);
  const before = [await fakpri("0001"), await fakpri("0002")];
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(report.souhrn, {
    written: 0,
    already_exists: 32,
    rejected: 4,
    needs_review: 1,
    deferred: 0,
    error: 0,
  });
  assert.deepEqual([await fakpri("0001"), await fakpri("0002")], before);
});

test("more documents than one batch holds are written in batches of 20, each once", async () => {
  const { dir, options } = await kaktusSetup();
  const many = Array.from({ length: 65 }, (_, index) =>
    taxyDocument("doc_8c35263c12", { id: `doc_many_${index}`, cisloDokladu: `M-${index}` }),
  );
  const report = await writeKaktus(many, clients, options);
  assert.equal(report.souhrn.written, 65);
  assert.equal(await batchCount(dir, "0002"), 4);
  assertWrittenOnce(
    await taxyRecords(options.dataDir),
    many.map((document) => String(document.id)),
  );
  assert.equal((await writeKaktus(many, clients, options)).souhrn.already_exists, 65);
});

test("the same id twice in the input is written once", async () => {
  const { options } = await kaktusSetup();
  const document = taxyDocument("doc_8c35263c12");
  const report = await writeKaktus([document, document], clients, options);
  assert.deepEqual(
    report.doklady.map((result) => `${result.stav} ${result.kod}`),
    ["written null", "rejected DUPLICATE_ID"],
  );
});

test("two connector runs at the same time never write a document twice, even with separate state", async () => {
  for (const separateState of [false, true]) {
    const { dir, options } = await kaktusSetup();
    const reports = await Promise.all([
      writeKaktus(DOCUMENTS, clients, options),
      writeKaktus(DOCUMENTS, clients, separateState ? { ...options, stateDir: join(dir, "other-state") } : options),
    ]);
    const written = reports.flatMap((report) =>
      report.doklady.filter((document) => document.stav === "written").map((document) => document.id),
    );
    assert.deepEqual(written.sort(), [...WRITTEN_IDS].sort());
    assert.ok(reports.some((report) => report.doklady.some((document) => document.kod === "COMPANY_BUSY")));
    assertWrittenOnce(await taxyRecords(options.dataDir), WRITTEN_IDS);
  }
});

test("a company open in Kaktus is deferred; other companies are written", async () => {
  const { dir, options, fakpri } = await kaktusSetup();
  execFileSync(process.execPath, [join(dir, "kaktus.cjs"), "zamknout", "0001"]);
  const before = await fakpri("0001");
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "deferred", "COMPANY_OPEN", "JANA");
  assert.equal(written(report, "0002"), 5);
  assert.deepEqual(await fakpri("0001"), before);
});

test("a lock file Kaktus holds open (unreadable) also means the company is open", async () => {
  const { options } = await kaktusSetup();
  await mkdir(join(options.dataDir, "0001", "FIRMA.LCK"));
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "deferred", "COMPANY_OPEN", "FIRMA.LCK not readable");
});

test("a company locked by another connector run is deferred", async () => {
  const { options } = await kaktusSetup();
  assert.ok(await lockCompany(join(options.dataDir, "0001")));
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "deferred", "COMPANY_BUSY");
  assert.equal(written(report, "0002"), 5);
});

test("a run whose lock was taken over stops before the next batch", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, {
    ...options,
    program: await stub(dir, "steal-lock.cjs", STEAL_LOCK),
  });
  const deferred = report.doklady.filter((document) => document.kod === "COMPANY_BUSY");
  assert.equal(deferred.length, 4, "the second batch of company 0001 is not sent");
  assert.ok(deferred.every((document) => document.zprava?.includes("took over")));
  assert.equal(written(report, "0001"), 19);
});

test("a company whose lock cannot be created fails alone", { skip: cannotDenyAccess() }, async () => {
  const { options } = await kaktusSetup();
  const company = join(options.dataDir, "0001");
  await chmod(company, 0o555);
  try {
    const report = await writeKaktus(DOCUMENTS, clients, options);
    assertAll(report, "0001", "error", "UNEXPECTED_ERROR", "EACCES");
    assert.equal(written(report, "0002"), 5);
  } finally {
    await chmod(company, 0o755);
  }
});

test("documents written before Kaktus crashed are confirmed from the DBF, the rest is retried", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, {
    ...options,
    program: await stub(dir, "crash-once.cjs", CRASH_ONCE),
  });
  assert.deepEqual(statuses(report), EXPECTED);
  const reconciled = report.doklady.filter((document) =>
    document.varovani.some((warning) => warning.kod === "RECONCILED"),
  );
  assert.deepEqual(
    reconciled.map((document) => document.id),
    ["doc_b0e22b273a", "doc_49aa18c650", "doc_70e0c21753"],
  );
  assertWrittenOnce(await taxyRecords(options.dataDir), WRITTEN_IDS);
});

test("a document Kaktus always fails on is isolated; the others are written", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, {
    ...options,
    program: await stub(dir, "poison.cjs", POISON),
  });
  assert.deepEqual(statuses(report), { ...EXPECTED, doc_70e0c21753: "error KAKTUS_IMPORT_FAILED" });
  assert.match(documentsById(report).get("doc_70e0c21753")?.zprava ?? "", /failed on this document alone/);
  assertWrittenOnce(
    await taxyRecords(options.dataDir),
    WRITTEN_IDS.filter((id) => id !== "doc_70e0c21753"),
  );
});

test("data corrupted by the import are restored and the batch is retried in the same run", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, {
    ...options,
    program: await stub(dir, "corrupt-once.cjs", CORRUPT_ONCE),
  });
  assert.deepEqual(statuses(report), EXPECTED);
  assert.deepEqual(
    report.udalosti.map((event) => [event.kaktusFirma, event.kod]),
    [["0001", "RESTORED_FROM_BACKUP"]],
  );
  assertWrittenOnce(await taxyRecords(options.dataDir), WRITTEN_IDS);
});

test("an unusable response is replaced by reading the DBF", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(BAKERY, clients, {
    ...options,
    program: await stub(dir, "garbled.cjs", GARBLED_RESPONSE),
  });
  assert.deepEqual(report.souhrn, {
    written: 5,
    already_exists: 1,
    rejected: 0,
    needs_review: 0,
    deferred: 0,
    error: 0,
  });
  const written = report.doklady.filter((document) => document.stav === "written");
  assert.ok(written.every((document) => document.varovani.some((warning) => warning.kod === "RECONCILED")));
});

test("a hung Kaktus is stopped; after three failed imports the company stops for the run", async () => {
  const { dir, options, fakpri } = await kaktusSetup();
  const before = await fakpri("0001");
  const program = await stub(dir, "hang-0001.cjs", HANG_FOR_0001);
  const report = await writeKaktus(DOCUMENTS, clients, { ...options, program, timeoutMs: 500 });
  assertAll(report, "0001", "error", "KAKTUS_IMPORT_FAILED", "timed out", ["already_exists", "needs_review"]);
  const messages = report.doklady.map((document) => document.zprava ?? "");
  assert.equal(messages.filter((message) => message.includes("failed on this document alone")).length, 2);
  assert.equal(messages.filter((message) => message.includes("3 imports in a row failed")).length, 23);
  assert.equal(await batchCount(dir, "0001"), 3, "one batch of 20, then single documents");
  assert.deepEqual(await fakpri("0001"), before);
  assert.equal(written(report, "0002"), 5);
});

test("Kaktus exit codes map to statuses", async () => {
  const cases: [number, string, string][] = [
    [2, "error", "BATCH_REJECTED"],
    [3, "deferred", "COMPANY_OPEN"],
    [4, "error", "UNKNOWN_COMPANY"],
  ];
  for (const [code, status, kod] of cases) {
    const { dir, options, fakpri } = await kaktusSetup();
    const before = await fakpri("0002");
    const program = await stub(dir, `exit-${code}.cjs`, `console.error("exit ${code}"); process.exit(${code});`);
    const report = await writeKaktus(BAKERY, clients, { ...options, program });
    assertAll(report, "0002", status, kod, `exit ${code}`, ["already_exists"]);
    assert.deepEqual(await fakpri("0002"), before);
  }
});

test("a Kaktus that cannot be started stops each company with an error", async () => {
  const { dir, options } = await kaktusSetup();
  const program = kaktusProgram(join(dir, "missing", "KAKTUS.EXE"));
  const report = await writeKaktus(DOCUMENTS, clients, { ...options, program });
  assertAll(report, "0001", "error", "KAKTUS_NOT_STARTED", "", ["already_exists", "needs_review"]);
  assertAll(report, "0002", "error", "KAKTUS_NOT_STARTED", "", ["already_exists"]);
});

test("a record written differently than sent needs review", async () => {
  const { dir, options } = await kaktusSetup();
  const report = await writeKaktus(BAKERY, clients, {
    ...options,
    program: await stub(dir, "change-text.cjs", CHANGE_FIRST_TEXT),
  });
  const review = report.doklady.filter((document) => document.stav === "needs_review");
  assert.deepEqual(
    review.map((document) => [document.id, document.kod]),
    [["doc_e3fc203569", "VERIFICATION_FAILED"]],
  );
  assert.match(review[0]?.zprava ?? "", /text: Kaktus changed by Kaktus, sent Mouka žitná chlebová/);
  assert.equal(report.souhrn.written, 4);
});

test("records Kaktus wrote without our id need review, and are found by supplier and number later", async () => {
  const { dir, options } = await kaktusSetup();
  const stripped = await writeKaktus(BAKERY, clients, {
    ...options,
    program: await stub(dir, "strip-notes.cjs", STRIP_NOTES),
  });
  assertAll(stripped, "0002", "needs_review", "VERIFICATION_FAILED", "no such record", ["already_exists"]);
  const rerun = await writeKaktus(BAKERY, clients, options);
  assert.equal(rerun.souhrn.already_exists, 6);
  assert.equal((await readBook(join(options.dataDir, "0002"))).invoices.length, 14 + 5);
});

test("a Kaktus writing to other data than we read stops the company", async () => {
  const { options } = await kaktusSetup();
  const elsewhere = await kaktusSetup();
  const report = await writeKaktus(DOCUMENTS, clients, { ...options, program: elsewhere.options.program });
  const mismatch = report.doklady.filter((document) => document.kod === "KAKTUS_DATA_MISMATCH");
  const sent = mismatch.filter((document) => document.stav === "needs_review");
  assert.equal(sent.length, 25, "the first batch of each company may be written in the other data");
  assert.ok(sent.every((document) => document.zprava?.includes("has no record of it")));
  assert.equal(mismatch.filter((document) => document.zprava?.startsWith("not sent:")).length, 5);
  assert.deepEqual(
    report.udalosti.map((event) => [event.kaktusFirma, event.kod]),
    [
      ["0001", "KAKTUS_DATA_MISMATCH"],
      ["0002", "KAKTUS_DATA_MISMATCH"],
    ],
  );
  assert.equal((await taxyRecords(options.dataDir)).size, 0);
});

test("a supplier sent without IČO next to a partner with IČO gets a new partner and a warning", async () => {
  const { options } = await kaktusSetup();
  const report = await writeKaktus([taxyDocument("doc_3c0d1615f6", { dodavatel: { ico: null } })], clients, options);
  assert.deepEqual(
    report.doklady.map((document) => [document.stav, document.varovani.map((warning) => warning.kod)]),
    [["written", ["SUPPLIER_WITHOUT_ICO"]]],
  );
  const { invoices, partners } = await readBook(join(options.dataDir, "0001"));
  const partner = partners.find((candidate) => candidate.id === invoices.at(-1)?.partnerId);
  assert.deepEqual([partner?.id, partner?.ico, partner?.name], [25, null, "Kování Říha, spol. s r.o."]);
});

test("after an interrupted run with intact data, documents already written are recognised by TAXY id", async () => {
  const { dir, options } = await kaktusSetup();
  await interruptedBatch(options);
  const plans = await Promise.all(["doc_b0e22b273a", "doc_49aa18c650"].map((id) => writePlan(taxyDocument(id))));
  await writeFile(
    join(dir, "interrupted.xml"),
    buildBatch(
      "0001",
      plans.map((plan) => plan.invoice),
    ),
  );
  execFileSync(process.execPath, [join(dir, "kaktus.cjs"), "import", join(dir, "interrupted.xml")]);

  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(
    report.udalosti.map((event) => event.kod),
    ["INTERRUPTED_BATCH"],
  );
  const byId = documentsById(report);
  for (const id of ["doc_b0e22b273a", "doc_49aa18c650"]) {
    assert.equal(byId.get(id)?.stav, "already_exists");
    assert.match(byId.get(id)?.zprava ?? "", /matched by TAXY id/);
  }
  assert.equal(report.souhrn.written, 26);
});

test("data corrupted by an interrupted batch are restored from its backup", async () => {
  const { options } = await kaktusSetup();
  const batchId = await interruptedBatch(options, { corrupt: true });

  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(statuses(report), EXPECTED);
  assert.deepEqual(
    report.udalosti.map((event) => [event.kaktusFirma, event.kod]),
    [["0001", "RESTORED_FROM_BACKUP"]],
  );
  assert.equal(
    (await stat(join(options.stateDir, "quarantine", "0001", batchId, "FAKPRI.DBF"))).size,
    0,
    "the corrupted file is kept",
  );
});

test("a table missing after an interrupted batch is restored too", async () => {
  const { options } = await kaktusSetup();
  await interruptedBatch(options);
  await rm(join(options.dataDir, "0001", "FAKPRI.DBF"));
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(statuses(report), EXPECTED);
  assert.deepEqual(
    report.udalosti.map((event) => event.kod),
    ["RESTORED_FROM_BACKUP"],
  );
});

test("an interrupted batch is recovered even when no document goes to its company", async () => {
  const { options } = await kaktusSetup();
  await interruptedBatch(options, { corrupt: true });
  const report = await writeKaktus(BAKERY, clients, options);
  assert.deepEqual(
    report.udalosti.map((event) => [event.kaktusFirma, event.kod]),
    [["0001", "RESTORED_FROM_BACKUP"]],
  );
  assert.equal(report.souhrn.written, 5);
  assert.deepEqual(await new StateStore(options.stateDir).pendingCompanies(), []);
});

test("recovery does not wait for the batch deadline when the batch's import is not running", async () => {
  const { options } = await kaktusSetup();
  // A quick restart, or a clock set back: the deadline has not passed, but nothing imports any more.
  await interruptedBatch(options, { corrupt: true, deadlineInFuture: true });
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assert.deepEqual(
    report.udalosti.map((event) => event.kod),
    ["RESTORED_FROM_BACKUP"],
  );
  assert.deepEqual(statuses(report), EXPECTED);
});

test("an import left running by a crashed run is stopped before the data are recovered", async () => {
  const { options } = await kaktusSetup();
  const batchId = await interruptedBatch(options, { corrupt: true, deadlineInFuture: true });
  const files = new StateStore(options.stateDir).batchFiles("0001", batchId);
  const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", files.batch, files.response], {
    stdio: "ignore",
  });
  try {
    const report = await writeKaktus(DOCUMENTS, clients, options);
    assert.equal(isAlive(leftover.pid!), false);
    assert.deepEqual(
      report.udalosti.map((event) => event.kod),
      ["IMPORT_STOPPED", "RESTORED_FROM_BACKUP"],
    );
    assert.deepEqual(statuses(report), EXPECTED);
  } finally {
    leftover.kill("SIGKILL");
  }
});

test("without the process list, recovery waits for the batch deadline", async () => {
  const { options, fakpri } = await kaktusSetup();
  await interruptedBatch(options, { corrupt: true, deadlineInFuture: true });
  const waiting = await withoutProcessList(() => writeKaktus(DOCUMENTS, clients, options));
  assertAll(waiting, "0001", "deferred", "RECOVERY_POSTPONED", "may still be importing");
  assert.match(waiting.udalosti[0]?.zprava ?? "", /process list unavailable/);
  assert.equal((await fakpri("0001")).length, 0, "nothing restored yet");
  assert.equal(written(waiting, "0002"), 5);

  const passed = await kaktusSetup();
  await interruptedBatch(passed.options, { corrupt: true });
  const after = await withoutProcessList(() => writeKaktus(DOCUMENTS, clients, passed.options));
  assert.deepEqual(
    after.udalosti.map((event) => event.kod),
    ["RESTORED_FROM_BACKUP"],
    "once the deadline has passed",
  );
});

test("an import outliving a killed connector is stopped by the next run; on Windows it dies with the connector", async () => {
  const { dir, options } = await kaktusSetup();
  await writeFile(join(dir, "hang.cjs"), HANG);
  const args = ["--data", options.dataDir, "--kaktus", join(dir, "hang.cjs"), "--state", options.stateDir];
  const inputs = ["--clients", CLIENTS_PATH, "--documents", DOCUMENTS_PATH, "--out", join(dir, "killed.json")];
  const connector = spawn(process.execPath, [CLI, "write", ...args, ...inputs, "--timeout", "600"], {
    stdio: "ignore",
  });
  let importPid = 0;
  try {
    importPid = await pidFrom(join(dir, "hang.pid"));
    connector.kill("SIGKILL");
    await once(connector, "exit");

    const windows = process.platform === "win32";
    for (let waited = 0; waited < 2_000 && isAlive(importPid); waited += 50) await sleep(50);
    assert.equal(isAlive(importPid), !windows, windows ? "a job object ends the import" : "the import outlived it");
    const report = await writeKaktus(DOCUMENTS, clients, options);
    assert.equal(isAlive(importPid), false);
    assert.deepEqual(
      report.udalosti.map((event) => event.kod),
      windows ? ["INTERRUPTED_BATCH"] : ["IMPORT_STOPPED", "INTERRUPTED_BATCH"],
    );
    assert.deepEqual(statuses(report), EXPECTED);
    assertWrittenOnce(await taxyRecords(options.dataDir), WRITTEN_IDS);
  } finally {
    connector.kill("SIGKILL");
    if (importPid && isAlive(importPid)) process.kill(importPid, "SIGKILL");
  }
});

test("restore is refused when the data changed after the batch; nothing is touched", async () => {
  const { options } = await kaktusSetup();
  await interruptedBatch(options, { corrupt: true });
  const fakpri = join(options.dataDir, "0001", "FAKPRI.DBF");
  await utimes(fakpri, new Date(), new Date()); // e.g. the accountant opened the company meanwhile

  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "error", "KAKTUS_DATA_CORRUPTED", "automatic restore refused");
  assert.equal((await stat(fakpri)).size, 0);
  assert.ok(await new StateStore(options.stateDir).readJournal("0001"), "the journal stays for the next run");
  assert.equal(written(report, "0002"), 5);
});

test("a journal of other Kaktus data is never applied", async () => {
  const { options, fakpri } = await kaktusSetup();
  await interruptedBatch(options, { corrupt: true, companyDir: join("/elsewhere", "DATA", "0001") });
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "error", "KAKTUS_STATE_MISMATCH", "belongs to");
  assert.equal((await fakpri("0001")).length, 0);
});

test("corrupted data not explained by our batch are left alone", async () => {
  const { options } = await kaktusSetup();
  const fakpri = join(options.dataDir, "0001", "FAKPRI.DBF");
  await writeFile(fakpri, "");
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "error", "KAKTUS_DATA_CORRUPTED", "manual check needed");
  assert.deepEqual(
    report.udalosti.map((event) => event.kod),
    ["KAKTUS_DATA_CORRUPTED"],
  );
  assert.equal((await stat(fakpri)).size, 0);
});

test("an unreadable journal stops the company with a clear message", async () => {
  const { options } = await kaktusSetup();
  await mkdir(join(options.stateDir, "journal"), { recursive: true });
  await writeFile(join(options.stateDir, "journal", "0001.json"), "");
  const report = await writeKaktus(DOCUMENTS, clients, options);
  assertAll(report, "0001", "error", "UNEXPECTED_ERROR", "manual check needed");
  assert.equal(written(report, "0002"), 5);
});

// Stubs stand in for Kaktus: they get `import <batch> <response>` and may run the simulator next to them.
const PRELUDE = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [command, batch, response] = process.argv.slice(2);
const kaktus = (...args) => spawnSync(process.execPath, [path.join(__dirname, "kaktus.cjs"), ...args]).status ?? 1;
const xml = fs.readFileSync(batch, "latin1");
// Imports a changed batch under the same file name, so IMPORT.LOG names our batch (findings I14).
const importChanged = (changed, out = response) => {
  const dir = path.join(path.dirname(batch), "changed");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, path.basename(batch)), changed, "latin1");
  return kaktus(command, path.join(dir, path.basename(batch)), out);
};
const documents = xml.split("  <FakturaPrijata>");
const withDocuments = (from, to) =>
  documents[0] + documents.slice(from, to).map((document) => "  <FakturaPrijata>" + document.split("</KaktusDavka>")[0]).join("") + "</KaktusDavka>\\r\\n";
`;

// Writes the first three documents, then the power goes out: no response, exit 1. Later runs are normal.
const CRASH_ONCE = `${PRELUDE}
const marker = path.join(__dirname, "crashed-once");
if (fs.existsSync(marker)) process.exit(kaktus(command, batch, response));
fs.writeFileSync(marker, "");
importChanged(withDocuments(1, 4), batch + ".partial.odpoved.xml");
process.exit(1);
`;

// Crashes on the document 8120045566 every time, after writing the documents before it.
const POISON = `${PRELUDE}
const poison = documents.findIndex((document) => document.includes("<CisloDodavatele>8120045566<"));
if (poison < 0) process.exit(kaktus(command, batch, response));
if (poison > 1) importChanged(withDocuments(1, poison), batch + ".partial.odpoved.xml");
process.exit(1);
`;

// Imports normally, then the power goes out while FAKPRI.DBF is rewritten (findings I4). Once.
const CORRUPT_ONCE = `${PRELUDE}
const status = kaktus(command, batch, response);
const marker = path.join(__dirname, "corrupted-once");
if (fs.existsSync(marker)) process.exit(status);
fs.writeFileSync(marker, "");
fs.writeFileSync(path.join(__dirname, "DATA", "0001", "FAKPRI.DBF"), "");
process.exit(1);
`;

// Imports normally, but the response file is damaged.
const GARBLED_RESPONSE = `${PRELUDE}
const status = kaktus(command, batch, response);
fs.writeFileSync(response, "<KaktusOdpoved firma=");
process.exit(status);
`;

// Hangs on batches of company 0001; imports the others normally.
const HANG_FOR_0001 = `${PRELUDE}
if (xml.includes('firma="0001"')) setTimeout(() => {}, 60000);
else process.exit(kaktus(command, batch, response));
`;

// Never ends, like a Kaktus waiting on a dialog; tells its pid.
const HANG = `${PRELUDE}
fs.writeFileSync(path.join(__dirname, "hang.pid"), String(process.pid));
setInterval(() => {}, 1000);
`;

// Imports normally; meanwhile another connector run takes over the lock of company 0001.
const STEAL_LOCK = `${PRELUDE}
const status = kaktus(command, batch, response);
const lock = path.join(__dirname, "DATA", "0001", "TAXY-CONNECTOR.LOCK");
if (fs.existsSync(lock)) fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "OTHER-PC", token: "other" }));
process.exit(status);
`;

// Stores a different text for the first document than the batch says.
const CHANGE_FIRST_TEXT = `${PRELUDE}
process.exit(importChanged(xml.replace(/<Text>[^<]*<\\/Text>/, "<Text>changed by Kaktus</Text>")));
`;

// Writes the documents without our note, so they cannot be found by TAXY id.
const STRIP_NOTES = `${PRELUDE}
process.exit(importChanged(xml.replace(/ *<Poznamka>[^<]*<\\/Poznamka>\\r\\n/g, "")));
`;

/**
 * Leaves a journal and backup as if the connector died during an import into company 0001 two minutes ago;
 * returns the batch id. `corrupt` empties FAKPRI.DBF during that import (power loss, findings I4).
 */
async function interruptedBatch(
  options: WriteOptions,
  { corrupt = false, deadlineInFuture = false, companyDir = "" } = {},
): Promise<string> {
  const dir = join(options.dataDir, "0001");
  const state = new StateStore(options.stateDir);
  const batchId = `crashed-${basename(dirname(options.dataDir))}`; // unique, so no other process matches it
  const entry = await state.beginBatch(
    { batchId, company: "0001", documentIds: ["doc_b0e22b273a", "doc_49aa18c650"] },
    dir,
    60_000,
  );
  const startedAt = Date.now() - 120_000;
  const journal = {
    ...entry,
    companyDir: companyDir || entry.companyDir,
    startedAt: new Date(startedAt).toISOString(),
    deadline: new Date(deadlineInFuture ? Date.now() + 60_000 : startedAt + 65_000).toISOString(),
  };
  await writeFile(join(options.stateDir, "journal", "0001.json"), JSON.stringify(journal));
  if (corrupt) await writeFile(join(dir, "FAKPRI.DBF"), "");
  const duringImport = new Date(startedAt + 1_000);
  for (const name of await readdir(dir)) await utimes(join(dir, name), duringImport, duringImport);
  return batchId;
}

/** The pid a stub writes to `path`, once it is there. */
async function pidFrom(path: string): Promise<number> {
  for (let waited = 0; waited < 30_000; waited += 50) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text) return Number(text);
    await sleep(50);
  }
  throw new Error(`${path} was not written`);
}

async function stub(dir: string, name: string, source: string): Promise<KaktusProgram> {
  await writeFile(join(dir, name), source);
  return kaktusProgram(join(dir, name));
}

async function batchCount(dir: string, company: string): Promise<number> {
  const files = await readdir(join(dir, "state", "batches", company));
  return files.filter((name) => name.endsWith(".xml") && !name.endsWith(".odpoved.xml")).length;
}

function cannotDenyAccess(): boolean {
  return process.platform === "win32" || process.getuid?.() === 0;
}

function written(report: WriteReport, company: string): number {
  return report.doklady.filter((document) => document.kaktusFirma === company && document.stav === "written").length;
}

function statuses(report: WriteReport): Record<string, string> {
  return Object.fromEntries(
    report.doklady.map((document) => [document.id, document.kod ? `${document.stav} ${document.kod}` : document.stav]),
  );
}

function documentsById(report: WriteReport): Map<string | null, DocumentResult> {
  return new Map(report.doklady.map((document) => [document.id, document]));
}

/** Each id has exactly one active record in Kaktus, and no other document of ours is there. */
function assertWrittenOnce(records: Map<string, string[]>, ids: readonly string[]): void {
  assert.deepEqual([...records.keys()].sort(), [...ids].sort());
  for (const [id, numbers] of records) assert.equal(numbers.length, 1, `${id}: ${numbers.join(", ")}`);
}

/** Every document of the company that passed validation ends with the given status. */
function assertAll(
  report: WriteReport,
  company: string,
  status: string,
  kod: string,
  text = "",
  except: string[] = [],
): void {
  const documents = report.doklady.filter(
    (document) => document.kaktusFirma === company && document.stav !== "rejected" && !except.includes(document.stav),
  );
  assert.ok(documents.length > 0, `no documents for ${company}`);
  for (const document of documents) {
    assert.deepEqual([document.stav, document.kod], [status, kod], `${document.id}: ${document.zprava}`);
    assert.ok(document.zprava?.includes(text), `${document.id}: ${document.zprava}`);
  }
}
