import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readKaktus } from "../src/read.js";
import { DATA_DIR, kaktusCopy } from "./helpers.js";

test("reads suppliers and received invoices of both companies", async () => {
  const { firmy } = await readKaktus(DATA_DIR);
  assert.deepEqual(
    firmy.map((company) => [company.kaktusFirma, company.dodavatele.length, company.fakturyPrijate.length, company.chyba]),
    [
      ["0001", 23, 44, undefined],
      ["0002", 9, 14, undefined],
    ],
  );
});

test("maps Kaktus records to the TAXY document schema", async () => {
  const [company] = (await readKaktus(DATA_DIR)).firmy;
  assert.ok(company);
  const numbers = company.fakturyPrijate.map((invoice) => invoice.kaktus.doklad);
  assert.ok(!numbers.includes("FP260020") && !numbers.includes("FP260039"), "deleted invoices are skipped");
  assert.ok(!company.dodavatele.some((supplier) => supplier.kaktusId === 20), "deleted partners are skipped");
  assert.equal(company.dodavatele.find((supplier) => supplier.kaktusId === 15)?.ico, "00242659", "IČO keeps leading zeros");

  const eur = company.fakturyPrijate.find((invoice) => invoice.kaktus.doklad === "FP260028");
  assert.deepEqual(
    [eur?.mena, eur?.kurz, eur?.celkem, eur?.rozpisDph, eur?.dodavatel?.nazev],
    ["EUR", 24.78, 1840.5, [{ sazba: 0, zaklad: 1840.5, dph: 0 }], "Holz Bauer GmbH"],
  );
  const mixed = company.fakturyPrijate.find((invoice) => invoice.kaktus.doklad === "FP260023");
  assert.deepEqual(mixed?.rozpisDph, [
    { sazba: 21, zaklad: 16468, dph: 3458.28 },
    { sazba: 12, zaklad: 1693.48, dph: 203.22 },
  ]);
  assert.equal(mixed?.kurz, null);
  assert.deepEqual(company.varovani, [{ kod: "DUPLICATE_SUPPLIER_ICO", zprava: "Partners 7, 19 share IČO 90100077" }]);
});

test("a corrupted company is reported without blocking the others", async () => {
  const dataDir = join(await kaktusCopy(), "DATA");
  await writeFile(join(dataDir, "0002", "FAKPRI.DBF"), Buffer.alloc(0));
  const { firmy } = await readKaktus(dataDir);
  assert.equal(firmy[0]?.fakturyPrijate.length, 44);
  assert.match(firmy[1]?.chyba ?? "", /FAKPRI\.DBF: file too short/);
});

test("a malformed value is reported with file, record and field", async () => {
  const dataDir = join(await kaktusCopy(), "DATA");
  const path = join(dataDir, "0002", "FAKPRI.DBF");
  const bytes = await readFile(path);
  const issueDateOffset = bytes.readUInt16LE(8) + 1 + 8 + 10 + 20 + 10 + 6; // record 1: flag, ID, DOKLAD, CISLODOD, VS, PARTNER
  bytes.write("2026XX07", issueDateOffset, "latin1");
  await writeFile(path, bytes);
  const { firmy } = await readKaktus(dataDir);
  assert.match(firmy[1]?.chyba ?? "", /FAKPRI\.DBF: record 1, DATVYST: invalid date "2026XX07"/);
});
