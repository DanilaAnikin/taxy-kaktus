import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOCK_FILE, lockCompany } from "../src/write/lock.js";
import { StateStore } from "../src/write/state.js";
import { kaktusCopy } from "./helpers.js";

const stateDir = () => mkdtemp(join(tmpdir(), "kaktus-state-"));
const BATCH = { batchId: "b1", company: "0001", documentIds: ["doc_1"] };

test("a journal records the batch, its data folder and a deadline counted after the backup", async () => {
  const companyDir = join(await kaktusCopy(), "DATA", "0001");
  const root = await stateDir();
  const state = new StateStore(root);
  assert.deepEqual(await state.pendingCompanies(), []);
  const before = Date.now();
  const entry = await state.beginBatch(BATCH, companyDir, 60_000);
  assert.deepEqual(await state.pendingCompanies(), ["0001"]);
  assert.deepEqual(await state.readJournal("0001"), entry);
  assert.equal(entry.companyDir, companyDir);
  assert.ok(Date.parse(entry.startedAt) >= before);
  assert.equal(Date.parse(entry.deadline) - Date.parse(entry.startedAt), 65_000);

  await state.endBatch(entry);
  assert.deepEqual(await state.pendingCompanies(), []);
  assert.deepEqual(await readdir(join(root, "backups", "0001")), []);
});

test("an unreadable journal stops with a clear message", async () => {
  const root = await stateDir();
  await new StateStore(root).beginBatch(BATCH, join(await kaktusCopy(), "DATA", "0001"), 60_000);
  await writeFile(join(root, "journal", "0001.json"), '{"batchId": "b1", "comp');
  await assert.rejects(new StateStore(root).readJournal("0001"), /journal .*0001\.json is unreadable .*manual check/);
});

test("restore is allowed only from an intact backup of untouched data", async () => {
  const companyDir = join(await kaktusCopy(), "DATA", "0001");
  const state = new StateStore(await stateDir());
  const lock = await lockCompany(companyDir); // the connector's own lock file is not company data
  const entry = await state.beginBatch(BATCH, companyDir, 60_000);
  assert.deepEqual(Object.keys(entry.checksums).sort(), ["ADRESAR.DBF", "FAKPRI.DBF", "IMPORT.LOG"]);
  assert.deepEqual(await state.restoreBlockers(entry, companyDir), []);
  await lock?.renew();
  assert.deepEqual(await state.restoreBlockers(entry, companyDir), [], "renewing our lock changes no data");

  const later = new Date(Date.parse(entry.deadline) + 1_000);
  await utimes(join(companyDir, "ADRESAR.DBF"), later, later);
  assert.match((await state.restoreBlockers(entry, companyDir)).join(), /ADRESAR\.DBF changed after the batch/);

  await writeFile(join(entry.backupDir, "FAKPRI.DBF"), "damaged");
  assert.match((await state.restoreBlockers(entry, companyDir)).join(), /backup of FAKPRI\.DBF has a wrong checksum/);

  const otherInstallation = join(await kaktusCopy(), "DATA", "0001");
  assert.deepEqual(await state.restoreBlockers(entry, otherInstallation), [`the backup is of ${companyDir}`]);
});

test("a company file the import never writes must be unchanged for a restore", async () => {
  const companyDir = join(await kaktusCopy(), "DATA", "0001");
  await copyFile(join(companyDir, "ADRESAR.DBF"), join(companyDir, "FAKVYD.DBF")); // another book of the company
  const state = new StateStore(await stateDir());
  const entry = await state.beginBatch(BATCH, companyDir, 60_000);
  assert.deepEqual(await state.restoreBlockers(entry, companyDir), []);
  await copyFile(join(companyDir, "FAKPRI.DBF"), join(companyDir, "FAKVYD.DBF"));
  assert.deepEqual(await state.restoreBlockers(entry, companyDir), ["FAKVYD.DBF changed since the backup"]);
});

test("restore puts the backup back and keeps the current files in quarantine", async () => {
  const companyDir = join(await kaktusCopy(), "DATA", "0001");
  const state = new StateStore(await stateDir());
  const original = await readFile(join(companyDir, "FAKPRI.DBF"));
  const entry = await state.beginBatch(BATCH, companyDir, 60_000);
  await writeFile(join(companyDir, "FAKPRI.DBF"), "");

  const quarantine = await state.restore(entry, companyDir);
  assert.deepEqual(await readFile(join(companyDir, "FAKPRI.DBF")), original);
  assert.equal((await readFile(join(quarantine, "FAKPRI.DBF"))).length, 0);
  assert.deepEqual((await readdir(companyDir)).sort(), ["ADRESAR.DBF", "FAKPRI.DBF", "IMPORT.LOG"]);
});
